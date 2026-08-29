#!/usr/bin/env node
//
// Grant, revoke and list RoverZoom console roles.
//
// Roles live in each admin's Supabase Auth `app_metadata` under
// `rz_admin_role`. That is server-controlled — the client SDK lets a user edit
// their own `user_metadata` but never `app_metadata` — which is what makes it
// safe to store a permission there. It is also why the Supabase dashboard's
// user editor does not expose it, and why this script exists.
//
//   npm run grant -- --list
//   npm run grant -- someone@roverzoom.com dispatcher
//   npm run grant -- someone@roverzoom.com --revoke
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read from .env).

require('../lib/env');

const crypto = require('crypto');
const { supabase, isConfigured } = require('../lib/supabase');
const { ROLES, ROLE_KEYS, ADMIN_ROLE_META_KEY, permissionsFor } = require('../lib/roles');

const args = process.argv.slice(2);

function usage() {
  console.log(`
RoverZoom console roles

  npm run grant -- --list                       show everyone who has a role
  npm run grant -- <email> <role>               grant or change a role
  npm run grant -- --create <email> <role>      create the account AND grant
  npm run grant -- <email> --revoke             remove console access

Roles:
${ROLE_KEYS.map((r) => `  ${r.padEnd(12)} ${ROLES[r].description}`).join('\n')}
`);
}

// The Admin API has no "get user by email", so page through and match.
async function findByEmail(email) {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = (data && data.users) || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 1000) break;
  }
  return null;
}

async function allUsers() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = (data && data.users) || [];
    out.push(...users);
    if (users.length < 1000) break;
  }
  return out;
}

async function list() {
  const users = await allUsers();
  const admins = users.filter((u) => (u.app_metadata || {})[ADMIN_ROLE_META_KEY]);
  const bootstrap = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();

  if (!admins.length) {
    console.log('\nNo account has a console role yet.');
  } else {
    console.log('\nConsole roles:\n');
    for (const u of admins) {
      const role = u.app_metadata[ADMIN_ROLE_META_KEY];
      const known = ROLE_KEYS.includes(role);
      console.log(`  ${(u.email || u.id).padEnd(34)} ${role}${known ? '' : '  ← UNKNOWN ROLE, denied at runtime'}`);
    }
  }

  if (bootstrap) {
    const hasRealRole = admins.some((u) => (u.email || '').toLowerCase() === bootstrap);
    console.log(`\nADMIN_BOOTSTRAP_EMAIL is set to ${bootstrap}`);
    console.log(hasRealRole
      ? '  That account now has a real role — safe to clear the variable.'
      : '  That account is an owner ONLY via this variable. Grant it a real role, then clear it.');
  } else {
    console.log('\nADMIN_BOOTSTRAP_EMAIL is not set.');
    if (!admins.length) {
      console.log('  Nobody can sign in. Set it, or grant a role with this script.');
    }
  }
  console.log();
}

// Creates a console account from scratch.
//
// THE TRAP THIS WORKS AROUND
// The rider/driver schema puts an AFTER INSERT trigger on auth.users
// (on_auth_user_created -> handle_new_driver), which inserts a row into
// `drivers` for EVERY new auth account. drivers.name and drivers.phone are
// NOT NULL, so creating an admin with no driver metadata raises
// 'missing_required_driver_field', and because that exception propagates, the
// whole transaction rolls back — the auth user is never created either. In the
// Supabase dashboard that surfaces as an opaque "Database error creating new
// user" with no hint about the cause.
//
// So: satisfy the trigger with placeholder metadata, then delete the driver
// row it created. An admin must not sit in the driver roster, where they would
// be counted as supply and offered as a dispatch candidate.
async function createAndGrant(email, role) {
  if (!ROLE_KEYS.includes(role)) {
    console.error(`\n✗ "${role}" is not a role. Choose one of: ${ROLE_KEYS.join(', ')}\n`);
    process.exit(1);
  }
  if (await findByEmail(email)) {
    console.error(`\n✗ ${email} already exists. Use: npm run grant -- ${email} ${role}\n`);
    process.exit(1);
  }

  // Placeholder identity purely to get past the NOT NULL columns. The phone is
  // randomized because drivers.phone is UNIQUE, so a fixed placeholder would
  // collide on the second admin created.
  const placeholderPhone = `admin-${crypto.randomBytes(6).toString('hex')}`;
  const tempPassword = crypto.randomBytes(18).toString('base64url');

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // console accounts are created by an owner, not self-served
    user_metadata: { name: `${email} (console)`, phone: placeholderPhone },
    app_metadata: { [ADMIN_ROLE_META_KEY]: role },
  });
  if (error) {
    console.error(`\n✗ Could not create the account: ${error.message}`);
    console.error('  If this mentions a driver field, the auth.users trigger rejected it.\n');
    process.exit(1);
  }

  const user = data.user;

  // Remove the driver row the trigger just made.
  const { data: spurious } = await supabase
    .from('drivers').select('id').eq('auth_user_id', user.id).maybeSingle();

  let cleaned = 'none created';
  if (spurious) {
    const { error: delErr } = await supabase.from('drivers').delete().eq('id', spurious.id);
    cleaned = delErr ? `FAILED — remove drivers row ${spurious.id} by hand (${delErr.message})` : 'removed';
  }

  console.log(`\n✓ Created ${email} as ${ROLES[role].label.toLowerCase()}.`);
  console.log(`  ${ROLES[role].description}`);
  console.log(`\n  Temporary password: ${tempPassword}`);
  console.log('  Send it over a channel you trust and have them change it at first sign-in.');
  console.log(`\n  Auto-created driver row: ${cleaned}`);
  console.log('  (The rider/driver schema makes one for every new account; an admin must not');
  console.log('   appear in the driver roster or be offered as a dispatch candidate.)\n');
}

async function grant(email, role) {
  if (!ROLE_KEYS.includes(role)) {
    console.error(`\n✗ "${role}" is not a role. Choose one of: ${ROLE_KEYS.join(', ')}\n`);
    process.exit(1);
  }

  const user = await findByEmail(email);
  if (!user) {
    console.error(`\n✗ No Supabase Auth user with the email ${email}.`);
    console.error('  Create the account first (Dashboard → Authentication → Users → Add user),');
    console.error('  then run this again.\n');
    process.exit(1);
  }

  // Read-modify-write: app_metadata also carries Checkr screening state and
  // the review decision for drivers. Replacing the object wholesale would
  // silently erase them.
  const existing = user.app_metadata || {};
  const previous = existing[ADMIN_ROLE_META_KEY] || null;
  const app_metadata = { ...existing, [ADMIN_ROLE_META_KEY]: role };

  const { error } = await supabase.auth.admin.updateUserById(user.id, { app_metadata });
  if (error) throw error;

  console.log(`\n✓ ${user.email} is now ${ROLES[role].label.toLowerCase()}${previous ? ` (was ${previous})` : ''}.`);
  console.log(`  ${ROLES[role].description}`);
  console.log(`  ${permissionsFor(role).length} permissions: ${permissionsFor(role).join(', ')}`);
  console.log('\n  They must sign out and back in for the change to take effect.\n');
}

async function revoke(email) {
  const user = await findByEmail(email);
  if (!user) {
    console.error(`\n✗ No Supabase Auth user with the email ${email}.\n`);
    process.exit(1);
  }
  const existing = user.app_metadata || {};
  if (!existing[ADMIN_ROLE_META_KEY]) {
    console.log(`\n${user.email} has no console role. Nothing to revoke.\n`);
    return;
  }

  // Set to null, never `delete`: Supabase merges app_metadata on update, so
  // omitting a key leaves the previous value in place — the role would not
  // actually be revoked.
  const app_metadata = { ...existing, [ADMIN_ROLE_META_KEY]: null };

  const { error } = await supabase.auth.admin.updateUserById(user.id, { app_metadata });
  if (error) throw error;

  console.log(`\n✓ Console access removed for ${user.email}.`);
  console.log('  Their driver profile, screening state and history are untouched.\n');
}

(async () => {
  if (!isConfigured) {
    console.error('\n✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Check your .env.\n');
    process.exit(2);
  }
  if (!args.length || args[0] === '--help' || args[0] === '-h') return usage();

  try {
    if (args[0] === '--list') return await list();
    if (args[0] === '--create') {
      const [, email, role] = args;
      if (!email || !role) { usage(); process.exit(1); }
      return await createAndGrant(email, role);
    }
    const [email, second] = args;
    if (!second) { usage(); process.exit(1); }
    if (second === '--revoke') return await revoke(email);
    return await grant(email, second);
  } catch (err) {
    console.error('\n✗ ' + err.message + '\n');
    process.exit(1);
  }
})();
