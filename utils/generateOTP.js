const crypto = require("crypto");

// 6-digit code from a cryptographically secure source (Math.random is predictable).
const generateOTP = () => String(crypto.randomInt(100000, 1000000));

module.exports = generateOTP;
