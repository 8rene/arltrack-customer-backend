const { auth, db } = require("../../config/firebaseConnection/firebase");
const jwt          = require("jsonwebtoken");
const { createSessionLog, expireStaleSessionsForUser } = require("../../utils/sessionLogs/sessionLogs.util");
const { checkAccountStatus } = require("../../utils/accountStatus/accountStatus.util");

// See login.controller.js for details — same admin roleIDs are blocked here.
const BLOCKED_ADMIN_ROLE_IDS = new Set([
  "1BX4V7M43t6barbPd4BP", // Owner
  "5bhRYMrDkjrs9VlFFY4u", // Admin
  "fFA8G2R2ANLbVsH00jlv", // Supervisor
]);

const googleLogin = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ message: "Google ID token is required." });
  }

  try {
    // 1. Verify the ID token with Firebase Admin SDK
    const decoded = await auth.verifyIdToken(idToken);
    const { uid, email } = decoded;

    // 2. Query Firestore by email (not UID)
    const userQuery = await db.collection("user")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(403).json({
        message: "No account found for this Google email. Please register first.",
      });
    }

    const userData = userQuery.docs[0].data();
    const userID   = userQuery.docs[0].id; // original UID from email signup

    // 2a. Check if account is pending admin approval, or has been
    // deactivated by an admin. Single source of truth in
    // accountStatus.util.js — shared with login.controller.js — so this
    // can't silently drift out of sync between login paths again.
    const statusBlock = checkAccountStatus(userData, userID, { logPrefix: "Blocked Google login attempt" });
    if (statusBlock) {
      return res.status(statusBlock.httpStatus).json({ message: statusBlock.message });
    }

    // 2b. Block admin-side accounts (Owner/Admin/Supervisor) from logging
    // into the customer-facing site via Google too.
    if (userData.roleID && BLOCKED_ADMIN_ROLE_IDS.has(userData.roleID)) {
      return res.status(403).json({
        message: "This account is an admin account and can't be used to log in here. Please use the admin panel.",
      });
    }

    // 3. Issue JWT using the original UID
    const token = jwt.sign(
      {
        userID:   userID,
        email:    userData.email,
        roleID:   userData.roleID,
        username: userData.username || "",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    expireStaleSessionsForUser(userID);
    createSessionLog(userID, userData.username || "");

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        userID:       userID,
        email:        userData.email,
        phone:        userData.phone        || "",
        username:     userData.username     || "",
        roleID:       userData.roleID       || "",
        profileImage: userData.profileImage || "",
        isVerified:   userData.isVerified   || false,
      },
    });

  } catch (error) {
    console.error("Google login error:", error.message);

    if (error.code === "auth/id-token-expired") {
      return res.status(401).json({ message: "Google session expired. Please try again." });
    }
    if (error.code === "auth/argument-error" || error.code === "auth/invalid-id-token") {
      return res.status(401).json({ message: "Invalid Google token. Please try again." });
    }

    return res.status(500).json({ message: "Server error. Please try again." });
  }
};

module.exports = { googleLogin };