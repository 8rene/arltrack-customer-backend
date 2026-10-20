// What the CUSTOMER is allowed to see about a payment's staff discount.
//
// discountLedger.getDiscountView() is the staff view: it carries who gave the discount, every ledger event and the
// consistency check. None of that goes to a customer. This keeps only the figures and the payout state they need to
// understand where their discount went (see discountLedger.js for the model):
//
//   offBalance        came off what they still owed: the booking really costs this much less
//   usedForPenalties  was used to pay a penalty (after the deposit)
//   held              credit still held for them (the booking was already fully paid), returned after the trip
//   returned          credit already sent back (returnedInRefund of it went back inside a cancellation refund)
//   payout            where the credit's own payout stands: null | { state, amount, via, method, at }
//   priceOff          how much the booking total shown to the customer drops: the discount while it is "off balance",
//                     nothing for credit (they paid the full price; the credit is returned, not deducted).
//                     A legacy discount (given before the ledger) was refunded on the spot, so it keeps the old
//                     meaning: the whole discount.
//
// Pure functions: no Firestore.

const { getDiscountView } = require("./discountLedger.util");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;

/** payment doc + its paymentEntries rows -> the customer's discount object, or null when no discount was ever given. */
const buildCustomerDiscount = (payment, entries = []) => {
  const v = getDiscountView(payment, entries);
  if (!v) return null;

  if (!v.ledger) {
    return {
      ledger: false, status: "legacy", total: v.total, reason: payment.discountReason || null,
      offBalance: v.total, usedForPenalties: 0, held: 0, returned: 0, returnedInRefund: 0,
      payout: null, priceOff: v.total,
    };
  }

  const usedForPenalties = round2(v.appliedPenalty);
  // Taken from the stored figures (applied = off the balance + on penalties), so it still adds up when the rows
  // could not be read.
  const offBalance = round2(Math.max(0, v.applied - usedForPenalties));
  const cr = v.creditReturn;
  return {
    ledger: true,
    status: v.status,                 // applied | held | partly_returned | returned
    total: v.total,
    reason: payment.discountReason || null,
    offBalance,
    usedForPenalties,
    held: v.credit,
    returned: v.returned,
    returnedInRefund: round2(v.returnedInRefund),
    payout: cr ? { state: cr.state, amount: cr.amount, via: cr.via, method: cr.method, at: cr.at } : null,
    priceOff: offBalance,
  };
};

/** The pesos to take off the booking total the customer sees. Works with or without the full discount object. */
const discountPriceOff = (payment, discount) => {
  if (discount && typeof discount.priceOff === "number") return discount.priceOff;
  return num(payment && payment.discountAmount);
};

module.exports = { buildCustomerDiscount, discountPriceOff };
