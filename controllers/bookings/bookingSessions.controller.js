const { db } = require("../../config/firebaseConnection/firebase");
const { derivePaymentStatus, computePaymentSplit } = require("../../utils/pricing");
const { hydratePaymentData } = require("../../utils/payments/paymentEntries.util");

// Shared ownership check — same pattern as cancelBooking in bookings.controller.js.
// Returns the booking data if the requester owns it, or null and writes the
// appropriate error response itself.
const loadOwnedBooking = async (req, res, bookingID) => {
  const bookingDoc = await db.collection("bookings").doc(bookingID).get();
  if (!bookingDoc.exists) {
    res.status(404).json({ message: "Booking not found." });
    return null;
  }
  const booking = bookingDoc.data();
  if (booking.userID !== req.user.userID) {
    res.status(403).json({ message: "Access denied." });
    return null;
  }
  return booking;
};

// GET /api/bookings/:bookingID/details
//
// Everything BookingDetails.jsx needs in one call: the commercial booking
// record (dates, status, driver mode, fee) plus its session's pins
// (pickup/dropoff/destination/extra stops). There was no single-booking-by-ID
// endpoint before this — only the list-all-for-user one — so this is new,
// not a rename. Deliberately excludes currentPosition — customers never see
// live position, on principle, not just hidden in the UI.
const getBookingDetails = async (req, res) => {
  const { bookingID } = req.params;
  try {
    const booking = await loadOwnedBooking(req, res, bookingID);
    if (!booking) return; // response already sent

    // The booking doc itself only stores carID — carName/carImage never
    // lived there. getUserBookings resolves this the same way (car doc ->
    // brandID/modelID -> brand/model collections, + carImages by carID);
    // this endpoint was reading booking.carName/booking.carImage directly,
    // which never existed, hence "Unknown Vehicle" / no image every time.
    let carName  = "Unknown Vehicle";
    let carImage = "";
    if (booking.carID) {
      const carDoc = await db.collection("cars").doc(booking.carID).get();
      if (carDoc.exists) {
        const car = carDoc.data();
        const [brandDoc, modelDoc] = await Promise.all([
          car.brandID ? db.collection("brand").doc(car.brandID).get() : null,
          car.modelID ? db.collection("model").doc(car.modelID).get() : null,
        ]);
        const brand = brandDoc?.exists ? (brandDoc.data().brandName || "") : "";
        const model = modelDoc?.exists ? (modelDoc.data().modelName || "") : "";
        carName = `${brand} ${model}`.trim() || "Unknown Vehicle";
      }
      const imgSnap = await db.collection("carImages")
        .where("carID", "==", booking.carID)
        .where("isPrimary", "==", true)
        .limit(1)
        .get();
      if (!imgSnap.empty) carImage = imgSnap.docs[0].data().imageURL || "";
    }

    const sessionSnap = await db.collection("bookingSessions")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    const session = sessionSnap.empty ? null : sessionSnap.docs[0].data();

    // Payment record — same collection/shape getUserBookings already reads
    // for MyBookings.jsx. This page never fetched it before, which is why
    // it never showed anything about payment (pending, paid, cancelled, etc).
    const paymentSnap = await db.collection("payments")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();

    let payment = null;
    if (!paymentSnap.empty) {
      const p = paymentSnap.docs[0].data();
      // paidAt moved into paymentEntries rows once a payment is confirmed. A display field must never fail
      // this page, so fall back to the document.
      let h = {};
      try {
        h = await hydratePaymentData(p, paymentSnap.docs[0].id);
      } catch (hydrateErr) {
        console.warn("getBookingDetails: could not read paymentEntries, using the payment document:", hydrateErr.message);
      }
      const { balance } = derivePaymentStatus(p);
      payment = {
        paymentID:         p.paymentID        || paymentSnap.docs[0].id,
        amount:            p.amount           || 0,
        rentalFee:         p.rentalFee        || 0,
        serviceFee:        p.serviceFee       || 0,
        extraFee:          p.extraFee         || 0,
        driversFee:        p.driversFee       || 0,
        gatewayFee:        p.gatewayFee       || 0,
        serviceFeeRate:    p.serviceFeeRate   || 0,
        gatewayFeeRate:    p.gatewayFeeRate   || 0,
        gatewayFeeBase:    p.gatewayFeeBase   || 0,
        securityDeposit:   p.securityDeposit  || 0,
        methodOfPayment:   p.methodOfPayment  || p.paymentMethod || "",
        paymentMethod:     p.paymentMethod    || p.methodOfPayment || "",
        status:            p.status           || "pending",
        // Two-phase payment fields (see utils/bookings/bookingStatus.util.js)
        // — lets the frontend offer "Complete Payment" for a still-pending
        // deposit OR a still-pending balance, not just the deposit.
        payNow:            computePaymentSplit(p.amount, p.methodOfPayment, p.securityDeposit).payNow,
        balanceAmount:     p.balanceAmount    || 0,
        balanceStatus:     p.balanceStatus    || "not_applicable",
        currentPhase:      p.currentPhase     || "deposit",
        // Staff discount (see admin applyDiscount) — getUserBookings already
        // sends this to MyBookings.jsx (see bookings.controller.js), but this
        // endpoint built its own separate payment object and never copied it
        // over, so BookingDetails.jsx had no discount data to show at all.
        discountAmount:    Number(p.discountAmount) || 0,
        // Lets the frontend offer a "Complete Payment" link while a
        // PayMongo checkout session is still open for this payment.
        checkoutUrl:       p.checkoutUrl      || null,
        createdAt:         p.createdAt        || null,
        paidAt:            h.paidAt           || p.paidAt || null,
        // "Email My Receipt" cooldown — lets the frontend keep the button
        // disabled with an accurate countdown across page reloads, not
        // just for the lifetime of one React state. See receipt.controller.js.
        lastReceiptSentAt: p.lastReceiptSentAt || null,
        // Was previously computed inline in BookingDetails.jsx — now the
        // server's own math.
        paymentStatus:     derivePaymentStatus(p),
        balanceDue:        balance,
      };
    }

    return res.status(200).json({
      booking: {
        bookingID,
        carID:          booking.carID          || null,
        carName,
        carImage,
        serviceType:    booking.serviceType    || "",
        status:         booking.status         || "pending",
        modeOfDriving:  booking.modeOfDriving  || "",
        startDateTime:  booking.startDateTime  || null,
        endDateTime:    booking.endDateTime    || null,
        totalDays:      booking.totalDays      || 1,
        // The real total only ever lives on the payment record's `amount`
        // (see getUserBookings, which does the exact same thing). 0 only
        // if there's genuinely no payment yet.
        totalFee:       payment?.amount        || 0,
      },
      // Pins — null if this booking predates the coordinate-capture change,
      // or if the customer typed an address without using the map.
      pickupLocation:     session?.pickupLocation  || null,
      dropoffLocation:    session?.dropoffLocation || null, // always == pickupLocation now, but session was written before that rule in older bookings
      geofenceZones:      session?.geofenceZones  || [],
      payment,
    });
  } catch (error) {
    console.error("getBookingDetails error:", error);
    return res.status(500).json({ message: "Failed to fetch booking details." });
  }

};

module.exports = { getBookingDetails };