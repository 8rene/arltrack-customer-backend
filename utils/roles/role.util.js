/**
 * Role utility — maps roleIDs to human-readable role names.
 *
 * Mirrors arltrack-admin-backend/utils/roles/role.util.js so both backends
 * agree on the same roleID constants. This is meant to be THE ONE place
 * these IDs live on the customer backend — don't copy them into individual
 * controllers.
 *
 * roleID constants (from Firestore roles collection):
 *   Owner      → 1BX4V7M43t6barbPd4BP
 *   Admin      → 5bhRYMrDkjrs9VlFFY4u
 *   Driver     → Na0Jpt86nldSO5SjfcLa
 *   Supervisor → fFA8G2R2ANLbVsH00jlv
 */

const ROLES = {
  OWNER:      "Owner",
  ADMIN:      "Admin",
  SUPERVISOR: "Supervisor",
  DRIVER:     "Driver",
};

const ROLE_IDS = {
  OWNER:      "1BX4V7M43t6barbPd4BP",
  ADMIN:      "5bhRYMrDkjrs9VlFFY4u",
  DRIVER:     "Na0Jpt86nldSO5SjfcLa",
  SUPERVISOR: "fFA8G2R2ANLbVsH00jlv",
};

// Admin-side roles that should never be able to log into the
// customer-facing site. Driver is intentionally NOT included — drivers may
// also need customer-side access depending on how the business uses that
// role.
const BLOCKED_ADMIN_ROLE_NAMES = new Set([ROLES.OWNER, ROLES.ADMIN, ROLES.SUPERVISOR]);

/**
 * Map a Firestore roleID → roleName.
 * Returns null if the roleID is unknown (e.g. a new role added in Firestore
 * that hasn't been added to ROLE_IDS yet).
 */
function roleIDToName(roleID) {
  const map = {
    [ROLE_IDS.OWNER]:      ROLES.OWNER,
    [ROLE_IDS.ADMIN]:      ROLES.ADMIN,
    [ROLE_IDS.DRIVER]:     ROLES.DRIVER,
    [ROLE_IDS.SUPERVISOR]: ROLES.SUPERVISOR,
  };
  return map[roleID] ?? null;
}

/**
 * Resolve whether a roleID belongs to a blocked admin-side role.
 *
 * Resolution order:
 *   1. The 4 known staff roles above — no DB call needed, matches admin
 *      backend's behavior exactly.
 *   2. Anything unknown (new role added in Firestore, not yet in the map
 *      above) — live lookup against the `roles` collection, using the
 *      `name` field (confirmed field name in Firestore — NOT `roleName`,
 *      which is what the admin backend's own fallback incorrectly uses).
 *
 * Fails CLOSED: if the roleID can't be resolved at all (unknown AND the
 * Firestore lookup fails or finds nothing), this returns true (blocked).
 * A roleID that can't be identified is treated as suspicious rather than
 * silently allowed through — this is a security-relevant check, not a
 * cosmetic one.
 */
async function isBlockedAdminRole(roleID, db) {
  const knownName = roleIDToName(roleID);
  if (knownName) {
    return BLOCKED_ADMIN_ROLE_NAMES.has(knownName);
  }

  try {
    const roleSnap = await db.collection("roles").doc(roleID).get();

    if (!roleSnap.exists) {
      console.error(`Role lookup failed: no roles doc for roleID "${roleID}". Failing closed (blocking login).`);
      return true;
    }

    const roleName = roleSnap.data().name;
    return BLOCKED_ADMIN_ROLE_NAMES.has(roleName);
  } catch (err) {
    console.error(`Role lookup error for roleID "${roleID}":`, err.message, "— failing closed (blocking login).");
    return true;
  }
}

module.exports = { ROLES, ROLE_IDS, roleIDToName, isBlockedAdminRole, BLOCKED_ADMIN_ROLE_NAMES };
