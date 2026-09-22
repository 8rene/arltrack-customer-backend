// ─────────────────────────────────────────────────────────────────────────────
// Booking status lifecycle — SINGLE SOURCE OF TRUTH.
//
// bookings.status flow:
//   "to pay"    → set on createBooking(). The first payment (the deposit) hasn't
//                 cleared yet. Nothing has been paid.
//   "upcoming"  → set as soon as the DEPOSIT is paid (see isDepositPaid /
//                 promoteBookingToUpcoming). 50% for "Partial", 100% for "Full".
//   "ongoing" / "completed" → set elsewhere (admin side / trip lifecycle).
//   "cancelled" → set here (auto), by cancelBooking() (customer), by an approved
//                 refund, or by admin.
//
// Two payments on a Partial booking (fields live on the payments doc):
//   status         → the FIRST payment (the "deposit" phase).
//                    "pending"|"paid"|"failed"|"cancelled".
//   balanceStatus  → the SECOND payment, Partial only (the other 50%):
//                    "not_applicable" (Full) | "not_due" | "pending" | "paid" | "failed".
//                    OPTIONAL to pay online — the booking screen tells the customer
//                    the balance is settled at pickup, so a deposit-paid booking is
//                    already confirmed. Staff collect whatever is left at pickup
//                    (admin: collectRemainingBalance → balanceCollected: true).
//   currentPhase   → "deposit" | "balance" — which phase the shared
//                    paymongoSessionID/checkoutUrl currently belong to.
//
// A "to pay" booking (nothing paid) stops being valid when EITHER is true:
//   1. Its own startDateTime has already passed.
//   2. It has sat unpaid for more than TO_PAY_WINDOW_MS (12 hours).
//
// SAFETY: before cancelling either way, PayMongo is asked whether the customer
// actually paid (a missed webhook must never cancel a booking that was paid).
// If PayMongo says it was paid the payment is settled instead; if PayMongo can't
// be reached the cancellation is skipped and retried on the next run.
// See enforceToPayValidity below.
//
// The same check runs inline on every read/write path that touches a "to pay"
// booking (getUserBookings, createPaymentLink, getPaymentStatus) and in the cron
// backstop (jobs/cancelStaleBookings.job.js).
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
// valid, or null if it's still fine to pay for / confirm.
//
// A booking whose deposit is already paid is NEVER stale here: real money has
// been collected, so it must be promoted to "upcoming" (see
// enforceToPayValidity), not cancelled — even if its start time has passed.
const getStaleReason = (booking, payment = null) => {
  if (booking.status !== BOOKING_STATUS.TO_PAY) return null;
  if (isDepositPaid(payment)) return null;
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
    bookingID,
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
// status, the cron sweep). Returns the booking's status afterwards.
//
//   deposit already paid  → promote to "upcoming" (heals bookings created under
//                           the older rule where a Partial deposit left it on "to pay")
//   not stale             → unchanged
//   stale                 → ask PayMongo first:
//                             paid            → settle it (booking becomes "upcoming")
//                             couldn't verify → leave it, try again next run
//                             genuinely unpaid → cancel
const enforceToPayValidity = async (bookingID, booking) => {
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();

  if (isDepositPaid(payment)) {
    const r = await promoteBookingToUpcoming(bookingID);
    return r.bookingStatus || booking.status;
  }

  const reason = getStaleReason(booking, payment);

  // Ask PayMongo whenever an unpaid booking has a checkout session — not only
  // when it's stale. This is what self-heals a missed webhook the moment the
  // customer opens My Bookings, and it's the guard that stops a paid booking
  // from being auto-cancelled.
  const canVerify = !paymentSnap.empty
    && String(payment.status || "").toLowerCase() === "pending"
    && !!payment.paymongoSessionID;

  if (!reason && !canVerify) return booking.status;

  if (canVerify) {
    // Lazy require: settlePayment.util requires this file (for promote), so a
    // top-level require here would be circular.
    const { verifyAndSettlePayment } = require("../payments/settlePayment.util");
    const v = await verifyAndSettlePayment(paymentSnap.docs[0], { source: "stale-check" });
    if (v.settled || v.alreadyPaid) return v.bookingStatus || BOOKING_STATUS.UPCOMING; // it WAS paid
    if (!v.checked && reason) {
      console.warn(`enforceToPayValidity: couldn't verify payment for ${bookingID} with PayMongo — skipping auto-cancel this round.`);
      return booking.status; // fail safe: never cancel on uncertainty
    }
  }

  if (!reason) return booking.status;

  const cancelled = await cancelStaleBooking(bookingID, reason);
  return cancelled ? BOOKING_STATUS.CANCELLED : booking.status;
};

// Once the deposit clears (webhook OR status-poll — whichever wins the race),
// move the booking from "to pay" to "upcoming".
//
// Returns { promoted, bookingStatus }:
//   promoted       true only if THIS call flipped it (so callers send the
//                  "Booking Confirmed" / new-booking notifications exactly once)
//   bookingStatus  the booking's status afterwards — "cancelled" tells the
//                  caller a payment landed on an already-cancelled booking.
const promoteBookingToUpcoming = async (bookingID) => {
  const none = { promoted: false, bookingStatus: null };
  if (!bookingID) return none;
  try {
    const [bookingSnap, paymentSnap] = await Promise.all([
      db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get(),
      db.collection("payments").where("bookingID", "==", bookingID).limit(1).get(),
    ]);
    if (bookingSnap.empty) return none;
    const bookingDoc = bookingSnap.docs[0];
    const status     = bookingDoc.data().status;
    if (status !== BOOKING_STATUS.TO_PAY) return { promoted: false, bookingStatus: status };

    const payment = paymentSnap.empty ? null : paymentSnap.docs[0].data();
    if (!isDepositPaid(payment)) return { promoted: false, bookingStatus: status };

    await bookingDoc.ref.update({ status: BOOKING_STATUS.UPCOMING, updatedAt: new Date() });

    // Keep the bookingSession (admin Car Tracking card) in step.
    try {
      const sessionSnap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
      if (!sessionSnap.empty && sessionSnap.docs[0].data().status === BOOKING_STATUS.TO_PAY) {
        await sessionSnap.docs[0].ref.update({ status: BOOKING_STATUS.UPCOMING, updatedAt: new Date() });
      }
    } catch (e) { /* session mirror is best-effort */ }

    return { promoted: true, bookingStatus: BOOKING_STATUS.UPCOMING };
  } catch (err) {
    console.error(`promoteBookingToUpcoming: failed for ${bookingID}:`, err.message);
    return none;
  }
};

// Cancels a booking because its refund was approved/completed. Only touches a
// booking that hasn't started ("to pay" or "upcoming") — an ongoing/completed
// trip is never silently cancelled by a refund. Leaves the payment doc alone
// (the refund flow owns its status). Idempotent.
const cancelBookingAfterRefund = async (bookingID, reason = "Cancelled: refund approved.") => {
  if (!bookingID) return false;
  const now = new Date();
  const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) return false;
  const doc = snap.docs[0];
  const status = doc.data().status;
  if (![BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING].includes(status)) return false;

  await doc.ref.update({ status: BOOKING_STATUS.CANCELLED, cancellationReason: reason, updatedAt: now });
  try {
    const sessionSnap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
    if (!sessionSnap.empty) await sessionSnap.docs[0].ref.update({ status: BOOKING_STATUS.CANCELLED, updatedAt: now });
  } catch (e) {
    console.error(`cancelBookingAfterRefund: failed to sync bookingSession for ${bookingID}:`, e.message);
  }
  return true;
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
  cancelBookingAfterRefund,
};
