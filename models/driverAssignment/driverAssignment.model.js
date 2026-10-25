// driverAssignments/{assignmentID}
//
// Owned and written by the ADMIN backend (see its models/driverAssignments/driverAssignment.model.js and
// services/driverAssignments/driverAssignments.service.js). The customer backend only READS it.
//
// ONE row per booking, updated in place. A row with status "assigned" is the booking's CURRENT driver; reassigning
// changes driverID / assignedAt on the same row, unassigning sets "unassigned", finishing the trip sets "completed".
//
// Plain shape only (same convention as models/booking/booking.model.js).
export const DriverAssignment = {
  assignmentID: "",  // same as the Firestore doc ID
  bookingID:    "",  // FK -> bookings.bookingID (falls back to the booking doc ID for very old bookings)
  driverID:     "",  // FK -> user/{uid}; the driver's first name is read from userDetails/{uid}
  status:       "",  // "assigned" | "unassigned" | "completed"
  assignedAt:   null,
  assignedBy:   "",
  enRouteAt:    null, // set when the assigned driver taps "On my way"; absent until then, removed on reassign.
                      // Read it ONLY from an "assigned" row (utils/bookings/enRoute.util.js does).
};