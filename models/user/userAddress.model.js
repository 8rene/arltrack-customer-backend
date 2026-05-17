const { v4: uuidv4 } = require("uuid");

const createUserAddress = (userID, data = {}) => ({
  userAddressID: uuidv4(),   // own unique ID — NOT the same as userID
  userID,
  region:       data.region       || "",
  province:     data.province     || "",
  municipality: data.municipality || "",
  barangay:     data.barangay     || "",
  street:       data.street       || "",
  createdAt:    new Date(),
});

module.exports = createUserAddress;
