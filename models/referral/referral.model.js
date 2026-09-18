// One doc per successful referral, written at signup time.
// Kept as its own collection (rather than only a counter on the referrer's
// user doc) so there's a real audit trail — who referred whom, and when —
// which the counter alone can't give you. This is also the doc a future
// "reward the referrer once their friend's booking is approved" job would
// update (status: "pending" -> "rewarded"), so `status` is included now
// even though nothing sets it to "rewarded" yet.
const createReferral = (referralID, data = {}) => ({
  referralID,
  referrerUserID: data.referrerUserID || "",
  referrerCode:   data.referrerCode   || "",
  referredUserID: data.referredUserID || "",
  referredUsername: data.referredUsername || "",
  status:    "pending", // pending -> rewarded | voided, once/if a rewards flow exists
  createdAt: new Date(),
});

module.exports = createReferral;
