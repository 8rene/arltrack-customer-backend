// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
//
// serviceType / serviceTypeID / pickupAt are written by the customer backend at creation and read by the admin backend,
// but are not yet in the admin copy of this model: add them there too.
//
// Matches the actual 'bookings' collection in Firestore
const Booking = {
  bookingID: "",
  carID: "",
  userID: "",
  location: "",
  startDateTime: null,
  endDateTime: null,
  totalDays: 0,
  rentalFee: 0,
  serviceFee: 0,
  status: "",         // "to pay" (created, deposit not cleared yet; becomes "upcoming" once it is) | "upcoming" | "ongoing" | "completed" | "cancelled" | "cancellation_request" (shown while a request is pending) | "stolen"
  serviceType: "",    // free-text label the customer picked (or typed for "Others")
  serviceTypeID: null, // FK -> serviceType; admin resolves the display name from it. null for "Others"
  pickupAt: null,     // exact pickup INSTANT (Manila, UTC+8); the 48-hour refund window is measured from it
  modeOfDriving: "",  // "With Chauffeur" | "Self Drive" — set at creation by the customer backend
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  createdAt: null,
  updatedAt: null,    // stamped on every admin change (edit, cancel, reject, driver assign / unassign, payment approval, refund cancel)
  returnedAt: null,   // stamped once when an ongoing booking is Returned (completed); the late-fee calculation reads it
  restoredAt: null,   // only on a booking that was restored from bookingArchives

  // Who is driving is NOT stored on the booking. A chauffeur booking's current
  // driver is its "assigned" row in driverAssignments (see
  // models/driverAssignment/driverAssignment.model.js); a booking with no such
  // row is still in the dispatch queue. (driverID / driverAssignedAt /
  // driverAssignedBy used to live here.)
  //
  // Likewise a customer's request to cancel an ongoing trip is a row in
  // cancellationRequests, not fields on the booking. The reason a booking was
  // cancelled is a row there too (type "direct"); cancellationReason is no
  // longer stored here. (The booking list still returns it, read from that row.)
};

module.exports = { Booking };