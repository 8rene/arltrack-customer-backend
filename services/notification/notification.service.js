const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");

/**
 * Creates a booking-related notification for a single customer — mirrors
 * admin-backend's createNotification() (see its notification.service.js),
 * kept as a separate local copy rather than a shared import since these
 * are two independently deployed apps. Same dedup rule: if this exact
 * type+refID+userID already has an ACTIVE copy, don't write a second one
 * (e.g. a slow webhook retry, or the payment-status poll racing the
 * webhook, should never leave two "Payment Successful" cards in the bell).
 */
const createNotification = async ({ type, userID, refID, title, message, refCollection = "bookings" }) => {
  if (!userID || !type) return null;

  const existing = await db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("userID", "==", userID)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (!existing.empty) return existing.docs[0].id;

  const ref = await db.collection("notifications").add({
    type,
    refID: refID || null,
    refCollection,
    userID,
    title,
    message,
    isRead: false,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  });

  console.log(`[NOTIF] Created ${type} for booking ${refID} (userID: ${userID})`);
  return ref.id;
};

/**
 * Marks every ACTIVE notification for this type+refID+userID as resolved
 * — used so a stale card (e.g. "Payment Pending") disappears from the
 * bell the instant the thing it was about is no longer true, instead of
 * sitting there alongside the newer "Payment Successful" card.
 */
const resolveNotification = async (type, refID, userID) => {
  let query = db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("status", "==", "active");
  if (userID) query = query.where("userID", "==", userID);

  const snap = await query.get();
  if (snap.empty) return;

  const batch = db.batch();
  snap.forEach((doc) => {
    batch.update(doc.ref, {
      status: "resolved",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
};

/** Hard delete — used when the customer manually dismisses a notification (the "×" button). */
const deleteNotification = async (notifID) => {
  await db.collection("notifications").doc(notifID).delete();
};

module.exports = { createNotification, resolveNotification, deleteNotification };
