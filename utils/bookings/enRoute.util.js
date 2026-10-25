// ─────────────────────────────────────────────────────────────────────────────
// "On my way" state, read from the driver's assignment row.
//
// The admin app stamps `enRouteAt` on the booking's CURRENT driverAssignments row (status "assigned") when the
// driver taps "On my way". It is no longer stored on the booking, and enRouteDriverID / enRouteDriverFirstName are
// gone too: the driver is the row's driverID and the first name is read from userDetails here.
//
// Only an "assigned" row counts. A reassign clears enRouteAt on the row, and an unassigned or completed row is
// never read, so a stale "on my way" can't reach the customer.
// ─────────────────────────────────────────────────────────────────────────────
const { db } = require("../../config/firebaseConnection/firebase");

const bookingKeyOf = (docID, booking) => (booking && booking.bookingID) || docID;

const isChauffeur = (b) => String((b && b.modeOfDriving) || "").toLowerCase().includes("chauffeur");
const isUpcoming  = (b) => String((b && b.status) || "").toLowerCase() === "upcoming";

// The newest "assigned" row wins if older data ever left two.
const millis = (v) => {
  if (!v) return 0;
  if (v.toMillis) return v.toMillis();
  if (v._seconds !== undefined) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};
const newest = (a, b) => (!a || millis(b.assignedAt) >= millis(a.assignedAt) ? b : a);

/** { enRouteAt, driverID } for one booking; both null when no driver is en route. */
const getEnRouteInfo = async (docID, booking) => {
  const key = bookingKeyOf(docID, booking);
  if (!key) return { enRouteAt: null, driverID: null };
  const snap = await db.collection("driverAssignments")
    .where("bookingID", "==", key)
    .where("status", "==", "assigned")
    .get();
  let row = null;
  snap.docs.forEach((d) => { row = newest(row, d.data()); });
  return { enRouteAt: (row && row.enRouteAt) || null, driverID: (row && row.driverID) || null };
};

/**
 * Map<bookingKey, enRouteAt> for a list of booking docs ({ id, ...data }). Only chauffeur + upcoming bookings can
 * be en route, so only those are queried (one "in" query per 30). A failure just means "not en route": the list
 * must never break because of it.
 */
const getEnRouteMap = async (bookings) => {
  const map = new Map();
  const keys = [...new Set(
    (bookings || []).filter((b) => isChauffeur(b) && isUpcoming(b)).map((b) => bookingKeyOf(b.id, b)).filter(Boolean)
  )];
  const rows = new Map();
  try {
    for (let i = 0; i < keys.length; i += 30) {
      const snap = await db.collection("driverAssignments")
        .where("bookingID", "in", keys.slice(i, i + 30))
        .where("status", "==", "assigned")
        .get();
      snap.docs.forEach((d) => {
        const r = d.data();
        rows.set(r.bookingID, newest(rows.get(r.bookingID), r));
      });
    }
  } catch (e) {
    console.warn("getEnRouteMap failed:", e.message);
  }
  rows.forEach((r, key) => { if (r.enRouteAt) map.set(key, r.enRouteAt); });
  return map;
};

/** The driver's first name, or "". */
const getDriverFirstName = async (driverID) => {
  if (!driverID) return "";
  try {
    const d = await db.collection("userDetails").doc(driverID).get();
    return (d.exists && String(d.data().firstName || "").trim()) || "";
  } catch (e) {
    console.warn("getDriverFirstName failed:", e.message);
    return "";
  }
};

module.exports = { getEnRouteInfo, getEnRouteMap, getDriverFirstName, bookingKeyOf };