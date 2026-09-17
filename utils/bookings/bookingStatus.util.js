// ─────────────────────────────────────────────────────────────────────────────
// Booking status lifecycle — SINGLE SOURCE OF TRUTH.
//
// bookings.status flow:
//   "to pay"    → set on createBooking(). Payment hasn't been confirmed yet.
//   "upcoming"  → set once PayMongo confirms the payment (webhook or poll).
//   "ongoing" / "completed" → set elsewhere (admin side / trip lifecycle).
//   "cancelled" → set here (auto) or by cancelBooking() (customer) / admin.
//
// A "to pay" booking stops being valid the moment EITHER of these is true:
//   1. It's been sitting unpaid for more than TO_PAY_WINDOW_MS (12 hours), or
//   2. Its own startDateTime has already passed — paying for a booking that
//      can no longer happen makes no sense regardless of the 12h window.
//
// Same pattern as utils/sessionLogs/sessionLogs.util.js's sweepExpiredSessions:
// a cron sweep (jobs/cancelStaleBookings.job.js) is the backstop, but the
// checks here are also called inline on the read/write paths that touch a
// "to pay" booking (getUserBookings, createPaymentLink, getPaymentStatus) so
// staleness is caught immediately instead of waiting for the next sweep.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { recordAudit } = require("../auditLogs/auditLogs.util");

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

// Returns a cancellation reason string if this "to pay" booking is no longer
// valid, or null if it's still fine to pay for / confirm.
const getStaleReason = (booking) => {
  if (booking.status !== BOOKING_STATUS.TO_PAY) return null;
  if (hasSchedulePassed(booking.startDateTime)) {
    return "Auto-cancelled: the booking's scheduled date/time has passed.";
  }
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

  // Mirror onto the payment doc (only if it's still pending — never
  // overwrite an already-paid/failed/refunded payment).
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (!paymentSnap.empty) {
    const paymentDoc = paymentSnap.docs[0];
    if (paymentDoc.data().status === "pending") {
      await paymentDoc.ref.update({ status: "cancelled", updatedAt: now });
    }
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

  return true;
};

// Call on any read/write path that's about to use a "to pay" booking
// (viewing "My Bookings", starting a PayMongo checkout, polling payment
// status). Cancels it in place if it's gone stale and returns the
// possibly-updated booking status; otherwise returns the original status.
const enforceToPayValidity = async (bookingID, booking) => {
  const reason = getStaleReason(booking);
  if (!reason) return booking.status;
  const cancelled = await cancelStaleBooking(bookingID, reason);
  return cancelled ? BOOKING_STATUS.CANCELLED : booking.status;
};

// Once PayMongo confirms payment (webhook OR status-poll — whichever wins
// the race), promote the booking from "to pay" to "upcoming". No-ops if the
// booking already moved on (e.g. was cancelled in the meantime by the 12h
// sweep) rather than clobbering that with "upcoming".
const promoteBookingToUpcoming = async (bookingID) => {
  if (!bookingID) return;
  try {
    const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (snap.empty) return;
    const doc = snap.docs[0];
    if (doc.data().status !== BOOKING_STATUS.TO_PAY) return;
    await doc.ref.update({ status: BOOKING_STATUS.UPCOMING, updatedAt: new Date() });
  } catch (err) {
    console.error(`promoteBookingToUpcoming: failed for ${bookingID}:`, err.message);
  }
};

module.exports = {
  BOOKING_STATUS,
  TO_PAY_WINDOW_MS,
  hasSchedulePassed,
  isPastToPayWindow,
  getStaleReason,
  cancelStaleBooking,
  enforceToPayValidity,
  promoteBookingToUpcoming,
};
