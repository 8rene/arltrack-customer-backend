// ─────────────────────────────────────────────────────────────────────────────
// Demo-mode display name — for taking clean screenshots (thesis/capstone
// documentation, presentations) without showing a real tester's personal
// name anywhere in the UI.
//
// This is PURELY a display-layer swap. It does NOT create a fake account,
// does not touch Firestore, and does not change what name is stored
// anywhere — whoever is actually logged in keeps using their real account
// for bookings, payments, etc. Turning this off just makes the real name
// show again; nothing to "undo" in the data.
//
// Toggle in .env (arltrack-customer-frontend/.env):
//   REACT_APP_DEMO_MODE=true
//   REACT_APP_DEMO_NAME=ARLTrack      (optional — defaults to "ARLTrack")
//
// After changing .env you need to restart `npm start` (CRA only reads
// REACT_APP_* vars at build/dev-server start, not live).
// ─────────────────────────────────────────────────────────────────────────────

export const isDemoMode = () => process.env.REACT_APP_DEMO_MODE === "true";

const DEMO_NAME = process.env.REACT_APP_DEMO_NAME || "ARLTrack";

/**
 * Wrap any computed display name with this — returns the demo name when
 * demo mode is on, otherwise returns realName unchanged.
 *   demoName(`${firstName} ${lastName}`)
 */
export const demoName = (realName) => (isDemoMode() ? DEMO_NAME : realName);

/** For avatar-letter/initial bubbles — first letter of the demo name. */
export const demoInitial = (realInitial) => (isDemoMode() ? DEMO_NAME[0].toUpperCase() : realInitial);
