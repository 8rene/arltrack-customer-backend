// GENERATED from arltrack-admin-backend/services/paymentEntries/paymentEntries.core.js -- DO NOT EDIT BY HAND.
// Change the admin file, then run: node scripts/build-customer-payment-entries.mjs <this repo>
// paymentEntries bound to the customer backend's Firestore connection.
// syncPaymentEntries(paymentDocID, opts) re-derives a payment's deposit / balance rows from the document
// after it was written. It NEVER throws -- a failure must not block a real payment.
const { db } = require("../../config/firebaseConnection/firebase");
const { makeEntriesDb } = require("./paymentEntries.core");

const svc = makeEntriesDb(db);

module.exports = {
  syncPaymentEntries:      svc.syncPaymentEntries,
  syncRefundEntries:       svc.syncRefundEntries,
  getEntriesForPaymentIDs: svc.getEntriesForPaymentIDs,
  hydratePayments:         svc.hydratePayments,
  hydratePaymentData:      svc.hydratePaymentData,
  hydratePenalties:        svc.hydratePenalties,
  getEntriesForPenaltyIDs: svc.getEntriesForPenaltyIDs,
  hydrateRefundRequests:   svc.hydrateRefundRequests,
};
