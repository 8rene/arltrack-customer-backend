const axios = require("axios");
const { db }  = require("../../config/firebaseConnection/firebase");
const jwt     = require("jsonwebtoken");
const { recordLogin } = require("../../utils/userLogs/userLogs.util");

// Admin-side role names (from the shared 'roles' Firestore collection) —
// these accounts manage the fleet/bookings and should never be able to log
// into the customer-facing site. Driver is intentionally NOT blocked here
// since drivers may also need customer-side access depending on how the
// business uses that role; only Owner/Admin/Supervisor are blocked.
// Looked up dynamically by roleID -> roles/{roleID}.roleName, so this stays
// correct even if roleIDs ever change/differ between environments.
const BLOCKED_ADMIN_ROLE_NAMES = new Set(["Owner", "Admin", "Supervisor"]);

const isBlockedAdminRole = async (roleID) => {
  if (!roleID) return false;
  try {
    const roleSnap = await db.collection("roles").doc(roleID).get();
    if (!roleSnap.exists) return false;
    return BLOCKED_ADMIN_ROLE_NAMES.has(roleSnap.data().roleName);
  } catch (err) {
    console.error("isBlockedAdminRole lookup failed:", err.message);
    return false; // fail open — don't lock everyone out if the roles lookup itself breaks
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const firebaseApiKey = process.env.FIREBASE_API_KEY;

  if (!firebaseApiKey || firebaseApiKey === "your_firebase_web_api_key_here") {
    return res.status(500).json({ message: "Server misconfiguration: FIREBASE_API_KEY not set." });
  }

  try {
    // 1. Verify credentials via Firebase Auth REST API using axios
    const signInRes = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      { email, password, returnSecureToken: true },
      { headers: { "Content-Type": "application/json" } }
    );

    const uid = signInRes.data.localId;

    // 2. Fetch user document from Firestore
    const userDoc = await db.collection("user").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User record not found." });
    }

    const userData = userDoc.data();

    // 2a. Check if account is pending admin approval
    if (userData.status === "locked") {
      return res.status(403).json({
        message: "Your account is pending approval. Please wait for admin verification.",
      });
    }

    // 2b. Block admin-side accounts (Owner/Admin/Supervisor) from logging
    // into the customer-facing site — they belong on the admin panel only.
    if (await isBlockedAdminRole(userData.roleID)) {
      return res.status(403).json({
        message: "This account is an admin account and can't be used to log in here. Please use the admin panel.",
      });
    }

    // 3. Issue JWT
    const token = jwt.sign(
      {
        userID:   uid,
        email:    userData.email,
        roleID:   userData.roleID,
        username: userData.username || "",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // Log this session for the admin's User Logs page — fire without
    // blocking the response; a logging hiccup should never fail a login.
    recordLogin(uid, userData.username || "");

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        userID:       uid,
        email:        userData.email,
        phone:        userData.phone        || "",
        username:     userData.username     || "",
        roleID:       userData.roleID       || "",
        profileImage: userData.profileImage || "",
        isVerified:   userData.isVerified   || false,
      },
    });

  } catch (error) {
    // Axios wraps HTTP errors — check the Firebase error code
    const code = error.response?.data?.error?.message || "";
    console.error("Login error code:", code);

    if (
      code.includes("EMAIL_NOT_FOUND") ||
      code.includes("INVALID_PASSWORD") ||
      code.includes("INVALID_LOGIN_CREDENTIALS") ||
      code.includes("INVALID_EMAIL")
    ) {
      return res.status(401).json({ message: "Invalid email or password." });
    }
    if (code.includes("USER_DISABLED")) {
      return res.status(403).json({ message: "Your account has been disabled." });
    }
    if (code.includes("TOO_MANY_ATTEMPTS_TRY_LATER") || code.includes("TOO_MANY_ATTEMPTS")) {
      return res.status(429).json({ message: "Too many failed attempts. Please try again later." });
    }
    if (code.includes("API_KEY_INVALID") || code.includes("API key not valid")) {
      return res.status(500).json({ message: "Server misconfiguration: invalid Firebase API key." });
    }

    console.error("Login error:", error.message);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
};

module.exports = { login };
