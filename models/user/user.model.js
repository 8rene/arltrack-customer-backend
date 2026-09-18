const createUser = (userID, data) => ({
  userID,
  username:     data.username    || "",
  email:        data.email       || "",
  phone:        data.phone       || "",
  // This user's own code, generated at signup, for them to share with
  // others. Distinct from `referredBy` below, which is about the code
  // THEY entered when THEY signed up.
  referralCode:    data.referralCode    || null,
  // Set only if the code they entered at signup matched a real user.
  // referredByCode preserves whatever they typed even when it didn't
  // match anyone, so a bad/mistyped code isn't silently lost — support
  // or an admin can still see what the customer entered.
  referredBy:      data.referredBy      || null, // referrer's userID, or null
  referredByCode:  data.referredByCode  || null, // raw code text entered, or null
  referralCount:   0,                            // how many people THIS user has referred
  status:       "locked",          // always locked on signup — admin unlocks after review
  isVerified:   false,             // always false on signup — admin verifies manually
  isFlagged:    false,
  profileImage: "",
  roleID:       process.env.DEFAULT_ROLE_ID || "9vD6ZU1s2qUtmyu0RXKD",
  createdAt:    new Date(),
  updatedAt:    new Date(),
});

module.exports = createUser;
