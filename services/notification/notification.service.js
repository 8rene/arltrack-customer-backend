const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");
const { ROLE_IDS } = require("../../utils/roles/role.util");

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
 * Fans a notification out to every Owner/Admin/Supervisor — ONE DOC PER PERSON,
 * each with that person's real userID.
 *
 * Why not a single shared doc: the admin app's bell only shows notifications
 * whose userID equals the signed-in staff member's own uid
 * (admin-frontend Header.jsx → where("userID", "==", user.uid)). A doc written
 * with no userID is never shown to anyone. This mirrors admin-backend's
 * notifyStaff() so both apps produce the same shape.
 *
 * Never throws — a notification failure must not fail the booking/refund
 * action that triggered it.
 */
const notifyStaff = async ({ type, refID, refCollection = "bookings", title, message }) => {
  try {
    const staffSnap = await db.collection("user")
      .where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN, ROLE_IDS.SUPERVISOR])
      .get();

    await Promise.all(
      staffSnap.docs.map((d) =>
        createNotification({ type, refID, refCollection, title, message, userID: d.id })
      )
    );
  } catch (err) {
    console.error(`[NOTIF] notifyStaff(${type}) failed:`, err.message);
  }
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

module.exports = { createNotification, notifyStaff, resolveNotification, deleteNotification };
