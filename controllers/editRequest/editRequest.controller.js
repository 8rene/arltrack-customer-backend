const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");

// Same role IDs as bookings.controller.js/paymongo.controller.js/
// signup.controller.js's STAFF_NOTIFY_ROLE_IDS — kept as a local literal
// here since this is a separate deployable app and can't import
// admin-backend's role.util.js directly.
const STAFF_NOTIFY_ROLE_IDS = [
  "1BX4V7M43t6barbPd4BP", // Owner
  "5bhRYMrDkjrs9VlFFY4u", // Admin
  "fFA8G2R2ANLbVsH00jlv", // Supervisor
];

// Human-readable labels + which Firestore collection each field actually
// lives in. Kept in the exact same shape the ADMIN frontend already reads
// (Users.jsx → EditRequestsTab → applyProfileChanges expects
// changes[].collection to be "user" | "userDetails" | "userAddress"),
// so requests submitted here show up and get approved there with zero
// changes needed on the admin side.
//
// NOTE: documentType/documentNumber are intentionally NOT included —
// admin's applyProfileChanges only buckets into user/userDetails/userAddress,
// so bundling a "userDocument" field would crash the admin's approve button.
const FIELD_META = {
  email:        { label: "Email",               collection: "user" },
  phone:        { label: "Phone",                collection: "user" },
  birthDate:    { label: "Birth Date",           collection: "userDetails" },
  province:     { label: "Province",             collection: "userAddress" },
  municipality: { label: "Municipality / City",  collection: "userAddress" },
  barangay:     { label: "Barangay",             collection: "userAddress" },
};

const toMillis = (t) => t?.toDate?.() ? t.toDate().getTime() : (t ? new Date(t).getTime() : 0);

// Snapshot the user's current values right now, from the same three
// collections — used both to fill in "oldValue" and to drop no-op changes.
const getCurrentValues = async (userID) => {
  const [userDoc, detailsSnap, addressSnap] = await Promise.all([
    db.collection("user").doc(userID).get(),
    db.collection("userDetails").where("userID", "==", userID).get(),
    db.collection("userAddress").where("userID", "==", userID).get(),
  ]);

  const user    = userDoc.exists ? userDoc.data() : {};
  const details = detailsSnap.docs[0]?.data() || {};
  const addresses = addressSnap.docs.map((d) => d.data());
  const primaryAddress = addresses.find((a) => a.isDefault) || addresses[0] || {};

  return {
    email:        user.email                || "",
    phone:        user.phone                || "",
    birthDate:    details.birthDate         || "",
    province:     primaryAddress.province     || "",
    municipality: primaryAddress.municipality || "",
    barangay:     primaryAddress.barangay     || "",
  };
};

// ─────────────────────────────────────────────────────────────
// POST /api/user/edit-requests
// body: { changes: [{ field, requestedValue }], reason }
// One pending bundle per user at a time — mirrors editRequests exactly
// as written by the admin app's own EditProfileModal (Account.jsx),
// just issued server-side (Admin SDK) since the customer app doesn't
// keep a live Firebase Auth session in the browser the way admin does.
// ─────────────────────────────────────────────────────────────
const createEditRequest = async (req, res) => {
  const userID = req.user.userID;
  const { changes, reason } = req.body;

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ message: "No changes were submitted." });
  }

  try {
    const existing = await db.collection("editRequests")
      .where("userID", "==", userID)
      .where("status", "==", "pending")
      .get();
    if (!existing.empty) {
      return res.status(409).json({ message: "You already have a pending edit request." });
    }

    const current = await getCurrentValues(userID);

    const cleanChanges = changes
      .filter((c) => c && FIELD_META[c.field])
      .map((c) => ({
        field:      c.field,
        label:      FIELD_META[c.field].label,
        collection: FIELD_META[c.field].collection,
        oldValue:   current[c.field] || "",
        newValue:   (c.requestedValue || "").trim(),
      }))
      .filter((c) => c.newValue !== c.oldValue);

    if (cleanChanges.length === 0) {
      return res.status(400).json({ message: "No valid changes were submitted." });
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const docRef = await db.collection("editRequests").add({
      userID,
      role:        "Customer",
      status:      "pending",
      changes:     cleanChanges,
      reason:      (reason || "").trim(),
      requestedBy: userID,
      reviewedBy:  null,
      reviewedAt:  null,
      reviewNote:  null,
      createdAt:   now,
      updatedAt:   now,
    });

    recordAudit({
      action: "create",
      description: `Edit request submitted by customer for: ${cleanChanges.map((c) => c.label).join(", ")}.`,
      userID,
    });

    // Notify every Owner/Admin/Supervisor — one doc per person, same
    // fan-out pattern as new_user/refund_request/cancellation_request.
    // This request type had no notification at all before; staff could
    // only find it by manually checking the Edit Requests tab.
    try {
      const staffSnap = await db.collection("user")
        .where("roleID", "in", STAFF_NOTIFY_ROLE_IDS)
        .get();

      const notifBatch = db.batch();
      staffSnap.forEach((staffDoc) => {
        const notifRef = db.collection("notifications").doc();
        notifBatch.set(notifRef, {
          type: "edit_request",
          userID: staffDoc.id,
          refID: docRef.id,
          refCollection: "editRequests",
          title: "Profile edit request",
          message: `A customer requested changes to: ${cleanChanges.map((c) => c.label).join(", ")}.`,
          isRead: false,
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          resolvedAt: null,
        });
      });
      await notifBatch.commit();
    } catch (notifErr) {
      // The edit request itself already succeeded — don't fail the
      // request over the notification fan-out.
      console.error("[editRequest] Failed to write notifications:", notifErr.message);
    }

    return res.status(201).json({
      message: "Edit request sent. An admin will review it shortly.",
      id: docRef.id,
    });
  } catch (error) {
    console.error("createEditRequest error:", error);
    return res.status(500).json({ message: "Failed to send edit request." });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/user/edit-requests/mine
// ─────────────────────────────────────────────────────────────
const getMyEditRequests = async (req, res) => {
  const userID = req.user.userID;

  try {
    const snap = await db.collection("editRequests")
      .where("userID", "==", userID)
      .get();

    const data = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

    return res.status(200).json({ data });
  } catch (error) {
    console.error("getMyEditRequests error:", error);
    return res.status(500).json({ message: "Failed to fetch edit requests." });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/user/edit-requests/:id/cancel
// ─────────────────────────────────────────────────────────────
const cancelEditRequest = async (req, res) => {
  const userID = req.user.userID;
  const { id }  = req.params;

  try {
    const ref = db.collection("editRequests").doc(id);
    const doc = await ref.get();

    if (!doc.exists)                     return res.status(404).json({ message: "Edit request not found." });
    if (doc.data().userID !== userID)    return res.status(403).json({ message: "Access denied." });
    if (doc.data().status !== "pending") return res.status(400).json({ message: "Only pending requests can be cancelled." });

    await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(200).json({ message: "Request cancelled." });
  } catch (error) {
    console.error("cancelEditRequest error:", error);
    return res.status(500).json({ message: "Failed to cancel edit request." });
  }
};

module.exports = { createEditRequest, getMyEditRequests, cancelEditRequest };