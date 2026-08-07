// ─────────────────────────────────────────────────────────────────────────────
// Booking pricing / fee calculations — SERVER-SIDE SOURCE OF TRUTH.
//
// This used to live only in the frontend (arltrack-customer-frontend/src/
// pages/Booking.jsx: calcDays / isBaseArea / extraFee / driversFee / etc).
// The backend simply trusted whatever numbers the browser sent along with
// the booking (`Number(rentalFee) || 0`, `Number(grandTotal) || ...`), which
// means anyone could open devtools and submit a booking — or a PayMongo
// checkout — for any amount they wanted.
//
// Every function here is pure (no DB/IO) so it's easy to unit test and to
// call from multiple controllers (bookings.controller.js, paymongo.controller.js).
// ─────────────────────────────────────────────────────────────────────────────

// Manila / Bulacan = base service area → no extra fee. Anything else = outside area.
const isBaseArea = (destination) => {
  if (!destination) return true; // no destination given = treat as base area
  const d = String(destination).toLowerCase();
  return d.includes("manila") || d.includes("bulacan");
};

// ── Day count with the 22h/25h billing-block rule ──────────────────────────
// 22 Hours duration type: each 22-hour block = 1 billing day.
// 12 Hours / anything else: each 25-hour block = 1 billing day (12-Hour
// bookings are always auto-calculated to fit inside a single block).
const calcBillableDays = (startDateTime, endDateTime, durationType) => {
  if (!startDateTime || !endDateTime) return { days: 0, diffHrs: 0 };
  const startDT = new Date(startDateTime);
  const endDT   = new Date(endDateTime);
  if (isNaN(startDT.getTime()) || isNaN(endDT.getTime())) return { days: 0, diffHrs: 0 };

  const diffHrs = (endDT - startDT) / 3600000;
  if (diffHrs <= 0) return { days: 0, diffHrs: 0 };

  const blockHrs = durationType === "22 Hours" ? 22 : 25;
  const days = Math.max(1, Math.ceil(diffHrs / blockHrs));
  return { days, diffHrs };
};

// Fixed fees — same constants the frontend used to hardcode.
const SERVICE_FEE  = 50; // flat platform/service fee
const GATEWAY_FEE  = 53; // flat payment gateway fee
const DEPOSIT_FEE  = 1000; // reservation deposit is always ₱1,000

// ── Full fee breakdown for a booking ────────────────────────────────────────
// pricePerDay must come from the car's own carPricing doc (looked up by the
// caller using carID + durationType) — never from the client.
const computeBookingFees = ({ pricePerDay, startDateTime, endDateTime, durationType, destination, driveType }) => {
  const { days, diffHrs } = calcBillableDays(startDateTime, endDateTime, durationType);

  // No valid date range selected yet — nothing should be charged at all,
  // not even the "flat" fees (service/gateway/driver's), since those used
  // to slip through even with days === 0 and show a phantom price before
  // the customer had picked any dates.
  if (days === 0) {
    return { days: 0, diffHrs: 0, rentalFee: 0, extraFee: 0, driversFee: 0, serviceFee: 0, gatewayFee: 0, grandTotal: 0, depositFee: DEPOSIT_FEE };
  }

  const rentalFee = days * (Number(pricePerDay) || 0);

  const baseArea = isBaseArea(destination);
  const extraFee   = baseArea ? 0 : 500;
  const driversFee = driveType === "chauffeur" ? (baseArea ? 1000 : 1500) : 0;

  const serviceFee = SERVICE_FEE;
  const gatewayFee = GATEWAY_FEE;

  const grandTotal = rentalFee + extraFee + driversFee + serviceFee + gatewayFee;

  return { days, diffHrs, rentalFee, extraFee, driversFee, serviceFee, gatewayFee, grandTotal, depositFee: DEPOSIT_FEE };
};

// ── Partial (50%) vs Full payment split ─────────────────────────────────────
const computePaymentSplit = (grandTotal, paymentAmount) => {
  const total = Number(grandTotal) || 0;
  const isPartial = String(paymentAmount).toLowerCase() !== "full";
  const payNow  = isPartial ? Math.floor(total * 0.5) : total;
  const balance = Math.max(0, total - payNow);
  return { payNow, balance, methodOfPayment: isPartial ? "Partial" : "Full" };
};

// ── "How much of this payment has actually been paid?" badge/derivation ────
// Mirrors the admin backend's computeAmounts() (payments.service.js) so the
// customer-facing badge always agrees with the admin dashboard's math,
// instead of each frontend recomputing its own (possibly-drifting) copy.
const derivePaymentStatus = (payment) => {
  if (!payment) return { key: "due", balance: 0, amountPaid: 0 };

  const amount     = Number(payment.amount) || 0;
  const depositFee = Number(payment.depositFee) || 0;
  const method     = String(payment.methodOfPayment || "").toLowerCase();
  const status     = String(payment.status || "").toLowerCase();

  if (status === "failed" || status === "rejected") return { key: "failed", balance: 0, amountPaid: 0 };
  if (status === "cancelled") return { key: "cancelled", balance: 0, amountPaid: 0 };

  let amountPaid;
  if (method.includes("full")) {
    amountPaid = amount;
  } else if (method.includes("down")) {
    amountPaid = Math.round(amount / 2);
  } else if (method.includes("deposit") || method.includes("partial")) {
    amountPaid = depositFee;
  } else if (status === "paid" || status === "approved") {
    amountPaid = amount;
  } else {
    amountPaid = depositFee;
  }

  const balance = Math.max(0, amount - amountPaid);
  if (amountPaid > 0 && balance <= 0) return { key: "paid", balance, amountPaid };
  if (amountPaid > 0) return { key: "partial", balance, amountPaid };
  return { key: "due", balance, amountPaid };
};

module.exports = {
  isBaseArea,
  calcBillableDays,
  computeBookingFees,
  computePaymentSplit,
  derivePaymentStatus,
  SERVICE_FEE,
  GATEWAY_FEE,
  DEPOSIT_FEE,
};
