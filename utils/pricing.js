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
// Fee AMOUNTS (SERVICE_FEE, GATEWAY_FEE, extraFeeOutsideArea,
// driversFeeBaseArea, driversFeeOutsideArea, baseAreaKeywords) now come from
// the same systemSettings Firestore doc the admin panel's System Settings
// page writes to (arltrack-admin-backend/services/systemSettings). This is
// the wiring the admin side's comments called "a separate follow-up" — this
// file is that follow-up.
//
// computeBookingFees is now ASYNC (it awaits the settings fetch below) —
// every caller must `await` it. Everything else here stays a pure function.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../config/firebaseConnection/firebase");
const { getPaymentBreakdown } = require("./payments/paymentBreakdown.util");

// Hardcoded fallback values — used ONLY if Firestore has no systemSettings
// doc yet, or the read fails. Kept identical to the original constants so
// behavior is unchanged for anyone who hasn't touched the admin panel yet.
const SETTINGS_DEFAULTS = {
  // Percentages (0-100), NOT flat pesos — see computeFeeBreakdown() below.
  serviceFeePercent: 5,
  gatewayFeePercent: 5,
  extraFeeOutsideArea: 500,
  // Refundable security deposit — same field the admin System Settings page
  // edits (systemSettings.securityDepositAmount). Now collected as part of
  // the booking's grand total, not separately at pickup.
  securityDepositAmount: 1000,
  driversFeeBaseArea: 1000,
  driversFeeOutsideArea: 1500,
  baseAreaKeywords: ["manila", "bulacan"],
};

// Short in-memory cache so a burst of live quote requests while the
// customer is picking dates/destination on Booking.jsx doesn't hit
// Firestore on every keystroke. Same pattern as the codingCache already
// used in bookings.controller.js for cars/codingRules.
const SETTINGS_CACHE_TTL_MS = 30_000;
let settingsCache = { data: null, fetchedAt: 0 };

// Reads the most recent doc in systemSettings (createdAt desc) — same doc
// the admin panel's System Settings page writes on every save. Falls back
// to SETTINGS_DEFAULTS if the collection is empty or the read fails, so a
// Firestore hiccup never breaks booking/quote instead of just using stale
// defaults.
const getSystemSettings = async () => {
  const now = Date.now();
  if (settingsCache.data && now - settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.data;
  }

  try {
    const snap = await db
      .collection("systemSettings")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    const data = snap.empty ? SETTINGS_DEFAULTS : { ...SETTINGS_DEFAULTS, ...snap.docs[0].data() };
    settingsCache = { data, fetchedAt: now };
    return data;
  } catch (error) {
    console.error("[PRICING] Failed to fetch systemSettings, using defaults:", error.message);
    return SETTINGS_DEFAULTS;
  }
};

// Prefers an EXACT match against the structured city/province the map
// picker resolves via reverse-geocoding (MapPicker.jsx → destinationCoords
// → destinationCity/destinationProvince), the same "exact, not fuzzy"
// preference checkCodingRule already uses for destinationCity.
//
// Falls back to a fuzzy substring check on the raw typed destination text
// only when neither structured field is available — i.e. the customer
// typed a destination without ever using the map picker. That fallback is
// what let false positives like "New Manila" (a Quezon City district, not
// the City of Manila) slip through before; it's kept only as a fallback
// now, not the primary check.
const isBaseArea = (destination, { destinationCity, destinationProvince } = {}, baseAreaKeywords = SETTINGS_DEFAULTS.baseAreaKeywords) => {
  const city     = String(destinationCity || "").trim().toLowerCase();
  const province = String(destinationProvince || "").trim().toLowerCase();

  if (city || province) {
    return baseAreaKeywords.some((k) => city === k || province === k);
  }

  if (!destination) return true; // no destination given at all = treat as base area
  const d = String(destination).toLowerCase();
  return baseAreaKeywords.some((k) => d.includes(k));
};

// ── Day count with the 22h/25h billing-block rule ──────────────────────────
// 22 Hours duration type: each 22-hour block = 1 billing day.
// 12 Hours / anything else: each 25-hour block = 1 billing day (12-Hour
// bookings are always auto-calculated to fit inside a single block).
//
// NOTE: unlike the fee amounts above, this 22h/25h rule stays a hardcoded
// constant on purpose (see systemSettings model comment on the admin side)
// — it's a unit definition Booking.jsx's date pickers already hardcode
// separately, not an adjustable price.
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

// ── Percentage fees (service + gateway) ─────────────────────────────────────
// PURE function — no Firestore, so it is trivially testable.
//
//   serviceFee  = serviceFeePercent % of the RENTAL FEE ONLY
//                 (not the extra fee, driver's fee or security deposit)
//   gatewayBase = rental + extra + driver's fee + serviceFee + securityDeposit
//                 (everything else on the booking, including the service fee)
//   gatewayFee  = gatewayFeePercent % of gatewayBase
//   grandTotal  = gatewayBase + gatewayFee
//
// Each fee is rounded to a whole peso so the Partial split and the PayMongo
// amounts (which already assume whole pesos) keep working.
const pct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 0;
};
const computeFeeBreakdown = ({
  rentalFee = 0, extraFee = 0, driversFee = 0, securityDeposit = 0,
  serviceFeePercent = 0, gatewayFeePercent = 0,
} = {}) => {
  const rental  = Math.max(0, Number(rentalFee) || 0);
  const extra   = Math.max(0, Number(extraFee) || 0);
  const drivers = Math.max(0, Number(driversFee) || 0);
  const deposit = Math.max(0, Number(securityDeposit) || 0);
  const serviceRate = pct(serviceFeePercent);
  const gatewayRate = pct(gatewayFeePercent);

  const serviceFee  = Math.round(rental * serviceRate / 100);
  const gatewayBase = rental + extra + drivers + serviceFee + deposit;
  const gatewayFee  = Math.round(gatewayBase * gatewayRate / 100);
  const grandTotal  = gatewayBase + gatewayFee;

  return { serviceFee, gatewayFee, gatewayFeeBase: gatewayBase, grandTotal, serviceFeeRate: serviceRate, gatewayFeeRate: gatewayRate };
};

// ── Full fee breakdown for a booking ────────────────────────────────────────
// pricePerDay must come from the car's own carPricing doc (looked up by the
// caller using carID + durationType) — never from the client.
//
// ASYNC — awaits getSystemSettings() internally (cached, see above) to pull
// every fee amount from the admin-panel-controlled systemSettings doc.
const computeBookingFees = async ({ pricePerDay, startDateTime, endDateTime, durationType, destination, destinationCity, destinationProvince, driveType }) => {
  const settings = await getSystemSettings();
  const { days, diffHrs } = calcBillableDays(startDateTime, endDateTime, durationType);

  // No valid date range selected yet — nothing should be charged at all,
  // not even the "flat" fees (service/gateway/driver's), since those used
  // to slip through even with days === 0 and show a phantom price before
  // the customer had picked any dates.
  if (days === 0) {
    return { days: 0, diffHrs: 0, rentalFee: 0, extraFee: 0, driversFee: 0, serviceFee: 0, gatewayFee: 0, gatewayFeeBase: 0, serviceFeeRate: pct(settings.serviceFeePercent), gatewayFeeRate: pct(settings.gatewayFeePercent), securityDeposit: 0, grandTotal: 0 };
  }

  const rentalFee = days * (Number(pricePerDay) || 0);

  const baseArea = isBaseArea(destination, { destinationCity, destinationProvince }, settings.baseAreaKeywords);
  const extraFee   = baseArea ? 0 : settings.extraFeeOutsideArea;
  const driversFee = driveType === "chauffeur" ? (baseArea ? settings.driversFeeBaseArea : settings.driversFeeOutsideArea) : 0;

  // Refundable security deposit, charged up front with everything else.
  const securityDeposit = Math.max(0, Number(settings.securityDepositAmount) || 0);

  // Service fee = % of rental only; gateway fee = % of everything else
  // (including the service fee). See computeFeeBreakdown().
  const { serviceFee, gatewayFee, gatewayFeeBase, grandTotal, serviceFeeRate, gatewayFeeRate } = computeFeeBreakdown({
    rentalFee, extraFee, driversFee, securityDeposit,
    serviceFeePercent: settings.serviceFeePercent,
    gatewayFeePercent: settings.gatewayFeePercent,
  });

  return {
    days, diffHrs, rentalFee, extraFee, driversFee,
    serviceFee, gatewayFee,
    gatewayFeeBase, serviceFeeRate, gatewayFeeRate,
    securityDeposit, grandTotal,
  };
};

// ── Partial (50%) vs Full payment split ─────────────────────────────────────
// The refundable security deposit is always collected in full up front:
// Partial pays the deposit + 50% of everything else. securityDeposit = 0
// (older bookings) reduces this to the original plain 50% split.
const computePaymentSplit = (grandTotal, paymentAmount, securityDeposit = 0) => {
  const total = Number(grandTotal) || 0;
  const sec = Math.min(Math.max(0, Number(securityDeposit) || 0), total);
  const isPartial = String(paymentAmount).toLowerCase() !== "full";
  const payNow  = isPartial ? sec + Math.floor((total - sec) * 0.5) : total;
  const balance = Math.max(0, total - payNow);
  return { payNow, balance, methodOfPayment: isPartial ? "Partial" : "Full" };
};

// ── "How much of this payment has actually been paid?" badge/derivation ────
// Built on getPaymentBreakdown() — the same math the admin backend's
// computeAmounts() uses (identical copy, see paymentBreakdown.util.js) — so the
// customer-facing badge can never drift from the admin dashboard.
//
// keys: "due" (nothing paid yet) | "partial" (deposit paid, balance owed) |
//       "paid" | "failed" | "cancelled" | "refunded"
//
// This used to ignore the payment's own status: an unpaid ("pending") Full
// booking showed as "paid" and an unpaid Partial as "partial" (assuming the
// flat ₱1,000 deposit). Nothing counts as paid until the payment is confirmed.
const derivePaymentStatus = (payment) => {
  // discountAmount/refundDue are surfaced here (rather than dropped) so
  // customer-facing screens like MyBookings.jsx can show that a discount
  // was applied, not just the already-net balance/amountPaid figures.
  const discountAmount = Number(payment && payment.discountAmount) || 0;

  if (!payment) return { key: "due", balance: 0, amountPaid: 0, discountAmount: 0, refundDue: 0 };

  const status = String(payment.status || "").toLowerCase();
  if (status === "failed" || status === "rejected") return { key: "failed",    balance: 0, amountPaid: 0, discountAmount, refundDue: 0 };
  if (status === "cancelled")                       return { key: "cancelled", balance: 0, amountPaid: 0, discountAmount, refundDue: 0 };
  if (status === "refunded")                        return { key: "refunded",  balance: 0, amountPaid: 0, discountAmount, refundDue: 0 };

  const { amountPaid, balance, refundDue } = getPaymentBreakdown(payment);
  if (amountPaid <= 0) return { key: "due",     balance, amountPaid: 0, discountAmount, refundDue };
  if (balance <= 0)    return { key: "paid",    balance, amountPaid, discountAmount, refundDue };
  return                      { key: "partial", balance, amountPaid, discountAmount, refundDue };
};

module.exports = {
  isBaseArea,
  calcBillableDays,
  computeBookingFees,
  computeFeeBreakdown,
  computePaymentSplit,
  derivePaymentStatus,
  getSystemSettings,
  SETTINGS_DEFAULTS,
};