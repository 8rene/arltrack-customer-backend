// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
//
// cancellationRequests/{cancellationRequestID}
//
// One row per customer request to cancel a trip that is already ongoing.
// (Upcoming / unpaid bookings use the direct cancel and never create one.)
// This replaces the cancellationRequestStatus / cancellationRequestReason /
// cancellationRequestedAt / cancellationRejectReason / statusBeforeCancellationRequest
// fields that used to live on the booking document.
//
// Deliberately NOT part of refundRequests -- that collection is about money
// (amount, PayMongo ids, ...). This one is only about ending a trip in progress.
//
// A customer whose request was rejected can ask again, so a booking can have
// several rows; at most one is "pending" at a time.
const CancellationRequest = {
  cancellationRequestID: "", // same as the Firestore doc ID
  bookingID:    "",   // FK -> bookings.bookingID (falls back to the booking doc ID for very old bookings)
  userID:       "",   // the customer who asked
  reason:       "",   // the customer's own free text
  refundRequestID: null, // set on a row that belongs to a refund request: that row is decided through the refund, so the
                         // mid-trip request screens and the pending count skip it
  notes:        "",   // refund requests only: the customer's extra notes (moved here from refundRequests)
  status:       "",   // "pending" | "approved" | "rejected"
  createdAt:    null, // was requestedAt (old rows still carry that name; every reader accepts both)
  updatedAt:    null, // set when a request row is resolved; direct rows never change, so they don't carry it
  processedBy:  null, // uid of the staff member who approved/rejected
  processedAt:  null,
  rejectReason: null,
  cancelledBy:  null, // direct rows only: "customer" | "staff" | "admin" | "system" | "refund" | "unknown".
                      // There is no `type` field: a row with cancelledBy is a direct cancellation, any other row
                      // is a customer request to end an ongoing trip.
};
// A direct row is written (with no status / processedBy / processedAt / rejectReason -- cancelledBy says who did it;
// older rows may still carry them) at the moment the booking is
// cancelled (doc ID = the booking key); its `reason` is why the booking was
// cancelled. This replaces bookings.cancellationReason.

module.exports = { CancellationRequest };