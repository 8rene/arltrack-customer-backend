const { db } = require("../config/firebaseConnection/firebase");

/**
 * Middleware: verifyAdmin
 * Must be used AFTER verifyToken (which populates req.user).
 * Checks that the authenticated user holds the admin roleID in Firestore.
 */
const verifyAdmin = async (req, res, next) => {
  // req.user is set by verifyToken middleware (contains { userID, ... })
  const userID = req.user?.userID;

  if (!userID) {
    return res.status(401).json({ message: "Unauthorized: no user identity found." });
  }

  try {
    const userDoc = await db.collection("user").doc(userID).get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "Requesting user not found." });
    }

    const userData = userDoc.data();

    // ── Admin roleID — update this value to match your Firestore admin role ──
    // You can also move ADMIN_ROLE_ID to .env for flexibility
    const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "ADMIN";

    if (userData.roleID !== ADMIN_ROLE_ID) {
      return res.status(403).json({
        message: "Forbidden: admin access required.",
      });
    }

    // Attach admin user data to request for downstream use if needed
    req.adminUser = userData;
    next();
  } catch (error) {
    console.error("verifyAdmin error:", error);
    return res.status(500).json({ message: "Failed to verify admin role." });
  }
};

module.exports = verifyAdmin;
