const { auth, db } = require("../../config/firebaseConnection/firebase");
const jwt          = require("jsonwebtoken");

const googleLogin = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ message: "Google ID token is required." });
  }

  try {
    // 1. Verify the ID token with Firebase Admin SDK
    const decoded = await auth.verifyIdToken(idToken);
    const { uid, email } = decoded;

    // 2. Query Firestore by email (not UID)
    const userQuery = await db.collection("user")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(403).json({
        message: "No account found for this Google email. Please register first.",
      });
    }

    const userData = userQuery.docs[0].data();
    const userID   = userQuery.docs[0].id; // original UID from email signup

    // 3. Issue JWT using the original UID
    const token = jwt.sign(
      {
        userID:   userID,
        email:    userData.email,
        roleID:   userData.roleID,
        username: userData.username || "",
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        userID:       userID,
        email:        userData.email,
        phone:        userData.phone        || "",
        username:     userData.username     || "",
        roleID:       userData.roleID       || "",
        profileImage: userData.profileImage || "",
        isVerified:   userData.isVerified   || false,
      },
    });

  } catch (error) {
    console.error("Google login error:", error.message);

    if (error.code === "auth/id-token-expired") {
      return res.status(401).json({ message: "Google session expired. Please try again." });
    }
    if (error.code === "auth/argument-error" || error.code === "auth/invalid-id-token") {
      return res.status(401).json({ message: "Invalid Google token. Please try again." });
    }

    return res.status(500).json({ message: "Server error. Please try again." });
  }
};

module.exports = { googleLogin };
