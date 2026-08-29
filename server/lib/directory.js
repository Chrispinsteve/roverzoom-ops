// Joins `drivers` rows to their Supabase Auth accounts.
//
// Trust state (review decision, Checkr screening) lives in each driver's Auth
// app_metadata, but the operational data lives in the `drivers` table. Every
// driver-facing screen needs both.
//
// Fetching one auth user per driver would be N network calls to the Auth API
// for a single list view. listUsers() pages at up to 1000 at a time, so one
// page usually covers the entire fleet. The result is cached briefly because
// a list view, its counts, and its filters all ask for the same data within
// milliseconds of each other.
const { supabase } = require('./supabase');
const { trustStanding, STANDING_PRIORITY } = require('../domain/trust');

const CACHE_MS = Number(process.env.DIRECTORY_CACHE_MS) || 10_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20; // 20k accounts; a hard stop so a bad page loop can't hang a request

let cache = { at: 0, byId: new Map() };

async function loadAuthUsers({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS && cache.byId.size) {
    return cache.byId;
  }

  const byId = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw error;
    const users = (data && data.users) || [];
    for (const user of users) byId.set(user.id, user);
    if (users.length < PAGE_SIZE) break;
  }

  cache = { at: Date.now(), byId };
  return byId;
}

// Invalidated explicitly after any write that changes app_metadata, so an
// operator who approves a driver sees the new standing immediately rather
// than up to CACHE_MS of stale state.
function invalidate() {
  cache = { at: 0, byId: new Map() };
}

// Decorates driver rows with their auth account and computed trust standing.
async function withTrust(drivers) {
  const byId = await loadAuthUsers();
  return drivers.map((driver) => {
    const authUser = driver.auth_user_id ? byId.get(driver.auth_user_id) || null : null;
    const standing = trustStanding(driver, authUser);
    return {
      ...driver,
      auth_present: Boolean(authUser),
      last_sign_in_at: authUser ? authUser.last_sign_in_at : null,
      standing: {
        key: standing.key,
        label: standing.label,
        risk: standing.risk,
      },
      trust: {
        accountActive: standing.factors.accountActive,
        documentsComplete: standing.factors.documentsComplete,
        screeningClear: standing.factors.screeningClear,
        humanApproved: standing.factors.humanApproved,
        review: standing.factors.review,
        screening: standing.factors.screening,
        provisional: standing.factors.provisional,
        provisionallyAuthorized: standing.factors.provisionallyAuthorized,
      },
    };
  });
}

function sortByUrgency(decorated) {
  return decorated.sort((a, b) => {
    const pa = STANDING_PRIORITY[a.standing.key] ?? 99;
    const pb = STANDING_PRIORITY[b.standing.key] ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

// A single driver, with the auth account fetched directly (no cache) so a
// detail view always reflects the newest metadata after a decision.
async function getDriverWithTrust(driverId) {
  const { data: driver, error } = await supabase
    .from('drivers').select('*').eq('id', driverId).maybeSingle();
  if (error) throw error;
  if (!driver) return null;

  let authUser = null;
  if (driver.auth_user_id) {
    const { data } = await supabase.auth.admin.getUserById(driver.auth_user_id);
    authUser = (data && data.user) || null;
  }
  const standing = trustStanding(driver, authUser);
  return {
    ...driver,
    auth_present: Boolean(authUser),
    last_sign_in_at: authUser ? authUser.last_sign_in_at : null,
    standing: { key: standing.key, label: standing.label, risk: standing.risk },
    trust: {
      accountActive: standing.factors.accountActive,
      documentsComplete: standing.factors.documentsComplete,
      screeningClear: standing.factors.screeningClear,
      humanApproved: standing.factors.humanApproved,
      review: standing.factors.review,
      screening: standing.factors.screening,
      provisional: standing.factors.provisional,
      provisionallyAuthorized: standing.factors.provisionallyAuthorized,
    },
    _authUser: authUser,
  };
}

// How recently a driver reported a position. Drivers stop sending location
// when the app is backgrounded or they lose signal, so a stale fix is the
// difference between "on the map" and "we think they're there".
function locationFreshness(driver, nowMs = Date.now()) {
  if (!driver.location_updated_at) return { state: 'never', ageSeconds: null };
  const ageSeconds = Math.round((nowMs - new Date(driver.location_updated_at).getTime()) / 1000);
  if (ageSeconds <= 60) return { state: 'live', ageSeconds };
  if (ageSeconds <= 300) return { state: 'recent', ageSeconds };
  return { state: 'stale', ageSeconds };
}

module.exports = { loadAuthUsers, invalidate, withTrust, sortByUrgency, getDriverWithTrust, locationFreshness };
