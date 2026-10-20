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
  // Minimum gap between two chauffeur trips (see utils/drivers/driverCapacity.util.js). Admin-editable.
  driverBufferMinutes: 120,
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
// Both sides of the comparison are normalised first. A map pin returns the
// OpenStreetMap name ("City of Manila", "Quezon City") while the admin's keyword is
// just "manila", and the admin may have typed it with capitals ("Bulacan") — an
// exact compare on the raw strings silently treated those as OUTSIDE the base area
// and charged the extra / driver's outside-area fee. Normalising (lowercase, drop
// "City of" / "Province of" / the word "city") and then still requiring an EXACT
// match keeps "New Manila" (a Quezon City district) from matching "manila".
const normalizePlace = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/\b(city|province|municipality) of\b/g, " ")
    .replace(/\bcity\b/g, " ")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// `destinationCounty` is the geocoder's "county" field — for many PH addresses that is the
// PROVINCE (e.g. "Bulacan") while "state" is only the region ("Central Luzon"), so it
// is accepted as one more name to match against the keywords.
const isBaseArea = (destination, { destinationCity, destinationProvince, destinationCounty } = {}, baseAreaKeywords = SETTINGS_DEFAULTS.baseAreaKeywords) => {
  const keywords = (Array.isArray(baseAreaKeywords) ? baseAreaKeywords : [])
    .map(normalizePlace)
    .filter(Boolean);
  const city     = normalizePlace(destinationCity);
  const province = normalizePlace(destinationProvince);
  const county   = normalizePlace(destinationCounty);

  if (city || province || county) {
    return keywords.some((k) => city === k || province === k || county === k);
  }

  if (!destination) return true; // no destination given at all = treat as base area
  const d = String(destination).toLowerCase();
  return keywords.some((k) => d.includes(k));
};

// How the "outside the base area" charge works — it is ONE yes/no flag (like a checkbox):
// if the PICKUP or ANY destination (the main one or an additional stop) is outside the
// base area, the surcharge applies ONCE. More locations outside never add it again.
//   - Self-drive (no driver): the surcharge is the separate EXTRA FEE (+extraFeeOutsideArea).
//   - With a driver: the surcharge is already inside the DRIVER'S FEE — it is
//     driversFeeBaseArea normally and driversFeeOutsideArea when the flag is on
//     (e.g. 1,000 -> 1,500). No separate extra fee is added on top, so it is never charged twice.
// Pickup itself can be anywhere in the Philippines; the base area only changes fees.
const BASE_AREA_BASIS = "either";

// True only when the pin gave us a city/province AND neither matches a base-area
// keyword. A pin with no structured place (e.g. the in-store pickup, which is the
// shop itself) can't be judged, so it is never charged — the same "can't tell →
// don't charge" rule the destination fallback uses.
const isOutsideByPin = ({ city, province, county } = {}, baseAreaKeywords = SETTINGS_DEFAULTS.baseAreaKeywords) => {
  const keywords = (Array.isArray(baseAreaKeywords) ? baseAreaKeywords : []).map(normalizePlace).filter(Boolean);
  const c = normalizePlace(city);
  const p = normalizePlace(province);
  const n = normalizePlace(county);
  if (!c && !p && !n) return false;
  return !keywords.some((k) => c === k || p === k || n === k);
};

// Pickup / destination / overall outside-area flags for one booking.
//   destinationOutside — the main destination OR any additional stop is outside
//   pickupOutside      — the pickup is outside
//   outsideArea        — pickup or any destination outside (this is the one-time surcharge flag)
//   outsideDestinationIds — which destinations are outside: 'primary' for the main one, then
//                        each additional stop's own id (so the page can say "Destination 2")
// Additional stops without a map pin can't be judged, so they are never charged.
const computeAreaFlags = ({ destination, destinationCity, destinationProvince, destinationCounty, pickupCity, pickupProvince, pickupCounty, extraDestinations }, baseAreaKeywords) => {
  const mainOutside   = !isBaseArea(destination, { destinationCity, destinationProvince, destinationCounty }, baseAreaKeywords);
  const outsideExtraIds = (Array.isArray(extraDestinations) ? extraDestinations : [])
    .filter((d) => d && isOutsideByPin({ city: d.city, province: d.province, county: d.county }, baseAreaKeywords))
    .map((d) => d.id)
    .filter((id) => id != null && id !== "");
  const extraOutside  = (Array.isArray(extraDestinations) ? extraDestinations : [])
    .some((d) => d && isOutsideByPin({ city: d.city, province: d.province, county: d.county }, baseAreaKeywords));
  const outsideDestinationIds = [...(mainOutside ? ["primary"] : []), ...outsideExtraIds];
  const destinationOutside = mainOutside || extraOutside;
  const pickupOutside      = isOutsideByPin({ city: pickupCity, province: pickupProvince, county: pickupCounty }, baseAreaKeywords);
  const outsideArea        = pickupOutside || destinationOutside;
  return { pickupOutside, destinationOutside, outsideArea, outsideDestinationIds };
};

// What the booking page needs to explain the base area up front: the keywords to
// shade on the map, which location(s) count, and the three amounts that depend on it.
const getBaseAreaConfig = async () => {
  const settings = await getSystemSettings();
  return {
    baseAreaKeywords: (Array.isArray(settings.baseAreaKeywords) ? settings.baseAreaKeywords : []).map((k) => String(k).trim()).filter(Boolean),
    basis: BASE_AREA_BASIS,
    extraFeeOutsideArea:   Number(settings.extraFeeOutsideArea)   || 0,
    driversFeeBaseArea:    Number(settings.driversFeeBaseArea)    || 0,
    driversFeeOutsideArea: Number(settings.driversFeeOutsideArea) || 0,
  };
};

// ── Day count with the 22h/25h billing-block rule ──────────────────────────
// 22 Hours duration type: each billing day is a 22-hour rental PLUS a 2-hour
// buffer, i.e. one 24-hour cycle. Booking.jsx sets the return time to
// "pickup time - 2 hours" on the chosen end date, so a rental of N calendar
// days is (24 * N - 2) hours long. Billing therefore counts
// ceil((hours + 2) / 24), which gives exactly N days:
//     1 day  = 22h -> 1     2 days = 46h -> 2     3 days = 70h -> 3
// (The old rule, ceil(hours / 22), billed 46h as 3 days and 70h as 4 days,
// so the days shown at checkout did not match the dates the customer picked.)
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

  const days = durationType === "22 Hours"
    ? Math.max(1, Math.ceil((diffHrs + 2) / 24))
    : Math.max(1, Math.ceil(diffHrs / 25));
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

// ── Online payment (gateway) fee on a PENALTY ───────────────────────────────
// A penalty paid through PayMongo costs the business PayMongo's cut, so the customer is charged the same
// gatewayFeePercent as the booking (one setting for the owner to manage). Same rounding as computeFeeBreakdown:
// a whole peso. The fee is NOT part of the penalty: the penalty's amount stays what was charged for the
// lateness / damage, and the fee exists only on the online checkout (never for in-store or deposit-covered).
//   gatewayFee = round(penaltyAmount x gatewayFeePercent / 100)      total = penaltyAmount + gatewayFee
const computePenaltyGatewayFee = (penaltyAmount = 0, gatewayFeePercent = 0) => {
  const base = Math.max(0, Math.round((Number(penaltyAmount) || 0) * 100) / 100);
  const rate = pct(gatewayFeePercent);
  const gatewayFee = Math.round(base * rate / 100);
  return { penaltyAmount: base, gatewayFeeRate: rate, gatewayFee, total: Math.round((base + gatewayFee) * 100) / 100 };
};

// The fee for a whole penalty checkout: each unpaid penalty is charged at ITS OWN saved gatewayFeeRate (the % that was
// in System Settings when the penalty was created), on what it still owes. A penalty with no saved rate (created before
// this existed) uses the current setting instead. items: [{ penaltyID, owed, gatewayFeeRate }].
// Returns the per-penalty `lines` (kept on the checkout so settlement can give each penalty its own fee), the totals,
// and gatewayFeeRate = the one % shared by every line (null when the lines differ, 0 when nothing is charged).
const computePenaltyCheckoutFees = (items = [], fallbackPercent = 0) => {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const lines = items.map((it) => {
    const stored = it.gatewayFeeRate;
    const hasRate = stored !== undefined && stored !== null && stored !== "" && Number.isFinite(Number(stored));
    const f = computePenaltyGatewayFee(it.owed, hasRate ? stored : fallbackPercent);
    return { penaltyID: it.penaltyID, amount: f.penaltyAmount, rate: f.gatewayFeeRate, fee: f.gatewayFee };
  });
  const penaltyAmount = r2(lines.reduce((s, l) => s + l.amount, 0));
  const gatewayFee = r2(lines.reduce((s, l) => s + l.fee, 0));
  const rates = [...new Set(lines.map((l) => l.rate))];
  return {
    lines, penaltyAmount, gatewayFee, total: r2(penaltyAmount + gatewayFee),
    gatewayFeeRate: rates.length === 1 ? rates[0] : rates.length === 0 ? 0 : null,
  };
};

// ── Full fee breakdown for a booking ────────────────────────────────────────
// pricePerDay must come from the car's own carPricing doc (looked up by the
// caller using carID + durationType) — never from the client.
//
// ASYNC — awaits getSystemSettings() internally (cached, see above) to pull
// every fee amount from the admin-panel-controlled systemSettings doc.
const computeBookingFees = async ({ pricePerDay, startDateTime, endDateTime, durationType, destination, destinationCity, destinationProvince, destinationCounty, pickupCity, pickupProvince, pickupCounty, extraDestinations, driveType }) => {
  const settings = await getSystemSettings();
  // Without Driver (self-drive) can go anywhere, so the base-area check only applies to With Driver.
  // Self-drive bookings never get the outside-area flags or an extra fee; only number coding is checked.
  const areaFlags = driveType === "chauffeur"
    ? computeAreaFlags({ destination, destinationCity, destinationProvince, destinationCounty, pickupCity, pickupProvince, pickupCounty, extraDestinations }, settings.baseAreaKeywords)
    : { pickupOutside: false, destinationOutside: false, outsideArea: false, outsideDestinationIds: [] };
  const { days, diffHrs } = calcBillableDays(startDateTime, endDateTime, durationType);

  // No valid date range selected yet — nothing should be charged at all,
  // not even the "flat" fees (service/gateway/driver's), since those used
  // to slip through even with days === 0 and show a phantom price before
  // the customer had picked any dates.
  if (days === 0) {
    return { ...areaFlags, extraFeeOutsideArea: Number(settings.extraFeeOutsideArea) || 0, driversFeeBaseArea: Number(settings.driversFeeBaseArea) || 0, driversFeeOutsideArea: Number(settings.driversFeeOutsideArea) || 0, days: 0, diffHrs: 0, rentalFee: 0, extraFee: 0, driversFee: 0, serviceFee: 0, gatewayFee: 0, gatewayFeeBase: 0, serviceFeeRate: pct(settings.serviceFeePercent), gatewayFeeRate: pct(settings.gatewayFeePercent), securityDeposit: 0, grandTotal: 0 };
  }

  const rentalFee = days * (Number(pricePerDay) || 0);

  // ONE outside-area surcharge, charged once (pickup OR any destination outside):
  //   with a driver -> it is the higher driver's fee (no separate extra fee on top)
  //   self-drive    -> it is the separate extra fee
  const isChauffeur = driveType === "chauffeur";
  const extraFee   = (areaFlags.outsideArea && !isChauffeur) ? settings.extraFeeOutsideArea : 0;
  // The driver is paid PER DAY: each billable day costs the base-area rate (e.g. 1,000) or the outside-area rate
  // (e.g. 1,500), and the days add up (3 days x 1,000 = 3,000). The outside-area flag is still one yes/no for the booking.
  const driversFeePerDay = isChauffeur ? (areaFlags.outsideArea ? settings.driversFeeOutsideArea : settings.driversFeeBaseArea) : 0;
  const driversFee = driversFeePerDay * days;

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
    days, diffHrs, rentalFee, extraFee, driversFee, driversFeePerDay,
    // Where the "outside the base area" charge came from — the booking page uses
    // these to say WHICH location is outside (pickup and/or destination).
    ...areaFlags,
    extraFeeOutsideArea: Number(settings.extraFeeOutsideArea) || 0,
    // Both rates are always returned (even before dates/destination are picked)
    // so the booking page can show what "With Driver" costs up front.
    driversFeeBaseArea:    Number(settings.driversFeeBaseArea)    || 0,
    driversFeeOutsideArea: Number(settings.driversFeeOutsideArea) || 0,
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
  // "Full" and "Full Payment" (an older stored label) both mean pay everything now.
  const isPartial = !String(paymentAmount).toLowerCase().startsWith("full");
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
  isOutsideByPin,
  computeAreaFlags,
  getBaseAreaConfig,
  BASE_AREA_BASIS,
  calcBillableDays,
  computeBookingFees,
  computeFeeBreakdown,
  computePenaltyGatewayFee,
  computePenaltyCheckoutFees,
  computePaymentSplit,
  derivePaymentStatus,
  getSystemSettings,
  SETTINGS_DEFAULTS,
};