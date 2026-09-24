// ─────────────────────────────────────────────────────────────────────────────
// Settling a PayMongo payment — ONE code path.
//
// Three things can discover that a customer has paid:
//   1. PayMongo's webhook            (paymongo.controller.js → handleWebhook)
//   2. the status poll               (paymongo.controller.js → getPaymentStatus)
//   3. the stale-booking safety check (bookingStatus.util.js → enforceToPayValidity,
//                                      the cron sweep, createPaymentLink's "Pay Now")
//
// They used to each carry their own copy of the settle logic and could race.
// Now they all call settlePhasePayment(), which:
//   • flips the phase to "paid" inside a Firestore TRANSACTION, so exactly one
//     caller performs the transition and the others get { alreadyPaid: true };
//   • stores the PayMongo payment id PER PHASE (depositPaymongoPaymentID /
//     balancePaymongoPaymentID) so a later refund can target each charge;
//   • promotes the booking to "upcoming" as soon as the deposit is paid;
//   • writes the transaction log with a deterministic id (no duplicates) that
//     includes the channel and the real PayMongo reference;
//   • if the money arrives for a booking that was ALREADY cancelled, opens a
//     Pending refund request for staff instead of silently keeping it.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { computePaymentSplit } = require("../pricing");
const { recordAudit } = require("../auditLogs/auditLogs.util");
const { recordTransactionLog } = require("../transactionLogs/transactionLogs.util");
const { BOOKING_STATUS, promoteBookingToUpcoming } = require("../bookings/bookingStatus.util");
const { createNotification, notifyStaff, resolveNotification } = require("../../services/notification/notification.service");
const { buildAndSendReceipt } = require("../receipt/receipt.util");
const { computeRefundPlan } = require("./paymentBreakdown.util");
const { channelLabel, retrieveCheckoutSession } = require("./paymongoClient.util");

const num   = (v) => Number(v) || 0;
const lower = (v) => String(v || "").toLowerCase();

const phaseOf = (payment) => (payment && payment.currentPhase === "balance" ? "balance" : "deposit");

const isPhasePaid = (payment, phase) =>
  phase === "balance"
    ? lower(payment.balanceStatus) === "paid"
    : ["paid", "approved"].includes(lower(payment.status));

// What THIS phase charged (not the grand total).
const chargedAmountFor = (payment, phase) =>
  phase === "balance"
    ? num(payment.balanceAmount)
    : num(computePaymentSplit(payment.amount, payment.methodOfPayment).payNow);

/**
 * Money arrived for a booking that is already cancelled (e.g. the customer paid
 * at the last second, or a webhook was delayed past an auto-cancel). Never keep
 * it silently: open a Pending refund request so staff see it and can approve.
 */
const openRefundForLatePayment = async ({ payment, phase, charged }) => {
  try {
    const existing = await db.collection("refundRequests")
      .where("paymentID", "==", payment.paymentID)
      .where("status", "in", ["Pending", "Approved"])
      .limit(1)
      .get();
    if (!existing.empty) return existing.docs[0].id;

    const plan = computeRefundPlan(payment);
    const ref  = db.collection("refundRequests").doc();
    const now  = new Date();
    await ref.set({
      refundRequestID: ref.id,
      bookingID: payment.bookingID || null,
      paymentID: payment.paymentID,
      userID: payment.userID || null,
      reason: "Other",
      notes: `Auto-created: the ${phase} payment of ₱${charged.toLocaleString()} arrived after booking ${payment.bookingID} was already cancelled.`,
      amount: plan.total,
      onlineAmount: plan.total - plan.manualAmount,
      manualAmount: plan.manualAmount,
      status: "Pending",
      autoCreated: true,
      paymongoRefundID: null,
      paymongoRefundIDs: [],
      parts: [],
      manualRefund: null,
      processedBy: null,
      processedAt: null,
      rejectReason: null,
      createdAt: now,
      updatedAt: now,
    });

    recordAudit({
      action: "create",
      description: `Payment ${payment.paymentID} (${phase}, ₱${charged.toLocaleString()}) arrived after booking ${payment.bookingID} was cancelled — refund request ${ref.id} opened automatically.`,
      userID: payment.userID || null,
      bookingID: payment.bookingID || null,
      paymentID: payment.paymentID,
      refundRequestID: ref.id,
    });

    await notifyStaff({
      type: "refund_request",
      refID: ref.id,
      refCollection: "refundRequests",
      title: "Refund Request — payment after cancellation",
      message: `A payment of ₱${charged.toLocaleString()} arrived after booking ${payment.bookingID} was cancelled. A refund request is awaiting review.`,
    });

    if (payment.userID) {
      await createNotification({
        type: "payment_after_cancellation",
        userID: payment.userID,
        refID: payment.bookingID || null,
        title: "Payment received after cancellation",
        message: `Your payment of ₱${charged.toLocaleString()} arrived after this booking was cancelled. We've opened a refund request for you and will notify you once it's reviewed.`,
      }).catch(() => {});
    }
    return ref.id;
  } catch (err) {
    console.error("openRefundForLatePayment failed:", err.message);
    return null;
  }
};

/**
 * Marks ONE phase of a payment as paid and runs everything that follows.
 *
 * Returns { settled, alreadyPaid, bookingStatus, phase }.
 *   settled      this call did the transition
 *   alreadyPaid  someone else (webhook/poll) already had — nothing was done
 */
const settlePhasePayment = async ({ paymentRef, phase, paymongoPaymentID = null, source = "webhook" }) => {
  const tx = await db.runTransaction(async (t) => {
    const snap = await t.get(paymentRef);
    if (!snap.exists) return { state: "missing" };
    const p = snap.data();
    if (isPhasePaid(p, phase)) return { state: "already" };

    const now = new Date();
    const payload = phase === "balance"
      ? { balanceStatus: "paid", balancePaidAt: now, updatedAt: now }
      : { status: "paid", paidAt: now, updatedAt: now };
    if (paymongoPaymentID) {
      payload.paymongoPaymentID = paymongoPaymentID; // legacy: latest charge
      payload[phase === "balance" ? "balancePaymongoPaymentID" : "depositPaymongoPaymentID"] = paymongoPaymentID;
    }
    payload.lastSettledVia = source;
    t.update(paymentRef, payload);
    return { state: "settled", payment: { ...p, ...payload } };
  });

  if (tx.state === "missing") return { settled: false, alreadyPaid: false, bookingStatus: null, phase };
  if (tx.state === "already") return { settled: false, alreadyPaid: true,  bookingStatus: null, phase };

  const payment = tx.payment;
  const bID     = payment.bookingID || null;
  const charged = chargedAmountFor(payment, phase);

  if (!paymongoPaymentID) {
    console.warn(`[settle] ${phase} payment for ${bID} had no PayMongo payment id — a refund of it will need a manual lookup.`);
  }

  // Deposit paid → booking becomes "upcoming". (No-op for the balance phase:
  // the booking is already upcoming.)
  const promo = await promoteBookingToUpcoming(bID);

  // Payment landed on a booking that was already cancelled → open a refund.
  if (promo.bookingStatus === BOOKING_STATUS.CANCELLED) {
    await openRefundForLatePayment({ payment, phase, charged });
  }

  recordAudit({
    action: "update",
    description: `Payment ${payment.paymentID} — ${phase} settled (paid, ₱${charged.toLocaleString()})${bID ? ` for booking ${bID}` : ""} via ${source}.`,
    userID: payment.userID || null,
    bookingID: bID,
    paymentID: payment.paymentID,
  });

  recordTransactionLog({
    logID: `${payment.paymentID}_${phase}`, // one settlement = one row, however many paths report it
    bookingID: bID,
    paymentID: payment.paymentID,
    userID: payment.userID || null,
    type: "Payment",
    amount: charged, // what THIS phase charged — never the grand total
    status: "Success",
    paymentMethod: channelLabel(payment.paymongoChannel || payment.paymentMethod),
    referenceNumber: paymongoPaymentID || "—",
    description: `${phase === "balance" ? "Balance" : "Deposit"} payment settled via PayMongo${bID ? ` for booking ${bID}` : ""} (${source}).`,
  });

  // ── customer notifications ──
  if (payment.userID && bID) {
    try {
      await createNotification({
        type: "payment_successful",
        userID: payment.userID,
        refID: bID,
        title: "Payment Successful",
        message: `Your ${phase === "balance" ? "balance" : "deposit"} payment of ₱${charged.toLocaleString()} was received.`,
      });
      if (promo.promoted) {
        await createNotification({
          type: "booking_confirmed",
          userID: payment.userID,
          refID: bID,
          title: "Booking Confirmed",
          message: "Your booking has been confirmed. We look forward to serving you!",
        });
      }
      await resolveNotification("payment_pending", bID, payment.userID);
    } catch (e) {
      console.error("[settle] failed to write customer notifications:", e.message);
    }

    // ── digital receipt, sent to the customer's Gmail ──
    // Fired for EVERY settled phase (deposit AND, later, balance) — each is
    // its own charge, so each gets its own receipt, same as the
    // "payment_successful" notification above. Best-effort: a failed email
    // must never undo the payment settlement that already happened.
    // Shared with the manual "Email my receipt" button — see
    // utils/receipt/receipt.util.js.
    await buildAndSendReceipt({ payment, phase, charged, paymongoPaymentID });
  }

  // ── staff: the booking is now real, so THIS is when staff hear about it ──
  // (Notifying at creation would announce bookings that are never paid.)
  if (promo.promoted && bID) {
    try {
      const bSnap = await db.collection("bookings").where("bookingID", "==", bID).limit(1).get();
      const b = bSnap.empty ? {} : bSnap.docs[0].data();
      const isChauffeur = /chauffeur/i.test(b.modeOfDriving || "");
      await notifyStaff({
        type: "new_booking",
        refID: bSnap.empty ? bID : bSnap.docs[0].id,
        refCollection: "bookings",
        title: isChauffeur ? "New booking — chauffeur needed" : "New booking",
        message: isChauffeur
          ? `A new chauffeur booking (${bID}) was paid and needs a driver assigned.`
          : `A new self-drive booking (${bID}) was paid.`,
      });
    } catch (e) {
      console.error("[settle] failed to notify staff of new booking:", e.message);
    }
  }

  return { settled: true, alreadyPaid: false, bookingStatus: promo.bookingStatus, phase };
};

/**
 * Asks PayMongo whether a payment's CURRENT phase was actually paid and, if so,
 * settles it. This is the "don't trust our own database blindly" check that
 * runs before any auto-cancel, before reusing an old checkout link, and on the
 * status poll.
 *
 * `paymentDoc` is a Firestore DocumentSnapshot of the payments doc.
 *
 * Returns { checked, settled, alreadyPaid, expired, phase, bookingStatus }:
 *   checked  false ONLY when PayMongo couldn't be asked (treat as "unknown")
 *   expired  the checkout session can no longer be paid → a fresh one is needed
 */
const verifyAndSettlePayment = async (paymentDoc, { source = "verify" } = {}) => {
  const p     = paymentDoc.data();
  const phase = phaseOf(p);
  const base  = { checked: true, settled: false, alreadyPaid: false, expired: false, phase, bookingStatus: null };

  if (isPhasePaid(p, phase)) return { ...base, alreadyPaid: true };

  const phaseStatus = phase === "balance" ? p.balanceStatus : p.status;
  if (lower(phaseStatus) !== "pending" || !p.paymongoSessionID) return base; // nothing to verify

  const r = await retrieveCheckoutSession(p.paymongoSessionID);
  if (!r.ok) return { ...base, checked: false };

  if (r.paid) {
    const s = await settlePhasePayment({ paymentRef: paymentDoc.ref, phase, paymongoPaymentID: r.paymongoPaymentID, source });
    return { ...base, settled: s.settled, alreadyPaid: s.alreadyPaid, bookingStatus: s.bookingStatus };
  }
  return { ...base, expired: r.expired };
};

module.exports = {
  phaseOf,
  isPhasePaid,
  chargedAmountFor,
  settlePhasePayment,
  verifyAndSettlePayment,
  openRefundForLatePayment,
};
