const validateSignup = (req, res, next) => {
  const { email, password, phone } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: "Invalid email format" });
  }

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?]).{8,16}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      message:
        "Password must be 8–16 characters with at least 1 uppercase, 1 lowercase, 1 number, and 1 special character",
    });
  }

  if (phone) {
    // +63 followed by 9 and 9 more digits = +639XXXXXXXXX
    const phoneRegex = /^\+639\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ message: "Invalid phone number. Must be +639XXXXXXXXX format." });
    }
  }

  next();
};

module.exports = validateSignup;
