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
// archiveUrl and lastArchivedAt (set by the history flush).
// GPS pings are NOT stored on this doc — they go to Google Sheets (one tab per
// PHT date), matched back to this session by sessionId + carID + startedAt.
//
// NOTE: geofence radius below is a placeholder (500m) — the real fixed
// radius value hasn't been decided yet. Change GEOFENCE_RADIUS_METERS
// once that's picked.
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
  // Entry: { city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }
  //   ruleID only records WHICH rule matched (codingRules/{ruleID}) — it may no longer
  //   exist; never rely on it. dayOfWeek is 1-7 (Monday = 1).
  codingWarnings:  Array.isArray(data.codingWarnings) ? data.codingWarnings : [],
  currentPosition: null, // { lat, lng, date } — set on first ping, edge-checked after
  createdAt:       new Date(),
  updatedAt:       new Date(),
});

// Helper: build a geofence_zones entry from a raw {lat,lng} point.
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