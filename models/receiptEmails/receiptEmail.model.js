// Copied from the admin backend's models/email/receiptEmail.model.js so both backends describe the same document. Keep it identical:
// change the admin file first, then copy it here.
// Written by BOTH backends (utils/receipt/receipt.util.js on this side).
//
// receiptEmails/{emailRequestID}
//
// Email rate limiter AND a record of what was emailed. One doc per receipt number or statement number that has been emailed.
// It remembers when it was last emailed, so the same one can't be emailed again within the 5-minute cooldown
// (EMAIL_COOLDOWN_MS in services/receipts/receipt.service.js), and it says which number went out.
//
// It is a collection, not server memory, because BOTH backends (admin and customer) write to it: an email sent by staff and
// one sent by the customer share the same cooldown, and a restart must not wipe it. emailLimiter.claim runs in a Firestore
// transaction so two simultaneous requests can't both get through. If the send fails, the document is put back as it was, or
// removed if that claim created it (emailLimiter.release), so a failed email doesn't lock anyone out or leave a false "sent".
//
// The document ID is a random auto ID like every other collection. The record is FOUND by `receiptNo`, the number printed on
// the document (a plain equality filter, no composite index):
//   receipt:   the receipt number   e.g. "RC-261111-534559"   (RC / PN / RF / DR prefix)
//   statement: the statement number e.g. "BS-261112-9986FB"   (BS prefix; carries the day it was generated, so a statement
//                                                             emailed on another day is a separate document)
// A statement is treated as a receipt here, so both use the one receiptNo field. `type` says which it is.
//
// Re-emailing the same number overwrites that document (lastSentAt moves), so the collection only grows with the number of
// distinct receipts/statements ever emailed.
const ReceiptEmail = {
  emailRequestID: "",   // this document's own ID (same value as the document ID; random)
  type: "",             // "payment" | "penalty" | "refund" | "deposit_return" | "statement"
  bookingID: "",        // the booking it belongs to
  paymentEntryID: null, // the payment entry a receipt was built from (null for a statement). For penalties paid together this is the
                        // entry the email was triggered from: a reference, not a unique link (they share one receiptNo).
  receiptNo: "",        // the printed number, and how the record is found: "RC-261111-534559" or, for a statement, "BS-261112-9986FB"
  lastSentAt: null,     // when it was last emailed (stamped BEFORE the send; restored/removed if the send fails)
  lastSentBy: null,     // uid of whoever triggered it; null for the automatic email after a payment settles
};

module.exports = { ReceiptEmail };