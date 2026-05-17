const { auth, db, bucket } = require("../../config/firebaseConnection/firebase");
const createUser         = require("../../models/user/user.model");
const createUserDetails  = require("../../models/user/userDetails.model");
const createUserAddress  = require("../../models/user/userAddress.model");
const createUserDocument = require("../../models/user/userDocument.model");

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
    console.log(`✅ Uploaded ${destPath} → ${url}`);
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

    // 2. Upload images to Firebase Storage (in parallel, Admin SDK — no rules)
    const [documentImageUrl, driverLicenseUrl, selfieWithIdUrl] = await Promise.all([
      uploadBase64Image(documentImageBase64,  `userDocuments/${userID}/governmentId.jpg`),
      uploadBase64Image(driverLicenseBase64,  `userDocuments/${userID}/driversLicense.jpg`),
      uploadBase64Image(selfieWithIdBase64,   `userDocuments/${userID}/selfieWithId.jpg`),
    ]);

    // 3. Batch-write all four Firestore documents atomically
    const batch = db.batch();

    // ── "user" collection ────────────────────────────────────
    const userRef = db.collection("user").doc(userID);
    batch.set(userRef, createUser(userID, { username, email, phone, referralCode }));

    // ── "userDetails" collection (own unique userDetailsID) ──
    const userDetailsRef = db.collection("userDetails").doc();
    batch.set(userDetailsRef, createUserDetails(userID, {
      firstName, middleName, lastName, suffix, birthdate,
    }));

    // ── "userAddress" collection (own unique userAddressID) ──
    const userAddressRef = db.collection("userAddress").doc();
    batch.set(userAddressRef, createUserAddress(userID, {
      region:       address?.region       || "",
      province:     address?.province     || "",
      municipality: address?.municipality || "",
      barangay:     address?.barangay     || "",
      street:       address?.street       || "",
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

    await batch.commit();

    return res.status(201).json({ message: "Signup successful", userID });

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
module.exports = { signup, checkEmail, checkAvailability };

