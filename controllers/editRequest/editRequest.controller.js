const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Every field a customer is allowed to request an edit for, and where its
// current value + label come from. Mirrors the ReadOnlyField entries on
// the customer ProfilePage, and matches the admin's own EDITABLE_FIELDS /
// EditProfileModal pattern (Account.jsx) so a single "editRequests"
// collection + review UI (Users.jsx > Edit Request tab) works for both
// staff and customers without any changes on the admin side.
const FIELD_CONFIG = {
  email:          { label: "Email",             collection: "user" },
  phone:          { label: "Phone",              collection: "user" },
  birthDate:      { label: "Birth Date",         collection: "userDetails" },
  province:       { label: "Province",           collection: "userAddress" },
  municipality:   { label: "Municipality",       collection: "userAddress" },
  barangay:       { label: "Barangay",           collection: "userAddress" },
  documentType:   { label: "Document Type",      collection: "userDocument" },
  documentNumber: { label: "Document Number",    collection: "userDocument" },
};

const getCurrentValue = async (userID, field, collection) => {
  if (collection === "user") {
    const doc = await db.collection("user").doc(userID).get();
    return doc.exists ? (doc.data()[field] || "") : "";
  }
  if (collection === "userDetails") {
    const doc = await db.collection("userDetails").doc(userID).get();
    return doc.exists ? (doc.data()[field] || "") : "";
  }
  if (collection === "userAddress") {
    const snap = await db.collection("userAddress").where("userID", "==", userID).get();
    const primary = snap.docs.find(d => d.data().isDefault) || snap.docs[0];
    return primary ? (primary.data()[field] || "") : "";
  }
  if (collection === "userDocument") {
    const snap = await db.collection("userDocument").where("userID", "==", userID).get();
    const primary = snap.docs[0];
    return primary ? (primary.data()[field] || "") : "";
  }
  return "";
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/edit-requests
// body: { changes: [{ field, requestedValue }], reason? }
// Bundles every submitted field change into ONE editRequests doc — matches
// the admin's own EditProfileModal ("every field goes in, not just the
// changed ones" so review is a plain old-vs-requested comparison).
// ─────────────────────────────────────────────────────────────────────────────
const requestEdit = async (req, res) => {
  const userID = req.user.userID;
  const { changes, reason } = req.body;

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ message: "No changes submitted." });
  }

  try {
    // Only one active bundle at a time — matches the admin/staff flow
    // ("You already have a pending edit request. Cancel it below...").
    const existingSnap = await db.collection("editRequests")
      .where("userID", "==", userID)
      .where("status", "==", "pending")
      .limit(1)
      .get();
    if (!existingSnap.empty) {
      return res.status(409).json({ message: "You already have a pending edit request. Cancel it first to submit different changes." });
    }

    const builtChanges = [];
    for (const c of changes) {
      const config = FIELD_CONFIG[c.field];
      if (!config) continue; // silently skip unknown/disallowed fields
      const requestedValue = String(c.requestedValue ?? "").trim();
      if (!requestedValue) continue;

      const oldValue = await getCurrentValue(userID, c.field, config.collection);
      builtChanges.push({
        field: c.field,
        label: config.label,
        collection: config.collection,
        oldValue,
        newValue: requestedValue,
      });
    }

    if (builtChanges.length === 0) {
      return res.status(400).json({ message: "No valid changes to submit." });
    }

    const ref = db.collection("editRequests").doc();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const editRequest = {
      userID,
      role: "Customer",
      status: "pending",
      changes: builtChanges,
      reason: reason || "",
      requestedBy: userID,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    };

    await ref.set(editRequest);

    return res.status(201).json({
      message: "Edit request sent. We'll notify you once it's reviewed.",
      editRequestID: ref.id,
    });
  } catch (error) {
    console.error("requestEdit error:", error.message);
    return res.status(500).json({ message: "Failed to submit edit request." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/edit-requests/mine
// ─────────────────────────────────────────────────────────────────────────────
const getMyEditRequests = async (req, res) => {
  const userID = req.user.userID;
  try {
    const snap = await db.collection("editRequests").where("userID", "==", userID).get();
    const requests = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return bT - aT;
      });
    return res.status(200).json({ data: requests });
  } catch (error) {
    console.error("getMyEditRequests error:", error.message);
    return res.status(500).json({ message: "Failed to fetch edit requests." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/user/edit-requests/:id/cancel
// Customer cancels their own still-pending bundle — matches the admin's
// handleCancelRequest (just flips status, never touches actual data).
// ─────────────────────────────────────────────────────────────────────────────
const cancelEditRequest = async (req, res) => {
  const userID = req.user.userID;
  const { id } = req.params;
  try {
    const ref = db.collection("editRequests").doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userID !== userID) {
      return res.status(404).json({ message: "Request not found." });
    }
    if (snap.data().status !== "pending") {
      return res.status(409).json({ message: `Request is already ${snap.data().status}.` });
    }
    await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(200).json({ message: "Request cancelled." });
  } catch (error) {
    console.error("cancelEditRequest error:", error.message);
    return res.status(500).json({ message: "Failed to cancel request." });
  }
};

module.exports = { requestEdit, getMyEditRequests, cancelEditRequest, FIELD_CONFIG };
