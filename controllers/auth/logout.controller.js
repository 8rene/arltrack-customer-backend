const { closeSessionLog } = require("../../utils/sessionLogs/sessionLogs.util");

// POST /api/auth/logout — called on manual logout AND on automatic
// logout when the frontend detects the JWT has expired. Requires
// verifyToken so we know which user's session to close.
const logout = async (req, res) => {
  try {
    await closeSessionLog(req.user.userID, "manual");
    return res.status(200).json({ message: "Logged out." });
  } catch (error) {
    console.error("logout error:", error.message);
    // Logging out should always "succeed" from the client's point of
    // view — the frontend clears its token regardless.
    return res.status(200).json({ message: "Logged out." });
  }
};

module.exports = { logout };