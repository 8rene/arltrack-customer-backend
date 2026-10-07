// Customer-side access to the cancellationRequests collection for DIRECT
// cancellations (type "direct"): a booking cancelled outright, as opposed to a
// customer request to end an ongoing trip (type "request", created by
// requestCancellation in bookings.controller.js). The reason a booking was
// cancelled lives here, not on the booking document.
//
// Imports only db, so any util/controller can require it without a cycle.
const { db } = require("../../config/firebaseConnection/firebase");
const admin = require("firebase-admin");

const COL = "cancellationRequests";

// Writes the row. Pass a Firestore batch to commit it together with the booking update.
const recordDirectCancellation = (bookingKey, { userID = null, reason = "", cancelledBy = "unknown" } = {}, batch = null) => {
  if (!bookingKey) return null;
  const ref  = db.collection(COL).doc(String(bookingKey));
  const now  = admin.firestore.FieldValue.serverTimestamp();
  const data = {
    cancellationRequestID: ref.id,
    type: "direct",
    bookingID: bookingKey,
    userID,
    reason: reason || "",
    status: "approved",
    cancelledBy,
    requestedAt: now,
    processedBy: null,
    processedAt: now,
    rejectReason: null,
  };
  if (batch) { batch.set(ref, data); return null; }
  return ref.set(data);
};

// { [bookingKey]: reason } for the given bookings: the direct row's reason, else an
// approved request's reason. Bookings with neither are simply absent.
const getCancellationReasons = async (bookingKeys) => {
  const keys = [...new Set((bookingKeys || []).filter(Boolean))];
  const out = {};
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await db.collection(COL).where("bookingID", "in", keys.slice(i, i + 30)).get();
    snap.forEach((d) => {
      const r = d.data();
      if (r.status !== "approved" || !r.reason) return;
      if (r.type === "direct" || !out[r.bookingID]) out[r.bookingID] = r.reason;
    });
  }
  return out;
};

module.exports = { recordDirectCancellation, getCancellationReasons };