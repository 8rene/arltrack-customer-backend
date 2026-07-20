// bookingSessions/{bookingSessionID} — own auto-generated primary key.
// bookingID is stored as a plain FK field only (still 1:1 with a booking,
// but lookups now go through a where("bookingID","==",...) query instead
// of a direct .doc(bookingID).get()).
//
// NOTE: geofence radius below is a placeholder (500m) — the real fixed
// radius value hasn't been decided yet. Change GEOFENCE_RADIUS_METERS
// once that's picked.
const GEOFENCE_RADIUS_METERS = 500;

const createBookingSession = (bookingSessionID, bookingID, data = {}) => ({
  bookingSessionID, // primary key (Firestore doc ID) — own identity, not derived from the booking
  bookingID,        // foreign key only — links back to bookings/{bookingID}, never used as this doc's ID
  pickupLocation:  data.pickupLocation  || null, // { address, lat, lng } — raw pin, not a geofence zone
  dropoffLocation: data.dropoffLocation || null, // { address, lat, lng }
  geofenceZones:   Array.isArray(data.geofenceZones) ? data.geofenceZones : [],
  geofenceAlerts:  [],
  codingAlerts:    [],
  // Audit trail from the coding-rule check at booking time — see
  // bookings.controller.js for how this gets populated.
  codingCheck:     data.codingCheck || null,
  pickupTime:      data.pickupTime || null,
  returnTime:      data.returnTime || null,
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