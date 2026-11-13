// idResubmitRequests/{requestID} -- a customer sending a new driver's license or ID document for staff review.
// Shape only: created by submitIdResubmitRequest in controllers/user/user.controller.js (auto-generated doc ID, also stored as the idResubmitRequestID field; requests created before that field existed don't have it);
// reviewed by the admin backend (services/profileRequests).
const IdResubmitRequest = {
  idResubmitRequestID: "", // this document's own ID (same value as the document ID)
  userID: "",
  role: "Customer",
  documentKind: "",    // "license" | "document"
  // documentKind === "license":
  currentLicenseUrl: "",
  newLicenseUrl: "",
  driversLicenseNumber: "",
  // documentKind === "document":
  currentDocumentUrl: "",
  newDocumentUrl: "",
  documentType: "",
  documentNumber: "",
  currentSelfieUrl: "",   // the selfie holding the ID that was on file
  newSelfieUrl: "",       // required with a government ID
  status: "pending",   // "pending" until staff review it
  requestedBy: "",     // same as userID
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: null,     // server timestamp
  updatedAt: null,
};

module.exports = { IdResubmitRequest };