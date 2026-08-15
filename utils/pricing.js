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
// Fee AMOUNTS (SERVICE_FEE, GATEWAY_FEE, DEPOSIT_FEE, extraFeeOutsideArea,
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

// Hardcoded fallback values — used ONLY if Firestore has no systemSettings
// doc yet, or the read fails. Kept identical to the original constants so
// behavior is unchanged for anyone who hasn't touched the admin panel yet.
const SETTINGS_DEFAULTS = {
  serviceFee: 50,
  gatewayFee: 53,
  depositFee: 1000,
  extraFeeOutsideArea: 500,
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
    return { days: 0, diffHrs: 0, rentalFee: 0, extraFee: 0, driversFee: 0, serviceFee: 0, gatewayFee: 0, grandTotal: 0, depositFee: settings.depositFee };
  }

  const rentalFee = days * (Number(pricePerDay) || 0);

  const baseArea = isBaseArea(destination, { destinationCity, destinationProvince }, settings.baseAreaKeywords);
  const extraFee   = baseArea ? 0 : settings.extraFeeOutsideArea;
  const driversFee = driveType === "chauffeur" ? (baseArea ? settings.driversFeeBaseArea : settings.driversFeeOutsideArea) : 0;

  const serviceFee = settings.serviceFee;
  const gatewayFee = settings.gatewayFee;

  const grandTotal = rentalFee + extraFee + driversFee + serviceFee + gatewayFee;

  return { days, diffHrs, rentalFee, extraFee, driversFee, serviceFee, gatewayFee, grandTotal, depositFee: settings.depositFee };
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
  getSystemSettings,
  SETTINGS_DEFAULTS,
};