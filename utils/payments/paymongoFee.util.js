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
// later balance charge) — each one's fee is saved on its own, and the totals
// below ADD THEM UP.
//
// VAT: PayMongo does not report VAT as a separate number on the payment. We
// store an ESTIMATE of the VAT inside the fee (fee × rate ÷ (100 + rate),
// default 12%) and label it as an estimate. Whether PayMongo's fee is VAT-
// inclusive is something to confirm on your PayMongo statement — set
// PAYMONGO_FEE_VAT_RATE=0 to turn the estimate off. If PayMongo ever sends a
// `taxes` list on the payment, it is stored raw alongside.
//
// Pure functions only (no Firestore / network) so they are trivially testable.

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const centavosToPesos = (c) => round2(num(c) / 100);

const vatRate = () => {
  const r = Number(process.env.PAYMONGO_FEE_VAT_RATE);
  return Number.isFinite(r) && r >= 0 ? r : 12;
};

// VAT contained in a VAT-INCLUSIVE fee: fee × rate ÷ (100 + rate).
const estimateIncludedVat = (fee, rate = vatRate()) => round2((num(fee) * rate) / (100 + rate));

// A PayMongo payment resource ({ id, attributes: { amount, fee, net_amount, … } })
// → { paymongoPaymentID, amount, fee, net, vatEstimate, taxes } in PESOS,
// or null when PayMongo gave no fee (so callers record nothing rather than a false 0).
const chargeFromPaymentResource = (resource) => {
  const a = resource && resource.attributes;
  if (!a || a.fee === undefined || a.fee === null || !Number.isFinite(Number(a.fee))) return null;
  const amount = centavosToPesos(a.amount);
  const fee    = centavosToPesos(a.fee);
  const net    = Number.isFinite(Number(a.net_amount)) ? centavosToPesos(a.net_amount) : round2(amount - fee);
  let taxes = null;
  if (Array.isArray(a.taxes) && a.taxes.length) {
    try { taxes = JSON.parse(JSON.stringify(a.taxes)); } catch { taxes = null; }
  }
  return { paymongoPaymentID: resource.id || null, amount, fee, net, vatEstimate: estimateIncludedVat(fee), taxes };
};

// The paid payment out of a checkout session's payments[] (falls back to the first one).
const pickPaidPayment = (payments) => {
  const list = Array.isArray(payments) ? payments : [];
  return list.find((p) => p && p.attributes && p.attributes.status === "paid") || list[0] || null;
};

const FIELD = {
  deposit: { fee: "depositPaymongoFee", vat: "depositPaymongoFeeVat", net: "depositPaymongoNet", taxes: "depositPaymongoTaxes" },
  balance: { fee: "balancePaymongoFee", vat: "balancePaymongoFeeVat", net: "balancePaymongoNet", taxes: "balancePaymongoTaxes" },
};

const hasFee = (payment, phase) => {
  const v = payment && payment[FIELD[phase === "balance" ? "balance" : "deposit"].fee];
  return v !== undefined && v !== null;
};

// The fields to write on the payments doc for ONE phase's charge, plus the
// running TOTALS across both phases. {} when there is nothing new to record
// (no fee from PayMongo, or this phase's fee is already saved — never overwritten).
const buildFeePatch = (payment, phase, charge, now = new Date()) => {
  const ph = phase === "balance" ? "balance" : "deposit";
  if (!charge || hasFee(payment, ph)) return {};
  const f = FIELD[ph];
  const patch = { [f.fee]: charge.fee, [f.vat]: charge.vatEstimate, [f.net]: charge.net };
  if (charge.taxes) patch[f.taxes] = charge.taxes;

  const merged = { ...payment, ...patch };
  const dep = FIELD.deposit, bal = FIELD.balance;
  patch.paymongoFeeTotal         = round2(num(merged[dep.fee]) + num(merged[bal.fee]));
  patch.paymongoFeeVatTotal      = round2(num(merged[dep.vat]) + num(merged[bal.vat]));
  patch.paymongoNetTotal         = round2(num(merged[dep.net]) + num(merged[bal.net]));
  patch.paymongoFeeVatIsEstimate = true;
  patch.paymongoFeeRecordedAt    = now;
  return patch;
};

module.exports = { centavosToPesos, estimateIncludedVat, chargeFromPaymentResource, pickPaidPayment, buildFeePatch, hasFee, round2 };
