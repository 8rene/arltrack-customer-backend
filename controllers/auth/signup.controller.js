const admin = require("firebase-admin");
const { auth, db, bucket } = require("../../config/firebaseConnection/firebase");
const createUser         = require("../../models/user/user.model");
const createUserDetails  = require("../../models/user/userDetails.model");
const createUserAddress  = require("../../models/user/userAddress.model");
const createUserDocument = require("../../models/user/userDocument.model");
const createReferral     = require("../../models/referral/referral.model");
const { recordAudit }    = require("../../utils/auditLogs/auditLogs.util");
const { generateUniqueReferralCode, findUserByReferralCode } = require("../../utils/referrals/referral.util");

// Same role IDs as bookings.controller.js's CANCELLATION_APPROVER_ROLE_IDS /
// paymongo.controller.js's STAFF_NOTIFY_ROLE_IDS / admin-backend/utils/roles/role.util.js
// — kept as a local literal here since this is a separate deployable app and
// can't import that file directly. Keep these lists in sync by hand if the
// roles collection's doc IDs ever change.
const STAFF_NOTIFY_ROLE_IDS = [
  "1BX4V7M43t6barbPd4BP", // Owner
  "5bhRYMrDkjrs9VlFFY4u", // Admin
  "fFA8G2R2ANLbVsH00jlv", // Supervisor
];

// ─────────────────────────────────────────────────────────────
// Helper: upload a base64 data-URL to Firebase Storage (Admin SDK)
// Returns the public download URL, or "" on failure.
// Admin SDK bypasses Storage Security Rules entirely.
// ─────────────────────────────────────────────────────────────
const uploadBase64Image = async (base64DataUrl, destPath) => {
  if (!base64DataUrl) return "";
  try {
    const matches = base64DataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      console.error(`uploadBase64Image: invalid data URL format for ${destPath}`);
      return "";
    }
    const mimeType = matches[1];
    const buffer   = Buffer.from(matches[2], "base64");

    const file = bucket.file(destPath);
    await file.save(buffer, {
      metadata: { contentType: mimeType },
      resumable: false,
    });
    await file.makePublic();
    const url = `https://storage.googleapis.com/${bucket.name}/${destPath}`;
    return url;
  } catch (err) {
    // Log the FULL error so it's visible in the backend console
    console.error(`❌ uploadBase64Image FAILED (${destPath}):`, err);
    return ""; // non-fatal — registration still proceeds
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/auth/signup
//
// Accepts all registration data including base64 images.
// Creates Firebase Auth user, uploads images via Admin SDK,
// then batch-writes four Firestore documents:
//   "user"         — account info
//   "userDetails"  — personal info
//   "userAddress"  — address info
//   "userDocument" — document info with real image URLs
//
// Status is always "locked" until admin approves.
// NO welcome email is sent — only sent when admin unlocks.
// ─────────────────────────────────────────────────────────────
const signup = async (req, res) => {
  const {
    username,
    email,
    password,
    phone,
    firstName,
    middleName,
    lastName,
    suffix,
    birthdate,
    address,
    referralCode,
    // Document fields
    documentType,
    documentNumber,
    documentImageBase64,
    driversLicenseNumber,
    driverLicenseBase64,
    selfieWithIdBase64,
  } = req.body;

  try {
    // 1. Create user in Firebase Auth
    const firebaseUser = await auth.createUser({
      email,
      password,
      phoneNumber: phone || undefined,
    });
    const userID = firebaseUser.uid;

    try {
      // 2. Upload images to Firebase Storage (in parallel, Admin SDK — no rules)
      const [documentImageUrl, driverLicenseUrl, selfieWithIdUrl] = await Promise.all([
        uploadBase64Image(documentImageBase64,  `userDocuments/${userID}/governmentId.jpg`),
        uploadBase64Image(driverLicenseBase64,  `userDocuments/${userID}/driversLicense.jpg`),
        uploadBase64Image(selfieWithIdBase64,   `userDocuments/${userID}/selfieWithId.jpg`),
      ]);

      // 2b. This user's own shareable referral code, and — if they entered
      // someone else's code — who referred them. Resolved before the batch
      // so the referral doc/counter increment can go in the same atomic
      // write as the user doc itself.
      const ownReferralCode = await generateUniqueReferralCode();

      let referrerDoc = null;
      if (referralCode) {
        referrerDoc = await findUserByReferralCode(referralCode);
      }

      // 3. Batch-write all Firestore documents atomically
      const batch = db.batch();

      // ── "user" collection ────────────────────────────────────
      const userRef = db.collection("user").doc(userID);
      batch.set(userRef, createUser(userID, {
        username, email, phone,
        referralCode:   ownReferralCode,
        referredBy:     referrerDoc ? referrerDoc.id : null,
        referredByCode: referralCode ? String(referralCode).trim().toUpperCase() : null,
      }));

      // ── "userDetails" collection (keyed by userID for easy lookup) ──
      const userDetailsRef = db.collection("userDetails").doc(userID);
      batch.set(userDetailsRef, createUserDetails(userID, {
        firstName, middleName, lastName, suffix, birthDate: birthdate,
      }));

      // ── "userAddress" collection (keyed by userID for easy lookup) ──
      const userAddressRef = db.collection("userAddress").doc(userID);
      batch.set(userAddressRef, createUserAddress(userID, {
        region:       address?.region       || "",
        province:     address?.province     || "",
        city:         address?.city         || "",
        municipality: address?.municipality || "",
        barangay:     address?.barangay     || "",
        street:       address?.street       || "",
        postalCode:   address?.postalCode   || "",
      }));

      // ── "userDocument" collection (own unique userDocumentID) ─
      const userDocumentRef = db.collection("userDocument").doc();
      batch.set(userDocumentRef, createUserDocument(userID, {
        documentType,
        documentNumber,
        documentImageUrl,
        driversLicenseNumber,
        driverLicenseUrl,
        selfieWithIdUrl,
      }));

      // ── Referral tracking — only if the entered code matched a real user ──
      // Same batch as everything else: either the whole signup (including
      // the referral credit) lands together, or none of it does. A code
      // that didn't match anyone is not an error — referredByCode above
      // still records what they typed for support/admin visibility, it
      // just doesn't get credited to anyone.
      if (referrerDoc) {
        const referralRef = db.collection("referrals").doc();
        batch.set(referralRef, createReferral(referralRef.id, {
          referrerUserID:   referrerDoc.id,
          referrerCode:     referrerDoc.data().referralCode,
          referredUserID:   userID,
          referredUsername: username || email || "",
        }));
        batch.update(referrerDoc.ref, {
          referralCount: admin.firestore.FieldValue.increment(1),
        });
      }

      await batch.commit();

      // ── Notify every Owner/Admin/Supervisor — one doc per person ──
      // Fan-out, not a single shared doc: each staff member gets their own
      // isRead/dismiss state, same pattern as requestCancellation() in
      // bookings.controller.js and requestRefund() in paymongo.controller.js.
      // Written directly here rather than relying on the admin backend's
      // (now-removed) userWatcher.js to notice via a Firestore onSnapshot()
      // listener — the admin backend runs as a Vercel serverless function,
      // which doesn't keep a persistent process alive to run watchers
      // reliably between requests. Matches the exact document shape
      // admin-backend/services/notification/notification.service.js
      // creates, so the existing bell UI needs no changes to read it.
      try {
        const staffSnap = await db.collection("user")
          .where("roleID", "in", STAFF_NOTIFY_ROLE_IDS)
          .get();

        const notifBatch = db.batch();
        staffSnap.forEach((staffDoc) => {
          const notifRef = db.collection("notifications").doc();
          notifBatch.set(notifRef, {
            type: "new_user",
            userID: staffDoc.id,
            refID: userID,
            refCollection: "user",
            title: "New user signup",
            message: `${username || email || "A new user"} is waiting for account review.${
              referrerDoc
                ? ` Referred by ${referrerDoc.data().username || referrerDoc.data().email || "a member"}.`
                : (referralCode ? ` Entered referral code ${String(referralCode).trim().toUpperCase()} (no match).` : "")
            }`,
            isRead: false,
            status: "active",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            resolvedAt: null,
          });
        });
        await notifBatch.commit();
      } catch (notifErr) {
        // Signup already succeeded at this point — log and move on rather
        // than fail the whole request over the notification fan-out.
        // Worst case: staff have to notice it in the user list instead of
        // the bell.
        console.error("[signup] Failed to write notifications:", notifErr.message);
      }

      // Audit trail: one entry per new signup, including who referred them.
      // recordAudit never throws, so this can't fail the signup itself.
      await recordAudit({
        action: "create",
        description: `New signup: ${username || email}${
          referrerDoc
            ? ` (referred by ${referrerDoc.data().username || referrerDoc.data().email || "a member"})`
            : (referralCode ? ` (entered referral code ${String(referralCode).trim().toUpperCase()}, no match)` : "")
        }.`,
        userID,
      });

      return res.status(201).json({
        message: "Signup successful",
        userID,
        referralCode: ownReferralCode,
        referralApplied: !!referrerDoc,
      });

    } catch (innerError) {
      // Firebase Auth user was created above, but something after that
      // failed (image upload threw, Firestore batch rejected, etc). Without
      // this, the customer is stuck: `auth/email-already-exists` on every
      // retry, but no profile they can actually log into or that an admin
      // can review. Clean up the orphaned Auth user so they can just try
      // signing up again.
      try {
        await auth.deleteUser(userID);
      } catch (cleanupErr) {
        console.error(`[signup] Failed to clean up orphaned Auth user ${userID}:`, cleanupErr.message);
      }
      throw innerError;
    }

  } catch (error) {
    console.error("Signup error:", error);
    if (error.code === "auth/email-already-exists")
      return res.status(409).json({ message: "Email is already in use." });
    if (error.code === "auth/invalid-phone-number")
      return res.status(400).json({ message: "Invalid phone number format." });
    if (error.code === "auth/weak-password")
      return res.status(400).json({ message: "Password is too weak." });
    return res.status(500).json({ message: "Server error. Please try again." });
  }
};


// ─────────────────────────────────────────────────────────────
// GET /api/auth/check-availability?email=xxx&username=xxx
// ─────────────────────────────────────────────────────────────
const checkAvailability = async (req, res) => {
  const email    = (req.query.email    || "").trim().toLowerCase();
  const username = (req.query.username || "").trim().toLowerCase();
  const result   = { email: false, username: false };

  try {
    if (email) {
      try {
        await auth.getUserByEmail(email);
        result.email = true;
      } catch (err) {
        if (err.code !== "auth/user-not-found") throw err;
      }
    }
    if (username) {
      const snap = await db
        .collection("user")
        .where("username", "==", username)
        .limit(1)
        .get();
      result.username = !snap.empty;
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error("checkAvailability error:", err);
    return res.status(500).json({ message: "Could not verify availability." });
  }
};

const checkEmail = checkAvailability;

// ─────────────────────────────────────────────────────────────
// GET /api/auth/check-referral?code=XXX
//
// Lets the signup form confirm a referral code live (show "Referred by
// <name>") before the account is even created, instead of the customer
// only finding out after submitting whether it did anything. No auth
// required — same reasoning as check-availability: called before the
// visitor has an account, and it's read-only.
// ─────────────────────────────────────────────────────────────
const checkReferralCode = async (req, res) => {
  const code = (req.query.code || "").trim();
  if (!code) return res.status(400).json({ message: "code is required." });

  try {
    const referrerDoc = await findUserByReferralCode(code);
    if (!referrerDoc) {
      return res.status(200).json({ valid: false });
    }
    const referrer = referrerDoc.data();
    return res.status(200).json({
      valid: true,
      // The referrer's USERNAME only (never their email, phone or real name) —
      // enough for the customer to recognise whose code they entered. The route
      // is rate-limited (see auth.routes.js) so this can't be used to enumerate
      // codes/users at scale.
      referrerName: referrer.username || "a member",
    });
  } catch (err) {
    console.error("checkReferralCode error:", err);
    return res.status(500).json({ message: "Could not verify referral code." });
  }
};

module.exports = { signup, checkEmail, checkAvailability, checkReferralCode };
