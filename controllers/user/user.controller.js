const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");

// Same role IDs as editRequest.controller.js/signup.controller.js's
// STAFF_NOTIFY_ROLE_IDS — kept as a local literal here too since each
// controller file in this app defines it independently (no shared
// constants module across controllers currently).
const STAFF_NOTIFY_ROLE_IDS = [
  "1BX4V7M43t6barbPd4BP", // Owner
  "5bhRYMrDkjrs9VlFFY4u", // Admin
  "fFA8G2R2ANLbVsH00jlv", // Supervisor
];

// ─────────────────────────────────────────────────────────────
// GET /api/user/details/:userID
// ─────────────────────────────────────────────────────────────
const getUserDetails = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  try {
    const [userDoc, detailsDoc] = await Promise.all([
      db.collection("user").doc(userID).get(),
      db.collection("userDetails").doc(userID).get(),
    ]);
    if (!userDoc.exists) return res.status(404).json({ message: "User not found." });
    const user    = userDoc.data();
    const details = detailsDoc.exists ? detailsDoc.data() : {};
    return res.status(200).json({
      userID,
      email:        user.email        || "",
      phone:        user.phone        || "",
      username:     user.username     || "",
      profileImage: user.profileImage || "",
      roleID:       user.roleID       || "",
      isVerified:   user.isVerified   || false,
      firstName:    details.firstName  || "",
      lastName:     details.lastName   || "",
      middleName:   details.middleName || "",
      suffix:       details.suffix     || "",
      birthDate:    details.birthDate  || "",
    });
  } catch (error) {
    console.error("getUserDetails error:", error);
    return res.status(500).json({ message: "Failed to fetch user details." });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/user/details/:userID
// ─────────────────────────────────────────────────────────────
const updateUserDetails = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  const { firstName, lastName, middleName, suffix, birthDate } = req.body;

  // suffix is optional (can be empty string to clear it) — not included in required check
  const hasAtLeastOneField = firstName || lastName || middleName || birthDate || suffix !== undefined;
  if (!hasAtLeastOneField)
    return res.status(400).json({ message: "At least one field is required to update." });

  try {
    // Build update object with only the fields present in the request
    const updates = { updatedAt: new Date() };
    if (firstName  !== undefined) updates.firstName  = firstName;
    if (lastName   !== undefined) updates.lastName   = lastName;
    if (middleName !== undefined) updates.middleName = middleName;
    if (birthDate  !== undefined) updates.birthDate  = birthDate;
    if (suffix     !== undefined) updates.suffix     = suffix; // allow "" to clear suffix

    await db.collection("userDetails").doc(userID).set(updates, { merge: true });
    return res.status(200).json({ message: "User details updated." });
  } catch (error) {
    console.error("updateUserDetails error:", error);
    return res.status(500).json({ message: "Failed to update user details." });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/user/profile/:userID — full profile (queries by userID field)
// ─────────────────────────────────────────────────────────────
const getFullProfile = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  try {
    // Fetch user, userDetails (stored by userID as doc id)
    const [userDoc, detailsDoc] = await Promise.all([
      db.collection("user").doc(userID).get(),
      db.collection("userDetails").doc(userID).get(),
    ]);

    if (!userDoc.exists) return res.status(404).json({ message: "User not found." });

    // Query userAddress and userDocument collections by userID field
    const [addressSnap, documentSnap] = await Promise.all([
      db.collection("userAddress").where("userID", "==", userID).get(),
      db.collection("userDocument").where("userID", "==", userID).get(),
    ]);

    const user    = userDoc.data();
    const details = detailsDoc.exists ? detailsDoc.data() : {};

    // Map all addresses
    const addresses = addressSnap.docs.map(doc => ({
      userAddressID: doc.id,
      ...doc.data(),
    }));

    // Map all documents
    const documents = documentSnap.docs.map(doc => ({
      userDocumentID: doc.id,
      ...doc.data(),
    }));

    // Primary address = isDefault true, or first one
    const primaryAddress = addresses.find(a => a.isDefault) || addresses[0] || {};

    // Primary document = first one (usually only one)
    const primaryDocument = documents[0] || {};

    return res.status(200).json({
      // user
      userID,
      email:             user.email             || "",
      phone:             user.phone             || "",
      username:          user.username          || "",
      profileImage:      user.profileImage      || "",
      roleID:            user.roleID            || "",
      isVerified:        user.isVerified        || false,
      status:            user.status            || "",
      // userDetails
      firstName:         details.firstName      || "",
      lastName:          details.lastName       || "",
      middleName:        details.middleName     || "",
      suffix:            details.suffix         || "",
      birthDate:         details.birthDate      || "",
      // primary address (flat — for profile page display)
      userAddressID:     primaryAddress.userAddressID || "",
      region:            primaryAddress.region        || "",
      province:          primaryAddress.province      || "",
      city:              primaryAddress.city          || "",
      municipality:      primaryAddress.municipality  || "",
      barangay:          primaryAddress.barangay      || "",
      street:            primaryAddress.street        || "",
      postalCode:        primaryAddress.postalCode    || "",
      zipCode:           primaryAddress.zipCode       || "",
      village:           primaryAddress.village       || "",
      isDefault:         primaryAddress.isDefault     || false,
      // all addresses array
      addresses,
      // primary document (flat) — isVerified lives on user collection, not userDocument
      userDocumentID:    primaryDocument.userDocumentID   || "",
      documentType:      primaryDocument.documentType     || "",
      documentNumber:    primaryDocument.documentNumber   || "",
      documentImageUrl:  primaryDocument.documentImageUrl || "",
      driverLicenseUrl:  primaryDocument.driverLicenseUrl || "",
      selfieWithIdUrl:   primaryDocument.selfieWithIdUrl  || "",
      documentVerified:  user.isVerified                  || false, // sourced from user collection
      // all documents array
      documents,
    });
  } catch (error) {
    console.error("getFullProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch profile." });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/user/profile/:userID — per-field update
// Accepts any subset of fields; updates the right collection
// ─────────────────────────────────────────────────────────────
const updateFullProfile = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  const {
    // user
    phone, username, profileImage,
    // userDetails
    firstName, lastName, middleName, suffix, birthDate,
    // userAddress (include userAddressID to update specific doc)
    userAddressID,
    province, city, municipality, barangay, street, postalCode, village,
  } = req.body;

  try {
    const now   = new Date();
    const batch = db.batch();

    // — user fields —
    const userFields = {};
    if (phone           !== undefined) userFields.phone           = phone;
    if (username        !== undefined) userFields.username        = username;
    if (profileImage !== undefined) userFields.profileImage = profileImage;
    if (Object.keys(userFields).length) {
      userFields.updatedAt = now;
      batch.set(db.collection("user").doc(userID), userFields, { merge: true });
    }

    // — userDetails fields —
    const detailFields = {};
    if (firstName  !== undefined) detailFields.firstName  = firstName;
    if (lastName   !== undefined) detailFields.lastName   = lastName;
    if (middleName !== undefined) detailFields.middleName = middleName;
    if (suffix     !== undefined) detailFields.suffix     = suffix;
    if (birthDate  !== undefined) detailFields.birthDate  = birthDate;
    if (Object.keys(detailFields).length) {
      detailFields.userID    = userID;
      detailFields.updatedAt = now;
      batch.set(db.collection("userDetails").doc(userID), detailFields, { merge: true });
    }

    // — userAddress fields —
    const addrFields = {};
    if (province     !== undefined) addrFields.province     = province;
    if (city         !== undefined) addrFields.city         = city;
    if (municipality !== undefined) addrFields.municipality = municipality;
    if (barangay     !== undefined) addrFields.barangay     = barangay;
    if (street       !== undefined) addrFields.street       = street;
    if (postalCode   !== undefined) { addrFields.postalCode = postalCode; addrFields.zipCode = postalCode; }
    if (village      !== undefined) addrFields.village      = village;

    if (Object.keys(addrFields).length) {
      addrFields.userID    = userID;
      addrFields.updatedAt = now;
      // Update the specific address doc if ID given, else query for user's address
      if (userAddressID) {
        batch.set(db.collection("userAddress").doc(userAddressID), addrFields, { merge: true });
      } else {
        // Try to find existing address doc for user
        const existingSnap = await db.collection("userAddress").where("userID", "==", userID).limit(1).get();
        if (!existingSnap.empty) {
          batch.set(existingSnap.docs[0].ref, addrFields, { merge: true });
        } else {
          // Create new address doc
          addrFields.isDefault = true;
          addrFields.createdAt = now;
          batch.set(db.collection("userAddress").doc(), addrFields);
        }
      }
    }

    await batch.commit();
    return res.status(200).json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error("updateFullProfile error:", error);
    return res.status(500).json({ message: "Failed to update profile." });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/user/profile/:userID/avatar — upload profile photo URL
// (Expects { profileImage } in body after client uploads to storage)
// ─────────────────────────────────────────────────────────────
const updateAvatar = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  const { profileImage } = req.body;
  if (!profileImage)
    return res.status(400).json({ message: "profileImage is required." });
  try {
    await db.collection("user").doc(userID).set(
      { profileImage, updatedAt: new Date() },
      { merge: true }
    );
    return res.status(200).json({ message: "Avatar updated.", profileImage });
  } catch (error) {
    console.error("updateAvatar error:", error);
    return res.status(500).json({ message: "Failed to update avatar." });
  }
};

module.exports = { getUserDetails, updateUserDetails, getFullProfile, updateFullProfile, updateAvatar, submitIdResubmitRequest };

// ─────────────────────────────────────────────────────────────
// POST /api/user/id-resubmit-requests
// Body: { documentKind, currentUrl, newUrl, documentType?, documentNumber? }
// documentKind: "license" | "document". newUrl is the downloadURL from a
// Storage upload the frontend already did (same pattern as updateAvatar
// above) — this endpoint only writes the Firestore doc.
//
// Writes into the SAME idResubmitRequests collection admin-backend's
// profileRequests.service.js already reads/approves for staff — nothing
// new on the admin review side is needed; a customer's request shows up
// in the same Edit Requests tab automatically, same shape, same
// approve/reject flow (including the required-expiry-on-approve rule
// for license). role is hardcoded to "Customer" since this app only
// ever acts on customer accounts (same reasoning as
// editRequest.controller.js's createEditRequest).
//
// documentType/documentNumber only apply when documentKind === "document"
// — typed here at submission by the customer, same as the original
// signup flow captured them, then carried straight through to
// userDocument on admin approval.
// ─────────────────────────────────────────────────────────────
async function submitIdResubmitRequest(req, res) {
  const userID = req.user.userID;
  const { documentKind, currentUrl, newUrl, documentType, documentNumber } = req.body || {};

  if (!["license", "document"].includes(documentKind)) {
    return res.status(400).json({ message: "documentKind must be 'license' or 'document'." });
  }
  if (!newUrl) {
    return res.status(400).json({ message: "newUrl is required." });
  }
  if (documentKind === "document" && (!documentType || !documentNumber)) {
    return res.status(400).json({ message: "documentType and documentNumber are required for a document resubmission." });
  }

  try {
    const urlFields = documentKind === "license"
      ? { currentLicenseUrl: currentUrl || "", newLicenseUrl: newUrl }
      : {
          currentDocumentUrl: currentUrl || "",
          newDocumentUrl: newUrl,
          documentType: documentType.trim(),
          documentNumber: documentNumber.trim(),
        };

    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = await db.collection("idResubmitRequests").add({
      userID,
      role: "Customer",
      documentKind,
      ...urlFields,
      status: "pending",
      requestedBy: userID,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    });

    const kindLabel = documentKind === "license" ? "driver's license" : "document";
    recordAudit({
      action: "update",
      description: `Submitted a ${kindLabel} resubmission for review.`,
      userID,
    });

    // Notify every Owner/Admin/Supervisor — same fan-out pattern as
    // createEditRequest above. This request type had no notification at
    // all before; staff could only find it by manually checking the
    // Edit Requests tab.
    try {
      const staffSnap = await db.collection("user")
        .where("roleID", "in", STAFF_NOTIFY_ROLE_IDS)
        .get();

      const notifBatch = db.batch();
      staffSnap.forEach((staffDoc) => {
        const notifRef = db.collection("notifications").doc();
        notifBatch.set(notifRef, {
          type: "id_resubmit_request",
          userID: staffDoc.id,
          refID: ref.id,
          refCollection: "idResubmitRequests",
          title: "ID resubmission submitted",
          message: `A customer submitted a ${kindLabel} resubmission for review.`,
          isRead: false,
          status: "active",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          resolvedAt: null,
        });
      });
      await notifBatch.commit();
    } catch (notifErr) {
      // The resubmission itself already succeeded — don't fail the
      // request over the notification fan-out.
      console.error("[submitIdResubmitRequest] Failed to write notifications:", notifErr.message);
    }

    return res.status(201).json({ message: "Resubmission sent for review.", id: ref.id });
  } catch (error) {
    console.error("submitIdResubmitRequest error:", error);
    return res.status(500).json({ message: "Failed to submit resubmission." });
  }
}