// ─────────────────────────────────────────────────────────────────────────────
// Terms & Conditions — build, hash, snapshot, and check acceptance.
//
//  • getActiveTerms()      builds the current text from the canonical content + the
//                          admin-managed policy numbers (deposit, fee %, refund hours)
//                          and hashes the RENDERED result. The hash therefore changes
//                          when either the wording or one of those numbers changes —
//                          exactly the cases where "what the customer agreed to" changes.
//  • ensureTermsSnapshot() saves the rendered text once per hash in `termsSnapshots`
//                          (append-only: the doc id IS the hash and is created, never
//                          updated), so the exact words behind any acceptance stay
//                          retrievable even after the wording or the numbers change.
//  • checkTermsAcceptance() compares the hash the customer's browser showed them with
//                          the current one.
//
// Enforcement switch: set REQUIRE_TERMS_ACCEPTANCE=true on the backend to REJECT a
// signup/booking that doesn't carry the current hash. While it is off (default), the
// acceptance is still recorded whenever the browser sends it. Turn it on only AFTER the
// new frontend is live — otherwise pages still open in old tabs can't book.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const { db } = require("../../config/firebaseConnection/firebase");
const { buildTermsSections, TERMS_TEMPLATE_VERSION } = require("./terms.content");
const { getPolicyValues } = require("../../controllers/policy/policy.controller");

const termsRequired = () => String(process.env.REQUIRE_TERMS_ACCEPTANCE || "").trim().toLowerCase() === "true";

const hashOf = (version, sections) =>
  crypto.createHash("sha256").update(`${version}\n${JSON.stringify(sections)}`).digest("hex");

const getActiveTerms = async () => {
  const policy = await getPolicyValues();
  const sections = buildTermsSections({
    ...policy,
    depositText: `₱${Number(policy.depositAmount).toLocaleString("en-PH")}`,
  }).map((s, i) => ({ num: String(i + 1).padStart(2, "0"), ...s }));
  return {
    version: TERMS_TEMPLATE_VERSION,
    hash: hashOf(TERMS_TEMPLATE_VERSION, sections),
    sections,
    policy, // the numbers quoted in the text, kept with the snapshot for reference
  };
};

// Idempotent: creates the snapshot doc if it isn't there yet. Never overwrites.
const ensureTermsSnapshot = async (terms) => {
  try {
    await db.collection("termsSnapshots").doc(terms.hash).create({
      hash: terms.hash,
      version: terms.version,
      sections: terms.sections,
      policy: terms.policy,
      createdAt: new Date(),
    });
  } catch (err) {
    // 6 = ALREADY_EXISTS → this exact text is already saved, which is what we want.
    if (err && (err.code === 6 || /ALREADY_EXISTS/i.test(err.message || ""))) return;
    throw err;
  }
};

const getTermsSnapshot = async (hash) => {
  const doc = await db.collection("termsSnapshots").doc(String(hash)).get();
  return doc.exists ? doc.data() : null;
};

// Resolves { ok:true, accepted, terms } or { ok:false, status, body } — never throws for a
// bad/missing hash. (A Firestore failure does throw; callers decide how to handle that.)
const checkTermsAcceptance = async (clientHash) => {
  const terms = await getActiveTerms();
  if (!clientHash) {
    if (termsRequired()) {
      return { ok: false, status: 400, body: {
        message: "Please read and accept the Terms & Conditions to continue.",
        termsRequired: true,
      } };
    }
    return { ok: true, accepted: false, terms };
  }
  if (String(clientHash) !== terms.hash) {
    return { ok: false, status: 409, body: {
      message: "Our Terms & Conditions were updated. Please review and accept the latest version to continue.",
      termsChanged: true,
      termsHash: terms.hash,
    } };
  }
  return { ok: true, accepted: true, terms };
};

module.exports = { getActiveTerms, ensureTermsSnapshot, getTermsSnapshot, checkTermsAcceptance, termsRequired };
