// ─────────────────────────────────────────────────────────────────────────────
// Paying a booking's unpaid penalties online (PayMongo).
//
// Penalties used to be payable in person only (admin: recordShortfallPayment).
// This is the customer-side counterpart. One checkout covers ALL of a
// booking's currently-unpaid CONFIRMED penalties; the amount is always
// computed here on the server, never taken from the client.
//
//   penaltyCheckouts/{PENCO-xxxx}   one doc per PayMongo session
//     { checkoutID, bookingID, userID, amount, penaltyAmount, gatewayFee, gatewayFeeRate, lines, channel, sessionID,
//       checkoutUrl, status: pending | paid, ... }
//     lines = [{ penaltyID, amount, rate, fee }]: what each penalty owed when the checkout opened, at ITS OWN
//     gatewayFeeRate, and the fee on it. Settlement adds every penalty's fee to ITS penalties.gatewayFeePaid.
//     amount = what the customer was charged = penaltyAmount + gatewayFee. Only penaltyAmount is penalty money;
//     gatewayFee is the online payment fee (same % as the booking). Checkouts opened before the fee existed have
//     neither field, and for them amount IS the penalty money.
//
// Like settlePayment.util.js, ONE function (settlePenaltyCheckout) settles a
// checkout no matter who discovers the payment first — the webhook or the
// status poll — and does it inside a Firestore transaction, so it is
// idempotent: only the first caller applies the money, the rest get
// { alreadyPaid: true }.
//
// Applying the money mirrors admin's recordShortfallPayment: oldest penalty
// first, never more than what each penalty still owes, paidAmount updated on
// the penalty, and one paymentEntries row per penalty covered (source:
// "online") so the admin Penalties page / reports pick it up unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { buildPenaltyPaymentEntry } = require("./paymentEntries.mapper");
const { recordTransactionLog } = require("../transactionLogs/transactionLogs.util");
const { recordAudit } = require("../auditLogs/auditLogs.util");
const { createNotification } = require("../../services/notification/notification.service");
const { channelLabel } = require("./paymongoClient.util");

const CHECKOUTS = "penaltyCheckouts";
const ENTRIES   = "paymentEntries";

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

// A checkout the customer opened but has not finished. PayMongo sessions expire after 24h, so a "pending" doc older
// than that is stale (nothing has flipped it to "expired" yet) and must not mark a penalty as awaiting payment.
// This is DERIVED on read, like the rest of the penalty state: nothing is stored on the penalty for it.
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** { [bookingID]: { checkoutID, checkoutUrl, amount, createdAt } } -- this customer's still-open penalty checkouts. */
const listPendingCheckouts = async (userID) => {
  const snap = await db.collection(CHECKOUTS)
    .where("userID", "==", userID).where("status", "==", "pending").get();
  const cutoff = Date.now() - PENDING_WINDOW_MS;
  const out = {};
  snap.docs.map((d) => d.data()).forEach((c) => {
    if (!c.bookingID || millis(c.createdAt) < cutoff) return;
    const prev = out[c.bookingID];
    if (!prev || millis(c.createdAt) > millis(prev.createdAt)) {
      out[c.bookingID] = { checkoutID: c.checkoutID, checkoutUrl: c.checkoutUrl || null, amount: num(c.amount), createdAt: c.createdAt };
    }
  });
  return out;
};

/** Confirmed penalties of this booking that still owe money, oldest first. */
const listUnpaidForBooking = async (userID, bookingID) => {
  const snap = await db.collection("penalties")
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
 * Applies a paid checkout to the booking's penalties. Idempotent.
 * Returns { settled, alreadyPaid, notFound, applied, unapplied }.
 */
const settlePenaltyCheckout = async ({ checkoutRef, paymongoPaymentID = null, charge = null, source = "webhook" }) => {
  const now = new Date();

  const result = await db.runTransaction(async (tx) => {
    const cs = await tx.get(checkoutRef);
    if (!cs.exists) return { notFound: true };
    const co = cs.data();
    if (co.status === "paid") return { alreadyPaid: true, checkout: co };

    // All reads before any write.
    const pSnap = await tx.get(
      db.collection("penalties").where("bookingID", "==", co.bookingID).where("status", "==", "Confirmed")
    );
    const unpaid = pSnap.docs
      .map((d) => ({ _ref: d.ref, ...d.data() }))
      .filter((p) => p.userID === co.userID && owedOn(p) > 0)
      .sort(byAge);

    // Only the penalty money is applied to penalties. The online payment fee the customer also paid is NOT penalty
    // money: it never touches a penalty's paidAmount (or it would clear the penalty early and show up below as an
    // overpayment). A checkout from before the fee existed has no penaltyAmount: its whole amount is penalty money.
    const hasSplit = co.penaltyAmount !== undefined && co.penaltyAmount !== null;
    const penaltyDue = hasSplit ? num(co.penaltyAmount) : num(co.amount);
    const feeCharged = hasSplit ? num(co.gatewayFee) : 0;

    // First decide how much goes to which penalty (oldest first), then write.
    let remaining = penaltyDue;
    const plan = [];
    for (const p of unpaid) {
      if (remaining <= 0) break;
      const apply = Math.min(owedOn(p), remaining);
      remaining = round2(remaining - apply);
      plan.push({ p, apply });
    }
    const appliedTotal = round2(penaltyDue - remaining);

    // Each penalty keeps the fee of ITS OWN line (its own rate), scaled to the part of it that was really applied: if
    // the penalty was partly or fully settled meanwhile, the fee on the part that could not be applied is returned
    // with it. A checkout without lines (no per-penalty rates) falls back to sharing the fee in proportion.
    const weights = plan.map((x) => x.apply);
    const lineOf = new Map((Array.isArray(co.lines) ? co.lines : []).map((l) => [l.penaltyID, l]));
    let feeShares;
    if (lineOf.size) {
      const pid = (x) => x.p.penaltyID || x.p._ref.id;
      feeShares = plan.map((x) => {
        const l = lineOf.get(pid(x));
        return l && num(l.amount) > 0 ? round2((num(l.fee) * Math.min(x.apply, num(l.amount))) / num(l.amount)) : 0;
      });
    } else {
      const kept = penaltyDue > 0 ? round2((feeCharged * appliedTotal) / penaltyDue) : 0;
      feeShares = splitProportional(kept, weights);
    }
    const feeKept = round2(feeShares.reduce((s, n) => s + n, 0));
    // PayMongo's own fee is for the WHOLE charge. It used to be stamped in full on every penalty the checkout
    // covered, which counted it once per penalty; it is now split across the rows so they add up to the real fee.
    const hasPaymongoFee = charge && charge.fee !== undefined && charge.fee !== null;
    const paymongoShares = hasPaymongoFee ? splitProportional(num(charge.fee), weights) : null;

    const applied = [];
    const groupID = db.collection(ENTRIES).doc().id;

    plan.forEach(({ p, apply }, i) => {
      const penaltyID = p.penaltyID || p._ref.id;

      // paidAmount only ever counts penalty money; the online payment fee is kept apart in gatewayFeePaid (a running total
      // like paidAmount), so the penalty can never look paid early because of a fee.
      tx.update(p._ref, { paidAmount: num(p.paidAmount) + apply, gatewayFeePaid: round2(num(p.gatewayFeePaid) + feeShares[i]), updatedAt: now });

      const entryRef = db.collection(ENTRIES).doc();
      const entry = buildPenaltyPaymentEntry({
        penalty: { ...p, userID: co.userID }, penaltyID, amount: apply,
        method: co.channel, referenceNumber: paymongoPaymentID || co.sessionID || null,
        processedBy: null, groupID, now,
      });
      tx.set(entryRef, {
        paymentEntryID: entryRef.id,
        ...entry,
        source: "online",                       // paid through PayMongo, not at the counter
        sessionID: co.sessionID || null,
        // amount = the penalty money only. The online payment fee the customer paid is on the penalty (gatewayFeePaid).
        transactionFee: paymongoShares ? paymongoShares[i] : null,   // PayMongo's actual cut for this row
      });
      applied.push({ penaltyID, amount: apply, paymentID: p.paymentID || null });
    });

    tx.update(checkoutRef, {
      status: "paid", paidAt: now, updatedAt: now, settledBy: source,
      paymongoPaymentID: paymongoPaymentID || null,
      appliedAmount: appliedTotal, unappliedAmount: remaining, appliedTo: applied,
      gatewayFeeApplied: feeKept, unappliedGatewayFee: round2(feeCharged - feeKept),
    });

    return {
      settled: true, checkout: co, applied: appliedTotal, unapplied: remaining, appliedTo: applied,
      gatewayFee: feeKept, unappliedGatewayFee: round2(feeCharged - feeKept),
    };
  });

  if (!result.settled) return result;

  // ── Side effects (outside the transaction; each is best-effort) ──────────
  const co = result.checkout;
  const first = result.appliedTo[0] || {};
  const label = channelLabel(co.channel);

  // One log per penalty the checkout covered (own penaltyID / paymentID, the amount put toward THAT penalty).
  // They share the checkout's PayMongo reference -- it was one real payment; its paymentEntries rows share a groupID.
  for (const a of result.appliedTo) {
    await recordTransactionLog({
      bookingID: co.bookingID, paymentID: a.paymentID || null, userID: co.userID,
      penaltyID: a.penaltyID,
      type: "Payment", amount: a.amount, status: "Success",
      paymentMethod: label, referenceNumber: paymongoPaymentID || co.sessionID || "",
      description: "Outstanding penalty balance paid online.",
      logID: `penalty-${co.checkoutID}-${a.penaltyID}`,   // deterministic → no duplicate if webhook + poll both land
    });
  }

  const returnDue = round2(result.unapplied + result.unappliedGatewayFee);   // penalty money + the fee paid on it
  recordAudit({
    action: "update", userID: co.userID, bookingID: co.bookingID, paymentID: first.paymentID || null,
    description: `Customer paid ₱${result.applied.toLocaleString()} of penalties${result.gatewayFee > 0 ? ` (+ ₱${result.gatewayFee.toLocaleString()} online payment fee)` : ""} on booking ${co.bookingID} online via ${label}`
      + `${returnDue > 0 ? ` (₱${returnDue.toLocaleString()} could not be applied — penalties were already settled; needs a manual refund)` : ""}.`,
  });

  createNotification({
    type: "penalty_paid", userID: co.userID, refID: co.bookingID,
    title: "Penalty payment received",
    message: `We received your online payment of ₱${result.applied.toLocaleString()} for the penalties on booking ${co.bookingID}`
      + `${result.gatewayFee > 0 ? ` (plus a ₱${result.gatewayFee.toLocaleString()} online payment fee)` : ""}. Thank you!`,
  }).catch((e) => console.error("[penalty-pay] notification failed:", e.message));

  return result;
};

module.exports = { CHECKOUTS, listUnpaidForBooking, unpaidTotal, settlePenaltyCheckout, owedOn, listPendingCheckouts };