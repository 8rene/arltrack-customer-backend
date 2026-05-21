const createUser = (userID, data) => ({
  userID,
  username:     data.username    || "",
  email:        data.email       || "",
  phone:        data.phone       || "",
  referralCode: data.referralCode || null,   // optional — stored as-is; null if not provided
  status:       "locked",          // always locked on signup — admin unlocks after review
  isVerified:   false,             // always false on signup — admin verifies manually
  isFlagged:    false,
  profileImage: "",
  roleID:       process.env.DEFAULT_ROLE_ID || "9vD6ZU1s2qUtmyu0RXKD",
  createdAt:    new Date(),
  updatedAt:    new Date(),
});

module.exports = createUser;
