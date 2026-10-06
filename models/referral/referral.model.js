// One doc per successful referral, written at signup time — a plain
// connection table: "referrerUserID referred referredUserID".
//
// This is the ONLY place the referral relationship is stored. Everything
// else is derived by querying it:
//   - who referred user X?   -> where referredUserID == X  (at most one row)
//   - who did user X invite? -> where referrerUserID == X
//   - how many did X invite? -> count of the row above
// `referralID` is just this row's own random ID (same idea as penaltyID in
// penalties) — nothing is ever looked up by it.
const createReferral = (referralID, data = {}) => ({
  referralID,
  referrerUserID: data.referrerUserID || "",
  referredUserID: data.referredUserID || "",
  createdAt: new Date(),
});

module.exports = createReferral;