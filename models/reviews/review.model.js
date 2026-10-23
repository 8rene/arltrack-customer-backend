// reviews/{reviewID} -- one review per booking; reviewID is derived from the bookingID (reviewIDForBooking in
// controllers/reviews/reviews.controller.js) so a booking can only be reviewed once.
// Shape only: created and edited by the customer backend; read by the admin backend (services/reviews).
const Review = {
  reviewID: "",
  userID: "",
  carID: "",
  bookingID: "",
  rating: 0,          // stars
  comment: "",        // cleaned text; edited later together with updatedAt (and rating, if one is sent)
  createdAt: null,
  updatedAt: null,
};

module.exports = { Review };
