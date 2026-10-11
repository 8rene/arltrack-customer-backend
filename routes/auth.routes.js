const express = require("express");
const router = express.Router();

const { signup, checkAvailability, checkReferralCode } = require("../controllers/auth/signup.controller");
const { login }   = require("../controllers/auth/login.controller");
const { sendOTP, verifyOTP } = require("../controllers/auth/otp.controller");
const { resetPassword } = require("../controllers/auth/resetPassword.controller"); // ← NEW
const { googleLogin } = require("../controllers/auth/google.controller"); // ← add
const { logout } = require("../controllers/auth/logout.controller"); // ← NEW
const validateSignup = require("../middlewares/signup.middleware");
const validateLogin  = require("../middlewares/login.middleware");
const verifyToken    = require("../middlewares/auth.middleware");
const rateLimit      = require("../middlewares/rateLimit.middleware");

// GET /api/auth/check-availability?email=x&phone=x&username=x
// Rate-limited: this tells the caller whether an email/username is registered, so it
// must not be scriptable at full speed. The signup form only calls it once per submit.
router.get("/check-availability", rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "check-availability" }), checkAvailability);
// GET /api/auth/check-referral?code=ARL-XXXXXXXX  (used live by the signup form)
// Public endpoint that confirms a code and returns the referrer's username, so it's
// rate-limited (30 lookups / 10 min / IP) to make guessing codes impractical.
router.get("/check-referral",     rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "check-referral" }), checkReferralCode);
router.post("/signup",            validateSignup, signup);
// Per-IP limits (10 min window). Deliberately generous: many mobile users share one
// carrier IP, so these only stop scripted floods, not normal use. The OTP endpoints
// are also protected per-code (5 wrong guesses) and per-email (60 s resend cooldown).
// NOTE: the limiter is in-memory, so on Vercel each serverless instance counts on
// its own — it slows an attacker down but is not a hard cap.
const authLimit = (keyPrefix, max) => rateLimit({ windowMs: 10 * 60 * 1000, max, keyPrefix });

router.post("/login",             authLimit("login", 30),           validateLogin,  login);
router.post("/send-otp",          authLimit("send-otp", 15),        sendOTP);
router.post("/verify-otp",        authLimit("verify-otp", 30),      verifyOTP);
router.post("/reset-password",    authLimit("reset-password", 15),  resetPassword); // ← NEW
router.post("/google",            authLimit("google-login", 30),    googleLogin); // ← add
router.post("/logout",            verifyToken, logout); // ← NEW

module.exports = router;
