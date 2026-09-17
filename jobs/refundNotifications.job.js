const { db } = require("../config/firebaseConnection/firebase");
const { createNotification } = require("../services/notification/notification.service");

// ─────────────────────────────────────────────────────────────────────────────
// "Approved"/"Rejected" only ever get SET from the admin app (staff review a
// refundRequests doc there — see admin-backend's refundRequest.service.js).
// Rather than adding a notification hook inside that separate deployable,
// this job just watches the shared refundRequests collection from the
// customer side instead and reacts once it sees the status flip — same
// data, no admin code touched at all.
//
// customerNotified is a plain boolean flag stamped on the refundRequests
// doc itself once this job has sent the notification for it, so a request
// is only ever scanned/notified once instead of every cron run forever.
// ─────────────────────────────────────────────────────────────────────────────
const runRefundNotifications = async () => {
  const snap = await db.collection("refundRequests")
    .where("status", "in", ["Approved", "Rejected"])
    .get();

  let sentCount = 0;

  for (const doc of snap.docs) {
    const r = doc.data();
    if (r.customerNotified) continue; // already handled on a previous run
    if (!r.userID) { await doc.ref.update({ customerNotified: true }); continue; }

    const isApproved = r.status === "Approved";

    const id = await createNotification({
      type: isApproved ? "refund_approved" : "refund_rejected",
      userID: r.userID,
      refID: r.bookingID || null,
      title: isApproved ? "Refund Approved" : "Refund Rejected",
      message: isApproved
        ? `Your refund of ₱${Number(r.amount || 0).toLocaleString()} has been approved and is being processed by PayMongo.`
        : (r.rejectReason ? `Your refund request was rejected: ${r.rejectReason}` : "Your refund request was rejected."),
    });

    // Stamped regardless of whether createNotification actually wrote a
    // fresh doc or hit its own dedup — either way this refund request has
    // been "seen" and shouldn't be re-checked on the next run.
    await doc.ref.update({ customerNotified: true });
    if (id) sentCount++;
  }

  console.log(`[CRON] refund-notifications: ${sentCount} refund decision notification(s) sent.`);
  return { sentCount };
};

module.exports = { runRefundNotifications };
