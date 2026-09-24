const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// EmailJS free plan caps templates at 2 — one is already OTP
// (template_pcp4m9n, see otp.controller.js), so there's exactly ONE slot
// left: "Blank template for general purpose" (EMAILJS_TEMPLATE_ID). Its
// Subject field is `{{subject}}` and its Content is just `{{ body }}` — a
// single HTML blob, no other placeholders — so both the account-approved
// email and the payment receipt below build their own full HTML body in
// JS and send it through that one shared template. Nothing needs to
// change in the EmailJS dashboard itself.
// ─────────────────────────────────────────────────────────────────────────────

const wrapEmailHtml = (innerHtml) => `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="color: #1e3a8a; margin-bottom: 16px;">ARL Car Rental</h2>
    ${innerHtml}
    <p style="margin-top: 28px; font-size: 12px; color: #6b7280;">
      This is an automated message from ARL Car Rental. Please don't reply directly to this email.
    </p>
  </div>
`;

/**
 * Sends one email through the SHARED "Blank template for general purpose"
 * template — its only placeholders are {{subject}} and {{ body }}, so the
 * caller supplies fully-built HTML.
 */
const sendGenericEmail = async ({ toEmail, subject, bodyHtml }) => {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email: toEmail,
      subject,
      body: bodyHtml,
    },
  };

  try {
    await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ Email sent to ${toEmail}: ${subject}`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Failed to send email (${subject}) to ${toEmail}:`, detail);
    return { success: false, error: detail };
  }
};

/**
 * Sends an account-approved notification email to the user.
 *
 * @param {Object} params
 * @param {string} params.toEmail   - Recipient email address
 * @param {string} params.toName    - Recipient display name
 */
const sendAccountApprovedEmail = ({ toEmail, toName }) => {
  const bookingUrl = process.env.APP_URL || "http://localhost:3000";
  const bodyHtml = wrapEmailHtml(`
    <p>Hi ${toName || "Valued Customer"},</p>
    <h3 style="margin-bottom: 8px;">Your Account Has Been Approved! 🎉</h3>
    <p style="line-height: 1.5;">Good news — your ARL Car Rental account has been verified and approved. You can now log in and start booking.</p>
    <p style="margin-top: 20px;">
      <a href="${bookingUrl}" style="background: #1e3a8a; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">Start Booking</a>
    </p>
  `);
  return sendGenericEmail({ toEmail, subject: "Your ARL Car Rental Account Has Been Approved", bodyHtml });
};

/**
 * Sends a digital receipt for one settled payment phase (deposit or
 * balance), through the SAME shared template as the approval email above.
 *
 * @param {Object} params
 * @param {string} params.toEmail
 * @param {string} params.toName
 * @param {string} params.bookingID
 * @param {string} params.carName
 * @param {string} params.phase            - "deposit" | "balance"
 * @param {number} params.amount           - Amount charged THIS phase (not the grand total)
 * @param {string} params.paymentMethod
 * @param {string} params.referenceNumber  - PayMongo payment id
 * @param {Date|string} params.startDateTime
 * @param {Date|string} params.endDateTime
 */
const sendPaymentReceiptEmail = ({
  toEmail, toName, bookingID, carName, phase, amount,
  paymentMethod, referenceNumber, startDateTime, endDateTime, receiptUrl,
}) => {
  if (!toEmail) {
    console.warn(`[email] no recipient email — skipped receipt for booking ${bookingID}`);
    return Promise.resolve({ success: false, error: "missing recipient email" });
  }

  const fmt = (d) => d ? new Date(d).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const phaseLabel = phase === "balance" ? "Balance" : "Deposit";

  const rows = [
    ["Booking ID", bookingID || "—"],
    ["Vehicle", carName || "—"],
    ["Payment", phaseLabel],
    ["Amount Paid", `₱${Number(amount || 0).toLocaleString()}`],
    ["Method", paymentMethod || "—"],
    ["Reference No.", referenceNumber || "—"],
    ["Rental Period", `${fmt(startDateTime)} – ${fmt(endDateTime)}`],
    ["Receipt Date", new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })],
  ].map(([label, value]) => `
      <tr>
        <td style="padding: 4px 0; color: #6b7280;">${label}</td>
        <td style="padding: 4px 0; text-align: right; font-weight: bold;">${value}</td>
      </tr>`).join("");

  return sendGenericEmail({ toEmail, subject: `Payment Receipt — Booking ${bookingID || ""}`, bodyHtml: wrapEmailHtml(`
    <p>Hi ${toName || "Valued Customer"},</p>
    <h3 style="margin-bottom: 8px;">Payment Receipt</h3>
    <p style="line-height: 1.5;">We've received your ${phaseLabel.toLowerCase()} payment. Here's your receipt:</p>
    <table style="width: 100%; border-collapse: collapse; background: #f3f4f6; border-radius: 8px; padding: 14px 16px; font-size: 14px;">
      ${rows}
    </table>
    <p style="margin-top: 20px;">
      <a href="${receiptUrl || process.env.APP_URL || "http://localhost:3000"}" style="background: #1e3a8a; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">${receiptUrl ? "Download PDF Receipt" : "View My Booking"}</a>
    </p>
  `) });
};

module.exports = { sendAccountApprovedEmail, sendPaymentReceiptEmail };
