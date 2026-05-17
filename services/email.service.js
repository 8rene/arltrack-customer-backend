const axios = require("axios");

/**
 * Sends an account-approved notification email to the user.
 * Uses the EmailJS REST API.
 *
 * @param {Object} params
 * @param {string} params.toEmail   - Recipient email address
 * @param {string} params.toName    - Recipient display name
 */
const sendAccountApprovedEmail = async ({ toEmail, toName }) => {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email:    toEmail,
      to_name:     toName || "Valued Customer",
      app_name:    "ARL Car Rental",
      booking_url: process.env.APP_URL || "http://localhost:3000",
    },
  };

  try {
    const response = await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ Approval email sent to ${toEmail}`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Failed to send approval email:", detail);
    return { success: false, error: detail };
  }
};

module.exports = { sendAccountApprovedEmail };
