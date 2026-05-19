const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

const storageBucket = `${serviceAccount.project_id}.firebasestorage.app`;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket,
});

const auth   = admin.auth();
const db     = admin.firestore();
const bucket = admin.storage().bucket();


module.exports = { auth, db, bucket };
