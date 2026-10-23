// idResubmitRequests/{requestID} -- a customer sending a new driver's license or ID document for staff review.
// Shape only: created by submitIdResubmitRequest in controllers/user/user.controller.js (auto-generated doc ID, not a field);
// reviewed by the admin backend (services/profileRequests).
const IdResubmitRequest = {
  userID: "",
  role: "Customer",
  documentKind: "",    // "license" | "document"
  // documentKind === "license":
  currentLicenseUrl: "",
  newLicenseUrl: "",
  // documentKind === "document":
  currentDocumentUrl: "",
  newDocumentUrl: "",
  documentType: "",
  documentNumber: "",
  status: "pending",   // "pending" until staff review it
  requestedBy: "",     // same as userID
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: null,     // server timestamp
  updatedAt: null,
};

module.exports = { IdResubmitRequest };
