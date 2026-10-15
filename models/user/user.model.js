const createUser = (userID, data) => ({
  userID,
  username:     data.username    || "",
  email:        data.email       || "",
  phone:        data.phone       || "",
  // This user's own shareable code, generated at signup. Who referred
  // them / who they referred lives in the "referrals" collection, not here.
  referralCode:    data.referralCode    || null,
  // Terms & Conditions accepted at signup: termsVersionID points at the exact text in the
  // admin's termsVersions collection. (Accounts created before this change carry
  // termsVersion + termsHash instead.)
  termsVersionID:  data.termsVersionID  || null,
  termsAcceptedAt: data.termsAcceptedAt || null,
  status:       "locked",          // always locked on signup — admin unlocks after review
  isVerified:   false,             // always false on signup — admin verifies manually
  isFlagged:    false,
  profileImage: "",
  roleID:       process.env.DEFAULT_ROLE_ID || "9vD6ZU1s2qUtmyu0RXKD",
  createdAt:    new Date(),
  updatedAt:    new Date(),
});

module.exports = createUser;
