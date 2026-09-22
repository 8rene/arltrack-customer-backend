// Tiny PayMongo HTTP helper shared by the payment controller and the
// settlement util. Kept separate so both can call PayMongo without importing
// each other's (large) modules.
const axios = require("axios");

// Per PayMongo's API reference, checkout_sessions live under v1.
const PAYMONGO_V1 = "https://api.paymongo.com/v1";

const paymongoHeaders = () => ({
  "Content-Type":  "application/json",
  "Authorization": `Basic ${Buffer.from((process.env.PAYMONGO_SECRET_KEY || "") + ":").toString("base64")}`,
});

// Human label for the channel we sent to PayMongo (payment_method_types[0]).
const channelLabel = (channel) => {
  const c = String(channel || "").toLowerCase();
  if (c === "gcash")   return "GCash";
  if (c === "paymaya") return "Maya";
  if (c === "qrph")    return "QRPH";
  return channel ? String(channel) : "PayMongo";
};

/**
 * Asks PayMongo what happened to a checkout session.
 *
 * Returns { ok, notFound, paid, paymongoPaymentID, expired }:
 *   ok        false when we could NOT determine the answer (network error, 5xx,
 *             auth problem). Callers must treat that as "unknown", never as "unpaid".
 *   notFound  PayMongo says the session doesn't exist (404).
 *   paid      a payment on the session has status "paid".
 *   expired   the session is no longer payable (status expired, or 404).
 *
 * NOTE: the exact field PayMongo uses for "session expired" should be
 * confirmed once in PayMongo TEST mode — this checks attributes.status for
 * "expired" (case-insensitive) and treats a 404 as expired too.
 */
const retrieveCheckoutSession = async (sessionID) => {
  try {
    const res = await axios.get(`${PAYMONGO_V1}/checkout_sessions/${sessionID}`, { headers: paymongoHeaders(), timeout: 10000 });
    const attrs    = res.data?.data?.attributes || {};
    const payments = attrs.payments || [];
    const paidPay  = payments.find((pay) => pay.attributes?.status === "paid");
    const intentOK = attrs.payment_intent?.attributes?.status === "succeeded";
    const paid     = !!paidPay || intentOK;
    return {
      ok: true,
      notFound: false,
      paid,
      paymongoPaymentID: paidPay?.id || null,
      expired: !paid && String(attrs.status || "").toLowerCase() === "expired",
    };
  } catch (e) {
    if (e?.response?.status === 404) return { ok: true, notFound: true, paid: false, paymongoPaymentID: null, expired: true };
    console.error("retrieveCheckoutSession failed —", e?.response?.status, e?.response?.data || e.message);
    return { ok: false, notFound: false, paid: false, paymongoPaymentID: null, expired: false };
  }
};

module.exports = { axios, PAYMONGO_V1, paymongoHeaders, channelLabel, retrieveCheckoutSession };
