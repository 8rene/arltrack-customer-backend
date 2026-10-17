const crypto = require("crypto");
const { db, auth } = require("../../config/firebaseConnection/firebase");
const generateOTP = require("../../utils/generateOTP");
const { isBlockedAdminRole } = require("../../utils/roles/role.util");

const OTP_EXPIRY_MS  = 5 * 60 * 1000;  // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000;     // 1 minute cooldown between requests
const MAX_ATTEMPTS = 5;                // max wrong guesses before lockout

// Firebase Auth matches emails case-insensitively, but the OTP document is keyed by the exact text
// — so "Juan@x.com" and "juan@x.com" got separate cooldowns, attempt counters and codes (and a code
// requested under one spelling could not be verified under the other). Always trimmed + lowercase.
const normalizeEmail = (raw) => (typeof raw === "string" ? raw.trim().toLowerCase() : "");

// ── OTP storage / verification helpers ───────────────────────────────────────
// Also used by resetPassword.controller.js.
//  - The code is never stored in plain text: Firestore keeps an HMAC of it
//    (keyed with a server secret), so a leaked database can't be used to read
//    live codes or brute-force the 1,000,000 possibilities offline.
//  - Checking a code and counting a wrong guess happen inside ONE Firestore
//    transaction, so parallel requests can't each "see" the same attempts count
//    and sneak extra guesses past MAX_ATTEMPTS, and a correct code can only be
//    consumed once.
const hmacKey = () => {
  const key = process.env.OTP_HMAC_SECRET || process.env.JWT_SECRET;
  if (!key) throw new Error("OTP_HMAC_SECRET (or JWT_SECRET) must be set.");
  return key;
};

// Bound to the email so the same digits for two emails never hash the same.
const hashOTP = (email, otp) =>
  crypto.createHmac("sha256", hmacKey()).update(`${String(email)}:${String(otp)}`).digest("hex");

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const otpMatches = (data, email, otp) => {
  if (data.otpHash) return safeEqual(data.otpHash, hashOTP(email, otp));
  // Codes issued before this change (still valid for up to 5 minutes) were
  // stored in plain text — keep accepting them during the rollout.
  return typeof data.otp === "string" && safeEqual(data.otp, String(otp));
};

/**
 * Validates `otp` for `email` atomically.
 * purpose: "signup" | "reset" — a code issued for one flow can't be spent in the other.
 * consume: delete the code on success (the reset flow passes false and deletes it
 *          itself once the password has actually been changed).
 * Returns { status: "ok" | "not_found" | "expired" | "locked" | "invalid", remaining? }
 */
const verifyAndConsumeOTP = async ({ email, otp, purpose, consume = true }) => {
  const ref = db.collection("otpCodes").doc(email);

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return { status: "not_found" };

    const data = doc.data();
    if (data.purpose !== purpose) return { status: "not_found" };

    if (new Date() > data.expiresAt.toDate()) {
      tx.delete(ref);
      return { status: "expired" };
    }

    const attempts = Number(data.attempts) || 0;
    if (attempts >= MAX_ATTEMPTS) {
      tx.delete(ref);
      return { status: "locked" };
    }

    if (!otpMatches(data, email, otp)) {
      tx.update(ref, { attempts: attempts + 1 });
      return { status: "invalid", remaining: MAX_ATTEMPTS - (attempts + 1) };
    }

    if (consume) tx.delete(ref);
    return { status: "ok" };
  });
};

// POST /api/auth/send-otp
// body: { email, name, purpose }   (a client-sent template_id is ignored — see below)
//
// `purpose` distinguishes the two flows that share this endpoint:
//   - "signup" (default/omitted) — the email is EXPECTED not to exist yet.
//     No account/role check here; that's what signup itself validates.
//   - "reset"  — forgot-password flow. The email MUST already belong to a
//     real, non-admin-side account, or we don't send an OTP at all. This
//     both avoids wasting OTP emails on addresses that were never
//     registered, and stops Owner/Admin/Supervisor/Driver accounts from
//     using the customer-side forgot-password flow to reset their password —
//     same accounts that are blocked from customer login (login.controller.js).
//
// The response is IDENTICAL whether or not the account exists (or is an
// admin-side account): { emailSent: true }, no OTP stored, no email sent.
// Previously an unknown email got a 404 "No account found", which let anyone
// test which emails are registered. (The reset-password step can't be used to
// probe either: it needs a valid OTP, and unknown emails never get one.)
const sendOTP = async (req, res) => {
  const { name, purpose } = req.body;
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ message: "Email is required." });

  try {
    if (purpose === "reset") {
      let firebaseUser;
      try {
        firebaseUser = await auth.getUserByEmail(email);
      } catch (err) {
        if (err.code === "auth/user-not-found") {
          return res.status(200).json({ emailSent: true }); // looks the same as a real send
        }
        throw err;
      }

      const userDoc = await db.collection("user").doc(firebaseUser.uid).get();
      const roleID  = userDoc.exists ? userDoc.data().roleID : null;

      if (roleID && await isBlockedAdminRole(roleID, db)) {
        return res.status(200).json({ emailSent: true }); // same — don't reveal admin-side accounts
      }
    }

    // Bug 4 fix: cooldown check — block if OTP was requested less than 1 minute ago
    const existing = await db.collection("otpCodes").doc(email).get();
    if (existing.exists) {
      const createdAt = existing.data().createdAt?.toDate?.() || new Date(0);
      const elapsed   = Date.now() - createdAt.getTime();
      if (elapsed < OTP_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          message: `Please wait ${secondsLeft} seconds before requesting a new OTP.`,
        });
      }
    }

    const otp  = generateOTP();
    const time = new Date().toLocaleTimeString();

    // Store OTP in Firestore with expiry, cooldown timestamp, and attempt counter
    await db.collection("otpCodes").doc(email).set({
      otpHash:    hashOTP(email, otp), // never store the code itself
      purpose:    purpose === "reset" ? "reset" : "signup",
      createdAt:  new Date(),
      expiresAt:  new Date(Date.now() + OTP_EXPIRY_MS),
      attempts:   0,
      verified:   false,
    });

    // Send OTP via EmailJS
    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id:  process.env.EMAILJS_SERVICE_ID,
        // Always the server's OTP template. This used to accept a client-sent
        // template_id, which let anyone send any of the account's EmailJS
        // templates to any address through this endpoint.
        template_id: process.env.EMAILJS_OTP_TEMPLATE_ID || "template_pcp4m9n",
        user_id:     process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
          name:       name || email.split("@")[0],
          otp_code:   otp,
          user_email: email,
          email,
          time,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Log the provider's error server-side only — it can contain account /
      // template details that shouldn't be sent to the browser.
      console.error("EmailJS error:", errText);
      return res.status(200).json({ emailSent: false });
    }

    return res.status(200).json({ emailSent: true });

  } catch (err) {
    console.error("sendOTP error:", err);
    return res.status(500).json({ message: "Server error sending OTP." });
  }
};

// POST /api/auth/verify-otp
const verifyOTP = async (req, res) => {
  const { otp } = req.body;
  const email = normalizeEmail(req.body.email);
  if (!email || !otp) {
    return res.status(400).json({ message: "Email and OTP are required." });
  }

  try {
    // Checks the code and counts a wrong guess in one atomic step (see
    // verifyAndConsumeOTP above). Only codes issued for signup / login verification
    // (purpose "signup") can be verified here — a "reset" code is spent through
    // /auth/reset-password instead.
    const result = await verifyAndConsumeOTP({ email, otp: String(otp), purpose: "signup" });

    if (result.status === "not_found") {
      return res.status(404).json({ message: "OTP not found. Please request a new one." });
    }
    if (result.status === "expired") {
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }
    if (result.status === "locked") {
      return res.status(429).json({ message: "Too many failed attempts. Please request a new OTP." });
    }
    if (result.status === "invalid") {
      return res.status(400).json({
        message: `Invalid OTP. ${result.remaining} attempt${result.remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // status "ok" — the code was deleted in the same transaction, so it can't be reused.
    return res.status(200).json({ message: "OTP verified successfully." });

  } catch (err) {
    console.error("verifyOTP error:", err);
    return res.status(500).json({ message: "Server error verifying OTP." });
  }
};

module.exports = { sendOTP, verifyOTP, verifyAndConsumeOTP, normalizeEmail };
