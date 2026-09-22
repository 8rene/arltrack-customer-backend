// NOTE on schedule: vercel.json currently runs this ONCE A DAY ("0 17 * * *").
// (An older comment here said "hourly" — that never matched the config.) Vercel's
// free Hobby plan only executes cron jobs once a day regardless, so if the project
// is still on Hobby that's the most often this can run. That's not a correctness
// problem: the same check runs inline on every read/write that touches a "to pay"
// booking (getUserBookings, createPaymentLink, getPaymentStatus), so anything a
// customer looks at is handled immediately — this sweep is only the backstop for
// bookings nobody opens again.
const { db } = require("../config/firebaseConnection/firebase");
const { BOOKING_STATUS, enforceToPayValidity } = require("../utils/bookings/bookingStatus.util");

// For every "to pay" booking this runs the SAME logic as the inline checks
// (enforceToPayValidity), which — before cancelling anything — asks PayMongo
// whether the customer actually paid:
//   • paid            → the payment is settled and the booking becomes "upcoming"
//   • PayMongo down   → skipped this run, retried on the next
//   • genuinely unpaid → cancelled
// It used to call getStaleReason + cancelStaleBooking directly, which trusted
// Firestore alone and could cancel a booking whose payment was real but whose
// webhook had been missed.
const runCancelStaleBookings = async () => {
  const snap = await db.collection("bookings").where("status", "==", BOOKING_STATUS.TO_PAY).get();

  let cancelledCount = 0;
  let recoveredCount = 0; // paid after all — settled instead of cancelled
  let skippedCount   = 0; // couldn't verify with PayMongo — left alone

  for (const doc of snap.docs) {
    const booking = doc.data();
    try {
      const before = booking.status;
      const after  = await enforceToPayValidity(booking.bookingID, booking);
      if (after === BOOKING_STATUS.CANCELLED) cancelledCount++;
      else if (after === BOOKING_STATUS.UPCOMING && before === BOOKING_STATUS.TO_PAY) recoveredCount++;
      else if (after === BOOKING_STATUS.TO_PAY) skippedCount++;
    } catch (err) {
      console.error(`[CRON] cancel-stale-bookings: failed on ${booking.bookingID}:`, err.message);
    }
  }

  console.log(`[CRON] cancel-stale-bookings: checked ${snap.size} — cancelled ${cancelledCount}, recovered ${recoveredCount} (were actually paid), still to pay/skipped ${skippedCount}.`);
  return { checked: snap.size, cancelledCount, recoveredCount, skippedCount };
};

module.exports = { runCancelStaleBookings };
