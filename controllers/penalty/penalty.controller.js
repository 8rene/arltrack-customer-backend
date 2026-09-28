const { db } = require("../../config/firebaseConnection/firebase");

// Firestore Timestamp | Date | string -> ISO string (or null), so the
// frontend never has to deal with {_seconds,_nanoseconds}.
const toISO = (v) => {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : v._seconds !== undefined ? new Date(v._seconds * 1000) : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

// Read-only from the customer's side — penalties are only ever created,
// voided/waived, or settled from the admin app. This endpoint feeds the
// "Security Deposit & Penalties" card on BookingDetails.
//
// What the customer needs to see, in order:
//   1. The deposit that was received.
//   2. Every penalty with WHAT it was for (each line item + amount) — plus
//      any that were later waived/voided, shown struck-through, since the
//      customer was already notified about them and would otherwise see
//      the charge just vanish.
//   3. How much of the deposit is (or was) deducted for those penalties.
//   4. How much they receive back — or how much they still owe.
//
// Money math mirrors the admin side (settleBooking / getDepositPosition):
// only CONFIRMED penalties count, and only what is still unpaid
// (amount - paidAmount) — a penalty already paid in store is not
// deducted from the deposit a second time.
//
// GET /api/bookings/:bookingID/penalties
const getMyBookingPenalties = async (req, res) => {
  const userID = req.user.userID;
  const { bookingID } = req.params;

  try {
    const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (bookingSnap.empty) return res.status(404).json({ message: "Booking not found." });
    const booking = bookingSnap.docs[0].data();
    if (booking.userID !== userID) {
      return res.status(403).json({ message: "This booking does not belong to your account." });
    }

    const [penaltiesSnap, paymentSnap] = await Promise.all([
      // No status filter on purpose: Confirmed drive the totals, Waived /
      // Voided are returned only so they can be shown as "removed".
      db.collection("penalties").where("bookingID", "==", bookingID).get(),
      // Payments store bookingID as a field — the booking doc does NOT
      // store paymentID, so this has to be a query, not a direct doc()
      // lookup. See admin-backend/services/penalty/penalty.service.js's
      // getPaymentByBookingID for the same lookup on the admin side.
      db.collection("payments").where("bookingID", "==", bookingID).limit(1).get(),
    ]);

    const paymentDoc = paymentSnap.empty ? null : paymentSnap.docs[0];

    const SHOWN = ["Confirmed", "Waived", "Voided"];
    const penalties = penaltiesSnap.docs
      .map((d) => d.data())
      .filter((p) => SHOWN.includes(p.status))
      .map((p) => ({
        penaltyID: p.penaltyID,
        status: p.status,
        // Each line item is one thing the customer was charged for.
        lineItems: (p.lineItems || []).map((i) => ({
          description: i.description || "Charge",
          amount: Number(i.amount) || 0,
        })),
        amount: Number(p.amount) || 0,
        paidAmount: Number(p.paidAmount) || 0,
        paymentMethod: p.paymentMethod || "",
        createdAt: toISO(p.confirmedAt || p.createdAt),
      }))
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    const confirmed = penalties.filter((p) => p.status === "Confirmed");
    const penaltyTotal = confirmed.reduce((s, p) => s + p.amount, 0);                       // everything charged
    const unpaidTotal  = confirmed.reduce((s, p) => s + Math.max(0, p.amount - p.paidAmount), 0); // still unpaid right now

    const deposit = paymentDoc?.exists ? paymentDoc.data().deposit : null;
    const depositAmount = deposit ? (deposit.amount ?? null) : null; // null = not yet collected, don't show a number
    const settlement = deposit?.settlement?.status ? deposit.settlement : null;

    let deductedFromDeposit = null;   // how much of the deposit went to penalties
    let refundAmount        = null;   // what the customer receives back (>= 0)
    let stillOwed           = 0;      // unpaid penalty money after the deposit
    let refundMethod        = null;
    let refundedAt          = null;

    if (depositAmount !== null) {
      if (settlement) {
        // Already settled — report what actually happened, not a recomputation.
        const net = settlement.net || 0;
        deductedFromDeposit = depositAmount - Math.max(0, net);
        refundAmount = Math.max(0, net);
        stillOwed = unpaidTotal; // includes anything raised after settling, minus anything paid since
        refundMethod = deposit.returned?.method || null;
        refundedAt = toISO(deposit.returned?.at || settlement.settledAt);
      } else {
        // Not settled yet — live preview of what settlement will do.
        deductedFromDeposit = Math.min(depositAmount, unpaidTotal);
        refundAmount = Math.max(0, depositAmount - unpaidTotal);
        stillOwed = Math.max(0, unpaidTotal - depositAmount);
      }
    } else {
      stillOwed = unpaidTotal; // no deposit on file: whatever is unpaid is owed outright
    }

    return res.status(200).json({
      data: {
        depositAmount,
        depositStatus: deposit?.status || "NotCollected",
        depositSettled: !!settlement,
        penalties,
        penaltyTotal,
        deductedFromDeposit,
        refundAmount,
        refundMethod,
        refundedAt,
        stillOwed,
        // Kept for older clients: signed deposit - unpaid penalties.
        runningBalance: depositAmount !== null ? depositAmount - unpaidTotal : null,
        settlement,
      },
    });
  } catch (err) {
    console.error("getMyBookingPenalties error:", err);
    return res.status(500).json({ message: "Failed to load penalties for this booking." });
  }
};

module.exports = { getMyBookingPenalties };