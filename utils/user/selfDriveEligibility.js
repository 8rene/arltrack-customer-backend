// selfDriveEligibility.js
// Who may book "Without Driver" (self-drive)?  Only a customer who
//   1. has a driver's license on file (photo uploaded at signup, or added later in Profile and approved by staff),
//   2. whose license has not expired (judged on the day the trip ENDS, so it cannot lapse mid-rental), and
//   3. is at least MIN_SELF_DRIVE_AGE years old on the pickup day.
// Everyone else can still book With Driver.
//
// Used by GET /user/details/:userID (so the booking page can grey the option out) AND by createBooking
// (the real rule — a request sent straight to the API skips the booking page).
//
// Dates are PH time (UTC+8), like the rest of the booking system.

const { db } = require("../../config/firebaseConnection/firebase");

const MIN_SELF_DRIVE_AGE = 21; // keep in sync with MIN_AGE in SignUpModal.jsx / MIN_SIGNUP_AGE in signup.controller.js
const PH_OFFSET_MS = 8 * 60 * 60 * 1000;

// "YYYY-MM-DD" in PH time for any instant.
const phDay = (at) => new Date(at.getTime() + PH_OFFSET_MS).toISOString().slice(0, 10);

const asDate = (v) => {
  if (!v) return null;
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Whole years from an ISO "YYYY-MM-DD" birthdate to the given PH day. null = unreadable / impossible.
const ageOnDay = (birthIso, dayIso) => {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthIso || ""));
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso);
  if (!b || !t) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age < 0 || age > 120 ? null : age;
};

const fmtDay = (iso) => {
  const d = new Date(`${iso}T00:00:00+08:00`);
  return d.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila" });
};

/**
 * @param {string} userID
 * @param {{ pickupAt?: Date, returnAt?: Date }} [when]  defaults to "now" for both (what the booking page uses)
 * @returns {Promise<{ canSelfDrive: boolean, reason: "ok"|"no_license"|"license_expired"|"underage"|"no_birthdate",
 *                     message: string, licenseExpiry: string|null, minAge: number }>}
 */
const getSelfDriveEligibility = async (userID, when = {}) => {
  const pickupAt = when.pickupAt || new Date();
  const returnAt = when.returnAt || pickupAt;
  const out = (canSelfDrive, reason, message, licenseExpiry = null) =>
    ({ canSelfDrive, reason, message, licenseExpiry, minAge: MIN_SELF_DRIVE_AGE });

  const [detailsDoc, docsSnap] = await Promise.all([
    db.collection("userDetails").doc(userID).get(),
    db.collection("userDocument").where("userID", "==", userID).get(),
  ]);

  // 1. A license on file. The photo is the proof (the license NUMBER is only typed at signup; a license added
  //    later through Profile is a photo that staff review and approve).
  const docs = docsSnap.docs.map((d) => d.data());
  const hasLicense = docs.some((d) => typeof d.driverLicenseUrl === "string" && d.driverLicenseUrl.trim() !== "");
  if (!hasLicense) {
    return out(false, "no_license",
      "Add your driver's license in your profile to book Without Driver. Until then you can book With Driver.");
  }

  // 2. Not expired. Several userDocument records can exist (re-uploads) — the LATEST expiry wins. No date on file
  //    (staff have not entered one yet) is not treated as expired.
  let expiry = null;
  docs.forEach((d) => {
    const e = asDate(d.driverLicenseExpiry);
    if (e && (!expiry || e > expiry)) expiry = e;
  });
  const expiryDay = expiry ? phDay(expiry) : null;
  if (expiryDay && expiryDay < phDay(returnAt)) {
    const ends = phDay(returnAt) !== phDay(new Date());
    return out(false, "license_expired",
      ends
        ? `Your driver's license expires on ${fmtDay(expiryDay)}, before this trip ends. Update it in your profile, or book With Driver.`
        : `Your driver's license expired on ${fmtDay(expiryDay)}. Update it in your profile to book Without Driver.`,
      expiryDay);
  }

  // 3. Minimum age on the pickup day.
  const birth = detailsDoc.exists ? detailsDoc.data().birthDate : "";
  const age = ageOnDay(birth, phDay(pickupAt));
  if (age === null) {
    return out(false, "no_birthdate",
      "We could not confirm your age, so Without Driver is not available. You can book With Driver.", expiryDay);
  }
  if (age < MIN_SELF_DRIVE_AGE) {
    return out(false, "underage",
      `You must be at least ${MIN_SELF_DRIVE_AGE} years old to book Without Driver. You can book With Driver.`, expiryDay);
  }

  return out(true, "ok", "", expiryDay);
};

module.exports = { getSelfDriveEligibility, MIN_SELF_DRIVE_AGE };
