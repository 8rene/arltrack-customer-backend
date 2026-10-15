const { db } = require("../../config/firebaseConnection/firebase");
const { isWithinServiceArea } = require("../location/location.controller");
const createBookingSession = require("../../models/bookingSession/bookingSession.model");
const { checkTermsAcceptance, ensureTermsSnapshot, termsRequired } = require("../../utils/terms/terms.service");
const { makeZone } = createBookingSession;
const { computeBookingFees, computePaymentSplit, derivePaymentStatus, getBaseAreaConfig } = require("../../utils/pricing");
const {
  toManila, manilaDayRange, cityMatchesRule, parseCodingTime, parseBannedDigits, fmtCodingMins,
  buildCodingLocations, evaluateCodingRange, codingBlockMessage, codingWarningMessage,
} = require("../../utils/bookings/codingRange.util");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");
const { BOOKING_STATUS, enforceToPayValidity } = require("../../utils/bookings/bookingStatus.util");
const { notifyStaff } = require("../../services/notification/notification.service");
const { syncPaymentEntries, hydratePayments } = require("../../utils/payments/paymentEntries.util");
const { recordDirectCancellation, getCancellationReasons } = require("../../utils/bookings/cancellationRequests.util");

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
  cars:        {},   // { [carID]: { plate, at } }
  codingRules: null, // full rules array
  rulesFetchedAt: 0, // ms timestamp — rules/plates are re-read after CODING_CACHE_TTL_MS
};
// Admin edits to coding rules or a car's plate show up within this time (no server restart needed).
const CODING_CACHE_TTL_MS = 5 * 60 * 1000;

const getCodingRules = async () => {
  const stale = Date.now() - codingCache.rulesFetchedAt > CODING_CACHE_TTL_MS;
  if (!codingCache.codingRules || stale) {
    const rulesSnap = await db.collection("codingRules").get();
    codingCache.codingRules = rulesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    codingCache.rulesFetchedAt = Date.now();
  }
  return codingCache.codingRules;
};

// The last digit of a car's plate (cached by carID). { notFound: true } when the
// car doesn't exist; lastDigit is NaN when the plate is empty or doesn't end in a digit.
const getPlateLastDigit = async (carID) => {
  const cached = codingCache.cars[carID];
  let plate = cached && Date.now() - cached.at < CODING_CACHE_TTL_MS ? cached.plate : null;
  if (!plate) {
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return { notFound: true, plate: "", lastDigit: NaN };
    plate = (carDoc.data().plateNumber || "").trim().toUpperCase();
    if (plate) codingCache.cars[carID] = { plate, at: Date.now() };
  }
  return { notFound: false, plate, lastDigit: parseInt(plate.slice(-1), 10) };
};

// Every public holiday between two instants (Manila calendar days, inclusive)
// as a Map of "YYYY-MM-DD" -> holiday name. One range query per check.
const getHolidayMap = async (startDateTime, endDateTime) => {
  const first = manilaDayRange(toManila(startDateTime).day).start;
  const last  = manilaDayRange(toManila(endDateTime || startDateTime).day).end;
  const snap = await db.collection("holidays")
    .where("holidayDate", ">=", first)
    .where("holidayDate", "<=", last)
    .get();
  const map = new Map();
  snap.docs.forEach((doc) => {
    const d = doc.data();
    const t = d.holidayDate && d.holidayDate.toDate ? d.holidayDate.toDate() : null;
    if (t) map.set(toManila(t).day, d.holidayName || "Public Holiday");
  });
  return map;
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
  const { carID, duration, startDate, startTime, endDate, endTime, destination, destinationCity, destinationProvince, destinationCounty, pickupCity, pickupProvince, pickupCounty, driveType, paymentAmount } = req.body;

  if (!carID || !duration) {
    return res.status(400).json({ message: "carID and duration are required." });
  }

  try {
    const pricePerDay = await getPricePerDay(carID, duration);

    // startDate/startTime are Manila wall-clock; always pin +08:00 so the instant is
    // the same whatever timezone the server runs in (Vercel is UTC).
    const startDateTime = startDate && startTime ? new Date(`${startDate}T${startTime}:00+08:00`) : null;
    const endDateTime    = endDate && endTime     ? new Date(`${endDate}T${endTime}:00+08:00`)     : null;

    const fees = await computeBookingFees({
      pricePerDay,
      startDateTime,
      endDateTime,
      durationType: duration,
      destination,
      destinationCity,
      destinationProvince,
      destinationCounty,
      pickupCity,
      pickupProvince,
      pickupCounty,
      driveType,
    });

    const split = computePaymentSplit(fees.grandTotal, paymentAmount, fees.securityDeposit);

    return res.status(200).json({ ...fees, ...split, pricePerDay });
  } catch (error) {
    console.error("getBookingQuote error:", error);
    return res.status(500).json({ message: "Failed to compute quote." });
  }
};

// Does this coding rule apply to this plate at this location? (plate's last digit is banned,
// the rule's city matches the location, and the rule has a usable day + time window.) The
// day/time of the booking is NOT tested here. Shared by findCodingNotices and buildCodingWarnings.
const ruleAppliesToLocation = (rule, lastDigit, loc) => {
  if (!parseBannedDigits(rule.bannedDigits).includes(lastDigit)) return false;
  if (rule.city && rule.city.trim() !== "" && !cityMatchesRule(rule.city, loc.destinationCity, loc.destination)) return false;
  const dow = Number(rule.dayOfWeek);
  if (isNaN(dow) || parseCodingTime(rule.startTime) === null || parseCodingTime(rule.endTime) === null) return false;
  return true;
};

// For every location: the days/hours on which THIS plate is under number coding there
// (no date needed). Used by the Destination-step heads-up (getCodingNotice).
const findCodingNotices = ({ rules, lastDigit, locations }) => {
  const notices = [];
  for (const loc of locations) {
    // Same matching as the real check, minus the day/time test.
    const seen = new Set();
    const schedule = [];
    for (const rule of rules) {
      if (!ruleAppliesToLocation(rule, lastDigit, loc)) continue;
      const dow = Number(rule.dayOfWeek);
      const k = `${dow}|${rule.startTime}|${rule.endTime}`;
      if (seen.has(k)) continue;
      seen.add(k);
      schedule.push({ dayOfWeek: dow, dayName: rule.dayName || "", startTime: rule.startTime, endTime: rule.endTime });
    }
    if (!schedule.length) continue;
    schedule.sort((a, b) => a.dayOfWeek - b.dayOfWeek || parseCodingTime(a.startTime) - parseCodingTime(b.startTime));
    const cityOfRule = rules.find((r) => r.city && cityMatchesRule(r.city, loc.destinationCity, loc.destination));
    notices.push({ id: loc.id, location: loc.label, city: (cityOfRule && cityOfRule.city) || loc.destinationCity || "", schedule });
  }
  return notices;
};

// The Number Coding warnings saved on the booking session (session.codingWarnings): a FLAT
// array, one entry per matched coding rule, no nested arrays —
//   { city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }
// Same matching as the pre-booking notice (ruleAppliesToLocation: plate digit + city, no date
// test) over pickup, destination and every extra stop. A rule that matches several stops
// appears once (deduped by ruleID). It is a snapshot copied from the rule, so it stays
// readable if the rule is edited or deleted later. Built on the SERVER, never from the
// browser. Never throws: on any failure it returns [].
const buildCodingWarnings = async ({ carID, destination, destinationCity, codingStops, pickup, pickupCity }) => {
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    const plate = carDoc.exists ? (carDoc.data().plateNumber || "").trim().toUpperCase() : "";
    const lastDigit = parseInt(plate.slice(-1), 10);
    if (isNaN(lastDigit)) return [];
    const rules = await getCodingRules();
    const locations = buildCodingLocations({ destination, destinationCity, codingStops, pickup, pickupCity });
    const byRule = new Map();
    for (const loc of locations) {
      for (const rule of rules) {
        if (!ruleAppliesToLocation(rule, lastDigit, loc)) continue;
        const ruleID = rule.ruleID || rule.id || null;
        const key = ruleID || `${rule.city}|${rule.dayOfWeek}|${rule.startTime}|${rule.endTime}`;
        if (byRule.has(key)) continue;
        byRule.set(key, {
          city:           ((rule.city && rule.city.trim()) || loc.destinationCity || "").trim(),
          plateLastDigit: lastDigit,
          ruleID,
          dayOfWeek:      Number(rule.dayOfWeek),
          startTime:      rule.startTime,
          endTime:        rule.endTime,
        });
      }
    }
    return [...byRule.values()].sort((x, y) =>
      x.city.localeCompare(y.city) ||
      x.dayOfWeek - y.dayOfWeek ||
      parseCodingTime(x.startTime) - parseCodingTime(y.startTime));
  } catch (e) {
    console.warn("buildCodingWarnings failed:", e.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/create
// ─────────────────────────────────────────────────────────────────────────────
const createBooking = async (req, res) => {
  const userID = req.user.userID; // from verified JWT — never trust body

  // Block new bookings while a past booking's penalty balance is still
  // unpaid. This used to read a cached outstandingPenaltyBalance field
  // mirrored onto the user doc by arltrack-admin-backend's
  // penalty.service.js — that field has been removed (it could drift out
  // of sync whenever a penalty was confirmed on a booking whose deposit
  // was already settled, since only settleBooking()/recordShortfallPayment()
  // ever wrote it). This now queries `penalties` directly instead: narrow,
  // indexed to this one customer's own Confirmed penalties, not a scan of
  // the whole collection. This is an account-level check, not
  // device/IP-level — a second account is a known, accepted gap (ID
  // verification makes it harder, not impossible).
  const unpaidPenaltiesSnap = await db.collection("penalties")
    .where("userID", "==", userID)
    .where("status", "==", "Confirmed")
    .get();
  const outstandingPenaltyBalance = unpaidPenaltiesSnap.docs.reduce((sum, doc) => {
    const p = doc.data();
    return sum + Math.max(0, (Number(p.amount) || 0) - (Number(p.paidAmount) || 0));
  }, 0);
  if (outstandingPenaltyBalance > 0) {
    return res.status(403).json({
      message: `Please settle your outstanding balance of ₱${outstandingPenaltyBalance} before booking again.`,
      outstandingPenaltyBalance,
    });
  }

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
    // NOTE: totalDays / rentalFee / extraFee / driversFee / serviceFee /
    // gatewayFee / grandTotal / methodOfPayment are intentionally
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
    codingStops, // [{ id, address, city }] — every additional stop, for the coding check
    codingAcknowledged, // true once the customer confirmed a multi-day Number Coding warning
    termsHash,   // hash of the Terms & Conditions text the customer was shown when they ticked the box
    pickupProvince,
    pickupRegion,
    pickupCity,
    pickupCounty,       // geocoder "county" — often the province; extra name for the base-area match
    destinationCounty,
  } = req.body;

  if (!carID) {
    return res.status(400).json({ message: "carID is required." });
  }

  // ── Terms & Conditions acceptance ──
  // The browser sends the hash of the text it displayed. It must equal the CURRENT text
  // (wording + the policy numbers quoted in it), otherwise the customer is asked to re-read
  // it. Whether a missing hash is rejected is controlled by REQUIRE_TERMS_ACCEPTANCE
  // (see utils/terms/terms.service.js). The acceptance record itself is written inside the
  // booking transaction below, so a booking can't exist without it.
  let termsCheck;
  try {
    termsCheck = await checkTermsAcceptance(termsHash);
    if (termsCheck.ok && termsCheck.accepted) await ensureTermsSnapshot(termsCheck.terms);
  } catch (termsErr) {
    console.error("Terms check failed:", termsErr.message);
    if (termsRequired()) {
      return res.status(503).json({ message: "We couldn't verify the Terms & Conditions right now. Please try again in a moment." });
    }
    termsCheck = { ok: true, accepted: false };
  }
  if (!termsCheck.ok) return res.status(termsCheck.status).json(termsCheck.body);

  // ── Server-side guard: pickup must be inside a region saved in our database ──
  // The frontend map picker already blocks other areas, but the request can be
  // sent directly, so the same rule is enforced here. The admin-configured
  // in-store pickup point is always allowed (matched by its saved coordinates).
  try {
    if (typeof pickupLat !== "number" || typeof pickupLng !== "number") {
      return res.status(400).json({ message: "Please choose your pickup location on the map." });
    }

    let isStorePickup = false;
    const settingsSnap = await db.collection("systemSettings").orderBy("createdAt", "desc").limit(1).get();
    if (!settingsSnap.empty) {
      const st = settingsSnap.docs[0].data();
      isStorePickup =
        typeof st.storeLat === "number" && typeof st.storeLng === "number" &&
        Math.abs(st.storeLat - pickupLat) < 1e-6 && Math.abs(st.storeLng - pickupLng) < 1e-6;
    }

    if (!isStorePickup) {
      const ok = await isWithinServiceArea([pickupRegion, pickupProvince, pickupCity]);
      if (!ok) {
        return res.status(400).json({
          message: "Pickup is only available within our service regions. Please choose a different pickup location.",
        });
      }
    }
  } catch (err) {
    console.error("createBooking pickup service-area check failed:", err);
    return res.status(500).json({ message: "Could not verify the pickup location. Please try again." });
  }

  // ── Server-side guard: never trust the client's date fields ─────
  // The frontend calendar blocks past dates, but a request can still
  // reach this endpoint directly (stale localStorage draft, bypassed
  // UI, manual API call, etc). Reject anything dated before "today"
  // at the booking-day granularity so legit same-day bookings still work.
  // "Today" and the requested dates are compared as Manila calendar days
  // ("YYYY-MM-DD" strings compare correctly) — the server's own timezone (UTC on
  // Vercel) must not decide what "today" is.
  const todayManila = toManila(new Date()).day;
  const isValidDay  = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(`${d}T00:00:00+08:00`).getTime());
  if (startDate) {
    if (!isValidDay(startDate) || startDate < todayManila) {
      return res.status(400).json({ message: "startDate cannot be in the past." });
    }
  }
  if (endDate) {
    if (!isValidDay(endDate) || endDate < todayManila) {
      return res.status(400).json({ message: "endDate cannot be in the past." });
    }
  }

  try {
    const now = new Date();

    // Build startDateTime and endDateTime
    // startDate/startTime are Manila wall-clock — pin +08:00 so the stored instant is
    // correct on any server timezone (this also makes the number-coding check below,
    // which reads the Manila weekday/time, agree with /bookings/check-coding).
    const startDateTime = startDate && startTime
      ? new Date(`${startDate}T${startTime}:00+08:00`)
      : now;
    const endDateTime = endDate && endTime
      ? new Date(`${endDate}T${endTime}:00+08:00`)
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
      destinationCounty,
      pickupCity,
      pickupProvince,
      pickupCounty,
      driveType,
    });
    const { payNow, methodOfPayment: computedMethod } = computePaymentSplit(fees.grandTotal, paymentAmount, fees.securityDeposit);

    const securityDeposit = fees.securityDeposit;
    const totalFee    = fees.rentalFee;
    const extra       = fees.extraFee;
    const drivers     = fees.driversFee;
    const service     = fees.serviceFee;
    const gateway     = fees.gatewayFee;
    // The % rates and the base the gateway fee was computed on are saved on the
    // payment too, so any past booking's fees can be explained even if the
    // Settings percentages change later.
    const gatewayBase = fees.gatewayFeeBase;
    const serviceRate = fees.serviceFeeRate;
    const gatewayRate = fees.gatewayFeeRate;
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
    // Walks EVERY Manila calendar day of the booking (not just the start day) and
    // tests the pickup, the destination and every extra stop. Short bookings are
    // blocked on a conflict; multi-day bookings need the customer's acknowledgement
    // (codingAcknowledged) — see utils/bookings/codingRange.util.js.
    const codingOutcome = await (async () => {
      const none = { block: null, warnings: [], warningMessage: "" };
      try {
        const { notFound, lastDigit } = await getPlateLastDigit(carID);
        if (notFound || isNaN(lastDigit)) return none;

        const holidays = await getHolidayMap(startDateTime, endDateTime);
        const _codingRules = await getCodingRules();
        const result = evaluateCodingRange({
          rules: _codingRules,
          startDateTime,
          endDateTime,
          lastDigit,
          holidays,
          locations: buildCodingLocations({ destination, destinationCity, codingStops, pickup: pickupLocation, pickupCity }),
        });
        if (!result.violations.length) return none;

        if (result.mode === "block") {
          return {
            block: {
              message: codingBlockMessage({
                lastDigit,
                violations: result.violations,
                windowText: `${fmtCodingMins(toManila(startDateTime).mins)} – ${fmtCodingMins(toManila(endDateTime).mins)}`,
              }),
              violations: result.violations,
            },
            warnings: [],
            warningMessage: "",
          };
        }
        return { block: null, warnings: result.violations, warningMessage: codingWarningMessage({ lastDigit, violations: result.violations }) };
      } catch (e) {
        console.warn("Coding rule check skipped:", e.message);
        return none;
      }
    })();

    if (codingOutcome.block) {
      return res.status(400).json({
        message: codingOutcome.block.message,
        codingViolation: true,
        violations: codingOutcome.block.violations,
      });
    }
    if (codingOutcome.warnings.length && codingAcknowledged !== true) {
      return res.status(400).json({
        message: "Please confirm the Number Coding warning for this booking before continuing.",
        codingWarning: true,
        requiresAcknowledgement: true,
        warnings: codingOutcome.warnings,
        warningMessage: codingOutcome.warningMessage,
      });
    }
    const codingWarned = codingOutcome.warnings.length;

    // "allMine" is read once here and reused by the duplicate guard right
    // below — no extra round-trip. (A previous version of this also
    // enforced a customer-wide 24h "can't book ANY car" cooldown here —
    // removed: it was blocking a customer from booking a different car
    // entirely, which was never the intent. The actual per-car "give the
    // car a day before it's bookable again" behavior is the turnaround
    // buffer in the availability guard further down in this function, which
    // only blocks the specific car that was just returned.)
    const asDate = (v) => (v && v.toDate ? v.toDate() : new Date(v));
    // Only the statuses the duplicate guard below can match — a customer's
    // completed/cancelled history grows forever and was being read in full on
    // every booking. Equality + "in" is served by Firestore's built-in indexes
    // (no composite index needed).
    const mineSnap = await db.collection("bookings")
      .where("userID", "==", userID)
      .where("status", "in", [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING])
      .get();
    const allMine = mineSnap.docs.map((d) => d.data());

    // ── Duplicate guard: same customer + same car + overlapping dates ──
    // A customer who backs out of checkout and books again used to end up with
    // several unpaid "to pay" bookings for the same trip (and, if each got paid,
    // several real ones). Filtered in memory so no composite index is needed.
    {
      const candidates = allMine
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
          // The frontend toast used to just repeat the generic message above
          // with nothing to check it against — a customer who genuinely
          // never booked this car had no way to tell what was actually
          // blocking them. Sending the conflicting booking's own dates lets
          // the UI show exactly which reservation is in the way.
          existingStartDateTime: b.startDateTime || null,
          existingEndDateTime: b.endDateTime || null,
        });
      }
    }

    // ── Availability guard: another customer's booking or scheduled maintenance ──
    // The calendar in Booking.jsx greys out these same dates (see
    // getDateStatuses() / GET /api/services/car-bookings/:carID), but that's a
    // client-side convenience only — nothing previously stopped this endpoint
    // from being called directly for a date the calendar had just refused to
    // show. Re-check the same source of truth here, server-side.
    //
    // The 1-day turnaround buffer (before a confirmed booking starts, and
    // after it ends — cleaning/inspection) is computed HERE directly from
    // the other booking's own start/end, not from a maintenance record, so
    // it's enforced the instant the other booking exists. Post-rental
    // maintenance records are created manually by staff in the admin app's
    // Maintenance page (cleaning/inspection checklist) and are not what
    // blocks the buffer day.
    // >>> The overlap + maintenance checks described above now run INSIDE the booking
    // transaction below (see "Atomic availability check + write"). They used to run
    // here, separately from the write, so two customers booking the same car at the
    // same moment could both pass them.

    // ── 1. Build the bookings doc (written inside the transaction below) ──
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
    const bookingData = {
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
      // The exact pickup INSTANT (Manila, UTC+8) — startDateTime is already pinned
      // to +08:00 above, so it is the real instant on any server timezone. The
      // refund policy's 48-hour window is measured from this.
      pickupAt:      startDateTime,
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
      // The Terms & Conditions accepted for THIS booking (full record: termsAcceptances/{bookingID};
      // the exact text: termsSnapshots/{termsHash}). Null if the browser didn't send an acceptance
      // and REQUIRE_TERMS_ACCEPTANCE is still off.
      termsAcceptedAt: termsCheck.accepted ? now : null,
      termsVersion:    termsCheck.accepted ? termsCheck.terms.version : null,
      termsHash:       termsCheck.accepted ? termsCheck.terms.hash : null,
      createdAt:     now,
      updatedAt:     now,
    };

    // ── 2. Build the payments doc (written inside the transaction below) ──
    const paymentRef = db.collection("payments").doc();
    const paymentID  = paymentRef.id;

    const paymentData = {
      paymentID,
      bookingID,
      userID:          userID         || "",
      amount:          totalAmount,           // grand total of ALL fees
      rentalFee:       totalFee,
      serviceFee:      service,
      extraFee:        extra,
      driversFee:      drivers,
      gatewayFee:      gateway,
      serviceFeeRate:  serviceRate,   // % of rental only
      gatewayFeeRate:  gatewayRate,   // % of gatewayFeeBase
      gatewayFeeBase:  gatewayBase,   // rental + extra + driver's + service fee + security deposit
      // Refundable; already inside `amount`. payments.depositStatus becomes "Held"
      // when the first payment settles — see settlePayment.util.js.
      securityDeposit,
      methodOfPayment: computedMethod,
      paymentMethod:   paymentMethod  || "",
      status:          "pending",
      // Two-phase payment (see utils/bookings/bookingStatus.util.js):
      // "Partial" pays payNow (50%) now, then the remaining balance
      // separately later, via its own PayMongo checkout, before the
      // booking is promoted to "upcoming". "Full" has no balance phase —
      // balanceStatus stays "not_applicable" and is never touched.
      // payNow is NOT stored: it is derived from amount / methodOfPayment / securityDeposit (computePaymentSplit)
      balanceAmount: Math.max(0, totalAmount - payNow),
      balanceStatus: computedMethod === "Full" ? "not_applicable" : "not_due",
      currentPhase:  "deposit",
      // No paymongoTransactions array: every charge is a row in paymentEntries,
      // written by syncPaymentEntries() as each one happens.
      createdAt:       now,
      updatedAt:       now,
    };

    // ── 3. Build the bookingSessions doc (own doc ID; bookingID is FK only; written inside the transaction below) ──
    // This is the piece that was missing entirely: pickupLocation,
    // geofenceZones and the codingWarnings
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

    const codingWarnings = await buildCodingWarnings({ carID, destination, destinationCity, codingStops, pickup: pickupLocation, pickupCity });
    const bookingSessionData =
      createBookingSession(bookingSessionID, bookingID, {
        pickupLocation: pickupLat != null && pickupLng != null
          ? { address: pickupLocation || "", lat: pickupLat, lng: pickupLng }
          : null,
        dropoffLocation: dropoffLat != null && dropoffLng != null
          ? { address: dropoffLocation || "", lat: dropoffLat, lng: dropoffLng }
          : null,
        geofenceZones,
        // Flat list of the coding rules that applied to this plate (the warnings the customer was
        // shown) — copied in as a snapshot. [] if none matched or the check failed.
        codingWarnings,
      });

    // ── Atomic availability check + write ──
    // The overlap/maintenance checks and the bookings / payments / bookingSessions
    // writes now happen in ONE Firestore transaction that also reads + writes a
    // per-car lock doc (carLocks/{carID}). Every booking for the same car touches
    // that doc, so concurrent bookings for the SAME car are serialised: the second
    // one retries, sees the first booking, and gets the 409. Different cars use
    // different lock docs and never wait on each other. The three docs are also
    // written together, so a failure can't leave a booking without its payment.
    //
    // NOTE: Firestore may run this callback more than once (retry on contention), so
    // it must not send responses or have side effects. Conflicts are thrown as
    // BookingConflict and turned into the 409 below.
    class BookingConflict extends Error {
      constructor(body) { super(body.message); this.body = body; }
    }

    try {
      await db.runTransaction(async (tx) => {
        const lockRef = db.collection("carLocks").doc(String(carID));

        // ---- all reads first ----
        // Only bookings that can possibly clash are read: every check below
        // needs  booking.end + 1-day buffer > requested start, so anything that
        // ended before (start - 1 day) can never matter. Needs a composite index
        // (carID + endDateTime). Until it exists Firestore rejects the query
        // (FAILED_PRECONDITION) — we log its create-index link once and fall
        // back to reading the car's full list, so booking never breaks.
        const BUFFER_READ_MS = 24 * 60 * 60 * 1000;
        const carBookingsQuery = db.collection("bookings")
          .where("carID", "==", carID)
          .where("endDateTime", ">", new Date(startDateTime.getTime() - BUFFER_READ_MS));
        const readCarBookings = async () => {
          try {
            return await tx.get(carBookingsQuery);
          } catch (e) {
            if (e && (e.code === 9 || /FAILED_PRECONDITION|requires an index/i.test(String(e.message)))) {
              if (!global.__carBookingsIndexWarned) {
                global.__carBookingsIndexWarned = true;
                console.warn("[createBooking] Create this Firestore index to speed up booking (bookings: carID asc, endDateTime asc):", e.message);
              }
              return tx.get(db.collection("bookings").where("carID", "==", carID));
            }
            throw e;
          }
        };
        const [, carBookingsSnap, maintSnap] = await Promise.all([
          tx.get(lockRef),
          readCarBookings(),
          tx.get(
            db.collection("maintenance")
              .where("carID", "==", carID)
              .where("status", "==", "Scheduled")
          ),
        ]);

        const BUFFER_MS = 24 * 60 * 60 * 1000;
        const ACTIVE = [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING];
        const carBookings = carBookingsSnap.docs.map((d) => d.data());

        // Same customer + same car + overlapping dates: last-line guard against a
        // double-click / two tabs. (The friendlier stale-booking handling already
        // ran above, before the transaction.)
        const mine = carBookings.find((b) =>
          b.userID === userID &&
          ACTIVE.includes(b.status) &&
          asDate(b.startDateTime) < endDateTime &&
          asDate(b.endDateTime)   > startDateTime
        );
        if (mine) {
          throw new BookingConflict({
            message: mine.status === BOOKING_STATUS.TO_PAY
              ? "You already have an unpaid booking for this car on these dates. Finish paying for it in My Bookings › To Pay, or cancel it there first."
              : "You already have a booking for this car on these dates.",
            existingBookingID: mine.bookingID,
            existingStatus: mine.status,
            existingStartDateTime: mine.startDateTime || null,
            existingEndDateTime: mine.endDateTime || null,
          });
        }

        // Another customer's booking, with the 1-day turnaround buffer.
        const otherOverlap = carBookings.find((b) => {
          if (b.userID === userID) return false;
          const bStart = asDate(b.startDateTime);
          const bEnd   = asDate(b.endDateTime);
          if (!bStart || !bEnd) return false;

          if (ACTIVE.includes(b.status)) {
            // Still pending/active — block its own window PLUS a 1-day buffer on
            // both sides, matching getDateStatuses()'s "preparation" days exactly.
            const bufferedStart = new Date(bStart.getTime() - BUFFER_MS);
            const bufferedEnd   = new Date(bEnd.getTime()   + BUFFER_MS);
            return bufferedStart < endDateTime && bufferedEnd > startDateTime;
          }

          if (b.status === BOOKING_STATUS.COMPLETED) {
            // Already returned — only the day-after cleaning/inspection buffer matters.
            const bufferedEnd = new Date(bEnd.getTime() + BUFFER_MS);
            return bEnd < endDateTime && bufferedEnd > startDateTime;
          }

          return false;
        });
        if (otherOverlap) {
          throw new BookingConflict({
            message: "This car needs a short turnaround before/after another booking on these dates. Please choose another date or vehicle.",
          });
        }

        // Staff-scheduled maintenance (single-day records, Manila calendar days).
        const maintOverlap = maintSnap.docs
          .map((d) => d.data().maintenanceDate)
          .filter(Boolean)
          .some((md) => {
            const { start: day, end: dayEnd } = manilaDayRange(toManila(asDate(md)).day);
            return day < endDateTime && dayEnd > startDateTime;
          });
        if (maintOverlap) {
          throw new BookingConflict({
            message: "This car is scheduled for maintenance on the selected dates. Please choose another date or vehicle.",
          });
        }

        // ---- then all writes ----
        tx.set(lockRef, { carID, lastBookingID: bookingID, updatedAt: now }, { merge: true });
        tx.set(bookingRef, bookingData);
        tx.set(paymentRef, paymentData);
        tx.set(bookingSessionRef, bookingSessionData);
        if (termsCheck.accepted) {
          // Append-only evidence of the acceptance, written with the booking (doc id = bookingID).
          tx.set(db.collection("termsAcceptances").doc(bookingID), {
            acceptanceID: bookingID,
            context:      "booking",
            bookingID,
            userID,
            termsVersion: termsCheck.terms.version,
            termsHash:    termsCheck.terms.hash,
            method:       "checkbox",
            acceptedAt:   now,
          });
        }
      });
    } catch (txErr) {
      if (txErr instanceof BookingConflict) return res.status(409).json(txErr.body);
      throw txErr; // anything else -> the outer catch (500)
    }

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
      serviceFeeRate: serviceRate,
      gatewayFeeRate: gatewayRate,
      gatewayFeeBase: gatewayBase,
      securityDeposit,
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

    // Why each cancelled booking was cancelled lives in cancellationRequests.
    const cancelReasons = await getCancellationReasons(
      bookings.filter((b) => (b.status || "").toLowerCase() === "cancelled").map((b) => b.bookingID || b.id)
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
        rentalFee:     0,
        status:               (b.status || "upcoming").toLowerCase(),
        cancellationReason:   cancelReasons[b.bookingID || b.id] || "",
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

    // balanceCollected / paidAt live in paymentEntries rows, not on the payment document: read the payments
    // through them. A display list must never fail on this, so fall back to the bare documents.
    const hydratedByDocID = {};
    try {
      const docs = paymentSnaps.filter((s) => !s.empty).map((s) => ({ id: s.docs[0].id, ...s.docs[0].data() }));
      const hydrated = await hydratePayments(docs);
      docs.forEach((d, n) => { hydratedByDocID[d.id] = hydrated[n]; });
    } catch (hydrateErr) {
      console.warn("getUserBookings: could not read paymentEntries, using the payment documents:", hydrateErr.message);
    }

    paymentSnaps.forEach((snap, i) => {
      if (!snap.empty) {
        const p = hydratedByDocID[snap.docs[0].id] || snap.docs[0].data();
        result[i].payment = {
          paymentID:       p.paymentID        || snap.docs[0].id,
          amount:          p.amount           || 0,
          driversFee:      p.driversFee       || 0,
          extraFee:        p.extraFee         || 0,
          gatewayFee:      p.gatewayFee       || 0,
          serviceFeeRate:  p.serviceFeeRate   || 0,
          gatewayFeeRate:  p.gatewayFeeRate   || 0,
          gatewayFeeBase:  p.gatewayFeeBase   || 0,
          securityDeposit: p.securityDeposit  || 0,
          serviceFee:      p.serviceFee       || 0,
          rentalFee:       p.rentalFee        || 0,
          methodOfPayment: p.methodOfPayment  || p.paymentMethod || "",
          paymentMethod:   p.paymentMethod    || p.methodOfPayment || "",
          // The pay_... reference lives on the payment's paymentEntries row; hydration fills these ids from it.
          referenceNumber: p.depositPaymongoPaymentID || p.paymongoPaymentID || "",
          status:          p.status           || "",
          // Two-phase payment fields — see utils/bookings/bookingStatus.util.js.
          // MyBookings.jsx needs these to know whether a "to pay" booking
          // already has its deposit paid (Partial, awaiting balance) so it
          // can show "Pay Balance" instead of "Pay Now" / hide "Cancel".
          payNow:          computePaymentSplit(p.amount, p.methodOfPayment, p.securityDeposit).payNow,
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
    // The reason lives in cancellationRequests (type "direct"), not on the booking.
    const cancelBatch = db.batch();
    cancelBatch.update(doc.ref, { status: "cancelled", updatedAt: now });
    recordDirectCancellation(booking.bookingID || doc.id, {
      userID, reason: reason || "Cancelled by user.", cancelledBy: "customer",
    }, cancelBatch);
    await cancelBatch.commit();

    // If this booking was still unpaid (or only deposit-paid on a Partial),
    // clean up its payment doc's still-pending fields so nothing sits as
    // "pending" forever (and can't still be paid via a stale PayMongo
    // checkout link). Never touches an already-paid deposit OR balance;
    // refunding those goes through the separate requestRefund flow instead.
    // The deposit / balance rows in paymentEntries take their status from
    // payments.status / payments.balanceStatus, so syncPaymentEntries() below
    // is all that is needed to mark the pending rows cancelled.
    if (booking.status === BOOKING_STATUS.TO_PAY) {
      try {
        const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
        if (!paymentSnap.empty) {
          const p = paymentSnap.docs[0].data();
          const updates = { updatedAt: now };
          if (p.status === "pending") updates.status = "cancelled";
          if (p.balanceStatus === "pending") updates.balanceStatus = "cancelled";
          if (Object.keys(updates).length > 1) {
            await paymentSnap.docs[0].ref.update(updates);
            await syncPaymentEntries(paymentSnap.docs[0].id);
          }
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

    // Don't allow spamming multiple pending requests on the same booking.
    // A request is its own row in cancellationRequests now (the old
    // cancellationRequest* fields on the booking are still honoured as "pending"
    // until the migration's cleanup phase has removed them).
    const bookingKey = booking.bookingID || doc.id;
    const pendingSnap = await db.collection("cancellationRequests")
      .where("bookingID", "==", bookingKey)
      .where("status", "==", "pending")
      .get();
    // A pending row that belongs to a refund request (refundRequestID) is decided through the refund, not here.
    if (pendingSnap.docs.some((d) => !d.data().refundRequestID)) {
      return res.status(400).json({ message: "A cancellation request for this booking is already pending admin review." });
    }

    const now = new Date();
    const requestRef = db.collection("cancellationRequests").doc();
    await requestRef.set({
      cancellationRequestID: requestRef.id,
      bookingID:    bookingKey,
      userID,
      reason:       reason.trim(),
      status:       "pending",
      createdAt:    now,
      processedBy:  null,
      processedAt:  null,
      rejectReason: null,
    });
    await doc.ref.update({ updatedAt: now });

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
// Body: { carID, startDateTime, endDateTime, destination, destinationCity, codingStops,
//         pickup, pickupCity }
// Returns: { blocked, reason?, violations?, warning?, warnings?, warningMessage?, holidays? }
//
// Logic:
//   1. Get the car's plate number → last digit
//   2. Walk EVERY Manila calendar day from the start to the end of the booking.
//      For each day, for each location (pickup, destination, extra stops):
//        a. the rule's weekday must match that day (Mon=1 … Sun=7)
//        b. if rule.city is set, the location must match that city
//        c. the part of the booking falling on that day must OVERLAP the rule's hours
//        d. the plate's last digit must be in rule.bannedDigits
//      Public holidays suspend coding for that day only.
//   3. Short bookings (<= 24h): any conflict → blocked.
//      Longer bookings: conflicts come back as `warnings` (not blocked) and the
//      customer must acknowledge them (createBooking enforces that too).
// ─────────────────────────────────────────────────────────────────────────────
const checkCodingRule = async (req, res) => {
  const { carID, startDateTime, endDateTime, destination, destinationCity, codingStops, pickup, pickupCity } = req.body;

  if (!carID || !startDateTime) {
    return res.status(400).json({ message: "carID and startDateTime are required." });
  }

  try {
    // 1. The car's plate number (cached by carID)
    const { notFound, lastDigit } = await getPlateLastDigit(carID);
    if (notFound) return res.status(404).json({ message: "Car not found." });
    if (isNaN(lastDigit)) return res.status(200).json({ blocked: false });

    // 2. Parse the booking window
    const bookingStart = new Date(startDateTime);
    if (isNaN(bookingStart.getTime())) {
      return res.status(400).json({ message: "startDateTime is not a valid date." });
    }
    const parsedEnd = endDateTime ? new Date(endDateTime) : null;
    // No (or invalid) end → treat as the rest of the start day, as before.
    const bookingEnd = parsedEnd && !isNaN(parsedEnd.getTime())
      ? parsedEnd
      : new Date(manilaDayRange(toManila(bookingStart).day).end.getTime());

    // 3. Holidays in range + rules (both cached/one query)
    const holidays = await getHolidayMap(bookingStart, bookingEnd);
    const codingRules = await getCodingRules();
    const holidayList = [...holidays.entries()].map(([date, name]) => ({ date, name }));
    const startDay = toManila(bookingStart).day;
    // Kept for older callers: set when the START day is a holiday.
    const legacyHoliday = holidays.has(startDay) ? { holiday: true, holidayName: holidays.get(startDay) } : {};
    if (!codingRules.length) return res.status(200).json({ blocked: false, holidays: holidayList, ...legacyHoliday });

    const result = evaluateCodingRange({
      rules: codingRules,
      startDateTime: bookingStart,
      endDateTime: bookingEnd,
      lastDigit,
      holidays,
      locations: buildCodingLocations({ destination, destinationCity, codingStops, pickup, pickupCity }),
    });

    if (!result.violations.length) {
      return res.status(200).json({ blocked: false, holidays: holidayList, holidaysSkipped: result.holidaysSkipped, ...legacyHoliday });
    }

    if (result.mode === "block") {
      // Window text in MANILA time (this used to call toLocaleTimeString on the
      // server, i.e. UTC on Vercel, so the message showed times 8 hours off).
      const windowText = `${fmtCodingMins(toManila(bookingStart).mins)}${parsedEnd ? " – " + fmtCodingMins(toManila(bookingEnd).mins) : ""}`;
      const first = result.violations[0];
      return res.status(200).json({
        blocked: true,
        reason: codingBlockMessage({ lastDigit, violations: result.violations, windowText }),
        // One entry per (day, location, rule) — the page marks each one.
        violations: result.violations,
        holidays: holidayList,
        holidaysSkipped: result.holidaysSkipped,
        // Kept for older callers: the first restriction found.
        rule: { city: first.city, dayName: first.dayName, startTime: first.startTime, endTime: first.endTime, bannedDigits: first.bannedDigits },
      });
    }

    // Multi-day booking: not blocked, but the customer has to acknowledge the dates.
    return res.status(200).json({
      blocked: false,
      warning: true,
      warnings: result.violations,
      warningMessage: codingWarningMessage({ lastDigit, violations: result.violations }),
      plateDigit: lastDigit,
      bookingHours: Math.round(result.hours * 10) / 10,
      holidays: holidayList,
      holidaysSkipped: result.holidaysSkipped,
      ...legacyHoliday,
    });

  } catch (error) {
    console.error("checkCodingRule error:", error);
    return res.status(500).json({ message: "Failed to check coding rules." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/coding-notice   (no auth — same as check-coding)
// body: { carID, destination, destinationCity, codingStops: [{ id, address, city }] }
//
// A date-INDEPENDENT heads-up for the "Pick Destination" step, which comes BEFORE
// the customer has chosen a date/time (so /check-coding has nothing to check yet).
// For every location picked (primary destination + each extra stop) it lists the
// days/hours on which THIS vehicle's plate is under number coding there. It never
// blocks anything — the real, date-specific check is still /check-coding (UI) and
// createBooking (server). Holidays aren't considered here, since no date is known.
// Response: { plateDigit, notices: [{ id, location, city, schedule: [{ dayOfWeek, dayName, startTime, endTime }] }] }
// ─────────────────────────────────────────────────────────────────────────────
const getCodingNotice = async (req, res) => {
  const { carID, destination, destinationCity, codingStops } = req.body;
  if (!carID) return res.status(400).json({ message: "carID is required." });

  try {
    const _cachedCar = codingCache.cars[carID];
    let plateNumber = _cachedCar && Date.now() - _cachedCar.at < CODING_CACHE_TTL_MS ? _cachedCar.plate : null;
    if (!plateNumber) {
      const carDoc = await db.collection("cars").doc(carID).get();
      if (!carDoc.exists) return res.status(404).json({ message: "Car not found." });
      plateNumber = (carDoc.data().plateNumber || "").trim().toUpperCase();
      if (plateNumber) codingCache.cars[carID] = { plate: plateNumber, at: Date.now() };
    }
    const lastDigit = parseInt((plateNumber || "").slice(-1), 10);
    if (!plateNumber || isNaN(lastDigit)) return res.status(200).json({ notices: [] });

    const rules     = await getCodingRules();
    const locations = buildCodingLocations({ destination, destinationCity, codingStops });
    const notices = findCodingNotices({ rules, lastDigit, locations });

    return res.status(200).json({ plateDigit: lastDigit, notices });
  } catch (error) {
    console.error("getCodingNotice error:", error);
    return res.status(500).json({ message: "Failed to load coding notice." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings/base-area   (no auth — read-only, same data the quote already reveals)
// Returns the admin's base-area keywords + the out-of-area fee amounts so the map can
// shade the base area and the booking page can explain the extra charges up front.
// { baseAreaKeywords, basis, extraFeeOutsideArea, driversFeeBaseArea, driversFeeOutsideArea }
// ─────────────────────────────────────────────────────────────────────────────
const getBaseArea = async (req, res) => {
  try {
    return res.status(200).json(await getBaseAreaConfig());
  } catch (error) {
    console.error("getBaseArea error:", error);
    return res.status(500).json({ message: "Failed to load base area." });
  }
};

module.exports = { createBooking, getUserBookings, cancelBooking, requestCancellation, checkCodingRule, getCodingNotice, getBookingQuote, getBaseArea };
