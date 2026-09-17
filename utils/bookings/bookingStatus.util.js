// ─────────────────────────────────────────────────────────────────────────────
// Booking status lifecycle — SINGLE SOURCE OF TRUTH.
//
// bookings.status flow:
//   "to pay"    → set on createBooking(). Payment hasn't fully cleared yet.
//   "upcoming"  → set once the booking is FULLY paid (see isFullyPaid below).
//   "ongoing" / "completed" → set elsewhere (admin side / trip lifecycle).
//   "cancelled" → set here (auto) or by cancelBooking() (customer) / admin.
//
// Two-phase payment (payments.controller fields, set in
// bookings.controller.js's createBooking / paymongo.controller.js):
//   status         → the FIRST payment ("deposit" phase — 50% for
//                     "Partial", 100% for "Full"). "pending"|"paid"|"failed"|"cancelled".
//   balanceStatus  → the SECOND payment, Partial bookings only (the
//                     remaining 50%, paid once the deposit has cleared).
//                     "not_applicable" (Full) | "not_due" (deposit not yet
//                     paid) | "pending" | "paid" | "failed".
//   currentPhase   → "deposit" | "balance" — which phase the payment doc's
//                     shared paymongoSessionID/checkoutUrl currently belong
//                     to (deposit and balance checkouts happen sequentially,
//                     never concurrently, so these fields are safely reused
//                     across phases rather than duplicated per-phase).
//
// A booking only reaches "upcoming" once isFullyPaid() is true — for
// "Partial" that means BOTH status AND balanceStatus are "paid", not just
// the deposit. See promoteBookingToUpcoming.
//
// A "to pay" booking stops being valid the moment EITHER of these is true:
//   1. Its own startDateTime has already passed — paying for a booking that
//      can no longer happen makes no sense regardless of anything else.
//   2. It's been sitting with NO deposit paid at all for more than
//      TO_PAY_WINDOW_MS (12 hours). Once a deposit IS paid, real money has
//      already been collected, so the 12h auto-cancel backs off — an
//      outstanding balance from then on needs a human (admin/refund), not
//      a silent auto-cancel. See getStaleReason.
//
// Same pattern as utils/sessionLogs/sessionLogs.util.js's sweepExpiredSessions:
// a cron sweep (jobs/cancelStaleBookings.job.js) is the backstop, but the
// checks here are also called inline on the read/write paths that touch a
// "to pay" booking (getUserBookings, createPaymentLink, getPaymentStatus) so
// staleness is caught immediately instead of waiting for the next sweep.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { recordAudit } = require("../auditLogs/auditLogs.util");
const { createNotification } = require("../../services/notification/notification.service");

const BOOKING_STATUS = {
  TO_PAY:    "to pay",
  UPCOMING:  "upcoming",
  ONGOING:   "ongoing",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const TO_PAY_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

const toDate = (val) => {
  if (!val) return null;
  const d = val.toDate ? val.toDate() : new Date(val);
  return isNaN(d.getTime()) ? null : d;
};

// Has the booking's own start date/time already passed?
const hasSchedulePassed = (startDateTime) => {
  const start = toDate(startDateTime);
  if (!start) return false; // nothing to compare against — don't block on missing data
  return start.getTime() <= Date.now();
};

// Has this "to pay" booking been sitting unpaid past the 12h window?
const isPastToPayWindow = (createdAt) => {
  const created = toDate(createdAt);
  if (!created) return false;
  return Date.now() - created.getTime() > TO_PAY_WINDOW_MS;
};

// Has the deposit (first/only payment) actually cleared?
const isDepositPaid = (payment) => !!payment && payment.status === "paid";

// Is this booking's payment fully settled? "Full" method needs just the one
// payment; "Partial" needs BOTH the deposit AND the balance paid.
const isFullyPaid = (payment) => {
  if (!payment) return false;
  const method = String(payment.methodOfPayment || "").toLowerCase();
  if (method === "full") return payment.status === "paid";
  return payment.status === "paid" && payment.balanceStatus === "paid";
};

// Returns a cancellation reason string if this "to pay" booking is no longer
// valid, or null if it's still fine to pay for / confirm. `payment` is
// optional but needed to correctly exempt a deposit-paid Partial booking
// from the 12h window (schedule-passed still applies either way).
const getStaleReason = (booking, payment = null) => {
  if (booking.status !== BOOKING_STATUS.TO_PAY) return null;
  if (hasSchedulePassed(booking.startDateTime)) {
    return "Auto-cancelled: the booking's scheduled date/time has passed.";
  }
  // A deposit already paid on a Partial booking is real money collected —
  // don't auto-cancel just because the balance is still outstanding. That
  // needs a human (admin/refund flow), not the 12h sweep silently
  // cancelling it out from under the customer.
  if (isDepositPaid(payment)) return null;
  if (isPastToPayWindow(booking.createdAt)) {
    return "Auto-cancelled: payment was not completed within 12 hours.";
  }
  return null;
};

// Cancels a single "to pay" booking (+ its payment + bookingSession docs),
// idempotent against races (re-reads the booking status right before
// writing, so a live request and the cron sweep can't double-cancel it).
const cancelStaleBooking = async (bookingID, reason) => {
  const now = new Date();

  const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  if (bookingSnap.empty) return false;

  const bookingDoc = bookingSnap.docs[0];
  const booking    = bookingDoc.data();

  // Re-check under the same status this function is meant to act on — if
  // something else (customer, admin, another sweep) already moved it out
  // of "to pay", there's nothing to do here.
  if (booking.status !== BOOKING_STATUS.TO_PAY) return false;

  await bookingDoc.ref.update({
    status:             BOOKING_STATUS.CANCELLED,
    cancellationReason: reason,
    updatedAt:          now,
  });

  // Mirror onto the payment doc — only touches fields that are still
  // "pending" (never overwrites an already-paid/failed deposit, and never
  // overwrites a paid/failed balance either).
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (!paymentSnap.empty) {
    const paymentDoc = paymentSnap.docs[0];
    const p = paymentDoc.data();
    const updates = { updatedAt: now };
    if (p.status === "pending") updates.status = "cancelled";
    if (p.balanceStatus === "pending") updates.balanceStatus = "cancelled";
    if (Object.keys(updates).length > 1) await paymentDoc.ref.update(updates);
  }

  // Mirror onto the bookingSession doc — same reasoning as cancelBooking()'s
  // own mirror step, so this doesn't leave a ghost "to pay" card in admin's
  // Car Tracking.
  try {
    const sessionSnap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
    if (!sessionSnap.empty) {
      await sessionSnap.docs[0].ref.update({ status: BOOKING_STATUS.CANCELLED, updatedAt: now });
    }
  } catch (err) {
    console.error(`cancelStaleBooking: failed to sync bookingSession for ${bookingID}:`, err.message);
  }

  // recordTransactionLog is intentionally NOT called here — its type/status
  // enums (Payment/Refund/Deposit/Discount, Success/Failed/Pending/etc.)
  // don't have a slot for "booking auto-cancelled with no money moved", and
  // cancelBooking() (the customer-initiated equivalent) doesn't log a
  // transaction for this either — recordAudit is the right trail for it.
  recordAudit({
    action: "update",
    description: `Booking ${bookingID} auto-cancelled. ${reason}`,
    userID: booking.userID || null,
  });

  // ── Notify the customer ──
  // A schedule-passed cancellation is the "Booking Date/Time Expired" case
  // specifically (the reservation is invalid because its own date passed,
  // not because anyone actively cancelled it) — everything else that
  // routes through this single choke-point (the 12h unpaid window, or an
  // immediately-failed deposit charge from the PayMongo webhook) reads as
  // a regular cancellation instead.
  if (booking.userID) {
    const isExpiry = /scheduled date\/time has passed/i.test(reason || "");
    await createNotification({
      type: isExpiry ? "booking_expired" : "booking_cancelled",
      userID: booking.userID,
      refID: bookingID,
      title: isExpiry ? "Booking Schedule Expired" : "Booking Cancelled",
      message: isExpiry
        ? "Your booking's scheduled date and time has passed without a completed payment, so this reservation is no longer valid."
        : reason,
    }).catch((err) => console.error(`cancelStaleBooking: failed to write notification for ${bookingID}:`, err.message));
  }

  return true;
};

// Call on any read/write path that's about to use a "to pay" booking
// (viewing "My Bookings", starting a PayMongo checkout, polling payment
// status). Cancels it in place if it's gone stale and returns the
// possibly-updated booking status; otherwise returns the original status.
const enforceToPayValidity = async (bookingID, booking) => {
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();
  const reason = getStaleReason(booking, payment);
  if (!reason) return booking.status;
  const cancelled = await cancelStaleBooking(bookingID, reason);
  return cancelled ? BOOKING_STATUS.CANCELLED : booking.status;
};

// Once a payment phase clears (webhook OR status-poll — whichever wins the
// race), check whether the booking is now FULLY paid and, if so, promote it
// from "to pay" to "upcoming". For a Partial booking, paying just the
// deposit correctly leaves it on "to pay" — the balance still needs to
// clear too (see isFullyPaid). No-ops if the booking already moved on
// (e.g. was cancelled in the meantime) rather than clobbering that.
const promoteBookingToUpcoming = async (bookingID) => {
  if (!bookingID) return;
  try {
    const [bookingSnap, paymentSnap] = await Promise.all([
      db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get(),
      db.collection("payments").where("bookingID", "==", bookingID).limit(1).get(),
    ]);
    if (bookingSnap.empty) return;
    const bookingDoc = bookingSnap.docs[0];
    if (bookingDoc.data().status !== BOOKING_STATUS.TO_PAY) return;

    const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();
    if (!isFullyPaid(payment)) return; // e.g. Partial deposit paid, balance still outstanding

    await bookingDoc.ref.update({ status: BOOKING_STATUS.UPCOMING, updatedAt: new Date() });
  } catch (err) {
    console.error(`promoteBookingToUpcoming: failed for ${bookingID}:`, err.message);
  }
};

module.exports = {
  BOOKING_STATUS,
  TO_PAY_WINDOW_MS,
  hasSchedulePassed,
  isPastToPayWindow,
  isDepositPaid,
  isFullyPaid,
  getStaleReason,
  cancelStaleBooking,
  enforceToPayValidity,
  promoteBookingToUpcoming,
};
