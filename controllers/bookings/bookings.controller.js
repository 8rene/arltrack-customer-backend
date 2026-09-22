const { db, bucket } = require("../../config/firebaseConnection/firebase");
const createBookingSession = require("../../models/bookingSession/bookingSession.model");
const { makeZone } = createBookingSession;
const { computeBookingFees, computePaymentSplit, derivePaymentStatus } = require("../../utils/pricing");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");
const { BOOKING_STATUS, enforceToPayValidity } = require("../../utils/bookings/bookingStatus.util");
const { notifyStaff } = require("../../services/notification/notification.service");

// Look up a car's price-per-day for a given durationType straight from
// Firestore — this is the one place pricing numbers are allowed to come
// from. Never trust a price sent by the client.
const getPricePerDay = async (carID, durationType) => {
  if (!carID || !durationType) return 0;
  const snap = await db.collection("carPricing")
    .where("carID", "==", carID)
    .where("durationType", "==", durationType)
    .limit(1)
    .get();
  if (snap.empty) return 0;
  return Number(snap.docs[0].data().price) || 0;
};

// In-memory cache for stable data used by checkCodingRule.
// cars: keyed by carID (plateNumber almost never changes)
// codingRules: full collection, rarely updated
const codingCache = {
  cars:        {},   // { [carID]: plateNumber }
  codingRules: null, // full rules array
};

// Helper: detect MIME type from base64 magic bytes
const getMimeType = (base64) => {
  if (base64.startsWith("/9j/"))   return "image/jpeg";
  if (base64.startsWith("iVBOR"))  return "image/png";
  if (base64.startsWith("UklGR"))  return "image/webp";
  if (base64.startsWith("JVBERi")) return "application/pdf";
  return "image/jpeg"; // fallback
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/quote
// Body: { carID, duration, startDate, startTime, endDate, endTime, destination, driveType, paymentAmount }
//
// Server-side pricing preview for the booking form (Step 2-5 live summary).
// No auth required — same reasoning as /bookings/check-coding: it's called
// before the user necessarily has an account/session, and it doesn't write
// anything. This is what replaced the frontend's own calcDays()/fee math —
// the browser now just displays whatever this endpoint returns instead of
// computing pricing itself.
// ─────────────────────────────────────────────────────────────────────────────
const getBookingQuote = async (req, res) => {
  const { carID, duration, startDate, startTime, endDate, endTime, destination, destinationCity, destinationProvince, driveType, paymentAmount } = req.body;

  if (!carID || !duration) {
    return res.status(400).json({ message: "carID and duration are required." });
  }

  try {
    const pricePerDay = await getPricePerDay(carID, duration);

    const startDateTime = startDate && startTime ? new Date(`${startDate}T${startTime}:00`) : null;
    const endDateTime    = endDate && endTime     ? new Date(`${endDate}T${endTime}:00`)     : null;

    const fees = await computeBookingFees({
      pricePerDay,
      startDateTime,
      endDateTime,
      durationType: duration,
      destination,
      destinationCity,
      destinationProvince,
      driveType,
    });

    const split = computePaymentSplit(fees.grandTotal, paymentAmount);

    return res.status(200).json({ ...fees, ...split, pricePerDay });
  } catch (error) {
    console.error("getBookingQuote error:", error);
    return res.status(500).json({ message: "Failed to compute quote." });
  }
};

// POST /api/bookings/create
const createBooking = async (req, res) => {
  const userID = req.user.userID; // from verified JWT — never trust body
  const {
    carID,
    serviceType,
    serviceTypeID,
    duration,
    startDate,
    startTime,
    endDate,
    endTime,
    pickupLocation,
    dropoffLocation,
    destination,
    driveType,
    firstName,
    lastName,
    contact,
    email,
    specialNotes,
    paymentAmount,
    paymentMethod,
    referenceNumber,
    // NOTE: totalDays / rentalFee / extraFee / driversFee / serviceFee /
    // gatewayFee / grandTotal / depositFee / methodOfPayment are intentionally
    // NOT read from the request body anymore. Those used to be computed in
    // the browser (Booking.jsx) and simply trusted here (`Number(x) || 0`),
    // which meant anyone could edit the request and book a car for ₱0. They
    // are now recomputed below from the car's own Firestore pricing doc and
    // the booking's start/end times — the only numbers that matter are the
    // ones this server calculates itself.
    // Coordinates the frontend already sends for geofencing, previously
    // never read here — this is why pickupLocation/geofenceZones were
    // always saving as null on the bookingSessions doc.
    pickupLat,
    pickupLng,
    dropoffLat,
    dropoffLng,
    destinationLat,
    destinationLng,
    destinationCity,
    destinationProvince,
    extraDestinations,
    // screenshot handled separately (base64 or URL)
    proofBase64,
  } = req.body;

  if (!carID) {
    return res.status(400).json({ message: "carID is required." });
  }

  // ── Server-side guard: never trust the client's date fields ─────
  // The frontend calendar blocks past dates, but a request can still
  // reach this endpoint directly (stale localStorage draft, bypassed
  // UI, manual API call, etc). Reject anything dated before "today"
  // at the booking-day granularity so legit same-day bookings still work.
  if (startDate) {
    const todayDateOnly = new Date();
    todayDateOnly.setHours(0, 0, 0, 0);
    const requestedStartDateOnly = new Date(`${startDate}T00:00:00`);

    if (isNaN(requestedStartDateOnly.getTime()) || requestedStartDateOnly < todayDateOnly) {
      return res.status(400).json({ message: "startDate cannot be in the past." });
    }
  }
  if (endDate) {
    const todayDateOnly = new Date();
    todayDateOnly.setHours(0, 0, 0, 0);
    const requestedEndDateOnly = new Date(`${endDate}T00:00:00`);

    if (isNaN(requestedEndDateOnly.getTime()) || requestedEndDateOnly < todayDateOnly) {
      return res.status(400).json({ message: "endDate cannot be in the past." });
    }
  }

  try {
    const now = new Date();

    // Build startDateTime and endDateTime
    const startDateTime = startDate && startTime
      ? new Date(`${startDate}T${startTime}:00`)
      : now;
    const endDateTime = endDate && endTime
      ? new Date(`${endDate}T${endTime}:00`)
      : startDateTime;

    // ── Authoritative fee calculation — never trust client-sent totals ──
    const pricePerDay = await getPricePerDay(carID, duration);
    const fees = await computeBookingFees({
      pricePerDay,
      startDateTime,
      endDateTime,
      durationType: duration,
      destination,
      destinationCity,
      destinationProvince,
      driveType,
    });
    const { payNow, methodOfPayment: computedMethod } = computePaymentSplit(fees.grandTotal, paymentAmount);

    const totalFee    = fees.rentalFee;
    const depositPaid = fees.depositFee; // always ₱1,000
    const extra       = fees.extraFee;
    const drivers     = fees.driversFee;
    const service     = fees.serviceFee;
    const gateway     = fees.gatewayFee;
    const totalAmount = fees.grandTotal;

    // ── Max rental length guard ──────────────────────────────────
    // Bookings of 10 billable days or more are not allowed. fees.days is
    // computed above from the server's own start/end datetimes, so this
    // can't be bypassed by sending a different `duration`/date combo than
    // what the calendar UI would allow.
    const MAX_BOOKING_DAYS = 10;
    if (fees.days >= MAX_BOOKING_DAYS) {
      return res.status(400).json({
        message: `Bookings of ${MAX_BOOKING_DAYS} days or more are not allowed. Please choose a shorter rental period or contact us directly for long-term rentals.`,
      });
    }

    // ── 0. Coding rule check (server-side enforcement) ──────────
    // Blocks booking if the booking window (startDateTime → endDateTime)
    // OVERLAPS with a coding rule window for the destination city.
    const codingViolation = await (async () => {
      try {
        const carDoc = await db.collection("cars").doc(carID).get();
        if (!carDoc.exists) return null;
        const plateNumber = (carDoc.data().plateNumber || "").trim().toUpperCase();
        if (!plateNumber) return null;
        const lastDigit = parseInt(plateNumber[plateNumber.length - 1], 10);
        if (isNaN(lastDigit)) return null;

        const dayOfWeek = startDateTime.getDay();

        // Holiday check — if the start date is a public holiday, coding is suspended
        // holidayDate is stored as a Firestore Timestamp, so we query by day range
        const _hDayStart = new Date(startDateTime); _hDayStart.setHours(0, 0, 0, 0);
        const _hDayEnd   = new Date(startDateTime); _hDayEnd.setHours(23, 59, 59, 999);
        const holidaySnap = await db.collection("holidays")
          .where("holidayDate", ">=", _hDayStart)
          .where("holidayDate", "<=", _hDayEnd)
          .limit(1)
          .get();
        if (!holidaySnap.empty) {
          return null; // holiday → no coding restriction applies
        }

        // Booking window in minutes-from-midnight (start of booking day)
        const bookingStartMins = startDateTime.getHours() * 60 + startDateTime.getMinutes();
        // If end is on a later calendar day, treat end-of-day as 23:59
        let bookingEndMins;
        const startDay = startDateTime.toISOString().split("T")[0];
        const endDay   = endDateTime.toISOString().split("T")[0];
        if (endDay > startDay) {
          bookingEndMins = 23 * 60 + 59;
        } else {
          bookingEndMins = endDateTime.getHours() * 60 + endDateTime.getMinutes();
        }

        const parseTime = (t) => {
          if (!t) return null;
          const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
          if (!m) return null;
          let h = parseInt(m[1], 10);
          const mn = parseInt(m[2], 10);
          if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
          if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
          return h * 60 + mn;
        };

        // Use shared cache — same rules array as checkCodingRule endpoint
        if (!codingCache.codingRules) {
          const rulesSnap = await db.collection("codingRules").get();
          codingCache.codingRules = rulesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        }
        for (const rule of codingCache.codingRules) {

          // Day-of-week match (JS: 0=Sun,1=Mon,...6=Sat)
          const ruleDayOfWeek = Number(rule.dayOfWeek);
          if (isNaN(ruleDayOfWeek) || ruleDayOfWeek !== dayOfWeek) continue;

          // City match — prefer exact match on the structured city (from the
          // map pin) over the fuzzy substring search on the free-text address.
          if (rule.city && rule.city.trim() !== "") {
            const ruleCity = rule.city.toLowerCase().trim();
            let cityMatches;
            if (destinationCity && destinationCity.trim() !== "") {
              cityMatches = destinationCity.toLowerCase().trim() === ruleCity;
            } else {
              const dest = (destination || "").toLowerCase();
              cityMatches = dest.includes(ruleCity);
            }
            if (!cityMatches) continue;
          }

          // Overlap check
          const rStart = parseTime(rule.startTime);
          const rEnd   = parseTime(rule.endTime);
          if (rStart === null || rEnd === null) continue;

          const overlaps = bookingStartMins < rEnd && bookingEndMins > rStart;
          if (!overlaps) continue;

          // bannedDigits — handle array of strings or numbers, or single value
          let banned = [];
          if (Array.isArray(rule.bannedDigits)) {
            banned = rule.bannedDigits.map(Number).filter(n => !isNaN(n));
          } else if (rule.bannedDigits !== undefined && rule.bannedDigits !== null) {
            const single = Number(rule.bannedDigits);
            if (!isNaN(single)) banned = [single];
          }

          if (banned.includes(lastDigit)) {
            return `This vehicle (plate ending in ${lastDigit}) is not allowed under the Number Coding Scheme in ${rule.city || "this area"} on ${rule.dayName || "this day"} from ${rule.startTime} to ${rule.endTime}. Your booking overlaps with this restriction. Please choose a different date, time, or another vehicle.`;
          }
        }
        return null;
      } catch (e) {
        console.warn("Coding rule check skipped:", e.message);
        return null;
      }
    })();

    if (codingViolation) {
      return res.status(400).json({ message: codingViolation, codingViolation: true });
    }

    // ── Duplicate guard: same customer + same car + overlapping dates ──
    // A customer who backs out of checkout and books again used to end up with
    // several unpaid "to pay" bookings for the same trip (and, if each got paid,
    // several real ones). Filtered in memory so no composite index is needed.
    {
      const asDate = (v) => (v && v.toDate ? v.toDate() : new Date(v));
      const mineSnap = await db.collection("bookings").where("userID", "==", userID).get();
      const candidates = mineSnap.docs
        .map((d) => d.data())
        .filter((b) =>
          b.carID === carID &&
          [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING].includes(b.status) &&
          asDate(b.startDateTime) < endDateTime &&
          asDate(b.endDateTime)   > startDateTime
        );

      for (const b of candidates) {
        // An unpaid booking that has gone stale (or was actually paid) is
        // resolved first, so it never blocks a legitimate rebooking.
        const st = b.status === BOOKING_STATUS.TO_PAY ? await enforceToPayValidity(b.bookingID, b) : b.status;
        if (st === BOOKING_STATUS.CANCELLED) continue;
        return res.status(409).json({
          message: st === BOOKING_STATUS.TO_PAY
            ? "You already have an unpaid booking for this car on these dates. Finish paying for it in My Bookings › To Pay, or cancel it there first."
            : "You already have a booking for this car on these dates.",
          existingBookingID: b.bookingID,
          existingStatus: st,
        });
      }
    }

    // ── Availability guard: another customer's booking or scheduled maintenance ──
    // The calendar in Booking.jsx greys out these same dates (see
    // getDateStatuses() / GET /api/services/car-bookings/:carID), but that's a
    // client-side convenience only — nothing previously stopped this endpoint
    // from being called directly for a date the calendar had just refused to
    // show. Re-check the same source of truth here, server-side.
    {
      const asDate = (v) => (v && v.toDate ? v.toDate() : new Date(v));

      const [otherSnap, maintSnap] = await Promise.all([
        db.collection("bookings").where("carID", "==", carID).get(),
        db.collection("carMaintenance")
          .where("carID", "==", carID)
          .where("status", "==", "Scheduled")
          .get(),
      ]);

      const otherOverlap = otherSnap.docs
        .map((d) => d.data())
        .find((b) =>
          b.userID !== userID &&
          [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING].includes(b.status) &&
          asDate(b.startDateTime) < endDateTime &&
          asDate(b.endDateTime)   > startDateTime
        );
      if (otherOverlap) {
        return res.status(409).json({
          message: "This car is no longer available on the selected dates. Please choose another date or vehicle.",
        });
      }

      // Maintenance records only store a single day (maintenanceDate), with
      // no separate end date — same as GET /api/services/car-bookings/:carID.
      const maintOverlap = maintSnap.docs
        .map((d) => d.data().maintenanceDate)
        .filter(Boolean)
        .some((md) => {
          const day = asDate(md); day.setHours(0, 0, 0, 0);
          const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
          return day < endDateTime && dayEnd > startDateTime;
        });
      if (maintOverlap) {
        return res.status(409).json({
          message: "This car is scheduled for maintenance on the selected dates. Please choose another date or vehicle.",
        });
      }
    }

    // ── 1. Save to bookings collection (auto Firestore ID) ──
    const bookingRef = db.collection("bookings").doc();
    const bookingID  = bookingRef.id;

    // Does this car already have a GPS device assigned? hasDevice needs to
    // start correct at creation — otherwise a car that already had a device
    // before this booking existed would wrongly show the "no device" badge
    // until someone re-assigns it in DeviceTrack.
    let hasDevice = false;
    if (carID) {
      const deviceSnap = await db.collection("gpsDevice")
        .where("carID", "==", carID)
        .where("assigned", "==", true)
        .limit(1)
        .get();
      hasDevice = !deviceSnap.empty;
    }

    // ── bookings collection: booking details ONLY — no fee/payment fields ──
    await bookingRef.set({
      bookingID,
      carID:         carID       || "",
      userID:        userID      || "",
      serviceType:   serviceType || "",
      // FK into the serviceType collection — used by admin to resolve the
      // display name (see admin-backend/services/booking/booking.service.js's
      // resolveServiceType()). null for "Others", since that's free text
      // typed by the customer with no matching serviceType doc.
      serviceTypeID: serviceTypeID || null,
      startDateTime,
      endDateTime,
      totalDays:     fees.days || 1,
      location:      destination || "",
      modeOfDriving: driveType === "chauffeur" ? "With Chauffeur" : "Self Drive",
      notesUser:     specialNotes || "",
      notesAdmin:    "",
      isReviewed:    false,
      // Booking starts life unpaid — it's only promoted to "upcoming" once
      // PayMongo actually confirms the payment (see promoteBookingToUpcoming
      // in paymongo.controller.js). If payment fails or is never completed,
      // it stays "to pay" until the customer pays or it auto-cancels (see
      // utils/bookings/bookingStatus.util.js).
      status:        BOOKING_STATUS.TO_PAY,
      hasDevice,
      createdAt:     now,
      updatedAt:     now,
    });

    // ── 2. Save to payments collection (auto Firestore ID) ──
    const paymentRef = db.collection("payments").doc();
    const paymentID  = paymentRef.id;

    // Upload proof of payment to Firebase Storage and save the URL
    let proofUrl = "";
    if (proofBase64) {
      const rawBase64  = proofBase64.includes(",") ? proofBase64.split(",")[1] : proofBase64;
      const mimeType   = getMimeType(rawBase64);
      const extension  = mimeType.split("/")[1] || "jpg";
      const filePath   = `proofs/${paymentID}.${extension}`;
      const file       = bucket.file(filePath);
      const buffer     = Buffer.from(rawBase64, "base64");

      await file.save(buffer, { contentType: mimeType });
      await file.makePublic();
      proofUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
    }

    await paymentRef.set({
      paymentID,
      bookingID,
      userID:          userID         || "",
      amount:          totalAmount,           // grand total of ALL fees
      rentalFee:       totalFee,
      serviceFee:      service,
      extraFee:        extra,
      driversFee:      drivers,
      gatewayFee:      gateway,
      depositFee:      depositPaid,
      methodOfPayment: computedMethod,
      paymentMethod:   paymentMethod  || "",
      referenceNumber: referenceNumber || "N/A",
      proofUrl,
      status:          "pending",
      // Two-phase payment (see utils/bookings/bookingStatus.util.js):
      // "Partial" pays payNow (50%) now, then the remaining balance
      // separately later, via its own PayMongo checkout, before the
      // booking is promoted to "upcoming". "Full" has no balance phase —
      // balanceStatus stays "not_applicable" and is never touched.
      payNow,
      balanceAmount: Math.max(0, totalAmount - payNow),
      balanceStatus: computedMethod === "Full" ? "not_applicable" : "not_due",
      currentPhase:  "deposit",
      createdAt:       now,
      updatedAt:       now,
    });

    // ── 3. Save to bookingSessions collection (own doc ID; bookingID is FK only) ──
    // This is the piece that was missing entirely: pickupLocation,
    // geofenceZones, pickupTime, returnTime, and the codingCheck audit
    // were always saving as null because nothing ever wrote this doc.
    const pickupZone      = makeZone("Pickup", { lat: pickupLat, lng: pickupLng });
    const destinationZone = makeZone(destination || "Destination", { lat: destinationLat, lng: destinationLng });
    const extraZones      = Array.isArray(extraDestinations)
      ? extraDestinations
          .filter(d => d && typeof d.lat === "number" && typeof d.lng === "number")
          .map((d, i) => makeZone(d.address || `Destination ${i + 2}`, { lat: d.lat, lng: d.lng }))
      : [];
    // Order: pickup first, then the primary destination, then any extra
    // stops — matches the order the customer actually visits them in.
    const geofenceZones = [pickupZone, destinationZone, ...extraZones].filter(Boolean);

    const bookingSessionRef = db.collection("bookingSessions").doc(); // own auto-generated PK
    const bookingSessionID  = bookingSessionRef.id;

    await bookingSessionRef.set(
      createBookingSession(bookingSessionID, bookingID, {
        pickupLocation: pickupLat != null && pickupLng != null
          ? { address: pickupLocation || "", lat: pickupLat, lng: pickupLng }
          : null,
        dropoffLocation: dropoffLat != null && dropoffLng != null
          ? { address: dropoffLocation || "", lat: dropoffLat, lng: dropoffLng }
          : null,
        geofenceZones,
        pickupTime:  startDateTime,
        returnTime:  endDateTime,
        codingCheck: {
          blocked:   false, // we only ever reach here when NOT blocked — the 400 above returns early otherwise
          reason:    null,
          city:      destinationCity || null,
          dayOfWeek: startDateTime.getDay(),
          checkedAt: now,
        },
      })
    );

    // ── 4. Save firstName/lastName to userDetails if empty ──
    if (userID && (firstName || lastName)) {
      const detailsDoc = await db.collection("userDetails").doc(userID).get();
      const existing   = detailsDoc.exists ? detailsDoc.data() : {};

      if (!existing.firstName && !existing.lastName) {
        await db.collection("userDetails").doc(userID).set(
          { firstName: firstName || "", lastName: lastName || "", updatedAt: now },
          { merge: true }
        );
      }
    }

    recordAudit({
      action: "create",
      description: `Booking ${bookingID} created by customer for car ${carID}.`,
      userID,
    });

    return res.status(201).json({
      message:   "Booking confirmed!",
      bookingID,
      paymentID,
      totalDays: fees.days,
      rentalFee: totalFee,
      extraFee:  extra,
      driversFee: drivers,
      serviceFee: service,
      gatewayFee: gateway,
      grandTotal: totalAmount,
      payNow,
    });

  } catch (error) {
    console.error("createBooking error:", error);
    return res.status(500).json({ message: "Failed to create booking. Please try again." });
  }
};


// GET /api/bookings/user/:userID — get all bookings for a user with car details
const getUserBookings = async (req, res) => {
  const { userID } = req.params;
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  try {
    const snap = await db.collection("bookings").where("userID", "==", userID).get();
    if (snap.empty) return res.status(200).json([]);

    const bookings = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Self-heal any "to pay" booking that's gone stale (12h unpaid, or its
    // own start date/time already passed) right here on read, instead of
    // only relying on the periodic cron sweep — so "My Bookings" never
    // shows a booking as payable that shouldn't be anymore. See
    // utils/bookings/bookingStatus.util.js.
    await Promise.all(
      bookings
        .filter((b) => b.status === BOOKING_STATUS.TO_PAY)
        .map(async (b) => {
          b.status = await enforceToPayValidity(b.bookingID, b);
        })
    );

    // Collect unique carIDs
    const carIDs = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];

    // Batch fetch cars, brands, models
    const carDocs = await Promise.all(carIDs.map((id) => db.collection("cars").doc(id).get()));
    const carMap  = {};
    const brandIDs = new Set();
    const modelIDs = new Set();

    carDocs.forEach((doc) => {
      if (doc.exists) {
        carMap[doc.id] = doc.data();
        if (doc.data().brandID) brandIDs.add(doc.data().brandID);
        if (doc.data().modelID) modelIDs.add(doc.data().modelID);
      }
    });

    const [brandDocs, modelDocs] = await Promise.all([
      Promise.all([...brandIDs].map((id) => db.collection("brand").doc(id).get())),
      Promise.all([...modelIDs].map((id) => db.collection("model").doc(id).get())),
    ]);

    const brandMap = {};
    brandDocs.forEach((d) => { if (d.exists) brandMap[d.id] = d.data().brandName || ""; });
    const modelMap = {};
    modelDocs.forEach((d) => { if (d.exists) modelMap[d.id] = d.data().modelName || ""; });

    // Fetch primary images for each car
    const imageSnaps = await Promise.all(
      carIDs.map((id) =>
        db.collection("carImages").where("carID", "==", id).where("isPrimary", "==", true).limit(1).get()
      )
    );
    const imageMap = {};
    imageSnaps.forEach((snap, i) => {
      if (!snap.empty) imageMap[carIDs[i]] = snap.docs[0].data().imageURL || "";
    });

    const result = bookings.map((b) => {
      const car    = carMap[b.carID] || {};
      const brand  = brandMap[car.brandID] || "";
      const model  = modelMap[car.modelID] || "";
      return {
        bookingID:     b.bookingID     || b.id,
        carID:         b.carID         || "",
        carName:       `${brand} ${model}`.trim() || "Unknown Vehicle",
        carImage:      imageMap[b.carID]           || "",
        carBodyType:   car.bodyType                || "",
        serviceType:   b.serviceType               || "",
        duration:      b.duration                  || "",
        startDateTime: b.startDateTime             || null,
        endDateTime:   b.endDateTime               || null,
        totalDays:     b.totalDays                 || 1,
        totalFee:      0,
        depositFee:    0,
        rentalFee:     0,
        status:               (b.status || "upcoming").toLowerCase(),
        cancellationReason:   b.cancellationReason        || "",
        modeOfDriving:        b.modeOfDriving             || "",
        location:             b.location                  || "",
        destination:          b.destination               || "",
        passengerName:        b.passengerName             || "",
        createdAt:            b.createdAt                 || null,
      };
    });

    // Fetch payments for each booking
    const paymentSnaps = await Promise.all(
      result.map((b) =>
        db.collection("payments").where("bookingID", "==", b.bookingID).limit(1).get()
      )
    );

    paymentSnaps.forEach((snap, i) => {
      if (!snap.empty) {
        const p = snap.docs[0].data();
        result[i].payment = {
          paymentID:       p.paymentID        || snap.docs[0].id,
          amount:          p.amount           || 0,
          depositFee:      p.depositFee       || 0,
          driversFee:      p.driversFee       || 0,
          extraFee:        p.extraFee         || 0,
          gatewayFee:      p.gatewayFee       || 0,
          serviceFee:      p.serviceFee       || 0,
          rentalFee:       p.rentalFee        || 0,
          methodOfPayment: p.methodOfPayment  || p.paymentMethod || "",
          paymentMethod:   p.paymentMethod    || p.methodOfPayment || "",
          referenceNumber: p.referenceNumber  || "",
          proofUrl:        p.proofUrl         || "",
          status:          p.status           || "",
          // Two-phase payment fields — see utils/bookings/bookingStatus.util.js.
          // MyBookings.jsx needs these to know whether a "to pay" booking
          // already has its deposit paid (Partial, awaiting balance) so it
          // can show "Pay Balance" instead of "Pay Now" / hide "Cancel".
          payNow:          p.payNow           || 0,
          // Bookings created before two-phase payments have no balance fields:
          // for a Partial one, infer them so Pay Balance / the balance math work.
          balanceAmount:   p.balanceAmount    || (String(p.methodOfPayment).toLowerCase() === "partial"
                             ? Math.max(0, (Number(p.amount) || 0) - Math.floor((Number(p.amount) || 0) / 2)) : 0),
          balanceStatus:   p.balanceStatus    || (String(p.methodOfPayment).toLowerCase() === "partial" ? "not_due" : "not_applicable"),
          balanceCollected: !!p.balanceCollected, // staff collected the balance in person
          currentPhase:    p.currentPhase     || "deposit",
          // Staff discount (see admin applyDiscount) — was computed into the
          // balance/amountPaid math below but never sent to the customer, so
          // MyBookings.jsx had no way to show that a discount was applied.
          discountAmount:  Number(p.discountAmount) || 0,
          refundIssued:    !!p.refundIssued,
          // Was previously recomputed in MyBookings.jsx (getPaymentInfo) —
          // now computed once, here, so it can't drift from the admin
          // dashboard's own version of the same math.
          paymentStatus:   derivePaymentStatus(p),
        };
        // Fix: fees are stored in payments, not in the booking doc
        result[i].totalFee   = p.amount      || 0;
        result[i].rentalFee  = p.rentalFee   || 0;
        result[i].depositFee = p.depositFee  || 0;
      } else {
        result[i].payment = null;
      }
    });

    // Sort by createdAt descending
    result.sort((a, b) => {
      const ta = a.createdAt?.toDate?.() || new Date(0);
      const tb = b.createdAt?.toDate?.() || new Date(0);
      return tb - ta;
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("getUserBookings error:", error);
    return res.status(500).json({ message: "Failed to fetch bookings." });
  }
};


// PATCH /api/bookings/:bookingID/cancel — user can cancel only their own PENDING bookings
const cancelBooking = async (req, res) => {
  const { bookingID } = req.params;
  const userID = req.user.userID; // from verified JWT — never trust body
  const { reason } = req.body;

  if (!bookingID) {
    return res.status(400).json({ message: "bookingID is required." });
  }

  try {
    // Find the booking document by bookingID field
    const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ message: "Booking not found." });
    }

    const doc     = snap.docs[0];
    const booking = doc.data();

    // Ownership check
    if (booking.userID !== userID) {
      return res.status(403).json({ message: "You are not allowed to cancel this booking." });
    }

    // Bookings not yet picked up can be cancelled by the customer — EXCEPT
    // a "to pay" booking that already has its deposit paid (Partial,
    // awaiting the balance). That's real money on it already, same as an
    // "upcoming" booking, so it goes through Request Refund (admin review)
    // instead of a free self-serve cancel — same reasoning as "upcoming".
    if (![BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING].includes(booking.status)) {
      return res.status(400).json({ message: "Only upcoming or unpaid bookings can be cancelled." });
    }
    // Anything with money on it goes through Request Refund (staff review + a
    // real refund), never a free self-serve cancel — otherwise the customer's
    // payment would just be kept. This used to be checked for "to pay" only, so
    // an "upcoming" (paid) booking could be cancelled directly through the API.
    {
      const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
      const payStatus = paymentSnap.empty ? "" : String(paymentSnap.docs[0].data().status || "").toLowerCase();
      if (["paid", "approved"].includes(payStatus)) {
        return res.status(400).json({
          message: "This booking has already been paid — please request a refund instead of cancelling directly.",
        });
      }
    }

    const now = new Date();
    await doc.ref.update({
      status:             "cancelled",
      cancellationReason: reason || "Cancelled by user.",
      updatedAt:          now,
    });

    // If this booking was still unpaid (or only deposit-paid on a Partial),
    // clean up its payment doc's still-pending fields so nothing sits as
    // "pending" forever (and can't still be paid via a stale PayMongo
    // checkout link). Never touches an already-paid deposit OR balance;
    // refunding those goes through the separate requestRefund flow instead.
    if (booking.status === BOOKING_STATUS.TO_PAY) {
      try {
        const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
        if (!paymentSnap.empty) {
          const p = paymentSnap.docs[0].data();
          const updates = { updatedAt: now };
          if (p.status === "pending") updates.status = "cancelled";
          if (p.balanceStatus === "pending") updates.balanceStatus = "cancelled";
          if (Object.keys(updates).length > 1) await paymentSnap.docs[0].ref.update(updates);
        }
      } catch (paymentErr) {
        console.error("cancelBooking: failed to sync payment status:", paymentErr.message);
      }
    }

    // Mirror the cancellation onto the bookingSession doc — otherwise this
    // self-service cancel path leaves an "upcoming" ghost card in admin's
    // Car Tracking, same failure mode the admin-side cancel already fixes.
    try {
      const sessionSnap = await db.collection("bookingSessions")
        .where("bookingID", "==", bookingID)
        .limit(1)
        .get();

      if (!sessionSnap.empty) {
        await sessionSnap.docs[0].ref.update({
          status:    "cancelled",
          updatedAt: now,
        });
      }
    } catch (sessionErr) {
      // Booking is already cancelled at this point — log and move on rather
      // than fail the whole request over the session-side mirror.
      console.error("cancelBooking: failed to sync bookingSession:", sessionErr.message);
    }

    recordAudit({
      action: "update",
      description: `Booking ${bookingID} cancelled by customer. Reason: ${reason || "No reason given."}`,
      userID,
    });

    return res.status(200).json({ message: "Booking cancelled successfully." });
  } catch (error) {
    console.error("cancelBooking error:", error);
    return res.status(500).json({ message: "Failed to cancel booking. Please try again." });
  }
};


// PATCH /api/bookings/:bookingID/request-cancellation
// For ONGOING bookings only — customer can't self-cancel once the rental
// has started, so this just flags the booking for admin review instead of
// changing its status outright. Admin approval/rejection is handled on the
// admin-backend side (not implemented in this file).
const requestCancellation = async (req, res) => {
  const { bookingID } = req.params;
  const userID = req.user.userID; // from verified JWT — never trust body
  const { reason } = req.body;

  if (!bookingID) {
    return res.status(400).json({ message: "bookingID is required." });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ message: "A reason is required to request cancellation." });
  }

  try {
    // Find the booking document by bookingID field
    const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ message: "Booking not found." });
    }

    const doc     = snap.docs[0];
    const booking = doc.data();

    // Ownership check
    if (booking.userID !== userID) {
      return res.status(403).json({ message: "You are not allowed to modify this booking." });
    }

    // Only bookings currently ongoing can go through this flow — anything
    // still "to pay" or "upcoming" uses the direct self-serve cancelBooking
    // instead.
    if (booking.status !== BOOKING_STATUS.ONGOING) {
      return res.status(400).json({ message: "Only ongoing bookings can request cancellation." });
    }

    // Don't allow spamming multiple pending requests on the same booking
    if (booking.cancellationRequestStatus === "pending") {
      return res.status(400).json({ message: "A cancellation request for this booking is already pending admin review." });
    }

    const now = new Date();
    await doc.ref.update({
      cancellationRequestStatus: "pending",
      cancellationRequestReason: reason.trim(),
      cancellationRequestedAt:   now,
      updatedAt:                 now,
    });

    // Tell every Owner/Admin/Supervisor (one notification each — the admin bell
    // only shows notifications addressed to the signed-in staff member).
    await notifyStaff({
      type: "cancellation_request",
      refID: doc.id,
      refCollection: "bookings",
      title: "Cancellation request",
      message: `Booking ${bookingID} (already ongoing) has a pending cancellation request.`,
    });

    recordAudit({
      action: "update",
      description: `Cancellation requested for booking ${bookingID} by customer. Reason: ${reason.trim()}`,
      userID,
      bookingID,
    });

    return res.status(200).json({ message: "Cancellation request submitted. An admin will review it shortly." });
  } catch (error) {
    console.error("requestCancellation error:", error);
    return res.status(500).json({ message: "Failed to submit cancellation request. Please try again." });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/check-coding
// Body: { carID, startDateTime, endDateTime, destination }
// Returns: { blocked: bool, reason?: string }
//
// Logic:
//   1. Get car's plate number → extract last digit
//   2. For each codingRule:
//      a. dayOfWeek must match the booking's start date
//      b. If rule.city is set, the destination must contain that city name
//      c. The booking window (startDateTime → endDateTime) must OVERLAP with
//         the rule window (rule.startTime → rule.endTime).
//         Overlap = bookingStart < ruleEnd  AND  bookingEnd > ruleStart
//         (i.e. any part of the trip falls inside the coded hours)
//      d. The plate's last digit must be in rule.bannedDigits
// ─────────────────────────────────────────────────────────────────────────────
const checkCodingRule = async (req, res) => {
  const { carID, startDateTime, endDateTime, destination, destinationCity } = req.body;

  if (!carID || !startDateTime) {
    return res.status(400).json({ message: "carID and startDateTime are required." });
  }

  try {
    // 1. Get the car's plate number (cached by carID)
    let plateNumber = codingCache.cars[carID];
    if (!plateNumber) {
      const carDoc = await db.collection("cars").doc(carID).get();
      if (!carDoc.exists) return res.status(404).json({ message: "Car not found." });
      plateNumber = (carDoc.data().plateNumber || "").trim().toUpperCase();
      if (plateNumber) codingCache.cars[carID] = plateNumber;
    }

    if (!plateNumber) {
      return res.status(200).json({ blocked: false });
    }

    const lastChar  = plateNumber[plateNumber.length - 1];
    const lastDigit = parseInt(lastChar, 10);
    if (isNaN(lastDigit)) {
      return res.status(200).json({ blocked: false });
    }

    // 2. Parse the booking start date/time
    const bookingStart = new Date(startDateTime);
    const dayOfWeek    = bookingStart.getDay(); // 0=Sun … 6=Sat

    // Booking start & end in minutes-from-midnight (same calendar day for comparison)
    const bookingStartMins = bookingStart.getHours() * 60 + bookingStart.getMinutes();

    // If endDateTime provided, compute end minutes; if it spans past midnight cap at 1439 (23:59)
    let bookingEndMins;
    if (endDateTime) {
      const bookingEnd = new Date(endDateTime);
      // If the end is on a later calendar day, treat end as end-of-day (23:59) for overlap check
      const startDay = bookingStart.toISOString().split("T")[0];
      const endDay   = bookingEnd.toISOString().split("T")[0];
      if (endDay > startDay) {
        bookingEndMins = 23 * 60 + 59; // booking goes past midnight → covers rest of day
      } else {
        bookingEndMins = bookingEnd.getHours() * 60 + bookingEnd.getMinutes();
      }
    } else {
      // No end time provided — treat the whole day as blocked
      bookingEndMins = 23 * 60 + 59;
    }

    // 3. Holiday check — if the booking's start date is a public holiday,
    //    coding rules are suspended for that day and booking is always allowed.
    // holidayDate is stored as a Firestore Timestamp, so query by day range.
    const hDayStart = new Date(bookingStart); hDayStart.setHours(0, 0, 0, 0);
    const hDayEnd   = new Date(bookingStart); hDayEnd.setHours(23, 59, 59, 999);
    const holidaySnap = await db.collection("holidays")
      .where("holidayDate", ">=", hDayStart)
      .where("holidayDate", "<=", hDayEnd)
      .limit(1)
      .get();
    if (!holidaySnap.empty) {
      const holiday = holidaySnap.docs[0].data();
      if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → Holiday detected:", holiday.holidayName || "Public Holiday", "— coding rules suspended.");
      return res.status(200).json({
        blocked: false,
        holiday: true,
        holidayName: holiday.holidayName || "Public Holiday",
      });
    }

    // 4. Fetch all codingRules (cached — rules rarely change)
    if (!codingCache.codingRules) {
      const rulesSnap = await db.collection("codingRules").get();
      codingCache.codingRules = rulesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
    if (!codingCache.codingRules.length) return res.status(200).json({ blocked: false });

    // Helper: parse "7:00 AM" → minutes from midnight
    const parseTime = (timeStr) => {
      if (!timeStr) return null;
      const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) return null;
      let hours      = parseInt(match[1], 10);
      const mins     = parseInt(match[2], 10);
      const ampm     = match[3].toUpperCase();
      if (ampm === "PM" && hours !== 12) hours += 12;
      if (ampm === "AM" && hours === 12) hours  = 0;
      return hours * 60 + mins;
    };

    // DEBUG — log what we're checking so we can see the data in server logs
    if (process.env.NODE_ENV !== "production") {
      console.log("[checkCodingRule] plateNumber:", plateNumber, "lastDigit:", lastDigit);
      console.log("[checkCodingRule] dayOfWeek (JS 0=Sun):", dayOfWeek, "bookingStartMins:", bookingStartMins, "bookingEndMins:", bookingEndMins);
      console.log("[checkCodingRule] destination:", destination);
      console.log("[checkCodingRule] total rules to check:", codingCache.codingRules.length);
    }

    // 4. Check each rule
    for (const rule of codingCache.codingRules) {
      const ruleDoc = { id: rule.id };

      if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] rule:", JSON.stringify({
        id: rule.id,
        dayOfWeek: rule.dayOfWeek,
        city: rule.city,
        startTime: rule.startTime,
        endTime: rule.endTime,
        bannedDigits: rule.bannedDigits,
        dayName: rule.dayName,
      }));

      // a. Day-of-week match — support both string and number stored in Firestore
      // JS: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
      const ruleDayOfWeek = Number(rule.dayOfWeek);
      if (isNaN(ruleDayOfWeek) || ruleDayOfWeek !== dayOfWeek) {
        if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → SKIP: dayOfWeek mismatch (rule:", ruleDayOfWeek, "booking:", dayOfWeek, ")");
        continue;
      }

      // b. City check — prefer an exact match against the structured city
      // (from the map pin) over a fuzzy substring search on the free-text
      // address. Falls back to the old behavior when no structured city
      // was sent (a typed address with no pin used).
      if (rule.city && rule.city.trim() !== "") {
        const ruleCity = rule.city.toLowerCase().trim();
        let cityMatches;
        if (destinationCity && destinationCity.trim() !== "") {
          cityMatches = destinationCity.toLowerCase().trim() === ruleCity;
        } else {
          const dest = (destination || "").toLowerCase();
          cityMatches = dest.includes(ruleCity);
        }
        if (!cityMatches) {
          if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → SKIP: city mismatch (rule city:", ruleCity, "dest:", destinationCity || destination, ")");
          continue;
        }
      }

      // c. Time overlap check
      const ruleStart = parseTime(rule.startTime);
      const ruleEnd   = parseTime(rule.endTime);
      if (ruleStart === null || ruleEnd === null) {
        if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → SKIP: could not parse rule times:", rule.startTime, rule.endTime);
        continue;
      }

      const overlaps = bookingStartMins < ruleEnd && bookingEndMins > ruleStart;
      if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] ruleStart:", ruleStart, "ruleEnd:", ruleEnd, "overlaps:", overlaps);
      if (!overlaps) continue;

      // d. Banned digit check — handle array of strings OR numbers from Firestore
      let bannedDigits = [];
      if (Array.isArray(rule.bannedDigits)) {
        bannedDigits = rule.bannedDigits.map(Number).filter(n => !isNaN(n));
      } else if (rule.bannedDigits !== undefined && rule.bannedDigits !== null) {
        // Stored as a single value — wrap it
        const single = Number(rule.bannedDigits);
        if (!isNaN(single)) bannedDigits = [single];
      }

      if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] bannedDigits (parsed):", bannedDigits, "lastDigit:", lastDigit, "isBlocked:", bannedDigits.includes(lastDigit));

      if (bannedDigits.includes(lastDigit)) {
        return res.status(200).json({
          blocked: true,
          reason: `This vehicle (plate ending in ${lastDigit}) is not allowed under the Number Coding Scheme in ${rule.city || "this area"} on ${rule.dayName || "this day"} from ${rule.startTime} to ${rule.endTime}. Your booking window (${new Date(startDateTime).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}${endDateTime ? " – "+new Date(endDateTime).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"}) : ""}) overlaps with this restriction. Please choose a different date, time, or another vehicle.`,
          rule: {
            city:         rule.city,
            dayName:      rule.dayName,
            startTime:    rule.startTime,
            endTime:      rule.endTime,
            bannedDigits: bannedDigits,
          },
        });
      }
    }

    if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → No rule blocked this booking.");
    return res.status(200).json({ blocked: false });

  } catch (error) {
    console.error("checkCodingRule error:", error);
    return res.status(500).json({ message: "Failed to check coding rules." });
  }
};

module.exports = { createBooking, getUserBookings, cancelBooking, requestCancellation, checkCodingRule, getBookingQuote };