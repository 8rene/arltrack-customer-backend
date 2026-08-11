const { db, auth } = require("../../config/firebaseConnection/firebase");
const { isBlockedAdminRole } = require("../../utils/roles/role.util");

const MAX_ATTEMPTS = 5;

// Same strength rule enforced client-side at signup (SignUpModal.jsx) —
// checked again here since this is a new, separate entry point.
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+[\]{};':"\\|,.<>/?]).{8,16}$/;

// POST /api/auth/reset-password
// body: { email, otp, newPassword }
// Reuses the same 'otpCodes' collection/flow as signup's send-otp — the
// OTP must have already been requested via POST /api/auth/send-otp.
const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: "Email, OTP, and new password are required." });
  }
  if (!PASSWORD_REGEX.test(newPassword)) {
    return res.status(400).json({
      message: "Password must be 8–16 characters with at least 1 uppercase, 1 lowercase, 1 number, and 1 special character.",
    });
  }

  try {
    // 1. Validate the OTP — same checks as verifyOTP in otp.controller.js
    const otpRef = db.collection("otpCodes").doc(email);
    const otpDoc = await otpRef.get();

    if (!otpDoc.exists) {
      return res.status(404).json({ message: "OTP not found. Please request a new one." });
    }

    const otpData = otpDoc.data();

    if (new Date() > otpData.expiresAt.toDate()) {
      await otpRef.delete();
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    if (otpData.attempts >= MAX_ATTEMPTS) {
      await otpRef.delete();
      return res.status(429).json({ message: "Too many failed attempts. Please request a new OTP." });
    }

    if (otpData.otp !== otp) {
      await otpRef.update({ attempts: otpData.attempts + 1 });
      const remaining = MAX_ATTEMPTS - (otpData.attempts + 1);
      return res.status(400).json({
        message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // 2. OTP correct — find the Firebase Auth user for this email
    let firebaseUser;
    try {
      firebaseUser = await auth.getUserByEmail(email);
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        return res.status(404).json({ message: "No account found with this email." });
      }
      throw err;
    }

    // 2a. Block admin-side accounts (Owner/Admin/Supervisor) from resetting
    // their password through the customer-facing site — mirrors the same
    // block in login.controller.js. This is checked again here (not just
    // at send-otp) since `purpose` on send-otp is client-supplied and
    // shouldn't be the only thing standing between a blocked role and a
    // password reset. Generic message, same reasoning as login.
    const userDoc = await db.collection("user").doc(firebaseUser.uid).get();
    const roleID  = userDoc.exists ? userDoc.data().roleID : null;
    if (roleID && await isBlockedAdminRole(roleID, db)) {
      await otpRef.delete();
      return res.status(404).json({ message: "No account found with this email." });
    }

    // 3. Update the password
    await auth.updateUser(firebaseUser.uid, { password: newPassword });

    // 4. OTP is single-use — delete it now that it's been consumed
    await otpRef.delete();

    return res.status(200).json({ message: "Password reset successfully. You can now log in with your new password." });

  } catch (err) {
    console.error("resetPassword error:", err);
    return res.status(500).json({ message: "Server error resetting password. Please try again." });
  }
};

module.exports = { resetPassword };
