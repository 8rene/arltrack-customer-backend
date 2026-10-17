const { db } = require("../../config/firebaseConnection/firebase");
const { closeSessionLog } = require("../../utils/sessionLogs/sessionLogs.util");

// A token with this little life left isn't worth revoking: it expires on its own in moments,
// and the frontend's AUTOMATIC logout (which fires ~2s before expiry and calls this same endpoint)
// must not sign the user out of their other devices.
const SKIP_REVOKE_IF_EXPIRING_WITHIN_S = 15;

// POST /api/auth/logout — called on manual logout AND on automatic
// logout when the frontend detects the JWT has expired. Requires
// verifyToken so we know which user's session to close.
const logout = async (req, res) => {
  try {
    await closeSessionLog(req.user.userID, "manual");
  } catch (error) {
    console.error("logout error:", error.message);
    // Logging out should always "succeed" from the client's point of
    // view — the frontend clears its token regardless.
  }

  // Make the token actually stop working (the frontend just forgetting it isn't enough if a copy
  // exists elsewhere). Stamps `tokensValidAfter` on the user doc; verifyToken refuses anything
  // issued earlier. Note: this ends the user's sessions on every device, not only this one.
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const secondsLeft = (req.user.exp || 0) - nowS;
    if (secondsLeft > SKIP_REVOKE_IF_EXPIRING_WITHIN_S) {
      await db.collection("user").doc(req.user.userID).set({ tokensValidAfter: nowS }, { merge: true });
    }
  } catch (error) {
    console.error("logout: could not end sessions:", error.message);
  }

  return res.status(200).json({ message: "Logged out." });
};

module.exports = { logout };
