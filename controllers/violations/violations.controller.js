// Customer side of the traffic-violation log.
//   POST /api/violations/report             a renter reports a ticket/notice they received
//   GET  /api/violations/booking/:bookingID the notices recorded for one of THEIR bookings
// Staff record notices that reach the company (and move them to paid/billed/recovered) in the
// admin app, on the same `violations` collection — see utils/violations/violations.util.js.
const { db } = require("../../config/firebaseConnection/firebase");
const { notifyStaff } = require("../../services/notification/notification.service");
const { BOOKING_STATUS } = require("../../utils/bookings/bookingStatus.util");
const { loadOwnedBooking, realWindow, toISO } = require("../../utils/bookings/ownedBooking.util");
const { VIOLATION_TYPES, VIOLATION_STATUS } = require("../../utils/violations/violations.util");

const MAX_REPORTS_PER_BOOKING = 20;

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// "2030-03-12T14:30" (a datetime-local value, no zone) is Manila wall-clock; anything that
// carries its own offset / Z is taken as-is. Returns null if it can't be parsed.
const parseOccurredAt = (v) => {
  const s = String(v || "").trim();
  if (!s) return null;
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(s);
  const withSeconds = /T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  const d = new Date(hasZone ? s : `${withSeconds}+08:00`);
  return isNaN(d.getTime()) ? null : d;
};

// null/"" → null; a valid 0–100,000 amount → number; anything else → NaN
const parseAmount = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) / 100 : NaN;
};

// What the customer is allowed to see of a violation doc.
const customerView = (id, d) => ({
  violationID:   id,
  type:          d.type || "Other",
  occurredAt:    toISO(d.occurredAt),
  location:      d.location || "",
  noticeNumber:  d.noticeNumber || "",
  amount:        d.amount ?? null,
  status:        d.status || VIOLATION_STATUS.REPORTED,
  source:        d.source === "customer" ? "customer" : "staff",
  withinRental:  d.withinRental ?? null,
  contestDeadline: toISO(d.contestDeadline),
  createdAt:     toISO(d.createdAt),
});

const reportViolation = async (req, res) => {
  try {
    const userID = req.user?.userID;
    const { bookingID, type, occurredAt, location, noticeNumber, amount, details } = req.body || {};

    const booking = await loadOwnedBooking(userID, bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });
    if (![BOOKING_STATUS.ONGOING, BOOKING_STATUS.COMPLETED].includes(booking.status)) {
      return res.status(400).json({ message: "You can report a ticket once your rental has started." });
    }

    if (!VIOLATION_TYPES.includes(type)) return res.status(400).json({ message: "Please choose the type of violation." });
    const when = parseOccurredAt(occurredAt);
    if (!when) return res.status(400).json({ message: "Please enter when the violation happened." });
    if (when.getTime() > Date.now() + 10 * 60 * 1000) return res.status(400).json({ message: "The violation date can't be in the future." });
    const place = clean(location, 200);
    if (!place) return res.status(400).json({ message: "Please enter where it happened." });
    const amountValue = parseAmount(amount);
    if (Number.isNaN(amountValue)) return res.status(400).json({ message: "Please enter a valid amount, or leave it blank." });
    const notice = clean(noticeNumber, 60);

    // Anti-spam + duplicate guard
    const existing = await db.collection("violations").where("bookingID", "==", booking.bookingID).get();
    const customerReports = existing.docs.filter((d) => d.data().source === "customer");
    if (customerReports.length >= MAX_REPORTS_PER_BOOKING) {
      return res.status(429).json({ message: "This booking already has the maximum number of reports. Please contact us." });
    }
    if (notice && existing.docs.some((d) => (d.data().noticeNumber || "").toLowerCase() === notice.toLowerCase())) {
      return res.status(409).json({ message: "A violation with that notice number is already recorded for this booking." });
    }

    // Plate of the car, from the car record (not from the browser)
    let plateNumber = "";
    if (booking.carID) {
      const carDoc = await db.collection("cars").doc(booking.carID).get();
      if (carDoc.exists) plateNumber = (carDoc.data().plateNumber || "").trim().toUpperCase();
    }

    const window = realWindow(booking);
    const withinRental = window ? when >= window.start && when <= window.end : null;
    const now = new Date();
    const ref = db.collection("violations").doc();
    const doc = {
      violationID:    ref.id,
      source:         "customer",
      status:         VIOLATION_STATUS.REPORTED,
      bookingID:      booking.bookingID,
      userID,
      carID:          booking.carID || null,
      plateNumber,
      // Who was driving matters for the recovery: the renter on a self-drive, ARL's own driver otherwise.
      driverType:     booking.modeOfDriving === "With Chauffeur" ? "chauffeur" : "renter",
      type,
      occurredAt:     when,
      withinRental,   // false = outside the booking's own dates — staff check it
      location:       place,
      noticeNumber:   notice,
      amount:         amountValue,
      details:        clean(details, 1000),
      contestDeadline: null, // staff fill this in once they know the issuing agency's window
      reportedByUserID: userID,
      history:        [{ at: now, by: "customer", action: "reported" }],
      createdAt:      now,
      updatedAt:      now,
    };
    await ref.set(doc);

    notifyStaff({
      type: "violation_reported",
      refID: ref.id,
      refCollection: "violations",
      title: "Traffic violation reported",
      message: `A renter reported a ${type.toLowerCase()} notice for booking ${booking.bookingID}${plateNumber ? ` (plate ${plateNumber})` : ""}.`,
    }).catch((e) => console.error("notifyStaff(violation_reported):", e.message));

    return res.status(201).json({ message: "Thank you — we received your report.", violation: customerView(ref.id, doc) });
  } catch (error) {
    console.error("reportViolation error:", error);
    return res.status(500).json({ message: "Could not save your report. Please try again." });
  }
};

const getBookingViolations = async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.user?.userID, req.params.bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });
    const snap = await db.collection("violations").where("bookingID", "==", booking.bookingID).get();
    const violations = snap.docs
      .map((d) => customerView(d.id, d.data()))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return res.json({ violations, types: VIOLATION_TYPES });
  } catch (error) {
    console.error("getBookingViolations error:", error);
    return res.status(500).json({ message: "Could not load the notices for this booking." });
  }
};

module.exports = { reportViolation, getBookingViolations };
