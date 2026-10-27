// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings/:bookingID/penalties
//
// Everything the customer's "Security Deposit & Penalties" card (BookingDetails.jsx) shows for ONE booking: the deposit,
// every penalty the customer was told about (with what it was for), what the held deposit / discount credit will pay,
// what is left to pay ONLINE and the online payment fee on it.
//
// The online payment figures come from planOnlinePayment() (penaltyPayment.util.js), the SAME function the checkout
// (createPenaltyPaymentLink) charges from, so the card can never show a different amount than PayMongo is asked for. That is
// also where the ₱1,000 rule lives: the online payment fee applies only to a penalty HIGHER than PENALTY_FEE_MIN_AMOUNT
// (utils/pricing.js). Nothing is worked out in the browser.
//
// Read-only. A penalty still under review (UnderReview) or rejected in review (Discarded) is never shown: the customer was
// not told about it (same rule as the receipts / statement).
// ─────────────────────────────────────────────────────────────────────────────
const { db } = require("../../config/firebaseConnection/firebase");
const {
  owedOn, listPendingCheckouts, heldDepositCover, planOnlinePayment,
} = require("../../utils/payments/penaltyPayment.util");
const { getSystemSettings } = require("../../utils/pricing");
const { getDepositView } = require("../../utils/payments/depositView.util");
const { getDiscountFigures, planSettlement } = require("../../utils/payments/discountLedger.util");

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toISO = (v) => {
  if (!v) return null;
  const d = typeof v.toDate === "function" ? v.toDate() : v._seconds !== undefined ? new Date(v._seconds * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const HIDDEN_STATUSES = ["UnderReview", "Discarded"];

const getMyBookingPenalties = async (req, res) => {
  const userID = req.user.userID;
  const { bookingID } = req.params;
  try {
    const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (bookingSnap.empty) return res.status(404).json({ message: "Booking not found." });
    if (bookingSnap.docs[0].data().userID !== userID) {
      return res.status(403).json({ message: "This booking does not belong to your account." });
    }

    const [penSnap, paySnap] = await Promise.all([
      db.collection("penalties").where("bookingID", "==", bookingID).get(),
      db.collection("payments").where("bookingID", "==", bookingID).limit(1).get(),
    ]);
    const payment = paySnap.empty ? null : paySnap.docs[0].data();

    // Only this customer's penalties, minus the ones they were never told about, oldest first.
    const docs = penSnap.docs
      .map((d) => ({ ...d.data(), id: d.id }))
      .filter((p) => p.userID === userID && !HIDDEN_STATUSES.includes(p.status) && !p.discardedFromReview)
      .sort((a, b) => String(toISO(a.createdAt) || "").localeCompare(String(toISO(b.createdAt) || "")));

    const penalties = docs.map((p) => {
      const items = Array.isArray(p.lineItems)
        ? p.lineItems.filter((i) => i && (i.description || num(i.amount))).map((i) => ({ description: i.description || "Charge", amount: num(i.amount) }))
        : [];
      const amount = num(p.amount);
      return {
        penaltyID: p.penaltyID || p.id,
        status: p.status || "Confirmed",
        amount,
        paidAmount: num(p.paidAmount),
        gatewayFeePaid: num(p.gatewayFeePaid),
        lineItems: items.length ? items : [{ description: "Penalty charge", amount }],
        createdAt: toISO(p.createdAt),
      };
    });

    // Confirmed penalties that still owe money, oldest first (the order settlement and the checkout use).
    const unpaidDocs = docs.filter((p) => (p.status || "Confirmed") === "Confirmed" && owedOn(p) > 0);
    const unpaid = round2(unpaidDocs.reduce((s, p) => s + owedOn(p), 0));

    // ── the deposit ──
    const dep = payment ? getDepositView(payment, { unpaid }) : null;
    const depositHeld = !!(dep && dep.status === "Held" && !dep.settlement);
    const depositSettled = !!(dep && dep.settled);
    const figures = payment ? getDiscountFigures(payment) : { credit: 0 };
    const creditHeld = depositHeld ? round2(figures.credit) : 0;   // discount credit only pays penalties while the deposit is held

    // What settling would do right now (held deposit first, then the credit). Only meaningful while the deposit is held.
    const plan = depositHeld
      ? planSettlement({
          depositAmount: dep.amount, alreadyApplied: dep.applied,
          penalties: unpaidDocs.map((p) => ({ id: p.penaltyID || p.id, owed: owedOn(p) })), credit: creditHeld,
        })
      : null;

    // How the deposit went back to the customer (the out-row in paymentEntries), once it has.
    let refundMethod = null;
    let refundedAt = null;
    if (depositSettled && dep.returnedAmount > 0 && payment.paymentID) {
      try {
        const rSnap = await db.collection("paymentEntries").where("paymentID", "==", payment.paymentID).get();
        const row = rSnap.docs.map((d) => d.data())
          .find((e) => e.direction === "out" && e.phase === "deposit_return" && e.status === "success");
        if (row) { refundMethod = row.method || null; refundedAt = toISO(row.settledAt) || toISO(row.processedAt) || toISO(row.createdAt); }
      } catch (e) { console.warn("getMyBookingPenalties: could not read the deposit return row:", e.message); }
    }

    // ── what is paid ONLINE, and the fee on it (same plan the checkout charges) ──
    let settings = {};
    let gatewayFeeKnown = true;
    try { settings = await getSystemSettings(); } catch (e) { gatewayFeeKnown = false; console.warn("getMyBookingPenalties: could not read settings:", e.message); }
    const cover = payment ? heldDepositCover(payment) : 0;   // held deposit + held credit: paid without going online, so no fee
    const online = planOnlinePayment(unpaidDocs, { depositCover: cover, fallbackPercent: settings.gatewayFeePercent });
    // The deposit pays first, then the credit: split what the plan says is covered between the two (as /user/profile does).
    const depositPart = Math.max(0, cover - creditHeld);
    const byDeposit = Math.min(depositPart, online.coveredByDeposit);
    const byCredit = round2(online.coveredByDeposit - byDeposit);

    let openCheckouts = {};
    try { openCheckouts = await listPendingCheckouts(userID); } catch (e) { console.warn("getMyBookingPenalties: could not read pending checkouts:", e.message); }

    return res.status(200).json({
      data: {
        // deposit
        depositAmount: dep ? dep.amount : null,
        depositStatus: dep ? dep.status : null,
        depositSettled,
        depositHeld,
        appliedToDeposit: dep ? dep.applied : 0,
        settlement: dep ? dep.settlement : null,
        // penalties
        penalties,
        deductedFromDeposit: depositSettled ? dep.deducted : depositHeld ? round2(dep.applied + plan.depositUsed) : 0,
        refundAmount: depositSettled ? dep.returnedAmount : depositHeld ? plan.depositReturn : 0,
        refundMethod, refundedAt,
        stillOwed: depositHeld ? plan.stillOwed : unpaid,
        // discount credit held for the customer
        creditHeld,
        coveredByCredit: depositHeld ? byCredit : 0,
        creditReturnPreview: depositHeld ? plan.creditReturn : 0,
        // the online payment: exactly what createPenaltyPaymentLink will charge
        onlinePaymentPending: !!openCheckouts[bookingID],
        coveredByDeposit: round2(byDeposit),
        payableNow: online.onlineDue,
        payableFee: online.gatewayFee,
        payableTotal: online.total,
        gatewayFeeRate: online.gatewayFeeRate,
        gatewayFeeKnown,
      },
    });
  } catch (error) {
    console.error("getMyBookingPenalties error:", error.message);
    return res.status(500).json({ message: "Failed to load penalties." });
  }
};

module.exports = { getMyBookingPenalties };