const { db } = require("../../config/firebaseConnection/firebase");
const crypto = require("crypto");

const MAX_COMMENT_LENGTH = 1000;

// Whole stars, 1–5. (Numeric strings are still accepted, as before.) Returns the number or null.
const parseRating = (raw) => {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

// Missing comment -> "" (same as before); anything that isn't text, or is huge, is refused.
const cleanComment = (raw) => {
  if (raw === undefined || raw === null) return { value: "" };
  if (typeof raw !== "string") return { error: "comment must be text." };
  const value = raw.trim();
  if (value.length > MAX_COMMENT_LENGTH) return { error: `comment must be ${MAX_COMMENT_LENGTH} characters or fewer.` };
  return { value };
};

// One review per booking. The review's document ID is derived from the booking, so two requests
// for the same booking at the same moment try to create the SAME document and Firestore lets only
// one of them succeed (create() fails if it already exists). The ID is opaque to the app.
const reviewIDForBooking = (bookingID) =>
  "rv_" + crypto.createHash("sha1").update(String(bookingID)).digest("hex").slice(0, 28);

// POST /api/reviews/create
const createReview = async (req, res) => {
  const userID = req.user.userID; // from verified JWT — never trust body
  const { carID, bookingID, rating, comment } = req.body || {};

  // A review must hang off one of the customer's own completed bookings. This used to be optional
  // ("if (bookingID) {...}"), so leaving it out skipped every check below: anyone could review any
  // car they never rented, as many times as they liked, with any rating.
  if (typeof bookingID !== "string" || !bookingID.trim()) {
    return res.status(400).json({ message: "bookingID is required." });
  }
  const stars = parseRating(rating);
  if (stars === null) {
    return res.status(400).json({ message: "rating must be a whole number between 1 and 5." });
  }
  const cleaned = cleanComment(comment);
  if (cleaned.error) return res.status(400).json({ message: cleaned.error });

  try {
    // Use .where() query — Firestore doc ID !== bookingID field
    const bookingSnap = await db.collection("bookings")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    const bookingData = bookingSnap.empty ? null : bookingSnap.docs[0].data();

    // "Not found" and "belongs to someone else" look identical, so booking IDs can't be probed.
    if (!bookingData || bookingData.userID !== userID) {
      return res.status(404).json({ message: "Booking not found." });
    }
    if ((bookingData.status || "").toLowerCase() !== "completed") {
      return res.status(403).json({ message: "You can only review completed bookings." });
    }

    // The review is for the car that was actually rented.
    const bookedCarID = bookingData.carID || "";
    if (bookedCarID && carID !== undefined && carID !== "" && String(carID) !== String(bookedCarID)) {
      return res.status(400).json({ message: "carID does not match this booking." });
    }
    const reviewCarID = bookedCarID || (typeof carID === "string" ? carID : "");
    if (!reviewCarID) return res.status(400).json({ message: "carID is required." });

    const alreadyMessage = "You already reviewed this booking. Edit your existing review instead.";

    // Reviews written before the ID scheme above have random IDs — catch those by lookup.
    const existing = await db.collection("reviews")
      .where("bookingID", "==", bookingID)
      .where("userID", "==", userID)
      .limit(1)
      .get();
    if (!existing.empty) return res.status(409).json({ message: alreadyMessage });

    const reviewID = reviewIDForBooking(bookingID);
    const reviewData = {
      reviewID,
      userID,
      carID:     reviewCarID,
      bookingID,
      rating:    stars,
      comment:   cleaned.value,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    try {
      await db.collection("reviews").doc(reviewID).create(reviewData);
    } catch (err) {
      if (err && (err.code === 6 || /ALREADY_EXISTS/.test(String(err.message)))) {
        return res.status(409).json({ message: alreadyMessage });
      }
      throw err;
    }
    return res.status(201).json({ message: "Review created.", reviewID });
  } catch (err) {
    console.error("createReview error:", err);
    return res.status(500).json({ message: "Failed to create review." });
  }
};

// PUT /api/reviews/:reviewID
const updateReview = async (req, res) => {
  const { reviewID } = req.params;
  const userID = req.user.userID; // from verified JWT — never trust body
  const { rating, comment } = req.body || {};
  if (!reviewID) return res.status(400).json({ message: "reviewID is required." });

  // Validate before converting — Number(undefined) = NaN which Firestore silently stores
  let parsedRating;
  if (rating !== undefined) {
    parsedRating = parseRating(rating);
    if (parsedRating === null) {
      return res.status(400).json({ message: "rating must be a whole number between 1 and 5." });
    }
  }
  const cleaned = cleanComment(comment);
  if (cleaned.error) return res.status(400).json({ message: cleaned.error });

  try {
    const doc = await db.collection("reviews").doc(reviewID).get();
    if (!doc.exists) return res.status(404).json({ message: "Review not found." });
    if (doc.data().userID !== userID) return res.status(403).json({ message: "Not authorized." });

    const updateData = { comment: cleaned.value, updatedAt: new Date() };
    // Only overwrite rating if one was actually provided
    if (parsedRating !== undefined) updateData.rating = parsedRating;

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
