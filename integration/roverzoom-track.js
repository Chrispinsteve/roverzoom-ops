// RoverZoom — first-party funnel tracking.
//
// DROP THIS INTO THE RIDER APP: copy to roverzoom/frontend/src/lib/track.js
// and add the seven calls listed in integration/README.md.
//
// It answers two questions the platform currently cannot: how many people
// visit, and where they stop. It sends NO personal data — no name, phone,
// email, address or IP — only a random per-visit id, which step was reached,
// and (at the price step) the fare shown. Region is resolved at the edge by
// the ops API from its own request headers, never by this file.
//
// Every call is fire-and-forget and wrapped so that analytics can never throw
// into the booking flow. If the ops API is down, bookings are unaffected.

const ENDPOINT = (import.meta.env.VITE_OPS_API_URL || '') + '/api/track';
const SESSION_KEY = 'rz_session';
const AD_CLICK_KEY = 'rz_ad_click'; // written by lib/gtag.js on an ad landing
const CLICK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

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
    return null; // private mode with storage disabled — simply do not track
  }
}

// Reuses the ad click gtag.js already captured, so ad attribution works even
// though the Google conversion tag itself reports nothing.
function cameFromAd() {
  try {
    const raw = localStorage.getItem(AD_CLICK_KEY);
    if (!raw) return false;
    const { at } = JSON.parse(raw);
    return typeof at === 'number' && Date.now() - at < CLICK_WINDOW_MS;
  } catch {
    return false;
  }
}

function channel() {
  if (cameFromAd()) return 'ad';
  try {
    if (window.location.search.includes('kiosk')) return 'kiosk';
    const ref = document.referrer;
    if (!ref) return 'direct';
    if (new URL(ref).hostname === window.location.hostname) return 'direct';
    return 'organic';
  } catch {
    return 'direct';
  }
}

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
      fromAd: cameFromAd(),
      channel: channel(),
      device: device(),
      value,
      bookingRef,
    });

    // sendBeacon survives the page being closed — essential for the very steps
    // that matter most here, which are the ones right before someone leaves.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
      return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the booking flow */
  }
}
