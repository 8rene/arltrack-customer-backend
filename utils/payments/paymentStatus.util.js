// Payment status, one canonical spelling -- same table as the admin backend's normalizePaymentStatus()
// (arltrack-admin-backend/services/payments/payments.service.js). KEEP IN SYNC with it.
//
// The customer app and the webhook write payment.status / balanceStatus in lowercase ("pending", "paid",
// "failed", "cancelled"); staff actions on the admin side write capitalised values ("Approved", "Rejected",
// "Refunded"). Comparing the raw string means a payment staff already confirmed ("Approved") is not seen as
// paid here. Every status check goes through this file instead: what is WRITTEN is unchanged, what is READ
// is compared in its canonical form. "paid" (PayMongo auto-confirmed) is "Approved", exactly as in admin.
const CANONICAL_STATUS = {
  pending:   "Pending",
  paid:      "Approved",
  approved:  "Approved",
  rejected:  "Rejected",
  cancelled: "Cancelled",
  canceled:  "Cancelled",
  failed:    "Failed",
  refunded:  "Refunded",
};

const normalizePaymentStatus = (raw) => {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "Pending";
  return CANONICAL_STATUS[key] || String(raw);
};

/** The phase has cleared: PayMongo paid it ("paid") or staff confirmed it ("Approved"). */
const isPaidStatus      = (raw) => normalizePaymentStatus(raw) === "Approved";
/** Still waiting. An empty / missing status counts as pending, same as admin. */
const isPendingStatus   = (raw) => normalizePaymentStatus(raw) === "Pending";
const isCancelledStatus = (raw) => normalizePaymentStatus(raw) === "Cancelled";

module.exports = { CANONICAL_STATUS, normalizePaymentStatus, isPaidStatus, isPendingStatus, isCancelledStatus };