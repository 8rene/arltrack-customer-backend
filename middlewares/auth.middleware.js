const jwt = require("jsonwebtoken");
const { db } = require("../config/firebaseConnection/firebase");

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(403).json({ message: "Access denied. No token provided." });
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  let verified;
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  // Re-check current status on every request, not just at login — a token
  // issued while the account was active stays valid (per its own expiry)
  // even if an admin sets the account to "inactive" or "locked" afterward,
  // unless we look it up here. Fails closed: any lookup problem blocks the
  // request rather than letting a stale token through.
  try {
    const userDoc = await db.collection("user").doc(verified.userID).get();

    if (!userDoc.exists) {
      return res.status(403).json({ message: "Account not found. Please log in again." });
    }

    const status = userDoc.data().status?.toLowerCase();
    if (status === "locked" || status === "inactive") {
      return res.status(403).json({
        message:
          status === "locked"
            ? "Your account is pending approval. Please wait for admin verification."
            : "Your account has been deactivated. Please contact support.",
      });
    }
  } catch (err) {
    console.error("Auth middleware status check failed:", err.message);
    return res.status(500).json({ message: "Server error. Please try again." });
  }

  req.user = verified;
  next();
};

module.exports = verifyToken;