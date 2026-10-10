// Customer-side access to the cancellationRequests collection. Three kinds of row:
//  - a DIRECT cancellation (a booking cancelled outright): has cancelledBy. It carries no status / processedBy /
//    processedAt / rejectReason -- it is always a finished cancellation. The reason a booking was cancelled lives here.
//  - a customer REQUEST to end an ongoing trip (requestCancellation in bookings.controller.js): no cancelledBy,
//    status pending | approved | rejected.
//  - a REFUND row: has refundRequestID. Created pending together with the refund request and holding who / why
//    (userID, reason, notes); staff decide it through the refund, so it is not a trip-cancellation request.
// Older rows may still carry type / requestedAt; readers accept both.
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
    bookingID: bookingKey,
    userID,
    reason: reason || "",
    cancelledBy,
    createdAt: now,
  };
  if (batch) { batch.set(ref, data); return null; }
  return ref.set(data);
};

// The pending row that goes with a new refund request: who asked and why live here, not on the refund doc.
const createPendingRefundRow = (refundRequestID, { bookingID = null, userID = null, reason = "", notes = "", createdAt = new Date() } = {}, batch = null) => {
  const ref  = db.collection(COL).doc();
  const data = {
    cancellationRequestID: ref.id,
    refundRequestID,
    bookingID,
    userID,
    reason: reason || "",
    notes: notes || "",
    status: "pending",
    createdAt,
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
      if (!r.reason) return;
      const direct = !!r.cancelledBy;
      const approvedRequest = !r.cancelledBy && !r.refundRequestID && r.status === "approved";
      if (!direct && !approvedRequest) return;
      if (direct || !out[r.bookingID]) out[r.bookingID] = r.reason;
    });
  }
  return out;
};

// Refund docs no longer carry userID / reason / notes / the decision: they live on the booking's cancellation row.
// Fills those gaps (a field the refund doc still has wins, same as the admin backend). The decision is only taken
// from the row once the request is no longer Pending.
const attachRefundRowInfo = async (requests) => {
  const list = requests || [];
  const need = list.filter((r) => !r.userID || !r.reason || (r.status === "Rejected" && !r.rejectReason));
  if (!need.length) return list;
  const keys = [...new Set(need.map((r) => r.bookingID).filter(Boolean))];
  const rows = [];
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await db.collection(COL).where("bookingID", "in", keys.slice(i, i + 30)).get();
    snap.forEach((d) => rows.push(d.data()));
  }
  return list.map((req) => {
    const row = rows.find((r) => r.refundRequestID && r.refundRequestID === req.refundRequestID)
      || rows.find((r) => r.bookingID === req.bookingID && r.cancelledBy);
    if (!row) return req;
    const decided = req.status && req.status !== "Pending";
    return {
      ...req,
      userID: req.userID || row.userID || null,
      reason: req.reason || row.reason || "",
      notes:  req.notes  || row.notes  || "",
      ...(decided ? {
        processedBy:  req.processedBy  || row.processedBy  || null,
        processedAt:  req.processedAt  || row.processedAt  || null,
        rejectReason: req.rejectReason || row.rejectReason || null,
      } : {}),
    };
  });
};

module.exports = { recordDirectCancellation, createPendingRefundRow, getCancellationReasons, attachRefundRowInfo };