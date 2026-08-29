// RoverZoom — first-party funnel tracking and traffic attribution.
//
// DROP THIS INTO THE RIDER APP: copy to roverzoom/frontend/src/lib/track.js
// and add the seven calls listed in integration/README.md.
//
// It answers three questions the platform currently cannot: how many people
// visit, where they came from, and where they stop. It sends NO personal data
// — no name, phone, email, address or IP — only a random per-visit id, which
// step was reached, the fare shown at the price step, and the raw attribution
// signals below. City is resolved at the edge by the ops API from its own
// request headers, never by this file.
//
// Every call is fire-and-forget and wrapped so analytics can never throw into
// the booking flow. If the ops API is down, bookings are unaffected.

const ENDPOINT = (import.meta.env.VITE_OPS_API_URL || '') + '/api/track';
const SESSION_KEY = 'rz_session';
const ATTRIB_KEY = 'rz_attrib';

// Platform click identifiers. Presence of one means the click was PAID, on
// that platform, regardless of anything else in the URL.
const CLICK_KEYS = [
  'gclid', 'gbraid', 'wbraid',  // Google Ads
  'fbclid',                     // Meta — Facebook and Instagram
  'ttclid',                     // TikTok
  'msclkid',                    // Microsoft / Bing
  'twclid',                     // X
  'li_fat_id',                  // LinkedIn
  'epik',                       // Pinterest
  'sccid',                      // Snapchat
];

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// A random id for THIS visit. sessionStorage, so it dies with the tab: it
// identifies a visit, not a person, and cannot follow anyone between sessions.
function sessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null; // storage disabled (private mode) — simply do not track
  }
}

// Capture attribution ONCE, on the first page of the visit, and reuse it for
// every later step. Without this, in-app navigation strips the query string
// and a booking would look "direct" even though it came from an ad — the
// classic way ad performance disappears from a report.
function captureAttribution() {
  try {
    const existing = sessionStorage.getItem(ATTRIB_KEY);
    if (existing) return JSON.parse(existing);

    const q = new URLSearchParams(window.location.search);

    const utm = {};
    for (const k of UTM_KEYS) {
      const v = q.get(k);
      if (v) utm[k.replace('utm_', '')] = v.slice(0, 80);
    }

    const clickIds = {};
    for (const k of CLICK_KEYS) {
      const v = q.get(k);
      if (v) clickIds[k] = v.slice(0, 200);
    }

    // Only the referring ORIGIN, never the full URL — a referring URL can
    // carry the visitor's search query or other personal detail in its path.
    let referrer = null;
    try {
      if (document.referrer) {
        const u = new URL(document.referrer);
        if (u.hostname !== window.location.hostname) referrer = u.origin;
      }
    } catch { /* unparseable referrer */ }

    const attrib = {
      utm,
      clickIds,
      referrer,
      isKiosk: q.has('kiosk') || q.get('mode') === 'kiosk',
    };
    sessionStorage.setItem(ATTRIB_KEY, JSON.stringify(attrib));
    return attrib;
  } catch {
    return { utm: {}, clickIds: {}, referrer: null, isKiosk: false };
  }
}

// Runs at import time, before any in-app navigation rewrites the URL.
const ATTRIBUTION = typeof window !== 'undefined'
  ? captureAttribution()
  : { utm: {}, clickIds: {}, referrer: null, isKiosk: false };

function device() {
  try {
    const w = window.innerWidth;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  } catch {
    return null;
  }
}

/**
 * Record one funnel step.
 *   track('quote_viewed', { value: fare })
 *   track('booked', { bookingRef: booking.reference })
 *
 * Valid steps: visit | booking_started | pickup_set | dropoff_set |
 *              quote_viewed | checkout_started | booked
 */
export function track(step, { value, bookingRef } = {}) {
  try {
    const id = sessionId();
    if (!id) return;

    const payload = JSON.stringify({
      sessionId: id,
      step,
      device: device(),
      value,
      bookingRef,
      // Raw signals. The ops API normalizes these into a source and medium, so
      // the vocabulary stays fixed and consistent across every report.
      utm: ATTRIBUTION.utm,
      clickIds: ATTRIBUTION.clickIds,
      referrer: ATTRIBUTION.referrer,
      isKiosk: ATTRIBUTION.isKiosk,
    });

    // Sent as text/plain, NOT application/json — and that is load-bearing.
    //
    // The console lives on a different origin to the rider site, so these are
    // cross-origin requests. application/json is not a CORS-safelisted content
    // type, so it forces a preflight; beacons are dispatched no-cors and a
    // preflighted beacon is simply dropped. The result would be tracking that
    // works perfectly in local development (same origin, via the dev proxy)
    // and silently records nothing in production — the worst possible failure
    // for an analytics pipeline, because it looks like "nobody visited".
    //
    // text/plain is safelisted, so no preflight happens. The body is still
    // JSON; the ops API parses it from the string.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'text/plain;charset=UTF-8' }));
      return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: payload,
      keepalive: true,
      mode: 'cors',
    }).catch(() => {});
  } catch {
    /* analytics must never break the booking flow */
  }
}
