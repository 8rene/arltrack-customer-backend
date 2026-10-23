// GET /api/terms/active       (public) the current Terms & Conditions (the admin's newest version)
// GET /api/terms/version/:id  (public) the exact text behind an earlier acceptance — :id is a
//                             termsVersionID
const { getActiveTerms, getTermsVersionByID } = require("../../utils/terms/terms.service");

const getActive = async (req, res) => {
  try {
    const terms = await getActiveTerms();
    if (!terms) return res.status(404).json({ message: "The Terms & Conditions have not been published yet." });
    return res.json(terms);
  } catch (error) {
    console.error("getActive terms error:", error.message);
    return res.status(500).json({ message: "Could not load the Terms & Conditions." });
  }
};

const getVersion = async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(400).json({ message: "Invalid version." });
    const terms = await getTermsVersionByID(id);
    if (!terms) return res.status(404).json({ message: "That version of the Terms & Conditions was not found." });
    return res.json(terms);
  } catch (error) {
    console.error("getVersion terms error:", error.message);
    return res.status(500).json({ message: "Could not load that version." });
  }
};

module.exports = { getActive, getVersion };