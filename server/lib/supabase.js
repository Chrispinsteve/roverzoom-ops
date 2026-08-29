// Service-role Supabase client. Bypasses Row Level Security by design: the
// admin console reads across every driver and every booking, which no RLS
// policy in the rider/driver schema permits (those policies scope reads to
// "my own rows" for a signed-in driver).
//
// SUPABASE_SERVICE_ROLE_KEY must never reach the browser. The console's
// frontend never talks to Supabase for data — it holds only an admin Auth
// session and calls this API, which is the sole holder of the key.
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[roverzoom-ops] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — database calls will fail.');
}

// Same defensive fallback the rider/driver backend uses: createClient throws
// synchronously on a malformed URL, which would kill every cold start over a
// config typo. A placeholder keeps the module loadable so misconfiguration
// surfaces as a caught per-request error instead.
const PLACEHOLDER_URL = 'https://misconfigured.supabase.co';

// createClient() rejects a URL that is missing OR malformed, and a typo is
// far likelier than an omission. Validate the shape ourselves and substitute
// the placeholder either way, so the module always loads.
function safeUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return { url: PLACEHOLDER_URL, ok: false };
  if (!/^https?:\/\//i.test(value)) {
    console.warn(`[roverzoom-ops] SUPABASE_URL is not an http(s) URL (${JSON.stringify(value)}) — using placeholder.`);
    return { url: PLACEHOLDER_URL, ok: false };
  }
  return { url: value, ok: true };
}

const { url, ok: urlOk } = safeUrl(process.env.SUPABASE_URL);
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const supabase = createClient(
  url,
  key || 'missing-service-role-key',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const isConfigured = Boolean(urlOk && key);

module.exports = { supabase, isConfigured };
