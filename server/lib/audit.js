// Append-only admin audit trail.
//
// Every state-changing admin action writes one row here BEFORE it is
// reported as successful. "Who suspended this driver, when, and why" must be
// answerable months later — for a rideshare operator that is a legal
// question, not a nice-to-have.
//
// STORAGE: prefers an `admin_audit_log` table (db/001_admin_audit_log.sql).
// That table needs DDL, which this environment may not be able to run, so
// the logger degrades to structured stdout instead of failing the action.
// It never throws: an audit backend being down must not block an operator
// from suspending a dangerous driver. It DOES report which sink was used, so
// the console can warn when the durable trail is unavailable.
const { supabase } = require('./supabase');

const TABLE = 'admin_audit_log';

// Flips to false permanently the first time the table is found to be
// missing, so we make one failed call per process rather than one per action.
let tableAvailable = true;

function serialize(event) {
  return {
    actor_email: event.actorEmail || null,
    actor_id: event.actorId || null,
    actor_role: event.actorRole || null,
    action: event.action,                    // e.g. 'driver.suspend'
    subject_type: event.subjectType || null, // 'driver' | 'booking' | 'admin'
    subject_id: event.subjectId || null,
    summary: event.summary || null,          // one human sentence
    detail: event.detail || null,            // JSON: before/after, reason
    ip: event.ip || null,
    created_at: new Date().toISOString(),
  };
}

async function record(event) {
  const row = serialize(event);

  if (tableAvailable) {
    try {
      const { error } = await supabase.from(TABLE).insert(row);
      if (!error) return { sink: 'database', ok: true };

      // PGRST205 / 42P01 both mean "that table isn't there".
      if (error.code === 'PGRST205' || error.code === '42P01') {
        tableAvailable = false;
        console.warn(
          `[audit] ${TABLE} not found — falling back to stdout. ` +
          'Run db/001_admin_audit_log.sql for a durable, queryable trail.'
        );
      } else {
        console.error('[audit] write failed:', error.message);
      }
    } catch (err) {
      console.error('[audit] write threw:', err.message);
    }
  }

  // Fallback sink. One JSON object per line so a log drain can parse it.
  console.log('[audit] ' + JSON.stringify(row));
  return { sink: 'stdout', ok: true };
}

// Wraps record() with the request's actor, so routes never have to remember
// to attach identity — the middleware already resolved it.
function auditor(req) {
  return (event) => record({
    actorEmail: req.admin && req.admin.email,
    actorId: req.admin && req.admin.id,
    actorRole: req.admin && req.admin.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    ...event,
  });
}

async function list({ limit = 100, subjectId = null, action = null } = {}) {
  if (!tableAvailable) {
    return { available: false, entries: [] };
  }
  let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false }).limit(limit);
  if (subjectId) query = query.eq('subject_id', subjectId);
  if (action) query = query.eq('action', action);

  const { data, error } = await query;
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') tableAvailable = false;
    return { available: false, entries: [] };
  }
  return { available: true, entries: data || [] };
}

module.exports = { record, auditor, list, TABLE };
