const { db } = require("../../config/firebaseConnection/firebase");
const { v4: uuidv4 } = require("uuid");

// POST /api/reviews/create
const createReview = async (req, res) => {
  const userID = req.user.userID; // from verified JWT — never trust body
  const { carID, bookingID, rating, comment } = req.body;
  if (!carID || !rating) {
    return res.status(400).json({ message: "carID and rating are required." });
  }
  try {
    // Validate that the booking exists and is completed
    if (bookingID) {
      // Use .where() query — Firestore doc ID !== bookingID field
      const bookingSnap = await db.collection("bookings")
        .where("bookingID", "==", bookingID)
        .limit(1)
        .get();
      if (bookingSnap.empty) {
        return res.status(404).json({ message: "Booking not found." });
      }
      const bookingData = bookingSnap.docs[0].data();
      if ((bookingData.status || "").toLowerCase() !== "completed") {
        return res.status(403).json({ message: "You can only review completed bookings." });
      }
      if (bookingData.userID !== userID) {
        return res.status(403).json({ message: "Not authorized to review this booking." });
      }
    }
    const reviewID = uuidv4();
    const reviewData = {
      reviewID,
      userID,
      carID,
      bookingID: bookingID || "",
      rating:    Number(rating),
      comment:   comment || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection("reviews").doc(reviewID).set(reviewData);
    return res.status(201).json({ message: "Review created.", reviewID });
  } catch (err) {
    console.error("createReview error:", err);
    return res.status(500).json({ message: "Failed to create review." });
  }
};

// PUT /api/reviews/:reviewID
const updateReview = async (req, res) => {
  const { reviewID } = req.params;
  const { userID, rating, comment } = req.body;
  if (!reviewID || !userID) return res.status(400).json({ message: "reviewID and userID are required." });

  // FIX: validate rating before converting — Number(undefined) = NaN which Firestore silently stores
  const parsedRating = Number(rating);
  if (rating !== undefined && (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5)) {
    return res.status(400).json({ message: "rating must be a number between 1 and 5." });
  }

  try {
    const doc = await db.collection("reviews").doc(reviewID).get();
    if (!doc.exists) return res.status(404).json({ message: "Review not found." });
    if (doc.data().userID !== userID) return res.status(403).json({ message: "Not authorized." });

    const updateData = { comment: comment || "", updatedAt: new Date() };
    // Only overwrite rating if one was actually provided
    if (rating !== undefined) updateData.rating = parsedRating;

    await db.collection("reviews").doc(reviewID).update(updateData);
    return res.status(200).json({ message: "Review updated." });
  } catch (err) {
    console.error("updateReview error:", err);
    return res.status(500).json({ message: "Failed to update review." });
  }
};

// GET /api/reviews/user/:userID
const getUserReviews = async (req, res) => {
  const { userID } = req.params;
  if (!userID) return res.status(400).json({ message: "userID is required." });
  if (req.user.userID !== userID) {
    return res.status(403).json({ message: "Access denied." });
  }
  try {
    const snap = await db.collection("reviews").where("userID", "==", userID).get();
    const reviews = snap.docs.map(doc => doc.data());
    return res.status(200).json({ reviews });
  } catch (err) {
    console.error("getUserReviews error:", err);
    return res.status(500).json({ message: "Failed to fetch reviews." });
  }
};

module.exports = { createReview, updateReview, getUserReviews };
