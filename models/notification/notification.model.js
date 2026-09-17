// notifications/{id}
//
// Customer-facing notifications live in the SAME Firestore "notifications"
// collection the admin backend already uses (see admin-backend's
// models/notification/notification.model.js) — same shape, same
// isRead/status lifecycle, just a different set of `type`s and `userID`
// pointing at a customer's own account instead of a staff account. This
// is deliberate: the customer app's bell (NotificationPanel.jsx) and the
// admin app's bell (Header.jsx) each query by their own logged-in
// `userID`, so there's no collision even though both read/write the same
// collection.
//
// refID + refCollection make a notification clickable to the exact
// record — for every type below, refCollection is "bookings" and refID
// is the booking's own bookingID (== the Firestore doc id bookings are
// created with in bookings.controller.js's createBooking()).
export const CustomerNotification = {
  type: "",
  //   "booking_created"    — booking successfully placed
  //   "payment_pending"    — payment still awaiting completion/review
  //   "payment_successful" — payment cleared (PayMongo webhook/poll)
  //   "payment_failed"     — PayMongo checkout failed, customer must retry
  //   "booking_confirmed"  — payment approved/settled, booking is confirmed
  //   "upcoming_booking"   — reminder sent ~24h before the trip starts
  //   "booking_reminder"   — reminder sent shortly (~2h) before the trip starts
  //   "booking_cancelled"  — booking cancelled (by customer or by staff)
  //   "booking_expired"    — booking's start time passed with no confirmed payment
  //   "booking_rescheduled"— staff changed the booking's date/time

  userID: "",            // which customer account this notification belongs to
  refID: "",              // bookingID this notification is about
  refCollection: "bookings",

  title: "",
  message: "",

  isRead: false,
  status: "active",      // "active" | "resolved" — resolved ones are cleared
                          // out of the bell automatically (e.g. payment_pending
                          // gets resolved the moment payment_successful fires)

  createdAt: null,
  resolvedAt: null,
};
