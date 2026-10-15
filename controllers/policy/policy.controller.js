// GET /api/policy  (public, no auth)
//
// The few admin-managed numbers the customer-facing Terms & Conditions / Booking
// Guidelines quote, so those pages always show what the system actually charges
// instead of a hardcoded figure that goes stale when an admin changes Settings:
//   depositAmount      the deposit that is NOT refunded on a late cancellation / no-show
//   serviceFeePercent  % of the rental fee
//   gatewayFeePercent  % of the booking total (incl. service fee + security deposit)
//   fullRefundHours    how far ahead of pickup a refund request still gets everything back
const { getSystemSettings } = require("../../utils/pricing");
const { REFUND_FULL_WINDOW_HOURS } = require("../../utils/payments/paymentBreakdown.util");

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);

// The numbers themselves — also used by the Terms & Conditions builder
// (utils/terms/terms.service.js) so the text and this endpoint never disagree.
const getPolicyValues = async () => {
  const s = await getSystemSettings(); // cached for ~60s
  return {
    depositAmount:     num(s.securityDepositAmount, 1000),
    serviceFeePercent: num(s.serviceFeePercent, 5),
    gatewayFeePercent: num(s.gatewayFeePercent, 5),
    fullRefundHours:   REFUND_FULL_WINDOW_HOURS,
  };
};

const getPolicySettings = async (req, res) => {
  try {
    return res.json(await getPolicyValues());
  } catch (error) {
    console.error("getPolicySettings error:", error.message);
    // Fail safe: the pages fall back to the same defaults.
    return res.json({ depositAmount: 1000, serviceFeePercent: 5, gatewayFeePercent: 5, fullRefundHours: REFUND_FULL_WINDOW_HOURS });
  }
};

module.exports = { getPolicySettings, getPolicyValues };
