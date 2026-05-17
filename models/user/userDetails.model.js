const { v4: uuidv4 } = require("uuid");

const createUserDetails = (userID, data = {}) => ({
  userDetailsID: uuidv4(),   // own unique ID — NOT the same as userID
  userID,
  firstName:  data.firstName  || "",
  middleName: data.middleName || "",
  lastName:   data.lastName   || "",
  suffix:     data.suffix     || "",
  birthdate:  data.birthdate  || "",
  createdAt:  new Date(),
});

module.exports = createUserDetails;
