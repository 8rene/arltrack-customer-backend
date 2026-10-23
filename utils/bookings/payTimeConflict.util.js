// Last-line availability check, run right BEFORE a checkout is opened for a "to pay" booking.
//
// Two customers can create "to pay" bookings for the same car at the same moment (nothing stops
// that at creation time). Neither is a real booking until it is paid, so the conflict is settled
// here, before any money is taken:
//   • another customer's booking that is already Upcoming / Ongoing  -> this one is blocked
//   • another customer's booking that is still "to pay" but was created EARLIER (ties broken by
//     bookingID) -> this one is blocked; the earlier one is allowed to pay
//   • a "to pay" booking created LATER is ignored -- it is the one that will be blocked
// Uses the same 1-day turnaround buffer as createBooking. Read-only; never writes.
const { db } = require("../../config/firebaseConnection/firebase");
const { BOOKING_STATUS } = require("./bookingStatus.util");

const BUFFER_MS = 24 * 60 * 60 * 1000;

const toDate = (v) => {
  if (!v) return null;
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// true when `other` was created before `mine` (bookingID breaks an exact tie)
const createdBefore = (other, mine) => {
  const o = toDate(other.createdAt);
  const m = toDate(mine.createdAt);
  if (o && m && o.getTime() !== m.getTime()) return o < m;
  return String(other.bookingID) < String(mine.bookingID);
};

/**
 * @param {object} booking  the booking being paid (needs bookingID, carID, startDateTime, endDateTime, createdAt)
 * @returns {Promise<{ conflict: boolean, reason?: string }>}
 */
const checkPayTimeConflict = async (booking) => {
  const start = toDate(booking.startDateTime);
  const end = toDate(booking.endDateTime);
  if (!booking.carID || !start || !end) return { conflict: false }; // malformed -> rejected elsewhere

  let snap;
  try {
    snap = await db.collection("bookings")
      .where("carID", "==", booking.carID)
      .where("endDateTime", ">", new Date(start.getTime() - BUFFER_MS))
      .get();
  } catch (e) {
    // composite index (carID + endDateTime) missing -> fall back to the car's full list
    snap = await db.collection("bookings").where("carID", "==", booking.carID).get();
  }

  const blocker = snap.docs.map((d) => d.data()).find((b) => {
    if (b.bookingID === booking.bookingID) return false;
    if (b.userID === booking.userID) return false; // same customer is handled at creation time
    const bStart = toDate(b.startDateTime);
    const bEnd = toDate(b.endDateTime);
    if (!bStart || !bEnd) return false;

    const isLive = b.status === BOOKING_STATUS.UPCOMING || b.status === BOOKING_STATUS.ONGOING;
    const isEarlierUnpaid = b.status === BOOKING_STATUS.TO_PAY && createdBefore(b, booking);
    if (!isLive && !isEarlierUnpaid) return false;

    return new Date(bStart.getTime() - BUFFER_MS) < end && new Date(bEnd.getTime() + BUFFER_MS) > start;
  });

  return blocker
    ? { conflict: true, reason: "This car was just booked by another customer for these dates. Please choose another date or vehicle." }
    : { conflict: false };
};

module.exports = { checkPayTimeConflict };