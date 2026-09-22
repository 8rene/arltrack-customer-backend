// One-time clean-up for bookings created under the OLD Partial-payment rule.
//
// Old rule: a Partial booking stayed "to pay" until BOTH the deposit and the
// balance were paid online — so a customer who paid their 50% deposit (real
// money, collected by PayMongo) was left on "to pay", asked to pay again, and
// eventually auto-cancelled with the deposit kept.
//
// New rule: the deposit confirms the booking ("upcoming"); the balance is
// settled at pickup (or optionally online).
//
// This finds every booking still at "to pay" whose payment is already paid and
// promotes it. The app also self-heals these on read (enforceToPayValidity), so
// running this is optional — it just clears the backlog in one go and lets you
// review it first. DRY-RUNS by default:
//
//   node scripts/promoteDepositPaidBookings.js          # list only
//   node scripts/promoteDepositPaidBookings.js --fix    # promote them
require("dotenv").config();
const { db } = require("../config/firebaseConnection/firebase");
const { promoteBookingToUpcoming } = require("../utils/bookings/bookingStatus.util");

const FIX = process.argv.includes("--fix");

(async () => {
  const snap = await db.collection("bookings").where("status", "==", "to pay").get();
  let found = 0;

  for (const doc of snap.docs) {
    const b = doc.data();
    const pSnap = await db.collection("payments").where("bookingID", "==", b.bookingID).limit(1).get();
    if (pSnap.empty) continue;
    const p = pSnap.docs[0].data();
    if (String(p.status || "").toLowerCase() !== "paid") continue;

    found++;
    console.log(`${FIX ? "FIX  " : "FOUND"} booking ${b.bookingID} (user ${b.userID}) — deposit paid ₱${p.payNow || "?"}, balanceStatus=${p.balanceStatus || "—"}`);
    if (FIX) {
      const r = await promoteBookingToUpcoming(b.bookingID);
      console.log(`       → ${r.promoted ? "promoted to upcoming" : `not promoted (status now ${r.bookingStatus})`}`);
    }
  }

  console.log(`\n${found} booking(s) ${FIX ? "processed" : "need promoting (re-run with --fix)"} out of ${snap.size} at "to pay".`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
