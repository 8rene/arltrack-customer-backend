// ─────────────────────────────────────────────────────────────────────────────
// Paying a booking's unpaid penalties online (PayMongo).
//
// Penalties used to be payable in person only (admin: recordShortfallPayment).
// This is the customer-side counterpart. One checkout covers ALL of a
// booking's currently-unpaid CONFIRMED penalties; the amount is always
// computed here on the server, never taken from the client.
//
// There is NO separate collection for an open checkout. Everything lives in the two collections the admin app
// already owns:
//
//   paymentEntries   one PENDING row per penalty the checkout covers, written when the checkout opens:
//                      { direction: "in", phase: "penalty", source: "online", status: "pending", penaltyID,
//                        amount: the penalty money this row will put toward that penalty,
//                        sessionID: the PayMongo checkout session,
//                        groupID: "PENCO-xxxx" -- shared by the rows of ONE checkout (the PayMongo
//                                 reference_number, so the webhook / return page find the rows by it) }
//                    The webhook or the status poll flips them to "success" (or "failed").
//   penalties        paidAmount and gatewayFeePaid, updated at settlement.
//
// The online payment (gateway) fee the customer pays on top of the penalty is NOT stored on the pending rows.
// It is the fee on each row's amount at its penalty's saved gatewayFeeRate (a penalty from before the rate was
// saved uses the current setting), and ONLY for a penalty whose own amount is higher than PENALTY_FEE_MIN_AMOUNT
// (pricing.js); a smaller penalty is paid with no fee. It is recomputed at checkout and at settlement, and the settled part is kept
// on penalties.gatewayFeePaid, nowhere else. A row's amount is the penalty money only.
//
// Like settlePayment.util.js, ONE function (settlePenaltyCheckout) settles a checkout no matter who discovers
// the payment first -- the webhook or the status poll -- and does it inside a Firestore transaction, so it is
// idempotent: only the first caller applies the money, the rest get { alreadyPaid: true }.
//
// Applying the money mirrors admin's recordShortfallPayment: never more than what each penalty still owes,
// paidAmount updated on the penalty, and the row of that penalty turns "success" so the admin Penalties page /
// reports pick it up unchanged. A row whose penalty was settled meanwhile (in store, from the deposit, or by
// another checkout) turns "failed" with a note, and the money is reported as needing a manual refund.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { buildPenaltyPaymentEntry } = require("./paymentEntries.mapper");
const { recordTransactionLog } = require("../transactionLogs/transactionLogs.util");
const { recordAudit } = require("../auditLogs/auditLogs.util");
const { createNotification } = require("../../services/notification/notification.service");
const { getSystemSettings, computePenaltyGatewayFee, computePenaltyCheckoutFees } = require("../pricing");
const { getDepositView } = require("./depositView.util");
const { getDiscountFigures } = require("./discountLedger.util");

const ENTRIES   = "paymentEntries";
const PENALTIES = "penalties";

const num   = (v) => Number(v) || 0;
const owedOn = (p) => Math.max(0, num(p.amount) - num(p.paidAmount));
const millis = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v._seconds !== undefined) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
};
const byAge = (a, b) => millis(a.createdAt) - millis(b.createdAt);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// method code on the row -> the label the transaction log / audit / notification use
const METHOD_LABEL = { gcash: "GCash", maya: "Maya", qrph: "QRPH" };
const labelOfMethod = (m) => METHOD_LABEL[String(m || "").toLowerCase()] || "PayMongo";

/** Splits `total` pesos across `weights` in proportion, in whole centavos, the last share taking the rounding
 *  remainder, so the shares always add back up to exactly `total`. */
const splitProportional = (total, weights) => {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length || !(sum > 0)) return weights.map(() => 0);
  const cents = Math.round(num(total) * 100);
  let given = 0;
  return weights.map((w, i) => {
    const share = i === weights.length - 1 ? cents - given : Math.round((cents * w) / sum);
    given += share;
    return share / 100;
  });
};

// A row of an online penalty checkout (as opposed to any other money movement).
const isPenaltyCheckoutRow = (r) => r && r.direction === "in" && r.phase === "penalty" && r.source === "online" && !!r.groupID;

// PayMongo sessions expire after 24h, so a "pending" row older than that is stale (nothing has flipped it yet)
// and must not mark a penalty as awaiting payment. This is DERIVED on read: nothing is stored for it.
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** All rows of one checkout (every status), as [{ _ref, id, ...data }]. */
const getGroupRows = async (groupID) => {
  const snap = await db.collection(ENTRIES).where("groupID", "==", groupID).get();
  return snap.docs.map((d) => ({ _ref: d.ref, id: d.id, ...d.data() })).filter(isPenaltyCheckoutRow);
};

/** This customer's still-pending checkout rows, grouped by checkout: [{ groupID, bookingID, userID, sessionID, method, rows, penaltyAmount, createdAt }].
 *  Equality filters only (no composite index). */
const listPendingGroups = async (userID, { bookingID = null } = {}) => {
  const snap = await db.collection(ENTRIES).where("userID", "==", userID).where("status", "==", "pending").get();
  const groups = new Map();
  snap.docs.forEach((d) => {
    const r = { _ref: d.ref, id: d.id, ...d.data() };
    if (!isPenaltyCheckoutRow(r)) return;
    if (bookingID && r.bookingID !== bookingID) return;
    const g = groups.get(r.groupID) || { groupID: r.groupID, bookingID: r.bookingID, userID: r.userID, sessionID: r.sessionID || null, method: r.method || null, rows: [], penaltyAmount: 0, createdAt: r.createdAt };
    g.rows.push(r);
    g.penaltyAmount = round2(g.penaltyAmount + num(r.amount));
    if (millis(r.createdAt) < millis(g.createdAt)) g.createdAt = r.createdAt;
    groups.set(r.groupID, g);
  });
  return [...groups.values()];
};

/** { [bookingID]: { checkoutID, checkoutUrl, amount, createdAt } } -- this customer's still-open penalty checkouts. */
const listPendingCheckouts = async (userID) => {
  const cutoff = Date.now() - PENDING_WINDOW_MS;
  const out = {};
  (await listPendingGroups(userID)).forEach((g) => {
    if (!g.bookingID || millis(g.createdAt) < cutoff) return;
    const prev = out[g.bookingID];
    if (!prev || millis(g.createdAt) > millis(prev.createdAt)) {
      out[g.bookingID] = { checkoutID: g.groupID, checkoutUrl: null, amount: g.penaltyAmount, createdAt: g.createdAt };
    }
  });
  return out;
};

/** Confirmed penalties of this booking that still owe money, oldest first. */
const listUnpaidForBooking = async (userID, bookingID) => {
  const snap = await db.collection(PENALTIES)
    .where("bookingID", "==", bookingID)
    .where("status", "==", "Confirmed")
    .get();
  return snap.docs
    .map((d) => ({ _ref: d.ref, ...d.data() }))
    .filter((p) => p.userID === userID && owedOn(p) > 0)
    .sort(byAge);
};

const unpaidTotal = (list) =>
  Math.round(list.reduce((s, p) => s + owedOn(p), 0) * 100) / 100;

// ── What the customer really pays ONLINE, and so what carries the online payment fee ────────────────────────────────
// A HELD security deposit pays the penalties first: staff's "Confirm & settle" (admin settleBooking) deducts them from it,
// oldest first. Money taken from the deposit is not an online payment, so that part has NO gateway fee. Only what the
// deposit does not cover is paid online, and only that remainder carries the fee (each penalty at its own saved rate).
// Once the deposit is no longer held (already settled and returned, refunded, waived, forfeited, or none was recorded)
// every unpaid penalty is paid online in full, fee included.

/**
 * What is still available to pay penalties WITHOUT an online payment: the payment's deposit while it is Held and not yet
 * settled, plus the discount credit held for the customer (a discount given on a fully paid booking, see discountLedger.js).
 * Settlement pays each penalty from the deposit first, then from the credit (admin applyPenaltyToDeposit / planSettlement), and
 * neither is an online payment, so neither carries the gateway fee. Else 0.
 */
const heldDepositCover = (payment) => {
  const dep = payment ? getDepositView(payment) : null;
  if (!(dep && dep.status === "Held" && !dep.settlement)) return 0;
  // Minus what was already taken for penalties when they were confirmed, so the same deposit is never counted twice.
  const deposit = Math.max(0, num(dep.amount) - num(dep.applied));
  // getDiscountFigures().credit is 0 for a legacy discount (refunded on the spot) and for no discount.
  return round2(deposit + getDiscountFigures(payment).credit);
};

/** The discount credit part of heldDepositCover(): 0 unless the deposit is Held and unsettled and credit is held. */
const heldCreditOf = (payment) => {
  const dep = payment ? getDepositView(payment) : null;
  if (!(dep && dep.status === "Held" && !dep.settlement)) return 0;
  return round2(getDiscountFigures(payment).credit);
};

/** heldDepositCover() of ONE booking's payment. */
const heldDepositCoverForBooking = async (bookingID) => {
  const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? 0 : heldDepositCover(snap.docs[0].data());
};

/** { [bookingID]: heldCreditOf } for every payment of this customer: how much of each booking's cover is discount credit. */
const heldCreditByBooking = async (userID) => {
  const snap = await db.collection("payments").where("userID", "==", userID).get();
  const out = {};
  snap.docs.forEach((d) => { const p = d.data(); if (p.bookingID) out[p.bookingID] = heldCreditOf(p); });
  return out;
};

/** { [bookingID]: heldDepositCover } for every payment of this customer (one read, for the all-bookings views). */
const heldDepositCoverByBooking = async (userID) => {
  const snap = await db.collection("payments").where("userID", "==", userID).get();
  const out = {};
  snap.docs.forEach((d) => { const p = d.data(); if (p.bookingID) out[p.bookingID] = heldDepositCover(p); });
  return out;
};

/**
 * The online payment for ONE booking's unpaid penalties. `unpaid` = this customer's Confirmed penalties that still owe.
 *   unpaidTotal       every unpaid penalty (what blocks a new booking)
 *   coveredByDeposit  what the held deposit will pay at settlement (no fee)
 *   onlineDue         the penalty money left to pay online (= penaltyAmount)
 *   gatewayFee        the online payment fee on onlineDue, each penalty at its own rate (else fallbackPercent)
 *   total             onlineDue + gatewayFee: what the checkout charges
 *   lines             [{ penaltyID, amount, rate, fee }] -- the pending row to write for each penalty, and its fee
 * onlineDue is put on the penalties OLDEST FIRST, the same order settlement applies online money in. Every penalty
 * therefore carries a fee line for exactly the part of it that is paid online.
 */
const planOnlinePayment = (unpaid = [], { depositCover = 0, fallbackPercent = 0 } = {}) => {
  const sorted = [...unpaid].filter((p) => owedOn(p) > 0).sort(byAge);
  const all = unpaidTotal(sorted);
  const coveredByDeposit = round2(Math.min(num(depositCover), all));
  const onlineDue = round2(all - coveredByDeposit);
  let left = onlineDue;
  const items = [];
  for (const p of sorted) {
    if (left <= 0) break;
    const part = Math.min(owedOn(p), left);
    left = round2(left - part);
    items.push({ penaltyID: p.penaltyID || (p._ref && p._ref.id) || p.id, owed: part, gatewayFeeRate: p.gatewayFeeRate, penaltyTotal: p.amount });
  }
  return { unpaidTotal: all, coveredByDeposit, onlineDue, ...computePenaltyCheckoutFees(items, fallbackPercent) };
};

/**
 * Opens a checkout: one PENDING paymentEntries row per penalty that has something to pay ONLINE, all sharing `groupID`
 * and the PayMongo `sessionID`. `unpaid` is listUnpaidForBooking(); `lines` is planOnlinePayment().lines, which says
 * how much of each penalty is paid online (a held deposit pays the rest, so that part gets no row and no fee).
 * Without `lines` every unpaid penalty is written in full. Written in one batch.
 */
const writePendingPenaltyRows = async ({ unpaid, lines = null, userID, groupID, sessionID, channel }) => {
  const now = new Date();
  const batch = db.batch();
  const onlineOf = lines ? new Map(lines.map((l) => [l.penaltyID, l.amount])) : null;
  unpaid.forEach((p) => {
    const penaltyID = p.penaltyID || p._ref.id;
    const amount = onlineOf ? num(onlineOf.get(penaltyID)) : owedOn(p);
    if (!(amount > 0)) return;
    const ref = db.collection(ENTRIES).doc();
    const built = buildPenaltyPaymentEntry({
      penalty: { ...p, userID }, penaltyID, amount,
      method: channel, referenceNumber: null, processedBy: null, groupID, now,
    });
    batch.set(ref, {
      paymentEntryID: ref.id,
      ...built,
      source: "online",          // paid through PayMongo, not at the counter
      status: "pending",         // flipped by settlePenaltyCheckout()
      sessionID,
      processedAt: null,
      settledAt: null,
    });
  });
  await batch.commit();
};

/** Marks every still-pending row of a checkout "cancelled" (its PayMongo session expired). */
const cancelPendingGroup = async (groupID, note = "Checkout expired before it was paid.") => {
  const rows = (await getGroupRows(groupID)).filter((r) => r.status === "pending");
  if (!rows.length) return 0;
  const now = new Date();
  const batch = db.batch();
  rows.forEach((r) => batch.update(r._ref, { status: "cancelled", transactionErrorNote: note, updatedAt: now }));
  await batch.commit();
  return rows.length;
};

/**
 * Applies a paid checkout (identified by its groupID) to the booking's penalties. Idempotent.
 * Returns { settled, alreadyPaid, notFound, applied, unapplied, ... }.
 */
const settlePenaltyCheckout = async ({ groupID, paymongoPaymentID = null, charge = null, source = "webhook" }) => {
  const now = new Date();
  const settings = await getSystemSettings();

  const result = await db.runTransaction(async (tx) => {
    // All reads before any write.
    const rowSnap = await tx.get(db.collection(ENTRIES).where("groupID", "==", groupID));
    const allRows = rowSnap.docs.map((d) => ({ _ref: d.ref, id: d.id, ...d.data() })).filter(isPenaltyCheckoutRow);
    if (!allRows.length) return { notFound: true };
    const rows = allRows.filter((r) => r.status === "pending");
    if (!rows.length) return { alreadyPaid: true, groupID };

    const first = rows[0];
    const bookingID = first.bookingID;
    const userID = first.userID;

    const pSnap = await tx.get(db.collection(PENALTIES).where("bookingID", "==", bookingID).where("status", "==", "Confirmed"));
    const penalties = new Map(pSnap.docs.map((d) => [d.data().penaltyID || d.id, { _ref: d.ref, ...d.data() }]));

    // First decide how much of each row can be applied, then write. A penalty is only touched by its own row.
    const plan = rows.map((r) => {
      const p = penalties.get(r.penaltyID);
      const planned = num(r.amount);
      const apply = p && p.userID === userID ? Math.min(owedOn(p), planned) : 0;
      const rate = p && p.gatewayFeeRate !== undefined && p.gatewayFeeRate !== null && p.gatewayFeeRate !== "" ? p.gatewayFeeRate : settings.gatewayFeePercent;
      const penaltyTotal = p ? p.amount : null;   // the penalty's own amount decides whether a fee applies at all
      const feeCharged = computePenaltyGatewayFee(planned, rate, penaltyTotal).gatewayFee;   // what the customer paid on this row
      const feeKept = apply > 0 ? computePenaltyGatewayFee(apply, rate, penaltyTotal).gatewayFee : 0;
      // A partly-applied row keeps the fee on the applied part only; the rest is returned with the money.
      return { r, p, planned, apply: round2(apply), feeCharged, feeKept: apply >= planned ? feeCharged : feeKept };
    });

    const appliedPlan = plan.filter((x) => x.apply > 0);
    const appliedTotal = round2(appliedPlan.reduce((s, x) => s + x.apply, 0));
    const plannedTotal = round2(plan.reduce((s, x) => s + x.planned, 0));
    const feeChargedTotal = round2(plan.reduce((s, x) => s + x.feeCharged, 0));
    const feeKeptTotal = round2(plan.reduce((s, x) => s + x.feeKept, 0));

    // PayMongo's own fee is for the WHOLE charge; split it across the rows that got money so they add up to the real fee.
    // PayMongo takes its cut of everything charged, so each row weighs what was charged on it: the penalty money PLUS the
    // online payment fee on it. (Weighing penalty money alone gave a penalty with no fee, one of P1,000 or less, too big a
    // share when it was paid in the same checkout as a larger penalty that carries a fee.)
    const hasPaymongoFee = charge && charge.fee !== undefined && charge.fee !== null;
    const paymongoShares = hasPaymongoFee ? splitProportional(num(charge.fee), appliedPlan.map((x) => x.apply + x.feeKept)) : null;

    const applied = [];
    let ai = 0;
    plan.forEach((x) => {
      const { r, p } = x;
      if (x.apply > 0) {
        // paidAmount only ever counts penalty money; the online payment fee is kept apart in gatewayFeePaid (a running
        // total like paidAmount), so the penalty can never look paid early because of a fee.
        tx.update(p._ref, { paidAmount: round2(num(p.paidAmount) + x.apply), gatewayFeePaid: round2(num(p.gatewayFeePaid) + x.feeKept), updatedAt: now });
        tx.update(r._ref, {
          status: "success", amount: x.apply,
          referenceNumber: paymongoPaymentID || r.sessionID || null,
          transactionFee: paymongoShares ? paymongoShares[ai] : null,   // PayMongo's actual cut for this row
          transactionErrorNote: x.apply < x.planned ? `Only ₱${x.apply} of the ₱${x.planned} paid could be applied -- the penalty was partly settled meanwhile; refund the rest manually.` : null,
          processedAt: now, settledAt: now, updatedAt: now,
        });
        ai += 1;
        applied.push({ penaltyID: r.penaltyID, amount: x.apply, paymentID: r.paymentID || null, entryID: r.id });
      } else {
        tx.update(r._ref, {
          status: "failed",
          transactionErrorNote: "The penalty was already settled before this payment arrived -- refund the customer manually.",
          updatedAt: now,
        });
      }
    });

    return {
      settled: true, groupID, bookingID, userID, method: first.method || null, sessionID: first.sessionID || null,
      applied: appliedTotal, unapplied: round2(plannedTotal - appliedTotal), appliedTo: applied,
      gatewayFee: feeKeptTotal, unappliedGatewayFee: round2(feeChargedTotal - feeKeptTotal),
    };
  });

  if (!result.settled) return result;

  // ── Side effects (outside the transaction; each is best-effort) ──────────
  const co = result;
  const firstApplied = co.appliedTo[0] || {};
  const label = labelOfMethod(co.method);

  // One log per penalty the checkout covered (own penaltyID / paymentID, the amount put toward THAT penalty).
  // They share the checkout's PayMongo reference -- it was one real payment; its rows share a groupID.
  for (const a of co.appliedTo) {
    await recordTransactionLog({
      bookingID: co.bookingID, paymentID: a.paymentID || null, userID: co.userID,
      penaltyID: a.penaltyID,
      type: "Payment", amount: a.amount, status: "Success",
      paymentMethod: label, referenceNumber: paymongoPaymentID || co.sessionID || "",
      description: "Outstanding penalty balance paid online.",
      logID: `penalty-${co.groupID}-${a.penaltyID}`,   // deterministic → no duplicate if webhook + poll both land
    });
  }

  const returnDue = round2(co.unapplied + co.unappliedGatewayFee);   // penalty money + the fee paid on it
  recordAudit({
    action: "update", userID: co.userID, bookingID: co.bookingID, paymentID: firstApplied.paymentID || null,
    description: `Customer paid ₱${co.applied.toLocaleString()} of penalties${co.gatewayFee > 0 ? ` (+ ₱${co.gatewayFee.toLocaleString()} online payment fee)` : ""} on booking ${co.bookingID} online via ${label}`
      + `${returnDue > 0 ? ` (₱${returnDue.toLocaleString()} could not be applied — penalties were already settled; needs a manual refund)` : ""}.`,
  });

  createNotification({
    type: "penalty_paid", userID: co.userID, refID: co.bookingID,
    title: "Penalty payment received",
    message: `We received your online payment of ₱${co.applied.toLocaleString()} for the penalties on booking ${co.bookingID}`
      + `${co.gatewayFee > 0 ? ` (plus a ₱${co.gatewayFee.toLocaleString()} online payment fee)` : ""}. Thank you!`,
  }).catch((e) => console.error("[penalty-pay] notification failed:", e.message));

  return result;
};

module.exports = {
  listUnpaidForBooking, unpaidTotal, owedOn, listPendingCheckouts, listPendingGroups, getGroupRows,
  writePendingPenaltyRows, cancelPendingGroup, settlePenaltyCheckout,
  heldDepositCover, heldDepositCoverForBooking, heldDepositCoverByBooking, heldCreditByBooking, planOnlinePayment,
};