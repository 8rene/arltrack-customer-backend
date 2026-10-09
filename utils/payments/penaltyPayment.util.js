// ─────────────────────────────────────────────────────────────────────────────
// Paying a booking's unpaid penalties online (PayMongo).
//
// Penalties used to be payable in person only (admin: recordShortfallPayment).
// This is the customer-side counterpart. One checkout covers ALL of a
// booking's currently-unpaid CONFIRMED penalties; the amount is always
// computed here on the server, never taken from the client.
//
//   penaltyCheckouts/{PENCO-xxxx}   one doc per PayMongo session
//     { checkoutID, bookingID, userID, amount, channel, sessionID, checkoutUrl,
//       status: pending | paid, ... }
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

    let remaining = num(co.amount);
    const applied = [];
    const groupID = db.collection(ENTRIES).doc().id;

    for (const p of unpaid) {
      if (remaining <= 0) break;
      const apply = Math.min(owedOn(p), remaining);
      remaining = Math.round((remaining - apply) * 100) / 100;
      const penaltyID = p.penaltyID || p._ref.id;

      tx.update(p._ref, { paidAmount: num(p.paidAmount) + apply, updatedAt: now });

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
        transactionFee: charge && charge.fee !== undefined ? charge.fee : null,
      });
      applied.push({ penaltyID, amount: apply, paymentID: p.paymentID || null });
    }

    const appliedTotal = Math.round((num(co.amount) - remaining) * 100) / 100;
    tx.update(checkoutRef, {
      status: "paid", paidAt: now, updatedAt: now, settledBy: source,
      paymongoPaymentID: paymongoPaymentID || null,
      appliedAmount: appliedTotal, unappliedAmount: remaining, appliedTo: applied,
    });

    return { settled: true, checkout: co, applied: appliedTotal, unapplied: remaining, appliedTo: applied };
  });

  if (!result.settled) return result;

  // ── Side effects (outside the transaction; each is best-effort) ──────────
  const co = result.checkout;
  const first = result.appliedTo[0] || {};
  const label = channelLabel(co.channel);

  await recordTransactionLog({
    bookingID: co.bookingID, paymentID: first.paymentID || null, userID: co.userID,
    penaltyID: result.appliedTo.length === 1 ? result.appliedTo[0].penaltyID : null,   // one payment can cover several
    type: "Payment", amount: result.applied, status: "Success",
    paymentMethod: label, referenceNumber: paymongoPaymentID || co.sessionID || "",
    description: "Outstanding penalty balance paid online.",
    logID: `penalty-${co.checkoutID}`,           // deterministic → no duplicate if webhook + poll both land
  });

  recordAudit({
    action: "update", userID: co.userID, bookingID: co.bookingID, paymentID: first.paymentID || null,
    description: `Customer paid ₱${result.applied.toLocaleString()} of penalties on booking ${co.bookingID} online via ${label}`
      + `${result.unapplied > 0 ? ` (₱${result.unapplied.toLocaleString()} could not be applied — penalties were already settled; needs a manual refund)` : ""}.`,
  });

  createNotification({
    type: "penalty_paid", userID: co.userID, refID: co.bookingID,
    title: "Penalty payment received",
    message: `We received your online payment of ₱${result.applied.toLocaleString()} for the penalties on booking ${co.bookingID}. Thank you!`,
  }).catch((e) => console.error("[penalty-pay] notification failed:", e.message));

  return result;
};

module.exports = { CHECKOUTS, listUnpaidForBooking, unpaidTotal, settlePenaltyCheckout, owedOn };