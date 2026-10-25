// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
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
  modeOfDriving: "",  // "With Chauffeur" | "Self Drive" — set at creation by the customer backend
  serviceType: "",     // free-text label the customer picked (or typed for "Others"). Admin does not read it today: it shows serviceTypeID's name
  serviceTypeID: null, // FK -> serviceType collection; admin resolves the display name from it. null for "Others"
  pickupAt: null,      // exact pickup INSTANT (Manila, UTC+8), written by the customer backend; the refund window and no-show check measure from it (resolvePickupAt)
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  // Terms & Conditions the customer agreed to for THIS booking (written once by the customer
  // backend at creation, never edited). termsVersionID points to the exact immutable doc in
  // termsVersions; the version number is read from it when needed.
  termsVersionID: "",
  termsAcceptedAt: null,   // server timestamp of the checkbox agreement
  notesAdmin: "",
  createdAt: null,
  updatedAt: null,    // stamped on every admin change (edit, cancel, reject, driver assign / unassign, payment approval, refund cancel)
  completedAt: null,   // stamped once when an ongoing booking is Returned (completed); the late-fee calculation reads it

  // Who is driving is NOT stored on the booking. A chauffeur booking's current
  // driver is its "assigned" row in driverAssignments (see
  // models/driverAssignments/driverAssignment.model.js); a booking with no such
  // row is still in the dispatch queue. (driverID / driverAssignedAt /
  // driverAssignedBy used to live here.)
  //
  // Likewise a customer's request to cancel an ongoing trip is a row in
  // cancellationRequests, not fields on the booking. The reason a booking was
  // cancelled is a row there too (type "direct"); cancellationReason is no
  // longer stored here. (The booking list still returns it, read from that row.)
};

module.exports = { Booking };