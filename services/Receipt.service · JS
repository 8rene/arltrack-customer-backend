const PDFDocument = require("pdfkit");
const { bucket } = require("../../config/firebaseConnection/firebase");

// ─────────────────────────────────────────────────────────────────────────────
// Generates a one-page PDF receipt and uploads it to Firebase Storage, the
// same way bookings.controller.js already uploads proof-of-payment images
// (bucket.file(...).save() → makePublic() → storage.googleapis.com URL) —
// no new upload pattern, just reusing the one already in this codebase.
//
// This exists because EmailJS's Free plan (which this app is on — see
// email.service.js) doesn't support email attachments at all, only Personal
// plan and up ($9/mo). Rather than pay for that, the PDF is hosted here and
// the receipt email links to it instead of attaching it directly.
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (d) => d ? new Date(d).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * @param {Object} params
 * @param {string} params.bookingID
 * @param {string} params.paymentID
 * @param {string} params.carName
 * @param {string} params.phase            - "deposit" | "balance"
 * @param {number} params.amount           - Amount charged THIS phase
 * @param {string} params.paymentMethod
 * @param {string} params.referenceNumber  - PayMongo payment id
 * @param {Date|string} params.startDateTime
 * @param {Date|string} params.endDateTime
 * @param {string} params.customerName
 * @returns {Promise<string>} the public download URL of the uploaded PDF
 */
const generateReceiptPdf = async ({
  bookingID, paymentID, carName, phase, amount, paymentMethod,
  referenceNumber, startDateTime, endDateTime, customerName,
}) => {
  const phaseLabel = phase === "balance" ? "Balance" : "Deposit";

  // pdfkit streams pages as Buffer chunks — collect them, then resolve with
  // the full PDF once the document is done (doc.end() triggers "end").
  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("ARL Car Rental", { align: "left" });
    doc.fontSize(14).fillColor("#6b7280").text("Payment Receipt", { align: "left" });
    doc.moveDown(1.5);

    doc.fillColor("#1f2937").fontSize(11);
    const row = (label, value) => {
      doc.font("Helvetica-Bold").text(label, { continued: true, width: 200 });
      doc.font("Helvetica").text(`  ${value}`);
      doc.moveDown(0.4);
    };

    row("Billed To:",      customerName || "Valued Customer");
    row("Booking ID:",     bookingID || "—");
    row("Vehicle:",        carName || "—");
    row("Payment:",        phaseLabel);
    row("Amount Paid:",    `PHP ${Number(amount || 0).toLocaleString()}`);
    row("Method:",         paymentMethod || "—");
    row("Reference No.:",  referenceNumber || "—");
    row("Rental Period:",  `${fmt(startDateTime)} - ${fmt(endDateTime)}`);
    row("Receipt Date:",   new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }));

    doc.moveDown(1.5);
    doc.fontSize(9).fillColor("#9ca3af")
      .text("This is a system-generated receipt from ARL Car Rental. No signature required.");

    doc.end();
  });

  const filePath = `receipts/${bookingID || "unknown"}_${phase}_${paymentID}.pdf`;
  const file = bucket.file(filePath);
  await file.save(pdfBuffer, { contentType: "application/pdf" });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${filePath}`;
};

module.exports = { generateReceiptPdf };
