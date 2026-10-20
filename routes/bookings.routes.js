const express = require("express");
const router  = express.Router();

const { createBooking, getUserBookings, cancelBooking, requestCancellation, checkCodingRule, getCodingNotice, getCodingCities, getBookingQuote, getBaseArea, getDriverAvailability, getDriverFullDays, getDriverPickupTimes } = require("../controllers/bookings/bookings.controller");
const { getBookingDetails } = require("../controllers/bookings/bookingSessions.controller");
const { getStatement, getStatementPdf, emailStatement, getReceipt, getReceiptPdf, emailReceipt } = require("../controllers/bookings/receipt.controller");
const verifyToken = require("../middlewares/auth.middleware");
const rateLimit = require("../middlewares/rateLimit.middleware");

router.post("/create",                        verifyToken, createBooking);
router.get("/user/:userID",                   verifyToken, getUserBookings);
router.patch("/:bookingID/cancel",            verifyToken, cancelBooking);
router.patch("/:bookingID/request-cancellation", verifyToken, requestCancellation); // ongoing bookings only — needs admin approval
router.post("/check-coding",        checkCodingRule);   // no auth needed — called before login check
router.post("/coding-notice",       getCodingNotice);   // no auth needed — date-independent heads-up for the Destination step; never blocks
router.post("/coding-cities",       getCodingCities);   // no auth needed — distinct cities with a coding rule, for the Destination map's orange heads-up shading; never blocks
router.post("/base-area",            getBaseArea);       // no auth needed — base-area keywords + out-of-area fee amounts (read-only)
router.post("/driver-availability", rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "driver-availability" }), getDriverAvailability); // no auth -- chauffeur capacity for a window; returns only { available }
router.post("/driver-availability/days", rateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: "driver-full-days" }), getDriverFullDays); // no auth -- days with no chauffeur all day, for the calendar; returns only dates
router.post("/driver-availability/times", rateLimit({ windowMs: 60 * 1000, max: 120, keyPrefix: "driver-pickup-times" }), getDriverPickupTimes); // no auth -- pickup times on a day that still have a driver; returns only "HH:MM" strings
router.post("/quote",               getBookingQuote);   // no auth needed — pricing preview only, writes nothing
router.get("/:bookingID/details",   verifyToken, getBookingDetails);

// Receipts + booking statement (same documents as the admin side). Owner-only; PDFs and emails are rate limited on top of
// the shared 5-minute email limit, since a PDF costs CPU.
const pdfLimit   = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "receipt-pdf" });
const emailLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: "receipt-email" });
router.get("/:bookingID/statement",                          verifyToken, getStatement);
router.get("/:bookingID/statement/pdf",                      verifyToken, pdfLimit,   getStatementPdf);
router.post("/:bookingID/statement/email",                   verifyToken, emailLimit, emailStatement);
router.get("/:bookingID/receipts/:entryID",                  verifyToken, getReceipt);
router.get("/:bookingID/receipts/:entryID/pdf",              verifyToken, pdfLimit,   getReceiptPdf);
router.post("/:bookingID/receipts/:entryID/email",           verifyToken, emailLimit, emailReceipt);

module.exports = router;