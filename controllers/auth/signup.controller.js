const admin = require("firebase-admin");
const { auth, db, bucket } = require("../../config/firebaseConnection/firebase");
const createUser         = require("../../models/user/user.model");
const createUserDetails  = require("../../models/user/userDetails.model");
const createUserAddress  = require("../../models/user/userAddress.model");
const createUserDocument = require("../../models/user/userDocument.model");
const createReferral     = require("../../models/referral/referral.model");
const { recordAudit }    = require("../../utils/auditLogs/auditLogs.util");
const { isArchivedUid }  = require("../../utils/accountStatus/accountStatus.util");
const { checkTermsAcceptance, termsRequired } = require("../../utils/terms/terms.service");
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
// Uploaded ID images: allowed types + size cap.
// The signup form always sends a compressed JPEG (SignUpModal.jsx compressImage),
// so anything else — or anything over the cap — is not a real submission. The
// client-supplied MIME type used to be trusted as-is and the only limit was the
// 20 MB request-body cap. We also check the file's magic bytes so a non-image
// can't be uploaded under an image MIME type.
// ─────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // decoded size per image (3 images ≈ 16 MB < 20 MB body limit)

// Minimum age to register. Keep in sync with MIN_AGE in SignUpModal.jsx.
const MIN_SIGNUP_AGE = 21;

// Age in whole years from an ISO "YYYY-MM-DD" birthdate, counted as of today in the Philippines
// (the business runs on PH time, so someone turning 21 today is 21 for the whole PH day,
// whatever timezone the server happens to run in). Returns null when the value isn't a real
// calendar date (wrong format, Feb 30, ...) or is implausible (over 120).
const ageFromBirthdate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof iso === "string" ? iso.trim() : "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const [ty, tm, td] = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).split("-").map(Number);
  let age = ty - y;
  if (tm < mo || (tm === mo && td < d)) age--;
  return age > 120 ? null : age;
};
const IMAGE_SIGNATURES = {
  "image/jpeg": (b) => b.length > 3  && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png":  (b) => b.length > 8  && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

// Returns { mimeType, buffer } for a valid image data-URL, or { error } (user-facing).
// An empty value is allowed here (callers decide whether an image is required).
const parseImageDataUrl = (dataUrl, label) => {
  if (!dataUrl) return { empty: true };
  const m = typeof dataUrl === "string"
    ? dataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/)
    : null;
  const mimeType = m && m[1].toLowerCase();
  if (!m || !IMAGE_SIGNATURES[mimeType]) {
    return { error: `${label} must be a JPEG, PNG, or WebP image.` };
  }
  // Check the size from the base64 length BEFORE decoding.
  const approxBytes = Math.floor((m[2].length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return { error: `${label} is too large. Maximum size is ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.` };
  }
  const buffer = Buffer.from(m[2], "base64");
  if (!IMAGE_SIGNATURES[mimeType](buffer)) {
    return { error: `${label} is not a valid ${mimeType.replace("image/", "").toUpperCase()} image.` };
  }
  return { mimeType, buffer };
};

// ─────────────────────────────────────────────────────────────
// Helper: upload a base64 data-URL to Firebase Storage (Admin SDK)
// Returns the public download URL, or "" on failure.
// Admin SDK bypasses Storage Security Rules entirely.
// ─────────────────────────────────────────────────────────────
const uploadBase64Image = async (base64DataUrl, destPath) => {
  if (!base64DataUrl) return "";
  try {
    // Validated again here (defence in depth — signup() also rejects bad images
    // up front, before the account is created).
    const parsed = parseImageDataUrl(base64DataUrl, destPath);
    if (parsed.error) {
      console.error(`uploadBase64Image: rejected ${destPath}: ${parsed.error}`);
      return "";
    }
    const { mimeType, buffer } = parsed;

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

// An archived (admin-deleted) account keeps its Firebase Auth login, only disabled, so its email and phone number stay
// taken. This finds out whether the Auth user that owns a taken email/phone is one of those, so the customer is told to
// contact the administrator instead of a plain "already in use". `lookup` returns the Auth user. Never throws.
const ownerIsArchived = async (lookup) => {
  try {
    const owner = await lookup();
    return await isArchivedUid(owner.uid);
  } catch {
    return false;
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
    username: rawUsername,
    email: rawEmail,
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
    termsVersionID, // termsVersions doc ID of the Terms & Conditions text shown when the customer ticked the box
  } = req.body;

  // Store email and username the way check-availability already compares them (trimmed + lowercase).
  // Before, the form lowercased the email but the username kept its capitals, so the lowercase
  // availability lookup could never match an existing "Juan" and a second "Juan" was let through.
  const email    = typeof rawEmail    === "string" ? rawEmail.trim().toLowerCase()    : rawEmail;
  const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : rawUsername;

  try {
    // 0-. Minimum age. The form checks this too, but a request made straight to the API skips the
    // form, so it has to be enforced here as well — before any image is parsed or anything is created.
    const age = ageFromBirthdate(birthdate);
    if (age === null) return res.status(400).json({ message: "A valid date of birth is required." });
    if (age < MIN_SIGNUP_AGE) {
      return res.status(400).json({ message: `You must be at least ${MIN_SIGNUP_AGE} years old to register.` });
    }

    // 0-b. The driver's license is OPTIONAL. Without one the customer can still register, but can only book
    // With Driver (Without Driver needs a license — see utils/user/selfDriveEligibility.js). The number and the photo
    // go together: one without the other is a half-filled form, not "no license".
    const hasLicenseNumber = typeof driversLicenseNumber === "string" && driversLicenseNumber.trim() !== "";
    const hasLicensePhoto  = !!driverLicenseBase64;
    if (hasLicenseNumber !== hasLicensePhoto) {
      return res.status(400).json({
        message: hasLicenseNumber
          ? "Please upload a photo of your driver's license, or clear the license number to continue without one."
          : "Please enter your driver's license number, or remove the photo to continue without one.",
      });
    }

    // 0. Reject bad ID images BEFORE creating anything (otherwise the account would
    // be created and the image silently dropped).
    for (const [value, label] of [
      [documentImageBase64, "Government ID photo"],
      [driverLicenseBase64, "Driver's license photo"],
      [selfieWithIdBase64,  "Selfie with ID"],
    ]) {
      const check = parseImageDataUrl(value, label);
      if (check.error) return res.status(400).json({ message: check.error });
    }

    // 0b. Terms & Conditions acceptance (see utils/terms/terms.service.js). A stale or missing
    // termsVersionID is rejected only when REQUIRE_TERMS_ACCEPTANCE=true; otherwise it's just not recorded.
    let termsCheck;
    try {
      termsCheck = await checkTermsAcceptance(termsVersionID);
    } catch (termsErr) {
      console.error("Terms check failed:", termsErr.message);
      if (termsRequired()) {
        return res.status(503).json({ message: "We couldn't verify the Terms & Conditions right now. Please try again in a moment." });
      }
      termsCheck = { ok: true, accepted: false };
    }
    if (!termsCheck.ok) return res.status(termsCheck.status).json(termsCheck.body);

    // 0c. The username must be unique. Only the browser's pre-check (check-availability) looked before,
    // so nothing stopped a request that skipped it. (Usernames saved before this change may still
    // contain capitals and can't be matched by this lookup.)
    if (username) {
      const taken = await db.collection("user").where("username", "==", username).limit(1).get();
      if (!taken.empty) return res.status(409).json({ message: "Username is already taken." });
    }

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
      const acceptedAt = new Date();
      batch.set(userRef, createUser(userID, {
        username, email, phone,
        referralCode: ownReferralCode,
        termsVersionID:  termsCheck.accepted ? termsCheck.terms.termsVersionID : null,
        termsAcceptedAt: termsCheck.accepted ? acceptedAt : null,
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
      // the referral row) lands together, or none of it does. A code that
      // didn't match anyone is not an error — it just isn't credited to
      // anyone (staff still see what was typed in the signup notification
      // and the audit log below).
      if (referrerDoc) {
        const referralRef = db.collection("referrals").doc();
        batch.set(referralRef, createReferral(referralRef.id, {
          referrerUserID: referrerDoc.id,
          referredUserID: userID,
        }));
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
    if (error.code === "auth/email-already-exists") {
      if (await ownerIsArchived(() => auth.getUserByEmail(email))) {
        return res.status(409).json({
          code: "ACCOUNT_ARCHIVED",
          message: "This email belongs to an archived account. Please contact the administrator to have it restored.",
        });
      }
      return res.status(409).json({ message: "Email is already in use." });
    }
    if (error.code === "auth/invalid-phone-number")
      return res.status(400).json({ message: "Invalid phone number format." });
    // check-availability only looks at email + username, so a phone number that is already on another
    // account is first discovered here — it used to fall through to the generic 500 below.
    // (createUser runs before any upload, so nothing is left behind when this fires.)
    if (error.code === "auth/phone-number-already-exists") {
      if (await ownerIsArchived(() => auth.getUserByPhoneNumber(phone))) {
        return res.status(409).json({
          code: "ACCOUNT_ARCHIVED",
          message: "This phone number belongs to an archived account. Please contact the administrator to have it restored.",
        });
      }
      return res.status(409).json({ message: "Phone number is already in use." });
    }
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
  const result   = { email: false, username: false, emailArchived: false };

  try {
    if (email) {
      try {
        const owner = await auth.getUserByEmail(email);
        result.email = true;
        result.emailArchived = await isArchivedUid(owner.uid); // taken by an account an admin archived
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
