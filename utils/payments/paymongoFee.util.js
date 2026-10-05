// PayMongo's own transaction fee for a payment — read from PayMongo, never guessed.
//
// WHY: the gateway fee we charge the customer (a % of the booking, see
// utils/pricing.js) is NOT PayMongo's real cost. PayMongo takes its own
// percentage out of every online charge and keeps it even when the payment is
// refunded. This records what PayMongo ACTUALLY took, per payment, so the
// business can see its real processing cost.
//
// Every PayMongo payment resource carries `fee` and `net_amount` in centavos
// (the checkout_session.payment.paid webhook embeds it under
// attributes.payments[]; retrieving the checkout session returns the same).
// A booking can have up to TWO online charges (the deposit-phase charge and a
// later balance charge). Only three numbers are stored on the payment:
//   depositPaymongoFee, balancePaymongoFee, paymongoFeeTotal (= the two added up).
// Sales margin = gatewayFee (what the customer paid) − paymongoFeeTotal.
//
// Pure functions only (no Firestore / network) so they are trivially testable.

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const centavosToPesos = (c) => round2(num(c) / 100);

// A PayMongo payment resource ({ id, attributes: { amount, fee, … } })
// → { paymongoPaymentID, amount, fee } in PESOS, or null when PayMongo gave no
// fee (so callers record nothing rather than a false 0).
const chargeFromPaymentResource = (resource) => {
  const a = resource && resource.attributes;
  if (!a || a.fee === undefined || a.fee === null || !Number.isFinite(Number(a.fee))) return null;
  return { paymongoPaymentID: resource.id || null, amount: centavosToPesos(a.amount), fee: centavosToPesos(a.fee) };
};

// The paid payment out of a checkout session's payments[] (falls back to the first one).
const pickPaidPayment = (payments) => {
  const list = Array.isArray(payments) ? payments : [];
  return list.find((p) => p && p.attributes && p.attributes.status === "paid") || list[0] || null;
};

const FIELD = { deposit: "depositPaymongoFee", balance: "balancePaymongoFee" };

const hasFee = (payment, phase) => {
  const v = payment && payment[FIELD[phase === "balance" ? "balance" : "deposit"]];
  return v !== undefined && v !== null;
};

// The fields to write on the payments doc for ONE phase's charge, plus the
// running total across both phases. {} when there is nothing new to record
// (no fee from PayMongo, or this phase's fee is already saved — never overwritten).
const buildFeePatch = (payment, phase, charge) => {
  const ph = phase === "balance" ? "balance" : "deposit";
  if (!charge || hasFee(payment, ph)) return {};
  const merged = { ...payment, [FIELD[ph]]: charge.fee };
  return {
    [FIELD[ph]]: charge.fee,
    paymongoFeeTotal: round2(num(merged[FIELD.deposit]) + num(merged[FIELD.balance])),
  };
};

module.exports = { centavosToPesos, chargeFromPaymentResource, pickPaidPayment, buildFeePatch, hasFee, round2 };