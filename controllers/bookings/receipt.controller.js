// Customer-side receipts and booking statement.
//
// These are the SAME documents the admin side prints (same numbers, same figures, built by utils/receipt/ from the
// paymentEntries rows), shown to the person who owns the booking:
//   GET  /bookings/:bookingID/statement                   the booking statement + the money-flow list (JSON)
//   GET  /bookings/:bookingID/statement/pdf               the statement as a downloadable PDF
//   POST /bookings/:bookingID/statement/email             email it to the address on the account
//   GET  /bookings/:bookingID/receipts/:entryID           one receipt (JSON)
//   GET  /bookings/:bookingID/receipts/:entryID/pdf       one receipt as a downloadable PDF
//   POST /bookings/:bookingID/receipts/:entryID/email     email it to the address on the account
//
// Every request first proves the logged-in customer owns that booking, and a receipt must belong to THAT booking, so
// guessing a bookingID or an entryID never shows someone else's money. A customer never chooses the email recipient (the
// request has no body), and the 5-minute email limit is shared with the admin side (collection receiptEmails).
// PDFs are built in memory and streamed to the owner; nothing is stored or made public.
const { db } = require("../../config/firebaseConnection/firebase");
const { buildReceipt, buildStatement, toCustomerView, emailLimiter, emailKeyFor } = require("../../utils/receipt/receipt.util");
const { renderReceiptEmail, renderStatementEmail } = require("../../utils/receipt/receiptEmail.util");
const { renderReceiptPdf, renderStatementPdf } = require("../../services/pdf/receipt.service");
const { sendGenericEmail } = require("../../services/email.service");

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Ownership: the booking must exist (live or archived) and belong to the logged-in customer.
const assertOwnsBooking = async (bookingID, userID) => {
  if (!bookingID) throw httpError(400, "Missing bookingID.");
  for (const collection of ["bookings", "bookingArchives"]) {
    const snap = await db.collection(collection).where("bookingID", "==", bookingID).limit(1).get();
    if (!snap.empty) {
      if (snap.docs[0].data().userID !== userID) throw httpError(403, "You don't have permission to access this booking.");
      return;
    }
  }
  throw httpError(404, "Booking not found.");
};

// A receipt opens only through the booking it belongs to.
const loadReceipt = async (req) => {
  const { bookingID, entryID } = req.params;
  await assertOwnsBooking(bookingID, req.user.userID);
  const receipt = await buildReceipt({ entryID });
  if (receipt.booking.bookingID !== bookingID) throw httpError(404, "Receipt not found.");
  return receipt;
};
const loadStatement = async (req) => {
  await assertOwnsBooking(req.params.bookingID, req.user.userID);
  return buildStatement({ bookingID: req.params.bookingID });
};

const fail = (res, err, tag) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  console.error(`[${tag}]`, err);
  return res.status(500).json({ message: "Server error. Please try again." });
};

const sendPdf = (res, buffer, name) => {
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${String(name).replace(/[^\w.-]/g, "_")}.pdf"`,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  return res.status(200).end(buffer);
};

// One email send, with the shared limit: claimed in a transaction BEFORE sending (two quick taps, or a staff member and the
// customer at the same time, cannot both pass) and handed back if the send fails.
const emailDocument = async (res, { key, toEmail, subject, bodyHtml, userID, sentLabel, masked }) => {
  if (!toEmail) return res.status(422).json({ message: "There is no email address on your account." });
  const slot = await emailLimiter.claim(key, userID);
  if (!slot.ok) {
    return res.status(429).json({
      message: `This ${sentLabel} was just emailed. Please wait ${Math.ceil(slot.wait / 60)} more minute(s) before sending it again.`,
      retryAfterSeconds: slot.wait,
    });
  }
  const sent = await sendGenericEmail({ toEmail, subject, bodyHtml });
  if (!sent.success) {
    await emailLimiter.release(key, slot.previous);
    return res.status(502).json({ message: "Couldn't send the email. Please try again in a bit." });
  }
  return res.status(200).json({ message: `Sent to ${masked || "your email"}.`, nextAllowedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
};

// ── statement ──
const getStatement = async (req, res) => {
  try { return res.status(200).json({ success: true, data: toCustomerView(await loadStatement(req)) }); }
  catch (err) { return fail(res, err, "statement"); }
};
const getStatementPdf = async (req, res) => {
  try {
    const s = toCustomerView(await loadStatement(req));
    return sendPdf(res, await renderStatementPdf(s), s.statementNo);
  } catch (err) { return fail(res, err, "statement-pdf"); }
};
const emailStatement = async (req, res) => {
  try {
    const built = await loadStatement(req);
    const { subject, bodyHtml } = renderStatementEmail(toCustomerView(built), { audience: "customer" });
    return emailDocument(res, {
      key: emailKeyFor.statement(built.booking.bookingID), toEmail: built._email, subject, bodyHtml,
      userID: req.user.userID, sentLabel: "statement", masked: built.customer.emailMasked,
    });
  } catch (err) { return fail(res, err, "statement-email"); }
};

// ── receipts ──
const getReceipt = async (req, res) => {
  try { return res.status(200).json({ success: true, data: toCustomerView(await loadReceipt(req)) }); }
  catch (err) { return fail(res, err, "receipt"); }
};
const getReceiptPdf = async (req, res) => {
  try {
    const r = toCustomerView(await loadReceipt(req));
    return sendPdf(res, await renderReceiptPdf(r), r.receiptNo);
  } catch (err) { return fail(res, err, "receipt-pdf"); }
};
const emailReceipt = async (req, res) => {
  try {
    const built = await loadReceipt(req);
    const { subject, bodyHtml } = renderReceiptEmail(toCustomerView(built), { audience: "customer" });
    return emailDocument(res, {
      key: emailKeyFor.receipt(built.receiptNo), toEmail: built._email, subject, bodyHtml,
      userID: req.user.userID, sentLabel: "receipt", masked: built.customer.emailMasked,
    });
  } catch (err) { return fail(res, err, "receipt-email"); }
};

module.exports = { getStatement, getStatementPdf, emailStatement, getReceipt, getReceiptPdf, emailReceipt };
