// ─────────────────────────────────────────────────────────────────────────────
// Terms & Conditions — read from the ADMIN-managed `termsVersions` collection.
//
// The admin app owns the text (models/termsVersions/termsVersions.model.js there):
// append-only docs { termsVersionID, version, content (Markdown), changeNote, createdAt,
// createdBy }. The CURRENT terms are the doc with the highest `version`. This file only
// READS that collection — the customer backend never writes to it.
//
// What a customer accepted is recorded on the document that was created:
//   bookings/{id}.termsVersionID + termsAcceptedAt   (and user/{id} for the signup box)
// termsVersionID points at the exact, immutable text. There is no hash and no snapshot
// any more.
//
//  • getActiveTerms()        the newest version (cached ~30 s for page loads; pass
//                            { fresh: true } to always read the database).
//  • getTermsVersionByID()   one specific version by its doc ID.
//  • getLegacyTermsByHash()  OLD bookings/signups (before this change) were accepted
//                            against a hash in `termsSnapshots`. Read-only, so those old
//                            acceptances can still be opened; converted to Markdown.
//  • checkTermsAcceptance()  compares the termsVersionID the customer's browser showed
//                            them with the current one (always read fresh).
//
// Enforcement switch: set REQUIRE_TERMS_ACCEPTANCE=true on the backend to REJECT a
// signup/booking that doesn't carry the current termsVersionID. While it is off (default),
// the acceptance is still recorded whenever the browser sends it. Turn it on only AFTER the
// new frontend is live — otherwise pages still open in old tabs can't book.
// If no Terms have been published in the admin yet there is nothing to accept, so nothing
// is recorded and nothing is rejected.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../config/firebaseConnection/firebase");

const COLLECTION = "termsVersions";
const CACHE_MS = 30 * 1000;
let cache = { at: 0, terms: null };

const termsRequired = () => String(process.env.REQUIRE_TERMS_ACCEPTANCE || "").trim().toLowerCase() === "true";

const iso = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null);

const shape = (id, data) => ({
  termsVersionID: id,
  version: data.version,
  content: data.content || "",
  effectiveAt: iso(data.createdAt),
});

// Newest version, or null if the admin hasn't published any yet.
const getActiveTerms = async ({ fresh = false } = {}) => {
  if (!fresh && cache.terms && Date.now() - cache.at < CACHE_MS) return cache.terms;
  const snap = await db.collection(COLLECTION).orderBy("version", "desc").limit(1).get();
  const terms = snap.empty ? null : shape(snap.docs[0].id, snap.docs[0].data());
  cache = { at: Date.now(), terms };
  return terms;
};

const getTermsVersionByID = async (id) => {
  const doc = await db.collection(COLLECTION).doc(String(id)).get();
  return doc.exists ? shape(doc.id, doc.data()) : null;
};

// Old acceptances: { version, hash, sections:[{ num, title, highlight?, body?, list?, footer? }] }
// stored in `termsSnapshots/{hash}`. Rendered to the same Markdown shape the admin uses.
const sectionsToMarkdown = (sections = []) => {
  const out = ["# ARL Car Rental — Terms & Conditions", ""];
  sections.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, "");
    if (s.highlight) out.push(`**${s.highlight}**`, "");
    if (s.body) out.push(s.body, "");
    if (Array.isArray(s.list)) { s.list.forEach((it) => out.push(`- **${it.label}:** ${it.value}`)); out.push(""); }
    if (s.footer) out.push(s.footer, "");
  });
  return out.join("\n").replace(/\n+$/, "\n");
};

const getLegacyTermsByHash = async (hash) => {
  const doc = await db.collection("termsSnapshots").doc(String(hash)).get();
  if (!doc.exists) return null;
  const snap = doc.data();
  return { termsVersionID: null, version: snap.version, content: sectionsToMarkdown(snap.sections), legacy: true };
};

// Resolves { ok:true, accepted, terms } or { ok:false, status, body } — never throws for a
// bad/missing ID. (A Firestore failure does throw; callers decide how to handle that.)
const checkTermsAcceptance = async (clientTermsVersionID) => {
  const terms = await getActiveTerms({ fresh: true });
  if (!terms) return { ok: true, accepted: false, terms: null }; // nothing published yet
  if (!clientTermsVersionID) {
    if (termsRequired()) {
      return { ok: false, status: 400, body: {
        message: "Please read and accept the Terms & Conditions to continue.",
        termsRequired: true,
      } };
    }
    return { ok: true, accepted: false, terms };
  }
  if (String(clientTermsVersionID) !== terms.termsVersionID) {
    return { ok: false, status: 409, body: {
      message: "Our Terms & Conditions were updated. Please review and accept the latest version to continue.",
      termsChanged: true,
      termsVersionID: terms.termsVersionID,
    } };
  }
  return { ok: true, accepted: true, terms };
};

module.exports = { getActiveTerms, getTermsVersionByID, getLegacyTermsByHash, checkTermsAcceptance, termsRequired };
