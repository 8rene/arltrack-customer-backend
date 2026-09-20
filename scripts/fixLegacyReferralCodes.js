// One-time clean-up for accounts created BEFORE the referral feature.
//
// The old signup stored the code a user TYPED in `referralCode`. That field
// now means "this user's OWN code", so those old values would show up on the
// profile as the user's own code and can clash with the real owner's code.
//
// Candidates = accounts that have a `referralCode` but were never touched by
// the new signup (no `referredByCode` and no `referralCount` field).
// NOTE: an old account that already opened its profile after the update also
// matches (it got a legitimately generated code) — so this DRY-RUNS by
// default. Read the list, then run with --fix only if it looks right.
//
//   node scripts/fixLegacyReferralCodes.js          # list only
//   node scripts/fixLegacyReferralCodes.js --fix    # move value to referredByCode + give a fresh own code
require("dotenv").config();
const { db } = require("../config/firebaseConnection/firebase");
const { generateUniqueReferralCode } = require("../utils/referrals/referral.util");

const FIX = process.argv.includes("--fix");

(async () => {
  const snap = await db.collection("user").get();
  const byCode = new Map(); // code -> [userIDs] to spot duplicates
  snap.docs.forEach((d) => {
    const c = d.data().referralCode;
    if (c) byCode.set(c, [...(byCode.get(c) || []), d.id]);
  });

  let found = 0;
  for (const doc of snap.docs) {
    const u = doc.data();
    if (!u.referralCode) continue;
    if (u.referredByCode !== undefined || u.referralCount !== undefined) continue; // created by new signup
    found++;
    const dup = (byCode.get(u.referralCode) || []).length > 1;
    console.log(`${FIX ? "FIX " : "FOUND"} ${doc.id} (@${u.username || "?"}) referralCode=${u.referralCode}${dup ? "  <-- DUPLICATE of another user's code" : ""}`);
    if (FIX) {
      const fresh = await generateUniqueReferralCode();
      await doc.ref.update({
        referredByCode: u.referralCode,
        referralCode:   fresh,
        referralCount:  0,
      });
      console.log(`     -> referredByCode=${u.referralCode}, new own code=${fresh}`);
    }
  }
  console.log(`\n${found} candidate(s).${FIX ? " Fixed." : " Dry run — nothing changed. Re-run with --fix to apply."}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
