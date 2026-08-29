-- RoverZoom Ops — first-party site analytics.
--
-- WHY THIS EXISTS
-- The rider site currently loads a Google ADS tag (AW-18393777489), which is a
-- conversion pixel, not analytics. There is no GA4 property, so there is no
-- pageview, session or region data anywhere to report on. This table creates
-- it, first-party, with no third-party analytics dependency.
--
-- It also answers "are the ads working?" WITHOUT relying on Google: the rider
-- app already stores an ad click (gclid/gbraid/wbraid) in localStorage under
-- `rz_ad_click`, so each event can say whether the visitor arrived from an ad.
-- Ad-driven visits and the bookings that follow are then countable here.
--
-- PRIVACY
-- Deliberately no IP address, no user agent string, no rider name, phone or
-- email, and no cross-site identifier. The session id is a random value the
-- browser generates per visit; it identifies a VISIT, not a person, and it
-- cannot be joined back to anyone. Region comes from the edge (Vercel's
-- geo headers) at city granularity, which is what an ads decision needs and
-- no more.
--
-- Run:  psql "$DATABASE_URL" -f db/002_site_events.sql

CREATE TABLE IF NOT EXISTS site_events (
  id           BIGSERIAL PRIMARY KEY,

  -- Random per-visit id from the browser. NOT a user id.
  session_id   TEXT NOT NULL,

  -- A funnel step. See server/domain/funnel.js for the ordered list; stored as
  -- free text so the rider app can add a step without a migration.
  step         TEXT NOT NULL,

  -- Did this visit originate from a Google Ads click?
  from_ad      BOOLEAN NOT NULL DEFAULT false,

  -- Where the visitor entered from: 'ad' | 'organic' | 'direct' | 'kiosk'.
  channel      TEXT,

  -- Edge geo, city granularity. Never an IP.
  country      TEXT,
  region       TEXT,
  city         TEXT,

  -- Coarse device class only: 'mobile' | 'tablet' | 'desktop'.
  device       TEXT,

  -- Step-specific numbers, e.g. the fare shown at `quote_viewed`. Bounded and
  -- validated server-side; never free-form user text.
  value_num    NUMERIC(10,2),

  -- Set only on the final step, so a booked session can be tied to its ride.
  booking_ref  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_events_created_at ON site_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_session ON site_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_events_step ON site_events(step, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_region ON site_events(region, created_at DESC);

-- RLS on with NO policies: only the ops API (service_role) touches this table.
-- No browser client can read it, and the ingest endpoint is the sole writer.
ALTER TABLE site_events ENABLE ROW LEVEL SECURITY;

REVOKE UPDATE, DELETE ON site_events FROM anon, authenticated;
GRANT INSERT, SELECT ON site_events TO service_role;

COMMENT ON TABLE site_events IS
  'First-party funnel and traffic events for the RoverZoom rider site. Visit-scoped, no personal data.';
