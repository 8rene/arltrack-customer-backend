const { db } = require("../../config/firebaseConnection/firebase");
const { getSelfDriveEligibility } = require("../../utils/user/selfDriveEligibility");
const admin  = require("firebase-admin");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");
const { generateUniqueReferralCode } = require("../../utils/referrals/referral.util");
const { listPendingCheckouts } = require("../../utils/payments/penaltyPayment.util");
const { getSystemSettings } = require("../../utils/pricing");
const { planOnlinePayment, heldDepositCoverByBooking, heldCreditByBooking } = require("../../utils/payments/penaltyPayment.util");

// Same role IDs as editRequest.controller.js/signup.controller.js's
// STAFF_NOTIFY_ROLE_IDS — kept as a local literal here too since each
// controller file in this app defines it independently (no shared
// constants module across controllers currently).
const STAFF_NOTIFY_ROLE_IDS = [
  "1BX4V7M43t6barbPd4BP", // Owner
  "5bhRYMrDkjrs9VlFFY4u", // Admin
  "fFA8G2R2ANLbVsH00jlv", // Supervisor
];

// ────────────────────────────────────────────────────────────
// Profile edit rules (shared by PUT /details/:userID and PUT /profile/:userID)
//
// Identity / contact / address fields are checked by staff against the ID the
// customer submitted at signup, so they can ONLY change through the admin-approved
// edit-request flow (POST /api/user/edit-requests — see editRequest.controller.js).
// These endpoints used to accept them directly, which skipped that approval.
// ────────────────────────────────────────────────────────────
const APPROVAL_REQUIRED_FIELDS = [
  "email", "phone", "birthDate",
  "region", "province", "city", "municipality", "barangay", "postalCode", "zipCode",
];
const APPROVAL_MESSAGE =
  "Email, phone, birth date and address (province / city / barangay) changes need admin approval. " +
  "Please submit an edit request from your profile instead.";
const hasApprovalField = (body) =>
  !!body && APPROVAL_REQUIRED_FIELDS.some((f) => body[f] !== undefined);

// Returns { value } (trimmed), { skip: true } when undefined, or { error }.
const cleanText = (raw, label, { min = 0, max = 100 } = {}) => {
  if (raw === undefined) return { skip: true };
  if (typeof raw !== "string") return { error: `${label} must be text.` };
  const value = raw.trim();
  if (value.length < min) return { error: `${label} is required.` };
  if (value.length > max) return { error: `${label} must be ${max} characters or fewer.` };
  return { value };
};

const TEXT_RULES = {
  firstName:  { label: "First name",  min: 1, max: 50  },
  lastName:   { label: "Last name",   min: 1, max: 50  },
  middleName: { label: "Middle name", min: 0, max: 50  },
  suffix:     { label: "Suffix",      min: 0, max: 10  },
  username:   { label: "Username",    min: 3, max: 30  },
  street:     { label: "Street",      min: 0, max: 120 },
  village:    { label: "Village",     min: 0, max: 120 },
};
// Validates the allowed text fields present in `body`. Returns { fields } or { error }.
const cleanProfileFields = (body, allowed) => {
  const fields = {};
  for (const key of allowed) {
    const r = cleanText(body[key], TEXT_RULES[key].label, TEXT_RULES[key]);
    if (r.error) return { error: r.error };
    if (!r.skip) fields[key] = r.value;
  }
  return { fields };
};

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
    // Whether this customer may book "Without Driver" (license on file, not expired, 21+). The booking page reads this
    // to grey that option out; createBooking enforces the same rule on the server.
    let drivingEligibility = null;
    try { drivingEligibility = await getSelfDriveEligibility(userID); }
    catch (eligErr) { console.error("getUserDetails: eligibility check failed:", eligErr.message); }
    return res.status(200).json({
      userID,
      drivingEligibility,
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
  if (hasApprovalField(req.body)) {
    return res.status(403).json({ message: APPROVAL_MESSAGE });
  }

  const { fields, error } = cleanProfileFields(req.body || {}, ["firstName", "lastName", "middleName", "suffix"]);
  if (error) return res.status(400).json({ message: error });
  if (!Object.keys(fields).length) {
    return res.status(400).json({ message: "At least one field is required to update." });
  }

  try {
    await db.collection("userDetails").doc(userID).set({ ...fields, updatedAt: new Date() }, { merge: true });
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

    // Accounts created before the referral feature existed have no
    // referralCode on their "user" doc at all (not even null — the field
    // was never written). Generate and persist one the first time they
    // load their profile, so every user ends up with a code without
    // needing a one-off backfill script run against the whole collection.
    let referralCode = user.referralCode;
    if (!referralCode) {
      referralCode = await generateUniqueReferralCode();
      await db.collection("user").doc(userID).update({ referralCode });
    }

    // Who referred this user (if anyone), and who this user has invited.
    // Usernames + status only — no email/phone of other customers.
    // Both come from the "referrals" connection table.
    const [myReferralSnap, invitedRefSnap] = await Promise.all([
      db.collection("referrals").where("referredUserID", "==", userID).limit(1).get(),
      db.collection("referrals").where("referrerUserID", "==", userID).get(),
    ]);

    let referredBy = null;
    if (!myReferralSnap.empty) {
      const referrerDoc = await db.collection("user").doc(myReferralSnap.docs[0].data().referrerUserID).get();
      referredBy = {
        username: referrerDoc.exists ? (referrerDoc.data().username || "") : "",
        removed:  !referrerDoc.exists,
      };
    }

    const invitedDocs = await Promise.all(
      invitedRefSnap.docs.map((d) => db.collection("user").doc(d.data().referredUserID).get())
    );
    const invited = invitedDocs
      .filter((d) => d.exists) // an invited account that has since been removed drops off the list
      .map((d) => {
        const u = d.data();
        return {
          username:   u.username || "",
          isVerified: !!u.isVerified,
          status:     u.status || "",
          joinedAt:   u.createdAt?.toDate ? u.createdAt.toDate().toISOString() : null,
        };
      })
      .sort((a, b) => String(b.joinedAt || "").localeCompare(String(a.joinedAt || "")));

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

    // Outstanding penalty balance — used to read a cached field mirrored
    // onto the user doc by admin-backend's penalty.service.js. That field
    // has been removed (it could drift out of sync — see
    // bookings.controller.js's createBooking guard for the full reasoning),
    // so this now queries `penalties` directly: narrow, indexed to this
    // one customer's own Confirmed penalties.
    const unpaidPenaltiesSnap = await db.collection("penalties")
      .where("userID", "==", userID)
      .where("status", "==", "Confirmed")
      .get();
    const outstandingByBooking = {};
    const unpaidDocsByBooking = {};   // the same penalties createPenaltyPaymentLink works the online payment out from
    const outstandingPenaltyBalance = unpaidPenaltiesSnap.docs.reduce((sum, doc) => {
      const p = doc.data();
      const owed = Math.max(0, (Number(p.amount) || 0) - (Number(p.paidAmount) || 0));
      if (owed > 0 && p.bookingID) {
        outstandingByBooking[p.bookingID] = (outstandingByBooking[p.bookingID] || 0) + owed;
        (unpaidDocsByBooking[p.bookingID] ||= []).push({ ...p, id: doc.id });
      }
      return sum + owed;
    }, 0);
    // Which bookings that balance belongs to — lets MyBookings.jsx's
    // banner link straight to the booking instead of just showing a total.
    // `pending` = the customer already opened an online checkout for it and hasn't finished paying.
    // A failed lookup only drops the badge; it never blocks the profile.
    let openCheckouts = {};
    try { openCheckouts = await listPendingCheckouts(userID); } catch (e) { console.warn("profile: could not read pending penalty checkouts:", e.message); }
    // What of each booking's balance is really paid ONLINE, and the online payment fee on it. A deposit that is still
    // Held pays penalties first (no fee); only the rest is paid online, with the fee on that remainder alone. The fee is
    // not part of outstandingPenaltyBalance. A failed lookup only drops these figures; it never blocks the profile.
    const planByBooking = {};
    try {
      const [feeSettings, covers, credits] = await Promise.all([getSystemSettings(), heldDepositCoverByBooking(userID), heldCreditByBooking(userID)]);
      Object.entries(unpaidDocsByBooking).forEach(([bookingID, docs]) => {
        planByBooking[bookingID] = planOnlinePayment(docs, { depositCover: covers[bookingID] || 0, fallbackPercent: feeSettings.gatewayFeePercent, threshold: feeSettings.penaltyThreshold });
        // The cover is the held deposit plus any discount credit held for the customer (no online payment, no fee on either).
        // The deposit pays first, then the credit: split what the plan says is covered between the two.
        const depositPart = Math.max(0, (covers[bookingID] || 0) - (credits[bookingID] || 0));
        const byDeposit = Math.min(depositPart, planByBooking[bookingID].coveredByDeposit);
        planByBooking[bookingID].depositOnly = Math.round(byDeposit * 100) / 100;
        planByBooking[bookingID].creditOnly = Math.round((planByBooking[bookingID].coveredByDeposit - byDeposit) * 100) / 100;
      });
    } catch (e) { console.warn("profile: could not work out the online payment fee on unpaid penalties:", e.message); }
    const outstandingPenaltyBookings = Object.entries(outstandingByBooking)
      .map(([bookingID, amount]) => {
        const plan = planByBooking[bookingID];
        return {
          bookingID, amount,
          coveredByDeposit: plan ? (plan.depositOnly ?? plan.coveredByDeposit) : 0,   // a held deposit pays this part at settlement (no fee)
          coveredByCredit: plan ? (plan.creditOnly || 0) : 0,   // held discount credit pays this part after the deposit (no fee)
          onlineDue: plan ? plan.onlineDue : amount,            // penalty money to pay online
          fee: plan ? plan.gatewayFee : 0,                      // the online payment fee on that
          total: plan ? plan.total : amount,                    // what the checkout charges
          pending: !!openCheckouts[bookingID],
          // What each unpaid penalty was for, so the customer can see what they were charged for (oldest first).
          penalties: (unpaidDocsByBooking[bookingID] || [])
            .map((pen) => {
              const created = pen.createdAt?.toDate ? pen.createdAt.toDate() : pen.createdAt?._seconds ? new Date(pen.createdAt._seconds * 1000) : null;
              const amt = Number(pen.amount) || 0;
              const items = Array.isArray(pen.lineItems)
                ? pen.lineItems.filter((i) => i && (i.description || Number(i.amount))).map((i) => ({ description: i.description || "Charge", amount: Number(i.amount) || 0 }))
                : [];
              return {
                penaltyID: pen.penaltyID || pen.id,
                amount: amt,
                owed: Math.max(0, amt - (Number(pen.paidAmount) || 0)),
                createdAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
                items: items.length ? items : [{ description: "Penalty charge", amount: amt }],
              };
            })
            .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))),
        };
      });

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
      // Queried live from `penalties` above — see MyBookings.jsx's
      // outstanding-balance banner, which reads this same response field.
      outstandingPenaltyBalance,
      outstandingPenaltyBookings, // [{ bookingID, amount, coveredByDeposit, onlineDue, fee, total, pending, penalties: [{ penaltyID, amount, owed, createdAt, items: [{ description, amount }] }] }] — one entry per booking with unpaid penalties
      // referral — this user's own shareable code and how many people
      // they've referred so far. Was already on the "user" doc since
      // signup started writing it, just never surfaced through this
      // endpoint before.
      referralCode:      referralCode           || "",
      referralCount:     invited.length,
      referredBy,                       // { username, removed } | null
      invited,                          // [{ username, isVerified, status, joinedAt }]
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
  if (hasApprovalField(req.body)) {
    return res.status(403).json({ message: APPROVAL_MESSAGE });
  }

  // Only what the Profile page really saves directly. (profileImage has its own
  // endpoint — POST /profile/:userID/avatar — so it is no longer accepted here.)
  const { userAddressID } = req.body || {};
  const { fields, error } = cleanProfileFields(req.body || {},
    ["username", "firstName", "lastName", "middleName", "suffix", "street", "village"]);
  if (error) return res.status(400).json({ message: error });
  if (userAddressID !== undefined && (typeof userAddressID !== "string" || !userAddressID || userAddressID.includes("/"))) {
    return res.status(400).json({ message: "Invalid userAddressID." });
  }
  if (!Object.keys(fields).length) {
    return res.status(400).json({ message: "At least one field is required to update." });
  }

  try {
    // Usernames are stored lowercase and must be unique (same rule as signup).
    if (fields.username !== undefined) {
      fields.username = fields.username.toLowerCase();
      const taken = await db.collection("user").where("username", "==", fields.username).limit(2).get();
      if (taken.docs.some((d) => d.id !== userID)) {
        return res.status(409).json({ message: "Username is already taken." });
      }
    }

    const now = new Date();
    const batch = db.batch();

    // — user fields —
    if (fields.username !== undefined) {
      batch.set(db.collection("user").doc(userID), { username: fields.username, updatedAt: now }, { merge: true });
    }

    // — userDetails fields —
    const detailFields = {};
    for (const k of ["firstName", "lastName", "middleName", "suffix"]) {
      if (fields[k] !== undefined) detailFields[k] = fields[k];
    }
    if (Object.keys(detailFields).length) {
      detailFields.userID = userID;
      detailFields.updatedAt = now;
      batch.set(db.collection("userDetails").doc(userID), detailFields, { merge: true });
    }

    // — userAddress fields (street / village only) —
    const addrFields = {};
    for (const k of ["street", "village"]) {
      if (fields[k] !== undefined) addrFields[k] = fields[k];
    }
    if (Object.keys(addrFields).length) {
      addrFields.userID = userID;
      addrFields.updatedAt = now;
      if (userAddressID) {
        // The ID comes from the request body, so it must be PROVEN to be this user's own
        // address. Without this check anyone could overwrite (and re-assign to
        // themselves, via the userID field above) another customer's address document.
        const addrDoc = await db.collection("userAddress").doc(userAddressID).get();
        if (!addrDoc.exists || addrDoc.data().userID !== userID) {
          return res.status(403).json({ message: "Access denied." });
        }
        batch.set(addrDoc.ref, addrFields, { merge: true });
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
