const { v4: uuidv4 } = require("uuid");

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
