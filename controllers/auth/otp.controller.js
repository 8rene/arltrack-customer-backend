const { db }      = require("../../config/firebaseConnection/firebase");
const generateOTP = require("../../utils/generateOTP");

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/auth/send-otp
const sendOTP = async (req, res) => {
  const { email, name, template_id } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required." });

  const otp  = generateOTP();
  const time = new Date().toLocaleTimeString();

  try {
    // 1. Store OTP in Firestore with expiry (keyed by email)
    await db.collection("otpCodes").doc(email).set({
      otp,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      verified:  false,
    });

    // 2. Send OTP via EmailJS
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

    // Check OTP match
    if (data.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP. Please try again." });
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
