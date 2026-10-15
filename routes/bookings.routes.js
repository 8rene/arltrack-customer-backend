const express = require("express");
const router  = express.Router();

const { createBooking, getUserBookings, cancelBooking, requestCancellation, checkCodingRule, getCodingNotice, getBookingQuote, getBaseArea } = require("../controllers/bookings/bookings.controller");
const { getBookingDetails } = require("../controllers/bookings/bookingSessions.controller");
const { resendReceipt } = require("../controllers/bookings/receipt.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.post("/create",                        verifyToken, createBooking);
router.get("/user/:userID",                   verifyToken, getUserBookings);
router.patch("/:bookingID/cancel",            verifyToken, cancelBooking);
router.patch("/:bookingID/request-cancellation", verifyToken, requestCancellation); // ongoing bookings only — needs admin approval
router.post("/check-coding",        checkCodingRule);   // no auth needed — called before login check
router.post("/coding-notice",       getCodingNotice);   // no auth needed — date-independent heads-up for the Destination step; never blocks
router.post("/base-area",            getBaseArea);       // no auth needed — base-area keywords + out-of-area fee amounts (read-only)
router.post("/quote",               getBookingQuote);   // no auth needed — pricing preview only, writes nothing
router.get("/:bookingID/details",   verifyToken, getBookingDetails);
router.post("/:bookingID/resend-receipt", verifyToken, resendReceipt);

module.exports = router;
