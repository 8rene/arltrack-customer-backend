// Chauffeur capacity -- "is there still a driver for this time window?"
//
// Why this is NOT based on driverAssignments: assigning a driver is a manual admin step that happens
// AFTER the booking. If the admin forgets, the assignment table says the driver is free and a second
// customer can take the same slot. So the question asked here is a headcount one:
//
//     eligible drivers  vs  the most chauffeur trips running at once in the requested window
//
// Every chauffeur booking counts (to pay / upcoming / ongoing), assigned or not. If the busiest moment
// in the window already has as many trips as there are eligible drivers, chauffeur is full.
//
// Buffer: a driver needs time to finish a drop-off, get to the next pickup and rest. Every trip is
// therefore treated as busy over [start, end + buffer). Two trips whose gap is shorter than the
// buffer overlap in that model, which also covers trips that merely touch (end == next start).
// The buffer comes from systemSettings.driverBufferMinutes (admin System Settings), default 120.
//
// The same buffer must be used by the admin dispatch check (admin-backend driverDispatch.service.js)
// so the customer-side check and the assignment check agree.

const { db } = require("../../config/firebaseConnection/firebase");
const { ROLE_IDS } = require("../roles/role.util");
const { getSystemSettings } = require("../pricing");
const { BOOKING_STATUS } = require("../bookings/bookingStatus.util");

const DEFAULT_BUFFER_MINUTES = 120; // 2 hours
const MINUTE_MS = 60 * 1000;
const CHAUFFEUR_MODE = "With Chauffeur";
const COUNTED_STATUSES = [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING];
const BLOCKED_DRIVER_STATUSES = new Set(["inactive", "locked"]); // same set the login check blocks

// Message shown to the customer and returned in the 409. States the period is full; it does not
// point at other dates, and it reveals no driver or booking details.
const NO_DRIVER_MESSAGE =
  "No drivers are available for the selected dates and times. Try a different schedule or choose self-drive.";

const asDate = (v) => {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Buffer in ms from systemSettings (cached 30 s by getSystemSettings). Falls back to 2 hours if the
// setting is missing or not a sensible number.
const getDriverBufferMs = async () => {
  const settings = await getSystemSettings();
  const mins = Number(settings.driverBufferMinutes);
  return (Number.isFinite(mins) && mins >= 0 ? mins : DEFAULT_BUFFER_MINUTES) * MINUTE_MS;
};

// Fixed doc every chauffeur booking reads + writes inside its transaction. Capacity is fleet-wide (not
// per car), so unlike carLocks/{carID} there is ONE lock: concurrent chauffeur bookings are serialised
// and the second sees the first. Self-drive bookings never touch it.
const driverCapacityLockRef = () => db.collection("driverLocks").doc("chauffeur");

// Drivers who could take a trip ending at `tripEnd`: role Driver, not inactive/locked, and a license
// that is still valid at the end of the trip. A driver with NO license date on file is counted (the
// admin assignment check also only warns when a license is actually expired).
const countEligibleDrivers = async (tripEnd) => {
  const end = asDate(tripEnd);
  if (!end) return 0;

  const driverSnap = await db.collection("user").where("roleID", "==", ROLE_IDS.DRIVER).get();
  const active = driverSnap.docs.filter((d) => !BLOCKED_DRIVER_STATUSES.has(String(d.data().status || "").toLowerCase()));
  if (!active.length) return 0;

  // A person can have several userDocument records (re-uploads): the LATEST expiry wins.
  const ids = active.map((d) => d.id);
  const expiry = new Map();
  for (let i = 0; i < ids.length; i += 30) { // Firestore "in" allows 30 values
    const snap = await db.collection("userDocument").where("userID", "in", ids.slice(i, i + 30)).get();
    snap.forEach((doc) => {
      const data = doc.data();
      const e = asDate(data.driverLicenseExpiry);
      if (!e) return;
      const prev = expiry.get(data.userID);
      if (!prev || e > prev) expiry.set(data.userID, e);
    });
  }
  return ids.filter((id) => !expiry.has(id) || expiry.get(id) >= end).length;
};

// Pure: the highest number of existing chauffeur trips that run at the same moment anywhere inside
// the requested window (all windows padded by the buffer). Exported for testing.
//   existing: [{ startDateTime, endDateTime, status }]
const computePeakOverlap = (existing, start, end, bufferMs, now = new Date()) => {
  const winStart = start.getTime();
  const winEnd = end.getTime() + bufferMs;

  const events = [];
  for (const b of existing) {
    const bStart = asDate(b.startDateTime);
    let bEnd = asDate(b.endDateTime);
    if (!bStart || !bEnd) continue;
    // A trip still out past its scheduled end keeps its driver busy until it actually comes back.
    if (b.status === BOOKING_STATUS.ONGOING && now > bEnd) bEnd = now;

    const s = bStart.getTime();
    const e = bEnd.getTime() + bufferMs;
    if (!(s < winEnd && e > winStart)) continue; // does not touch the requested window
    events.push([Math.max(s, winStart), 1], [Math.min(e, winEnd), -1]);
  }

  // Intervals are half-open: at the same instant, a trip ending frees its driver BEFORE the next starts.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
};

// Reads the chauffeur bookings that can count. Equality + "in" filters only, so Firestore's built-in
// indexes serve it (no composite index). With `tx` the read is part of the caller's transaction.
const readChauffeurBookings = async (tx = null) => {
  const q = db.collection("bookings")
    .where("modeOfDriving", "==", CHAUFFEUR_MODE)
    .where("status", "in", COUNTED_STATUSES);
  const snap = await (tx ? tx.get(q) : q.get());
  return snap.docs.map((d) => d.data());
};

/**
 * Is there room for one more chauffeur trip in [startDateTime, endDateTime]?
 *
 * Call it with `tx` inside the booking transaction (the authoritative check) and without for the
 * customer-facing availability message. Pass `eligibleDrivers` / `bufferMs` if already loaded so the
 * transaction callback (which Firestore may retry) does no extra work.
 *
 * Returns { available, capacity, peak }. `capacity` and `peak` are for server logs only; the public
 * endpoint must not return them.
 */
const checkChauffeurCapacity = async ({ startDateTime, endDateTime, tx = null, eligibleDrivers = null, bufferMs = null, now = new Date() }) => {
  const start = asDate(startDateTime);
  const end = asDate(endDateTime) || start;
  if (!start || !end) return { available: true, capacity: 0, peak: 0 }; // malformed dates are rejected elsewhere

  const [capacity, buffer] = await Promise.all([
    eligibleDrivers != null ? eligibleDrivers : countEligibleDrivers(end),
    bufferMs != null ? bufferMs : getDriverBufferMs(),
  ]);
  if (capacity <= 0) return { available: false, capacity: 0, peak: 0 };

  if (tx) await tx.get(driverCapacityLockRef()); // joins the lock into this transaction's read set
  const bookings = await readChauffeurBookings(tx);
  const peak = computePeakOverlap(bookings, start, end, buffer, now);
  return { available: peak < capacity, capacity, peak };
};

module.exports = {
  checkChauffeurCapacity,
  countEligibleDrivers,
  computePeakOverlap,
  getDriverBufferMs,
  driverCapacityLockRef,
  NO_DRIVER_MESSAGE,
  DEFAULT_BUFFER_MINUTES,
};