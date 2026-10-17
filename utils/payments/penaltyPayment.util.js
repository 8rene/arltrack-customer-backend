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
// saved uses the current setting). It is recomputed at checkout and at settlement, and the settled part is kept
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
const { getSystemSettings, computePenaltyGatewayFee } = require("../pricing");

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

/**
 * Opens a checkout: one PENDING paymentEntries row per unpaid penalty, all sharing `groupID` and the PayMongo
 * `sessionID`. `unpaid` is listUnpaidForBooking(). Written in one batch.
 */
const writePendingPenaltyRows = async ({ unpaid, userID, groupID, sessionID, channel }) => {
  const now = new Date();
  const batch = db.batch();
  unpaid.forEach((p) => {
    const penaltyID = p.penaltyID || p._ref.id;
    const ref = db.collection(ENTRIES).doc();
    const built = buildPenaltyPaymentEntry({
      penalty: { ...p, userID }, penaltyID, amount: owedOn(p),
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
      const feeCharged = computePenaltyGatewayFee(planned, rate).gatewayFee;   // what the customer paid on this row
      const feeKept = apply > 0 ? computePenaltyGatewayFee(apply, rate).gatewayFee : 0;
      // A partly-applied row keeps the fee on the applied part only; the rest is returned with the money.
      return { r, p, planned, apply: round2(apply), feeCharged, feeKept: apply >= planned ? feeCharged : feeKept };
    });

    const appliedPlan = plan.filter((x) => x.apply > 0);
    const appliedTotal = round2(appliedPlan.reduce((s, x) => s + x.apply, 0));
    const plannedTotal = round2(plan.reduce((s, x) => s + x.planned, 0));
    const feeChargedTotal = round2(plan.reduce((s, x) => s + x.feeCharged, 0));
    const feeKeptTotal = round2(plan.reduce((s, x) => s + x.feeKept, 0));

    // PayMongo's own fee is for the WHOLE charge; split it across the rows that got money so they add up to the real fee.
    const hasPaymongoFee = charge && charge.fee !== undefined && charge.fee !== null;
    const paymongoShares = hasPaymongoFee ? splitProportional(num(charge.fee), appliedPlan.map((x) => x.apply)) : null;

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
};
