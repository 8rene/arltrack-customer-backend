// ─────────────────────────────────────────────────────────────────────────────
// One place for "build a receipt (PDF + email) for a settled payment phase
// and send it" — extracted out of settlePhasePayment() in
// utils/payments/settlePayment.util.js so the SAME logic (car-name join,
// Timestamp conversion, PDF, email) can be reused by the manual
// "Email my receipt" button (controllers/bookings/receipt.controller.js)
// without copy-pasting it a second time and having the two drift apart.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");
const { sendPaymentReceiptEmail } = require("../../services/email.service");
const { generateReceiptPdf } = require("../../services/pdf/receipt.service");
const { channelLabel } = require("../payments/paymongoClient.util");

// Firestore Timestamps have .toDate(); plain values (or already-Date) fall
// back to new Date(v). Without this, new Date(timestampObject) silently
// produces "Invalid Date".
const asDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : (v ? new Date(v) : null));

// carName is NOT stored on the booking doc — it's a joined field
// (carID → cars → brandID/modelID → brand/model), same as
// bookings.controller.js resolves it for listings.
const resolveCarName = async (carID) => {
  if (!carID) return "Unknown Vehicle";
  const carSnap = await db.collection("cars").doc(carID).get();
  if (!carSnap.exists) return "Unknown Vehicle";
  const car = carSnap.data();
  const [brandSnap, modelSnap] = await Promise.all([
    car.brandID ? db.collection("brand").doc(car.brandID).get() : null,
    car.modelID ? db.collection("model").doc(car.modelID).get() : null,
  ]);
  const brand = brandSnap && brandSnap.exists ? brandSnap.data().brandName || "" : "";
  const model = modelSnap && modelSnap.exists ? modelSnap.data().modelName || "" : "";
  return `${brand} ${model}`.trim() || "Unknown Vehicle";
};

/**
 * Builds the PDF + email for one settled payment phase and sends it.
 * Used both right after a payment settles (automatic) and from the
 * customer-triggered "Email my receipt" button (manual resend) — same
 * result either way, since it's the same function.
 *
 * @param {Object} params
 * @param {Object} params.payment           - full payment doc data (userID, bookingID, paymentID, paymongoChannel/paymentMethod)
 * @param {string} params.phase             - "deposit" | "balance"
 * @param {number} params.charged           - amount charged THIS phase
 * @param {string} params.paymongoPaymentID - reference number for this phase
 * @returns {Promise<{success:boolean, error?:string}>}
 */
const buildAndSendReceipt = async ({ payment, phase, charged, paymongoPaymentID }) => {
  const bID = payment.bookingID || null;
  if (!payment.userID || !bID) {
    return { success: false, error: "payment is missing userID or bookingID" };
  }

  try {
    const [userSnap, bSnap, detailsSnap] = await Promise.all([
      db.collection("user").doc(payment.userID).get(),
      db.collection("bookings").where("bookingID", "==", bID).limit(1).get(),
      db.collection("userDetails").doc(payment.userID).get(),
    ]);
    const userEmail = userSnap.exists ? userSnap.data().email : null;
    const b         = bSnap.empty ? {} : bSnap.docs[0].data();

    const carName        = await resolveCarName(b.carID);
    const startDateTime  = asDate(b.startDateTime);
    const endDateTime    = asDate(b.endDateTime);

    let toName = "Valued Customer";
    if (detailsSnap.exists) {
      const { firstName, lastName } = detailsSnap.data();
      toName = [firstName, lastName].filter(Boolean).join(" ") || toName;
    }

    const paymentMethod = channelLabel(payment.paymongoChannel || payment.paymentMethod);

    // PDF first — EmailJS's Free plan can't attach files, so the email
    // links to this instead of attaching it.
    const receiptUrl = await generateReceiptPdf({
      bookingID: bID, paymentID: payment.paymentID, carName, phase, amount: charged,
      paymentMethod, referenceNumber: paymongoPaymentID, startDateTime, endDateTime,
      customerName: toName,
    });

    await sendPaymentReceiptEmail({
      toEmail: userEmail, toName, bookingID: bID, carName, phase, amount: charged,
      paymentMethod, referenceNumber: paymongoPaymentID, startDateTime, endDateTime,
      receiptUrl,
    });

    return { success: true };
  } catch (e) {
    console.error(`[receipt] failed to build/send for booking ${bID} (${phase}):`, e.message);
    return { success: false, error: e.message };
  }
};

module.exports = { buildAndSendReceipt, resolveCarName, asDate };
