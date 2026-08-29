// Admin authentication and authorization.
//
// Identity is a real Supabase Auth user — the same auth system the drivers
// use, a different set of accounts. The bearer token is verified against
// Supabase on every request (not locally), for the same reason
// requireDriver.js does it: a locally-verified JWT signature cannot see a
// revoked session or a role that was pulled thirty seconds ago, and role is
// deliberately NOT a JWT claim.
//
// Authorization is app_metadata.rz_admin_role, which is server-controlled:
// the Supabase client API lets a user edit their own user_metadata but never
// their app_metadata. A driver — or anyone who signs up — therefore cannot
// grant themselves a role.
//
// FAILS CLOSED. No token, no role, an unrecognized role, or an unreachable
// auth service all deny access. There is no bypass, no shared key, and no
// "if unset, allow" branch anywhere in this file.
const { supabase } = require('../lib/supabase');
const { roleOf, permissionsFor, can, ADMIN_ROLE_META_KEY } = require('../lib/roles');

// Bootstrap: the very first owner cannot be granted by an existing admin,
// because there isn't one. This email — set in the server environment, never
// by a client — is treated as an owner even with no role in app_metadata.
// Unset means "no bootstrap", not "everyone is an owner".
//
// Grant a real role to your own account and remove this variable once you
// are in; it is a ladder, not a permanent door.
const BOOTSTRAP_EMAIL = (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();

function resolveRole(authUser) {
  const explicit = roleOf(authUser);
  if (explicit) return { role: explicit, viaBootstrap: false };

  const email = (authUser.email || '').trim().toLowerCase();
  if (BOOTSTRAP_EMAIL && email && email === BOOTSTRAP_EMAIL) {
    return { role: 'owner', viaBootstrap: true };
  }
  return { role: null, viaBootstrap: false };
}

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Sign in to use the RoverZoom console.', code: 'no_session' });
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      // Distinguish "your session is bad" from "we couldn't check". Answering
      // 401 during an auth outage tells every operator to re-login for a
      // problem no re-login can fix — during an incident, that is the worst
      // possible time to lock the ops team out of the board.
      const unreachable = error && (
        error.name === 'AuthRetryableFetchError' ||
        error.status === 0 ||
        (error.status || 0) >= 500
      );
      if (unreachable) {
        console.error('[auth] Supabase Auth unreachable —', error.message);
        return res.status(503).json({
          error: 'Could not verify your session right now. Try again in a moment.',
          code: 'auth_unavailable',
        });
      }
      return res.status(401).json({ error: 'Your session has expired.', code: 'session_invalid' });
    }

    const user = data.user;
    const { role, viaBootstrap } = resolveRole(user);

    if (!role) {
      // A valid RoverZoom account with no admin role. Most likely a driver
      // who found the console URL. Deny without confirming anything about
      // what the console contains.
      return res.status(403).json({
        error: 'This account does not have access to the RoverZoom console.',
        code: 'not_an_admin',
      });
    }

    req.admin = {
      id: user.id,
      email: user.email,
      role,
      viaBootstrap,
      permissions: permissionsFor(role),
      name: (user.user_metadata && user.user_metadata.name) || null,
    };

    if (viaBootstrap) {
      console.warn(`[auth] ${user.email} authenticated as owner via ADMIN_BOOTSTRAP_EMAIL. Assign a real role and unset it.`);
    }

    next();
  } catch (err) {
    console.error('[auth] requireAdmin failed:', err.message);
    res.status(500).json({ error: 'Could not verify your session.', code: 'auth_error' });
  }
}

// Route-level permission gate. Always mounted AFTER requireAdmin.
function requirePermission(permission) {
  return function permissionGate(req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ error: 'Not signed in.', code: 'no_session' });
    }
    if (!can(req.admin.role, permission)) {
      return res.status(403).json({
        error: `Your role (${req.admin.role}) cannot ${permission.replace('.', ' ')}.`,
        code: 'forbidden',
        required: permission,
      });
    }
    next();
  };
}

module.exports = { requireAdmin, requirePermission, resolveRole, ADMIN_ROLE_META_KEY };
