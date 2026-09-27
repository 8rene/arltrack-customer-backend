const { db } = require("../../config/firebaseConnection/firebase");

// Read-only from the customer's side — penalties are only ever created,
// confirmed, or settled from the admin app. This endpoint exists so
// MyBookings/BookingDetails can show the "Penalties" box described in the
// design: starts at the deposit amount, lists each CONFIRMED penalty
// (drafts are never shown to the customer), and the running balance.
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
      db.collection("penalties")
        .where("bookingID", "==", bookingID)
        .where("status", "==", "Confirmed") // never expose drafts/voided to the customer
        .get(),
      // Payments store bookingID as a field — the booking doc does NOT
      // store paymentID, so this has to be a query, not a direct doc()
      // lookup. See admin-backend/services/penalty/penalty.service.js's
      // getPaymentByBookingID for the same lookup on the admin side.
      db.collection("payments").where("bookingID", "==", bookingID).limit(1).get(),
    ]);

    const paymentDoc = paymentSnap.empty ? null : paymentSnap.docs[0];

    const penalties = penaltiesSnap.docs.map((d) => {
      const p = d.data();
      return {
        penaltyID: p.penaltyID,
        lineItems: p.lineItems || [],
        amount: p.amount,
        paidAmount: p.paidAmount || 0,
        paymentMethod: p.paymentMethod || "",
        confirmedAt: p.confirmedAt || null,
      };
    });

    const deposit = paymentDoc?.exists ? paymentDoc.data().deposit : null;
    const depositAmount = deposit?.amount ?? null; // null = not yet collected, don't show a number
    const penaltyTotal = penalties.reduce((sum, p) => sum + p.amount, 0);
    const runningBalance = depositAmount !== null ? depositAmount - penaltyTotal : null;

    return res.status(200).json({
      data: {
        depositAmount,
        depositStatus: deposit?.status || "NotCollected",
        penalties,
        penaltyTotal,
        runningBalance, // can go negative — the customer's own "you owe" signal
        settlement: deposit?.settlement?.status ? deposit.settlement : null,
      },
    });
  } catch (err) {
    console.error("getMyBookingPenalties error:", err);
    return res.status(500).json({ message: "Failed to load penalties for this booking." });
  }
};

module.exports = { getMyBookingPenalties };