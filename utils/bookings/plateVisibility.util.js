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
 * @param {object} booking   needs { status, startDateTime }; for a chauffeur booking also { modeOfDriving, enRouteAt } (enRouteAt from enRoute.util)
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

  // With a chauffeur the DRIVER decides: the plate stays hidden while the booking is upcoming and shows once the driver taps
  // "On my way". `enRouteAt` is NOT on the booking doc: it is stamped on the driver's assignment row, so the caller passes it in
  // as `{ ...booking, enRouteAt }` (see utils/bookings/enRoute.util.js). `plateWithDriver` lets the page say so. Ongoing / completed bookings fall through to the
  // normal rule below, so older chauffeur trips that never had "On my way" still show their plate in the history.
  const chauffeur = String((booking && booking.modeOfDriving) || "").toLowerCase().includes("chauffeur");
  if (chauffeur && status === "upcoming") {
    return booking.enRouteAt
      ? { plateNumber: plate, plateRevealsAt: null, plateWithDriver: false }
      : { plateNumber: "", plateRevealsAt: null, plateWithDriver: true };
  }

  const revealsAt = start.getTime() - PLATE_REVEAL_HOURS_BEFORE * 3600 * 1000;
  if (now >= revealsAt) return { plateNumber: plate, plateRevealsAt: null };
  return { plateNumber: "", plateRevealsAt: new Date(revealsAt).toISOString() };
};

module.exports = { plateForBooking, PLATE_REVEAL_HOURS_BEFORE };