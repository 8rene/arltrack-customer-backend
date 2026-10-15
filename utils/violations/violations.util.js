// ─────────────────────────────────────────────────────────────────────────────
// Traffic violation notices — shared constants + a matching helper.
//
// Data lives in the `violations` collection, which BOTH apps use:
//   • this (customer) backend lets a renter REPORT a ticket they received and see the notices
//     recorded for their booking (controllers/violations/violations.controller.js);
//   • the ADMIN app is where staff record notices that arrive at the company (the plate's
//     registered owner) and work them through to recovery. It can copy matchBookingForNotice()
//     below to find which booking a notice belongs to from just the plate + date/time.
// See docs/violations-and-handover-contract.md for the full document shape and the notification
// types each side should create.
// ─────────────────────────────────────────────────────────────────────────────
const { db } = require("../../config/firebaseConnection/firebase");
const { BOOKING_STATUS } = require("../bookings/bookingStatus.util");
const { realWindow } = require("../bookings/ownedBooking.util");

const VIOLATION_TYPES = ["Number coding", "Parking", "Traffic sign / lane", "Speeding", "Other"];

// Lifecycle (staff move a notice along it): reported (by the customer) / recorded (by staff)
// → under review → contesting | paid → billed → recovered, or dismissed.
const VIOLATION_STATUS = {
  REPORTED:     "reported",
  RECORDED:     "recorded",
  UNDER_REVIEW: "under review",
  CONTESTING:   "contesting",
  PAID:         "paid",
  BILLED:       "billed",
  RECOVERED:    "recovered",
  DISMISSED:    "dismissed",
};

const normalizePlate = (p) => String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// plate + moment of the violation → the booking(s) whose real rental window contained it.
//   { matches: [{ bookingID, userID, carID, status }], ambiguous: boolean }
// `graceMs` widens the window a little (notices are time-stamped by cameras/enforcers whose
// clocks aren't ours, and a car is often a bit early/late at handover).
const matchBookingForNotice = async ({ plateNumber, occurredAt, graceMs = 2 * 60 * 60 * 1000 }) => {
  const plate = normalizePlate(plateNumber);
  const when  = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!plate || isNaN(when.getTime())) return { matches: [], ambiguous: false };

  const carsSnap = await db.collection("cars").get();
  const carIDs = carsSnap.docs.filter((d) => normalizePlate(d.data().plateNumber) === plate).map((d) => d.id);
  const matches = [];
  for (const carID of carIDs) {
    const snap = await db.collection("bookings").where("carID", "==", carID).get();
    snap.docs.forEach((d) => {
      const b = d.data();
      if (![BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING, BOOKING_STATUS.COMPLETED].includes(b.status)) return;
      const w = realWindow(b);
      if (w && when >= new Date(w.start.getTime() - graceMs) && when <= new Date(w.end.getTime() + graceMs)) {
        matches.push({ bookingID: d.id, userID: b.userID, carID, status: b.status });
      }
    });
  }
  return { matches, ambiguous: matches.length > 1 };
};

module.exports = { VIOLATION_TYPES, VIOLATION_STATUS, normalizePlate, matchBookingForNotice };
