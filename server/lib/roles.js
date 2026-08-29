// Admin roles and the permission matrix.
//
// The role lives in the admin's Supabase Auth app_metadata under
// `rz_admin_role` — server-controlled and not editable by the user it
// describes, the same mechanism screening.js uses for Checkr state. No DDL
// required, so this works in an environment that cannot migrate tables.
//
// Design rules:
//  1. Deny by default. An unknown role has NO permissions, and an account
//     with no role set is not an admin at all.
//  2. Reading rider contact details is its OWN permission. A dispatcher needs
//     a rider's phone to resolve a live pickup; a finance analyst reconciling
//     payouts does not. Bulk PII exposure is the thing most likely to hurt
//     real people, so it is never bundled into a general "read" grant.
//  3. Destructive and money-moving actions are separate permissions from the
//     reads that accompany them.
//  4. Identity documents are their own permission, above 'drivers.read'. A
//     dispatcher needs to know a driver's standing to place a ride; nobody
//     needs to see a scan of their licence to do that. Only the people whose
//     job is vetting get 'drivers.documents'.

const ADMIN_ROLE_META_KEY = 'rz_admin_role';

const PERMISSIONS = {
  'overview.read':   'See the live operations overview',
  'rides.read':      'Browse and inspect rides',
  'rides.cancel':    'Cancel a ride on behalf of a rider or driver',
  'rides.reassign':  'Detach a ride from its driver and re-dispatch it',
  'dispatch.read':   'See the dispatch board and stuck rides',
  'dispatch.assign': 'Manually assign a ride to a specific driver',
  'drivers.read':    'Browse drivers and their trust standing',
  'drivers.documents':'View a driver\'s licence and insurance certificate',
  'drivers.review':  'Approve or reject a driver for the road',
  'drivers.suspend': 'Suspend or reinstate a driver account',
  'riders.pii':      'Reveal rider name, phone and email',
  'finance.read':    'See fares, earnings ledgers and payout balances',
  'finance.payout':  'Mark payouts as paid and settle balances',
  'audit.read':      'Read the admin audit trail',
  'admins.manage':   'Grant and revoke admin roles',
};

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

// Roles are defined by the JOB someone does, not by a seniority ladder.
const ROLES = {
  // Full control, including granting roles to others.
  owner: {
    label: 'Owner',
    description: 'Full control of the platform, including admin access itself.',
    permissions: ALL_PERMISSIONS,
  },

  // The person watching the board during a shift. Can move rides and reach
  // riders, but cannot approve drivers or touch money.
  dispatcher: {
    label: 'Dispatcher',
    description: 'Runs the live board: assigns stuck rides, reaches riders and drivers.',
    permissions: [
      'overview.read', 'rides.read', 'rides.cancel', 'rides.reassign',
      'dispatch.read', 'dispatch.assign', 'drivers.read', 'riders.pii',
    ],
  },

  // Handles rider and driver contact. Needs PII and ride history; must not
  // be able to re-dispatch or approve anyone.
  support: {
    label: 'Support',
    description: 'Answers riders and drivers. Can cancel a ride, cannot dispatch or vet.',
    permissions: [
      'overview.read', 'rides.read', 'rides.cancel', 'drivers.read', 'riders.pii',
    ],
  },

  // Owns driver vetting. Deliberately has NO ride-operations powers.
  trust: {
    label: 'Trust & Safety',
    description: 'Vets drivers, acts on screening results, suspends accounts.',
    permissions: [
      'overview.read', 'rides.read', 'drivers.read', 'drivers.documents',
      'drivers.review', 'drivers.suspend', 'riders.pii', 'audit.read',
    ],
  },

  // Reconciles the ledger. Sees money, never sees rider contact details.
  finance: {
    label: 'Finance',
    description: 'Reconciles fares, earnings and payouts. No rider contact access.',
    permissions: [
      'overview.read', 'rides.read', 'drivers.read', 'finance.read', 'finance.payout',
    ],
  },

  // Read-only, and PII-free. Safe for an investor demo or a new hire.
  viewer: {
    label: 'Viewer',
    description: 'Read-only view of operations. No rider contact details, no actions.',
    permissions: ['overview.read', 'rides.read', 'drivers.read', 'dispatch.read'],
  },
};

const ROLE_KEYS = Object.keys(ROLES);

function roleOf(authUser) {
  const meta = (authUser && authUser.app_metadata) || {};
  const role = meta[ADMIN_ROLE_META_KEY];
  return ROLE_KEYS.includes(role) ? role : null;
}

function permissionsFor(role) {
  const def = ROLES[role];
  return def ? def.permissions : [];
}

function can(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = {
  ADMIN_ROLE_META_KEY,
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLES,
  ROLE_KEYS,
  roleOf,
  permissionsFor,
  can,
};
