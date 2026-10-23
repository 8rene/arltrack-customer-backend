// editRequests/{requestID} -- a customer asking staff to change profile fields they cannot edit themselves.
// Shape only: created by controllers/editRequest/editRequest.controller.js (auto-generated doc ID, not stored as a field);
// reviewed by the admin backend (services/profileRequests).
const EditRequest = {
  userID: "",          // the customer the change is for
  role: "Customer",
  status: "pending",   // "pending" until staff review it (approved / rejected values are set by the admin backend)
  // One entry per changed field:
  //   { field, label, collection, oldValue, newValue }   (collection = which user collection the field lives in)
  changes: [],
  reason: "",          // the customer's explanation
  requestedBy: "",     // same as userID
  reviewedBy: null,    // staff uid, set on review
  reviewedAt: null,
  reviewNote: null,
  createdAt: null,     // server timestamp
  updatedAt: null,
};

module.exports = { EditRequest };
