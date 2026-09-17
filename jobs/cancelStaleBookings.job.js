// NOTE on schedule: vercel.json runs this hourly ("0 * * * *"). Vercel's
// free Hobby plan only actually executes cron jobs once a day regardless of
// what's configured — if this project is still on Hobby, this sweep will
// only run once daily until it's upgraded. That's not a correctness problem
// though: the inline self-heal checks in getUserBookings/createPaymentLink
// (bookings.controller.js / paymongo.controller.js) already catch staleness
// in real time whenever a booking is actually touched — this sweep is only
// the backstop for bookings nobody looks at again.
const { db } = require("../config/firebaseConnection/firebase");
const { BOOKING_STATUS, getStaleReason, cancelStaleBooking } = require("../utils/bookings/bookingStatus.util");

// Backstop for the inline self-heal checks in getUserBookings/createPaymentLink
// (bookings.controller.js / paymongo.controller.js) — those only fire when
// someone actually touches a given "to pay" booking. This catches everyone
// else (a booking nobody opens again after creating it), so it doesn't sit
// as "to pay" forever just because nobody happened to trigger the inline
// check. Same relationship expireSessions.job.js has to its own lazy check.
const runCancelStaleBookings = async () => {
  const snap = await db.collection("bookings").where("status", "==", BOOKING_STATUS.TO_PAY).get();

  let cancelledCount = 0;
  for (const doc of snap.docs) {
    const booking = doc.data();
    const reason  = getStaleReason(booking);
    if (!reason) continue;
    const cancelled = await cancelStaleBooking(booking.bookingID, reason);
    if (cancelled) cancelledCount++;
  }

  console.log(`[CRON] cancel-stale-bookings: auto-cancelled ${cancelledCount} stale "to pay" booking(s).`);
  return { cancelledCount, checked: snap.size };
};

module.exports = { runCancelStaleBookings };
