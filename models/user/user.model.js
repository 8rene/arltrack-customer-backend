const createUser = (userID, data) => ({
  userID,
  username:     data.username    || "",
  email:        data.email       || "",
  phone:        data.phone       || "",
  // This user's own shareable code, generated at signup. Who referred
  // them / who they referred lives in the "referrals" collection, not here.
  referralCode:    data.referralCode    || null,
  // Terms & Conditions accepted at signup (the full record + exact text: termsAcceptances / termsSnapshots).
  termsAcceptedAt: data.termsAcceptedAt || null,
  termsVersion:    data.termsVersion    || null,
  termsHash:       data.termsHash       || null,
  status:       "locked",          // always locked on signup — admin unlocks after review
  isVerified:   false,             // always false on signup — admin verifies manually
  isFlagged:    false,
  profileImage: "",
  roleID:       process.env.DEFAULT_ROLE_ID || "9vD6ZU1s2qUtmyu0RXKD",
  createdAt:    new Date(),
  updatedAt:    new Date(),
});

module.exports = createUser;
