const { db, auth } = require("../../config/firebaseConnection/firebase");
const generateOTP = require("../../utils/generateOTP");
const { isBlockedAdminRole } = require("../../utils/roles/role.util");

const OTP_EXPIRY_MS  = 5 * 60 * 1000;  // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000;     // 1 minute cooldown between requests
const MAX_ATTEMPTS   = 5;              // max wrong guesses before lockout

// POST /api/auth/send-otp
// body: { email, name, template_id, purpose }
//
// `purpose` distinguishes the two flows that share this endpoint:
//   - "signup" (default/omitted) — the email is EXPECTED not to exist yet.
//     No account/role check here; that's what signup itself validates.
//   - "reset"  — forgot-password flow. The email MUST already belong to a
//     real, non-admin-side account, or we don't send an OTP at all. This
//     both avoids wasting OTP emails on addresses that were never
//     registered, and stops Owner/Admin/Supervisor accounts from using
//     the customer-side forgot-password flow to reset their password —
//     same accounts that are blocked from customer login (login.controller.js).
//
// Message is intentionally generic either way ("No account found with
// this email") so a reset attempt against a real staff email doesn't
// reveal that the email belongs to an admin-side account.
const sendOTP = async (req, res) => {
  const { email, name, template_id, purpose } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required." });

  try {
    if (purpose === "reset") {
      let firebaseUser;
      try {
        firebaseUser = await auth.getUserByEmail(email);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          return res.status(404).json({ message: "No account found with this email." });
        }
        throw err;
      }

      const userDoc = await db.collection("user").doc(firebaseUser.uid).get();
      const roleID  = userDoc.exists ? userDoc.data().roleID : null;

      if (roleID && await isBlockedAdminRole(roleID, db)) {
        return res.status(404).json({ message: "No account found with this email." });
      }
    }

    // Bug 4 fix: cooldown check — block if OTP was requested less than 1 minute ago
    const existing = await db.collection("otpCodes").doc(email).get();
    if (existing.exists) {
      const createdAt = existing.data().createdAt?.toDate?.() || new Date(0);
      const elapsed   = Date.now() - createdAt.getTime();
      if (elapsed < OTP_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          message: `Please wait ${secondsLeft} seconds before requesting a new OTP.`,
        });
      }
    }

    const otp  = generateOTP();
    const time = new Date().toLocaleTimeString();

    // Store OTP in Firestore with expiry, cooldown timestamp, and attempt counter
    await db.collection("otpCodes").doc(email).set({
      otp,
      purpose:    purpose === "reset" ? "reset" : "signup",
      createdAt:  new Date(),
      expiresAt:  new Date(Date.now() + OTP_EXPIRY_MS),
      attempts:   0,
      verified:   false,
    });

    // Send OTP via EmailJS
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:  process.env.EMAILJS_SERVICE_ID,
        template_id: template_id || "template_pcp4m9n",
        user_id:     process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
          name:       name || email.split("@")[0],
          otp_code:   otp,
          user_email: email,
          email,
          time,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("EmailJS error:", errText);
      return res.status(200).json({ emailSent: false, emailError: errText });
    }

    return res.status(200).json({ emailSent: true });

  } catch (err) {
    console.error("sendOTP error:", err);
    return res.status(500).json({ message: "Server error sending OTP." });
  }
};

// POST /api/auth/verify-otp
const verifyOTP = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ message: "Email and OTP are required." });
  }

  try {
    const doc = await db.collection("otpCodes").doc(email).get();

    if (!doc.exists) {
      return res.status(404).json({ message: "OTP not found. Please request a new one." });
    }

    const data = doc.data();

    // Check expiry
    if (new Date() > data.expiresAt.toDate()) {
      await db.collection("otpCodes").doc(email).delete();
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    // Bug 5 fix: check attempt count before validating
    if (data.attempts >= MAX_ATTEMPTS) {
      await db.collection("otpCodes").doc(email).delete();
      return res.status(429).json({
        message: "Too many failed attempts. Please request a new OTP.",
      });
    }

    // Check OTP match
    if (data.otp !== otp) {
      // Increment attempt counter
      await db.collection("otpCodes").doc(email).update({
        attempts: data.attempts + 1,
      });
      const remaining = MAX_ATTEMPTS - (data.attempts + 1);
      return res.status(400).json({
        message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // OTP is valid — delete it so it can't be reused
    await db.collection("otpCodes").doc(email).delete();
    return res.status(200).json({ message: "OTP verified successfully." });

  } catch (err) {
    console.error("verifyOTP error:", err);
    return res.status(500).json({ message: "Server error verifying OTP." });
  }
};

module.exports = { sendOTP, verifyOTP };
