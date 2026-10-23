// Copied from the admin backend's models/email/receiptEmail.model.js so both backends describe the same document. Keep it identical:
// change the admin file first, then copy it here.
// Written by BOTH backends (utils/receipt/receipt.util.js on this side).
//
// receiptEmails/{key}
//
// Email rate limiter -- NOT a log or an archive. One tiny doc per receipt or
// statement that remembers when it was last emailed, so the same one can't be
// emailed again within the 5-minute cooldown (EMAIL_COOLDOWN_MS in
// services/receipts/receipt.service.js).
//
// It is a collection, not server memory, because BOTH backends (admin and
// customer) write to it: an email sent by staff and one sent by the customer
// share the same cooldown, and a restart must not wipe it. The check runs in a
// Firestore transaction (emailLimiter.claim) so two simultaneous requests
// can't both get through. If the send fails, the previous value is put back
// (emailLimiter.release) so a failed email doesn't lock anyone out.
//
// The doc ID IS the key (there is no separate ID field), built by emailKeyFor:
//   receipt:   "receipt_<receiptNo>"     -- stable for a payment entry
//   statement: "statement_<bookingID>"   -- keyed by booking, because the
//                                           statement number carries today's date
// "/" and whitespace in the key are replaced with "_".
//
// The doc is overwritten on every send, so the collection only grows with the
// number of receipts/statements ever emailed. Old docs are harmless and can be
// cleaned up occasionally.
const ReceiptEmail = {
  lastSentAt: null, // when it was last emailed (stamped BEFORE the send; restored if the send fails)
  lastSentBy: null, // uid of whoever triggered it; null for the automatic email after a payment settles
};

module.exports = { ReceiptEmail };
