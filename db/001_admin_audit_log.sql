-- RoverZoom Admin — audit trail.
--
-- OPTIONAL BUT STRONGLY RECOMMENDED. The console works without this table:
-- lib/audit.js falls back to structured stdout so an audit backend being
-- unavailable can never block an operator from suspending a dangerous driver.
-- But stdout is not queryable months later, and "who suspended this driver
-- and why" is a question a rideshare operator eventually has to answer to
-- someone other than themselves.
--
-- Run against the SAME Supabase project the rider/driver app uses:
--   psql "$DATABASE_URL" -f db/001_admin_audit_log.sql
-- or paste it into the Supabase SQL editor.
--
-- Additive only. It creates one new table and touches nothing that already
-- exists, so it is safe to run against the live database.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who acted. Denormalized on purpose: the email is captured as it was AT
  -- THE TIME, so a later rename or a deleted admin account cannot rewrite
  -- history. actor_id still points at auth.users for joining when it exists.
  actor_id     UUID,
  actor_email  TEXT,
  actor_role   TEXT,

  action       TEXT NOT NULL,        -- 'driver.suspend', 'dispatch.assign', ...
  subject_type TEXT,                 -- 'driver' | 'booking' | 'payout' | 'admin'
  subject_id   TEXT,                 -- TEXT, not UUID: some subjects are groups
  summary      TEXT,                 -- one human-readable sentence
  detail       JSONB,                -- before/after, reason, acknowledged warnings
  ip           TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_subject ON admin_audit_log(subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action, created_at DESC);

-- RLS on, with NO policies: the ops API reaches this table with the
-- service_role key, which bypasses RLS entirely. No browser client — driver
-- or admin — can read the audit trail directly under any circumstances.
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- An audit trail that can be edited is not an audit trail. Revoke UPDATE and
-- DELETE from the API roles so even a compromised service key can only
-- append. (Superuser/table owner can still administer the table.)
REVOKE UPDATE, DELETE ON admin_audit_log FROM anon, authenticated, service_role;
GRANT INSERT, SELECT ON admin_audit_log TO service_role;

COMMENT ON TABLE admin_audit_log IS
  'Append-only record of every state-changing action taken in the RoverZoom admin console.';
