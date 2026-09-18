const { db } = require("../../config/firebaseConnection/firebase");

// Characters chosen to avoid visually-ambiguous ones (0/O, 1/I/L) since
// people read these codes off a screen and type them back in by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH   = 8;
const CODE_PREFIX   = "ARL-";

const randomCode = () => {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${out}`;
};

// Every user gets their own shareable referral code at signup. Collisions
// are astronomically unlikely (32^8 combinations) but we still check,
// same defensive spirit as the rest of this codebase not trusting luck
// where a duplicate would silently misattribute referrals.
const generateUniqueReferralCode = async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomCode();
    const snap = await db.collection("user")
      .where("referralCode", "==", candidate)
      .limit(1)
      .get();
    if (snap.empty) return candidate;
  }
  // Vanishingly unlikely to ever hit this, but fail loudly instead of
  // silently handing out a colliding code if it somehow does.
  throw new Error("Could not generate a unique referral code after 5 attempts.");
};

// Looks up which user owns a given referral code. Normalizes case/whitespace
// since customers will copy-paste this from a text message, screenshot, etc.
// Returns the user doc snapshot (with .id === userID), or null if not found.
const findUserByReferralCode = async (rawCode) => {
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) return null;

  const snap = await db.collection("user")
    .where("referralCode", "==", code)
    .limit(1)
    .get();

  return snap.empty ? null : snap.docs[0];
};

module.exports = { generateUniqueReferralCode, findUserByReferralCode, CODE_PREFIX };
