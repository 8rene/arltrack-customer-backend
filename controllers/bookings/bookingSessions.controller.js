const { db } = require("../../config/firebaseConnection/firebase");
const { derivePaymentStatus } = require("../../utils/pricing");

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

// GET /api/bookings/:bookingID/traceback
//
// Reads bookingSessions/{bookingID}/archive/{date} — one small doc per
// calendar day of the trip (each holding just that day's points), written
// by the admin backend at return/stolen (or nightly for a trip still active
// past midnight). Concatenating them in date order reconstructs the full
// trail without ever reading one document large enough to risk Firestore's
// 1MiB-per-document limit — that's the whole reason it's chunked by day
// instead of one big array.
const getBookingTraceback = async (req, res) => {
  const { bookingID } = req.params;
  try {
    const booking = await loadOwnedBooking(req, res, bookingID);
    if (!booking) return; // response already sent

    const sessionSnap = await db.collection("bookingSessions")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    if (sessionSnap.empty) {
      return res.status(404).json({ message: "No tracking session for this booking yet." });
    }
    const sessionRef = sessionSnap.docs[0].ref; // own bookingSessionID — bookingID is FK only now

    // Doc IDs are "YYYY-MM-DD" strings, so sorting by document ID in JS is
    // the same as sorting by date — no separate date field to order by, and
    // no need for a Firestore orderBy() import for what's always a small
    // number of day-docs per trip.
    const archiveSnap = await sessionRef
      .collection("archive")
      .get();

    if (archiveSnap.empty) {
      // Not an error — a trip that's still ongoing (or just hasn't been
      // archived yet) legitimately has nothing here.
      return res.status(200).json({ points: [], message: "No archived trail yet for this booking." });
    }

    const points = archiveSnap.docs
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .flatMap((doc) => {
        const data = doc.data();
        return Array.isArray(data.points) ? data.points : [];
      });

    return res.status(200).json({ points });
  } catch (error) {
    console.error("getBookingTraceback error:", error);
    return res.status(500).json({ message: "Failed to fetch traceback." });
  }
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
      const carDoc = await db.collection("car").doc(booking.carID).get();
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
      const { balance } = derivePaymentStatus(p);
      payment = {
        paymentID:         p.paymentID        || paymentSnap.docs[0].id,
        amount:            p.amount           || 0,
        depositFee:        p.depositFee       || 0,
        rentalFee:         p.rentalFee        || 0,
        serviceFee:        p.serviceFee       || 0,
        extraFee:          p.extraFee         || 0,
        driversFee:        p.driversFee       || 0,
        gatewayFee:        p.gatewayFee       || 0,
        methodOfPayment:   p.methodOfPayment  || p.paymentMethod || "",
        paymentMethod:     p.paymentMethod    || p.methodOfPayment || "",
        referenceNumber:   p.referenceNumber  || "",
        proofUrl:          p.proofUrl         || "",
        status:            p.status           || "pending",
        // Lets the frontend offer a "Complete Payment" link while a
        // PayMongo checkout session is still open for this payment.
        checkoutUrl:       p.checkoutUrl      || null,
        createdAt:         p.createdAt        || null,
        paidAt:            p.paidAt           || null,
        // Was previously computed inline in BookingDetails.jsx as
        // Math.max(0, amount - depositFee) — now the server's own math.
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
        // The booking doc's own totalFee is always 0 — the real total only
        // ever lives on the payment record's `amount` (see getUserBookings,
        // which does the exact same fallback). Fall back to 0 only if
        // there's genuinely no payment yet.
        totalFee:       payment?.amount        || booking.totalFee || 0,
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

module.exports = { getBookingTraceback, getBookingDetails };
