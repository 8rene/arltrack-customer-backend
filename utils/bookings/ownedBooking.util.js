// Shared helpers for the customer-side handover + inspection endpoints.
const { db } = require("../../config/firebaseConnection/firebase");
const { resolvePickupAt } = require("../payments/paymentBreakdown.util");

const toDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const toISO  = (v) => { const d = toDate(v); return d && !isNaN(d.getTime()) ? d.toISOString() : null; };

// The booking, but ONLY if it belongs to this user. A missing booking and someone else's
// booking look identical (null), so ids can't be probed. The doc id IS the bookingID.
const loadOwnedBooking = async (userID, bookingID) => {
  if (!userID || !bookingID) return null;
  const doc = await db.collection("bookings").doc(String(bookingID)).get();
  if (!doc.exists) return null;
  const booking = doc.data();
  // storedBookingID = the bookingID field as saved in the document (normally the same as the doc id; the admin app
  // may have filed older records under either, so the inspection lookup tries both).
  return booking.userID === userID ? { ...booking, bookingID: doc.id, storedBookingID: booking.bookingID || null } : null;
};

// The REAL pickup/return instants. Newer bookings store the exact pickup (`pickupAt`); older
// ones only have startDateTime/endDateTime that were parsed without a timezone (8 hours off on
// a UTC server) — resolvePickupAt() corrects for that, and the length of the rental is kept from
// the stored pair so both conventions give the right window.
const realWindow = (booking) => {
  const start = resolvePickupAt(booking);
  if (!start) return null;
  const s = toDate(booking.startDateTime), e = toDate(booking.endDateTime);
  const span = s && e ? Math.max(0, e.getTime() - s.getTime()) : 0;
  return { start, end: new Date(start.getTime() + span) };
};

module.exports = { loadOwnedBooking, realWindow, toDate, toISO };
