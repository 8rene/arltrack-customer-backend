const { db } = require("../../config/firebaseConnection/firebase");
const { derivePaymentStatus, computePaymentSplit } = require("../../utils/pricing");
const { hydratePaymentData, getEntriesForPaymentIDs } = require("../../utils/payments/paymentEntries.util");
const { buildCustomerDiscount } = require("../../utils/payments/discountView.util");
const { getTermsVersionByID } = require("../../utils/terms/terms.service");
const { plateForBooking } = require("../../utils/bookings/plateVisibility.util");

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
// Firestore Timestamp / Date / ISO string -> ISO string (null if empty)
const toISO = (v) => {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

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
    let carPlate = "";
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
        carPlate = car.plateNumber || "";
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
      // The money math reads the row-hydrated view (balanceCollected comes from the balance entry); if the rows
      // could not be read (h is empty) it falls back to the document, as the rest of this block does.
      const hp = Object.keys(h).length ? h : p;
      const { balance } = derivePaymentStatus(hp);
      // The customer-facing discount summary (see utils/payments/discountView.util.js). Needs the payment's rows to split
      // what was used on the balance from what was used on a penalty; without them the held / returned figures still
      // come from the payment, so this never fails the page.
      let discount = null;
      if (Number(hp.discountAmount) > 0) {
        let rows = [];
        try {
          const key = p.paymentID || p.originalId || paymentSnap.docs[0].id;
          rows = (await getEntriesForPaymentIDs([key])).get(key) || [];
        } catch (rowsErr) {
          console.warn("getBookingDetails: could not read discount rows:", rowsErr.message);
        }
        discount = buildCustomerDiscount(hp, rows);
      }
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
        // Where the discount stands for the customer (null = none): off the balance / held as credit / used for a penalty /
        // returned, plus the payout state. `discount.priceOff` is what to subtract from the total, not discountAmount.
        discount,
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
        paymentStatus:     derivePaymentStatus(hp),
        balanceDue:        balance,
      };
    }

    // The Terms & Conditions accepted for this booking: termsVersionID (the version number is
    // read from that termsVersions doc). viewID is what /terms?v=<viewID> opens.
    let terms = null;
    if (booking.termsVersionID) {
      let version = null;
      try {
        const tv = await getTermsVersionByID(booking.termsVersionID);
        version = tv ? tv.version : null;
      } catch (e) {
        console.warn("getBookingDetails terms lookup failed:", e.message);
      }
      terms = {
        acceptedAt:     toISO(booking.termsAcceptedAt),
        termsVersionID: booking.termsVersionID,
        version,
        viewID:         booking.termsVersionID,
      };
    }

    return res.status(200).json({
      booking: {
        bookingID,
        carID:          booking.carID          || null,
        carName,
        carImage,
        // Plate number is only included once paid and within 24h of pickup (kept for history).
        ...plateForBooking(booking, carPlate),
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
      // What the customer accepted for this booking, and the coding warnings the system found
      // for the locations they picked (both written when the booking was created).
      terms,
      codingWarnings: session?.codingWarnings || [],
      payment,
    });
  } catch (error) {
    console.error("getBookingDetails error:", error);
    return res.status(500).json({ message: "Failed to fetch booking details." });
  }

};

// GET /api/bookings/:bookingID/arrival
//
// The temporary "your driver is on the way" page. Owner-only, chauffeur bookings only, and served ONLY while the driver is
// en route: the driver tapped "On my way" (booking.enRouteAt is set, by the admin app) and the booking is still "upcoming".
// Start Pickup turns the booking "ongoing", which closes the window by itself.
// It returns the car, its plate number and the driver's first name. NO position: customers never see live position (see
// getBookingDetails above), and the car is not tracked before pickup anyway.
const getArrival = async (req, res) => {
  const { bookingID } = req.params;
  try {
    const booking = await loadOwnedBooking(req, res, bookingID);
    if (!booking) return; // response already sent

    if (!String(booking.modeOfDriving || "").toLowerCase().includes("chauffeur")) {
      return res.status(404).json({ message: "This booking has no driver.", reason: "no_driver" });
    }
    if (String(booking.status || "").toLowerCase() !== "upcoming") {
      return res.status(410).json({ message: "This page is only available while your driver is on the way.", reason: "closed" });
    }
    if (!booking.enRouteAt) {
      return res.status(404).json({ message: "Your driver hasn't left yet. You'll get a notification when they do.", reason: "not_on_the_way" });
    }

    let carName = "Unknown Vehicle", carImage = "", carPlate = "";
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
        carPlate = car.plateNumber || "";
      }
      const imgSnap = await db.collection("carImages")
        .where("carID", "==", booking.carID)
        .where("isPrimary", "==", true)
        .limit(1)
        .get();
      if (!imgSnap.empty) carImage = imgSnap.docs[0].data().imageURL || "";
    }

    // Where the car is heading: the customer's own pickup pin, as text only.
    let pickupAddress = null;
    try {
      const sessionSnap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
      const pin = sessionSnap.empty ? null : sessionSnap.docs[0].data().pickupLocation;
      pickupAddress = (pin && (pin.address || pin.name || pin.label)) || null;
    } catch (e) {
      console.warn("getArrival: could not read the pickup pin:", e.message);
    }

    // Plate through the same rule as everywhere else: with enRouteAt set it is shown.
    const { plateNumber } = plateForBooking(booking, carPlate);

    return res.status(200).json({
      bookingID,
      carName,
      carImage,
      plateNumber,
      driverFirstName: booking.enRouteDriverFirstName || "",
      enRouteAt:       toISO(booking.enRouteAt),
      startDateTime:   booking.startDateTime || null,
      pickupAddress,
    });
  } catch (error) {
    console.error("getArrival error:", error);
    return res.status(500).json({ message: "Failed to load the arrival page." });
  }
};

module.exports = { getBookingDetails, getArrival };