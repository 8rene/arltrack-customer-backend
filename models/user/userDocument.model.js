const { v4: uuidv4 } = require("uuid");

// NOT written here: driverLicenseExpiry (date | null). It is added LATER by the admin backend, when the reviewer approves a
// new license (models/user/userDocument.model.js there). This backend only READS it (utils/drivers/driverCapacity.util.js),
// so a new document does not carry it and readers must treat it as optional.
const createUserDocument = (userID, data = {}) => ({
  userDocumentID:      uuidv4(),   // own unique ID — NOT the same as userID
  userID,
  documentType:        data.documentType        || "",
  documentNumber:      data.documentNumber      || "",
  documentImageUrl:    data.documentImageUrl    || "",
  driversLicenseNumber: data.driversLicenseNumber || "",
  driverLicenseUrl:    data.driverLicenseUrl    || "",
  selfieWithIdUrl:     data.selfieWithIdUrl     || "",
  createdAt:           new Date(),
});

module.exports = createUserDocument;