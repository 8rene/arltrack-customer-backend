const { db, bucket } = require("../../config/firebaseConnection/firebase");

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

// POST /api/bookings/create
const createBooking = async (req, res) => {
  const userID = req.user.userID; // from verified JWT — never trust body
  const {
    carID,
    serviceType,
    duration,
    startDate,
    startTime,
    endDate,
    endTime,
    totalDays,
    rentalFee,
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
    methodOfPayment,
    referenceNumber,
    depositFee,
    extraFee,
    driversFee,
    serviceFee,
    gatewayFee,
    grandTotal,
    // screenshot handled separately (base64 or URL)
    proofBase64,
  } = req.body;

  if (!carID) {
    return res.status(400).json({ message: "carID is required." });
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

    const totalFee    = Number(rentalFee) || 0;
    const depositPaid = 1000;                   // deposit fee is always ₱1,000
    const extra       = Number(extraFee)   || 0;
    const drivers     = Number(driversFee) || 0;
    const service     = Number(serviceFee) || 0;
    const gateway     = Number(gatewayFee) || 0;
    const totalAmount = Number(grandTotal) || (totalFee + extra + drivers + service + gateway);

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

        const rulesSnap = await db.collection("codingRules").get();
        for (const ruleDoc of rulesSnap.docs) {
          const rule = ruleDoc.data();

          // Day-of-week match (JS: 0=Sun,1=Mon,...6=Sat)
          const ruleDayOfWeek = Number(rule.dayOfWeek);
          if (isNaN(ruleDayOfWeek) || ruleDayOfWeek !== dayOfWeek) continue;

          // City match — if rule has a city, destination must contain it
          if (rule.city && rule.city.trim() !== "") {
            const ruleCity = rule.city.toLowerCase().trim();
            const dest     = (destination || "").toLowerCase();
            if (!dest.includes(ruleCity)) continue;
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

    // ── 1. Save to bookings collection (auto Firestore ID) ──
    const bookingRef = db.collection("bookings").doc();
    const bookingID  = bookingRef.id;

    // ── bookings collection: booking details ONLY — no fee/payment fields ──
    await bookingRef.set({
      bookingID,
      carID:         carID       || "",
      userID:        userID      || "",
      serviceType:   serviceType || "",
      startDateTime,
      endDateTime,
      totalDays:     Number(totalDays) || 1,
      location:      destination || "",
      modeOfDriving: driveType === "chauffeur" ? "With Chauffeur" : "Self Drive",
      notesUser:     specialNotes || "",
      notesAdmin:    "",
      isReviewed:    false,
      status:        "pending",
      createdAt:     now,
      updatedAt:     now,
    });

    // ── 2. Save to payments collection (auto Firestore ID) ──
    const paymentRef = db.collection("payments").doc();
    const paymentID  = paymentRef.id;

    // Upload proof of payment to Firebase Storage and save the URL
    let proofUrl = "";
    if (proofBase64) {
      const mimeType   = getMimeType(proofBase64);
      const extension  = mimeType.split("/")[1] || "jpg";
      const filePath   = `proofs/${paymentID}.${extension}`;
      const file       = bucket.file(filePath);
      const buffer     = Buffer.from(proofBase64, "base64");

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
      methodOfPayment: methodOfPayment || (paymentAmount === 'deposit' ? 'Deposit' : paymentAmount === 'partial' ? 'Partial' : 'Full'),
      paymentMethod:   paymentMethod  || "",
      referenceNumber: referenceNumber || "N/A",
      proofUrl,
      status:          "pending",
      createdAt:       now,
      updatedAt:       now,
    });

    // ── 3. Save firstName/lastName to userDetails if empty ──
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

    return res.status(201).json({
      message:   "Booking confirmed!",
      bookingID,
      paymentID,
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
        status:               (b.status || "pending").toLowerCase(),
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
  const { userID, reason } = req.body;

  if (!bookingID || !userID) {
    return res.status(400).json({ message: "bookingID and userID are required." });
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

    // Only pending bookings can be cancelled by the user
    if (booking.status !== "pending") {
      return res.status(400).json({ message: "Only pending bookings can be cancelled." });
    }

    const now = new Date();
    await doc.ref.update({
      status:             "cancelled",
      cancellationReason: reason || "Cancelled by user.",
      updatedAt:          now,
    });

    return res.status(200).json({ message: "Booking cancelled successfully." });
  } catch (error) {
    console.error("cancelBooking error:", error);
    return res.status(500).json({ message: "Failed to cancel booking. Please try again." });
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
  const { carID, startDateTime, endDateTime, destination } = req.body;

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
      console.log("[checkCodingRule] total rules to check:", rulesSnap.size);
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

      // b. City check — destination must contain the rule's city name (case-insensitive)
      // If rule has no city set, it applies to ALL destinations
      if (rule.city && rule.city.trim() !== "") {
        const ruleCity = rule.city.toLowerCase().trim();
        const dest     = (destination || "").toLowerCase();
        if (!dest.includes(ruleCity)) {
          if (process.env.NODE_ENV !== "production") console.log("[checkCodingRule] → SKIP: city mismatch (rule city:", ruleCity, "dest:", dest, ")");
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

module.exports = { createBooking, getUserBookings, cancelBooking, checkCodingRule };
