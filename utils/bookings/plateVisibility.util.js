// ─────────────────────────────────────────────────────────────────────────────
// When may a customer see the PLATE NUMBER of the car they booked?
//
//   • Only for their own booking, and only once it is paid (status upcoming,
//     ongoing or completed — never "to pay" or "cancelled").
//   • From PLATE_REVEAL_HOURS_BEFORE (2) hours before the start time — the same
//     moment the "Booking Reminder" notification goes out — through the whole trip
//     (ongoing) and afterwards (completed), so the booking history keeps showing
//     which car (plate) the customer rented.
//
// The plate is decided HERE, on the server, and left out of the response when it
// isn't allowed yet — hiding it only in the page would still leak it in the JSON.
// (The public /api/cars endpoint no longer returns plateNumber at all.)
// ─────────────────────────────────────────────────────────────────────────────

const PLATE_REVEAL_HOURS_BEFORE = 2; // same moment as the "Booking Reminder" notification (jobs/bookingNotifications.job.js)
const SHOWN_STATUSES = new Set(["upcoming", "ongoing", "completed"]);

const toDate = (val) => {
  if (!val) return null;
  const d = val.toDate ? val.toDate() : new Date(val._seconds !== undefined ? val._seconds * 1000 : val);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * @param {object} booking   needs { status, startDateTime }
 * @param {string} plateNumber  the car's plate (from the cars doc)
 * @returns {{ plateNumber: string, plateRevealsAt: string|null }}
 *   plateNumber is "" until allowed. plateRevealsAt (ISO) is set only for a paid
 *   upcoming booking whose reveal time hasn't come yet, so the page can say when.
 */
const plateForBooking = (booking, plateNumber, now = Date.now()) => {
  const plate = String(plateNumber || "").trim().toUpperCase();
  const status = String((booking && booking.status) || "").toLowerCase();
  const start = toDate(booking && booking.startDateTime);
  if (!plate || !start || !SHOWN_STATUSES.has(status)) return { plateNumber: "", plateRevealsAt: null };

  const revealsAt = start.getTime() - PLATE_REVEAL_HOURS_BEFORE * 3600 * 1000;
  if (now >= revealsAt) return { plateNumber: plate, plateRevealsAt: null };
  return { plateNumber: "", plateRevealsAt: new Date(revealsAt).toISOString() };
};

module.exports = { plateForBooking, PLATE_REVEAL_HOURS_BEFORE };
