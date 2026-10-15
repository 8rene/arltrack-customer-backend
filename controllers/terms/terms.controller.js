// GET /api/terms/active            (public) the current Terms & Conditions, rendered, with its hash
// GET /api/terms/version/:hash     (public) the exact text behind an earlier acceptance
const { getActiveTerms, ensureTermsSnapshot, getTermsSnapshot } = require("../../utils/terms/terms.service");

const getActive = async (req, res) => {
  try {
    const terms = await getActiveTerms();
    // Save the text the moment it is first shown, so any hash a browser holds can be
    // looked up later. Best-effort: a failure here must not stop the page from loading
    // (createBooking / signup save it again before recording an acceptance).
    ensureTermsSnapshot(terms).catch((e) => console.error("ensureTermsSnapshot:", e.message));
    return res.json({ version: terms.version, hash: terms.hash, sections: terms.sections });
  } catch (error) {
    console.error("getActive terms error:", error.message);
    return res.status(500).json({ message: "Could not load the Terms & Conditions." });
  }
};

const getVersion = async (req, res) => {
  try {
    const hash = String(req.params.hash || "");
    if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ message: "Invalid version." });
    const snap = await getTermsSnapshot(hash);
    if (!snap) return res.status(404).json({ message: "That version of the Terms & Conditions was not found." });
    return res.json({ version: snap.version, hash: snap.hash, sections: snap.sections });
  } catch (error) {
    console.error("getVersion terms error:", error.message);
    return res.status(500).json({ message: "Could not load that version." });
  }
};

module.exports = { getActive, getVersion };
