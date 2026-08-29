-- RoverZoom Ops — multi-source traffic attribution.
--
-- 002 recorded only whether a visit came from a Google ad. That is too narrow:
-- traffic for a local ride service arrives from Facebook and Instagram,
-- community sites like Nextdoor and Yelp, organic search, printed flyers with
-- a QR code, and direct word of mouth. Without these columns every non-Google
-- channel is invisible, and "are the ads working?" can only be asked of Google.
--
-- Additive and idempotent — safe to run whether or not 002 has already been
-- applied, and safe to re-run.
--
-- Run:  psql "$DATABASE_URL" -f db/003_site_events_attribution.sql

ALTER TABLE site_events
  -- Normalized platform: google | facebook | instagram | nextdoor | yelp |
  -- tiktok | bing | direct | kiosk | <referrer host> ...
  ADD COLUMN IF NOT EXISTS source        TEXT,

  -- How they arrived: cpc | social | organic | referral | email | sms | qr | none.
  -- `cpc` is the one that means money was spent.
  ADD COLUMN IF NOT EXISTS medium        TEXT,

  -- utm_campaign / utm_content / utm_term, so individual campaigns and
  -- creatives can be compared against each other.
  ADD COLUMN IF NOT EXISTS campaign      TEXT,
  ADD COLUMN IF NOT EXISTS content       TEXT,
  ADD COLUMN IF NOT EXISTS term          TEXT,

  -- Referring hostname only — never a full URL, which can carry a search query
  -- or other personal detail in its path.
  ADD COLUMN IF NOT EXISTS referrer_host TEXT,

  -- True when a click id or an explicit cpc medium says this click was bought.
  -- Broader than the original from_ad, which only knew about Google.
  ADD COLUMN IF NOT EXISTS paid          BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_site_events_source ON site_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_medium ON site_events(medium, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_campaign ON site_events(campaign, created_at DESC)
  WHERE campaign IS NOT NULL;

-- Backfill rows written before this migration: from_ad could only ever have
-- meant a Google Ads click.
UPDATE site_events
   SET source = COALESCE(source, CASE WHEN from_ad THEN 'google' ELSE 'direct' END),
       medium = COALESCE(medium, CASE WHEN from_ad THEN 'cpc' ELSE 'none' END),
       paid   = COALESCE(paid, from_ad)
 WHERE source IS NULL;

COMMENT ON COLUMN site_events.source IS 'Normalized traffic source. Server-derived from utm_source, platform click ids and referrer — never trusted raw from the client.';
COMMENT ON COLUMN site_events.paid IS 'This click was bought (any platform), not just Google.';
