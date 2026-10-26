// bookingSessions/{bookingSessionID} — own auto-generated primary key.
// bookingID is stored as a plain FK field only (still 1:1 with a booking,
// but lookups now go through a where("bookingID","==",...) query instead
// of a direct .doc(bookingID).get()).
//
// Fields set HERE at booking creation: status, pickupLocation, dropoffLocation,
// geofenceZones, codingWarnings, currentPosition, timestamps. The scheduled
// pickup/return dates are NOT copied here — they live on the booking.
// Fields added LATER by the admin backend (not present on a new doc):
// carID and startedAt (set at pickup by markSessionActive), droppedOffTime,
// archiveUrl and lastArchivedAt (set by the history flush), plus the live-tracking
// bookkeeping fields below. The customer backend never writes or reads these; they
// are documented in the admin's models/booking/bookingSession.model.js:
//   startedAtSource     only set by the admin's date-migration script
//   geofenceFlipCount   consecutive pings that disagree with the logged geofence state
//   lastPingReceivedAt  last time the server heard from the tracker (ISO string)
//   stolenAt            when the car was flagged stolen (a marker, not an end)
//   needsFinalFlush     true until the trip's final history file is saved
//   pointCount          GPS points in the flushed trail (may be absent)
// GPS pings are NOT stored on this doc — they go to Google Sheets (one tab per
// PHT date), matched back to this session by sessionId + carID + startedAt.
//
// GEOFENCE ZONES live ONLY on this doc (geofenceZones). The car doc keeps no zones
// of its own — there is no per-car default list any more. The session is the one
// place zones are stored and edited:
//   - created HERE at booking: [Pickup, <destination>, ...extra stops], one zone per
//     point that has coordinates. The booking is rejected without pickup coordinates,
//     so a new session always has at least the Pickup zone; a destination or extra
//     stop without lat/lng is simply skipped. (Older sessions may have none.)
//   - edited LATER by staff from the admin Car Tracking page, for an upcoming or an
//     active trip alike (the admin backend overwrites the whole list on each save),
//     and moved by the admin when a booking's destination changes.
//   - read by the live GPS check (admin) to raise a geofence alert when the car leaves
//     every zone, and returned to the customer by getBookingDetails.
// Zone shape: { label, lat, lng, radius } — radius in METERS (not km).
//
// NOTE: geofence radius below is a placeholder (500m) — the real fixed
// radius value hasn't been decided yet. Change GEOFENCE_RADIUS_METERS
// once that's picked. Staff can resize each zone per trip after creation.
const GEOFENCE_RADIUS_METERS = 500;

const createBookingSession = (bookingSessionID, bookingID, data = {}) => ({
  bookingSessionID, // primary key (Firestore doc ID) — own identity, not derived from the booking
  bookingID,        // foreign key only — links back to bookings/{bookingID}, never used as this doc's ID
  // upcoming | active | ended | cancelled | stolen — same field admin's
  // markSessionActive/Ended/Cancelled/Stolen write to. Standardized on
  // `status` (not `sessionStatus`) since that's the field admin-backend
  // actually queries/writes — a prior pass here renamed it the other way
  // by mistake, which silently broke the link between the two backends
  // again (customer wrote sessionStatus, admin only ever read status).
  status: data.status || "upcoming",
  pickupLocation:  data.pickupLocation  || null, // { address, lat, lng } — raw pin, not a geofence zone
  dropoffLocation: data.dropoffLocation || null, // { address, lat, lng }
  // [{ label, lat, lng, radius(m) }] — the ONLY place this trip's zones are kept (see header). Built at booking
  // by makeZone below; staff may add, remove or resize zones afterwards from the admin side.
  geofenceZones:   Array.isArray(data.geofenceZones) ? data.geofenceZones : [],
  geofenceAlerts:  [],
  codingAlerts:    [],
  // Number Coding restrictions found for the car's plate BEFORE the booking was
  // made — the list the customer was warned about. FLAT: one entry per matched rule,
  // no nested arrays.
  // This is a SNAPSHOT / backup: the city, digit, day and time window are copied in, so
  // the admin never looks anything up in codingRules to show it — it still reads
  // correctly after the rule is edited or deleted.
  // Written by the CUSTOMER backend (bookings.controller.js, buildCodingWarnings); the
  // admin only READS it. The customer is shown these warnings and continuing the booking
  // counts as accepting them, so no acknowledgement is stored here. Older sessions simply
  // lack it (read as []).
  // Only rules that fall on the days the booking actually covers are saved (a Wednesday-only booking
  // saves Wednesday rules only; Wed -> Mon saves Wed..Mon). Holidays are skipped.
  // Entry: { city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }
  //   ruleID only records WHICH rule matched (codingRules/{ruleID}) — it may no longer
  //   exist; never rely on it. dayOfWeek is 1-7 (Monday = 1).
  codingWarnings:  Array.isArray(data.codingWarnings) ? data.codingWarnings : [],
  currentPosition: null, // { lat, lng, date } — set on first ping, edge-checked after
  createdAt:       new Date(),
  updatedAt:       new Date(),
});

// Helper: build one geofenceZones entry { label, lat, lng, radius } from a raw {lat,lng} point.
// Returns null if the point is missing coords (caller should skip it).
const makeZone = (label, point) => {
  if (!point || typeof point.lat !== "number" || typeof point.lng !== "number") return null;
  return {
    label,
    lat:    point.lat,
    lng:    point.lng,
    radius: GEOFENCE_RADIUS_METERS,
  };
};

module.exports = createBookingSession;
module.exports.makeZone = makeZone;
module.exports.GEOFENCE_RADIUS_METERS = GEOFENCE_RADIUS_METERS;