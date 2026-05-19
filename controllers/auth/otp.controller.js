const generateOTP = require("../../utils/generateOTP");

const sendOTP = async (req, res) => {
  const { email, name, template_id } = req.body;

  if (!email) return res.status(400).json({ message: "Email is required." });

  const otp = generateOTP();
  const time = new Date().toLocaleTimeString();

  try {
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:    process.env.EMAILJS_SERVICE_ID,
        template_id:   template_id || "template_pcp4m9n",
        user_id:       process.env.EMAILJS_PUBLIC_KEY,
        accessToken:   process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
          name:       name || email.split("@")[0],
          otp_code:   otp,
          user_email: email,
          email:      email,
          time,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("EmailJS error:", errText);
      // Still allow registration to proceed even if email fails
      return res.status(200).json({ emailSent: false, emailError: errText });
    }

    return res.status(200).json({ emailSent: true });

  } catch (err) {
    console.error("sendOTP error:", err);
    return res.status(500).json({ message: "Server error sending OTP." });
  }
};

module.exports = { sendOTP };
