// Site analytics: a public ingest beacon, and the admin queries over it.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { STEPS, isStep, CHANNELS, DEVICES, buildFunnel } = require('../domain/funnel');

const router = express.Router();

// --- ingest ----------------------------------------------------------------

// Crude per-instance rate limit. On serverless each instance keeps its own map,
// so this caps a single abusive client per instance rather than globally — a
// speed bump against accidental loops and casual spam, NOT a defence against a
// determined attacker. Anything stronger belongs at the edge (Vercel WAF /
// Cloudflare), which is the right layer for it.
const HITS = new Map();
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 60;

function rateLimited(key) {
  const now = Date.now();
  const entry = HITS.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    HITS.set(key, { start: now, count: 1 });
    // Opportunistic sweep so the map cannot grow without bound.
    if (HITS.size > 5000) {
      for (const [k, v] of HITS) if (now - v.start > WINDOW_MS) HITS.delete(k);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

// Geo from the edge. Vercel sets these on every request; other hosts set their
// own. No IP address is read or stored — city granularity is what an ads
// decision needs, and nothing finer is collected.
function geoFrom(req) {
  const h = req.headers;
  const dec = (v) => {
    if (!v) return null;
    try { return decodeURIComponent(String(v)).slice(0, 80); } catch { return String(v).slice(0, 80); }
  };
  return {
    country: dec(h['x-vercel-ip-country'] || h['cf-ipcountry']) || null,
    region: dec(h['x-vercel-ip-country-region'] || h['x-vercel-ip-region']) || null,
    city: dec(h['x-vercel-ip-city'] || h['cf-ipcity']) || null,
  };
}

// Strips control characters and caps length.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const clean = (v, max = 64) =>
  v == null ? null : String(v).replace(CONTROL_CHARS, '').trim().slice(0, max) || null;

// POST /api/track — PUBLIC. Called by the rider site.
//
// Accepts only a fixed vocabulary: a known step, a known channel, a known
// device class, a session id and one number. Everything else is dropped. It
// therefore cannot become a channel for arbitrary user text, which is what
// keeps this table free of personal data by construction rather than by
// promise.
router.post('/track', async (req, res) => {
  // Always answer 204, even on a bad payload or a rate-limit. A tracking
  // beacon must never surface an error into the booking flow, and must never
  // tell a prober what it did or did not accept.
  const done = () => res.status(204).end();

  try {
    const ip = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (rateLimited(String(ip).split(',')[0].trim())) return done();

    const { sessionId, step, fromAd, channel, device, value, bookingRef } = req.body || {};
    if (!sessionId || !step || !isStep(step)) return done();

    const num = Number(value);
    const row = {
      session_id: clean(sessionId, 64),
      step,
      from_ad: fromAd === true,
      channel: CHANNELS.includes(channel) ? channel : null,
      device: DEVICES.includes(device) ? device : null,
      // Bounded: a fare, not an arbitrary number.
      value_num: Number.isFinite(num) && num >= 0 && num < 100000 ? Math.round(num * 100) / 100 : null,
      booking_ref: /^RZ-[A-Z0-9]{5}$/.test(String(bookingRef || '')) ? bookingRef : null,
      ...geoFrom(req),
    };

    if (!row.session_id) return done();

    const { error } = await supabase.from('site_events').insert(row);
    if (error && error.code !== 'PGRST205' && error.code !== '42P01') {
      console.error('[track] insert failed:', error.message);
    }
    return done();
  } catch (err) {
    console.error('[track]', err.message);
    return done();
  }
});

// --- admin queries ---------------------------------------------------------

function windowFrom(req) {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  return { from: new Date(Date.now() - days * 86400000).toISOString(), days };
}

// Signals the table has not been installed, so the console can say so rather
// than rendering convincing zeros.
function tableMissing(error) {
  return error && (error.code === 'PGRST205' || error.code === '42P01');
}

router.get('/analytics/traffic', requireAdmin, requirePermission('analytics.read'), async (req, res) => {
  try {
    const { from, days } = windowFrom(req);

    const { data, error } = await supabase
      .from('site_events')
      .select('session_id, step, from_ad, channel, country, region, city, device, created_at')
      .gte('created_at', from)
      .limit(100000);

    if (tableMissing(error)) return res.json({ installed: false, window: { from, days } });
    if (error) throw error;

    const events = data || [];

    // One row per SESSION, using its earliest event for attribution.
    const sessions = new Map();
    for (const e of events) {
      const s = sessions.get(e.session_id);
      if (!s || new Date(e.created_at) < new Date(s.created_at)) sessions.set(e.session_id, e);
    }
    const visits = [...sessions.values()];
    const bookedSessions = new Set(events.filter((e) => e.step === 'booked').map((e) => e.session_id));

    const tally = (keyFn) => {
      const m = new Map();
      for (const v of visits) {
        const k = keyFn(v) || 'Unknown';
        const row = m.get(k) || { key: k, visits: 0, booked: 0, fromAd: 0 };
        row.visits += 1;
        if (bookedSessions.has(v.session_id)) row.booked += 1;
        if (v.from_ad) row.fromAd += 1;
        m.set(k, row);
      }
      return [...m.values()]
        .map((r) => ({ ...r, conversionPct: r.visits ? Math.round((r.booked / r.visits) * 1000) / 10 : 0 }))
        .sort((a, b) => b.visits - a.visits);
    };

    const byDay = new Map();
    for (const v of visits) {
      const day = v.created_at.slice(0, 10);
      const row = byDay.get(day) || { day, visits: 0, booked: 0 };
      row.visits += 1;
      if (bookedSessions.has(v.session_id)) row.booked += 1;
      byDay.set(day, row);
    }

    const adVisits = visits.filter((v) => v.from_ad);
    const adBooked = adVisits.filter((v) => bookedSessions.has(v.session_id)).length;

    res.json({
      installed: true,
      window: { from, days },
      totals: {
        visits: visits.length,
        booked: bookedSessions.size,
        conversionPct: visits.length ? Math.round((bookedSessions.size / visits.length) * 1000) / 10 : 0,
      },
      // The first-party answer to "are the ads working?" — independent of
      // Google's conversion tag, which is currently not reporting at all.
      ads: {
        visits: adVisits.length,
        booked: adBooked,
        conversionPct: adVisits.length ? Math.round((adBooked / adVisits.length) * 1000) / 10 : 0,
        shareOfTraffic: visits.length ? Math.round((adVisits.length / visits.length) * 1000) / 10 : 0,
      },
      byCity: tally((v) => v.city).slice(0, 40),
      byRegion: tally((v) => v.region).slice(0, 40),
      byChannel: tally((v) => v.channel),
      byDevice: tally((v) => v.device),
      daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (err) {
    console.error('[analytics:traffic]', err.message);
    res.status(500).json({ error: 'Could not load traffic.' });
  }
});

router.get('/analytics/funnel', requireAdmin, requirePermission('analytics.read'), async (req, res) => {
  try {
    const { from, days } = windowFrom(req);
    const onlyAds = req.query.source === 'ad';

    let query = supabase
      .from('site_events')
      .select('session_id, step, from_ad, value_num, created_at')
      .gte('created_at', from)
      .limit(100000);
    if (onlyAds) query = query.eq('from_ad', true);

    const { data, error } = await query;
    if (tableMissing(error)) return res.json({ installed: false, window: { from, days }, steps: STEPS });
    if (error) throw error;

    const events = data || [];
    const funnel = buildFunnel(events);

    // What price did people see before leaving, versus before booking? If
    // abandoners consistently saw higher fares than bookers, price is the
    // problem rather than the flow.
    const booked = new Set(events.filter((e) => e.step === 'booked').map((e) => e.session_id));
    const quotes = events.filter((e) => e.step === 'quote_viewed' && e.value_num != null);
    const avg = (rows) => rows.length
      ? Math.round((rows.reduce((s, r) => s + Number(r.value_num), 0) / rows.length) * 100) / 100
      : null;

    res.json({
      installed: true,
      window: { from, days },
      source: onlyAds ? 'ad' : 'all',
      ...funnel,
      price: {
        quotesSeen: quotes.length,
        avgQuoteBooked: avg(quotes.filter((q) => booked.has(q.session_id))),
        avgQuoteAbandoned: avg(quotes.filter((q) => !booked.has(q.session_id))),
      },
    });
  } catch (err) {
    console.error('[analytics:funnel]', err.message);
    res.status(500).json({ error: 'Could not load the funnel.' });
  }
});

module.exports = router;
