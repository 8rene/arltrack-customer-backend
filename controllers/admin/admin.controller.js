const { db } = require("../../config/firebaseConnection/firebase");
const { sendAccountApprovedEmail } = require("../../services/email.service");

// ─────────────────────────────────────────────────────────────
// PUT /api/admin/user/:userID/status
// Body: { status: "locked" | "unlocked" }
//
// Business rule:
//   locked  → unlocked : update Firestore + send approval email
//   unlocked → locked  : update Firestore only (no email)
//   any other value    : 400 Bad Request
// ─────────────────────────────────────────────────────────────
const updateUserStatus = async (req, res) => {
  const { userID } = req.params;
  const { status }  = req.body;

  // ── 1. Validate incoming status ──────────────────────────────
  const VALID_STATUSES = ["locked", "unlocked"];
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}.`,
    });
  }

  try {
    // ── 2. Fetch the user document ────────────────────────────
    const userRef = db.collection("user").doc(userID);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found." });
    }

    const userData       = userDoc.data();
    const previousStatus = userData.status || "locked"; // default to locked if unset

    // ── 3. Guard: skip if status is unchanged ─────────────────
    if (previousStatus === status) {
      return res.status(200).json({
        message: `User status is already "${status}". No changes made.`,
        userID,
        status,
      });
    }

    // ── 4. Write the status change to Firestore ───────────────
    await userRef.set(
      { status, statusUpdatedAt: new Date() },
      { merge: true }
    );

    console.log(`📝 User ${userID}: status changed from "${previousStatus}" → "${status}"`);

    // ── 5. Send approval email ONLY on locked → unlocked ──────
    let emailResult = null;

    if (previousStatus === "locked" && status === "unlocked") {
      // Resolve the best display name available
      const toName  = userData.username || userData.email?.split("@")[0] || "Valued Customer";
      const toEmail = userData.email;

      if (!toEmail) {
        console.warn(`⚠️  User ${userID} has no email address stored — skipping approval email.`);
      } else {
        emailResult = await sendAccountApprovedEmail({ toEmail, toName });

        if (!emailResult.success) {
          // Email failure is non-fatal — status is already updated
          console.error("⚠️  Status updated but approval email failed:", emailResult.error);
        }
      }
    }

    // ── 6. Return response ────────────────────────────────────
    return res.status(200).json({
      message:       `User status updated to "${status}" successfully.`,
      userID,
      previousStatus,
      status,
      emailSent:     status === "unlocked" && previousStatus === "locked"
                       ? (emailResult?.success ?? false)
                       : false,
    });

  } catch (error) {
    console.error("updateUserStatus error:", error);
    return res.status(500).json({ message: "Failed to update user status." });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users
// Returns all users with their status field (for admin dashboard)
// ─────────────────────────────────────────────────────────────
const getAllUsers = async (req, res) => {
  try {
    const snapshot = await db.collection("user").get();

    const users = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        userID:          doc.id,
        email:           data.email          || "",
        username:        data.username       || "",
        phone:           data.phone          || "",
        roleID:          data.roleID         || "",
        isVerified:      data.isVerified     || false,
        status:          data.status         || "locked",
        profileImage:    data.profileImage   || "",
        createdAt:       data.createdAt      || null,
        statusUpdatedAt: data.statusUpdatedAt || null,
      };
    });

    return res.status(200).json({ users });
  } catch (error) {
    console.error("getAllUsers error:", error);
    return res.status(500).json({ message: "Failed to fetch users." });
  }
};

module.exports = { updateUserStatus, getAllUsers };
