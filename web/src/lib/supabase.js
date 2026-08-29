import { createClient } from '@supabase/supabase-js';

// The console holds an admin Auth session and nothing else. It never reads
// application data through Supabase directly — every byte of ride, driver and
// money data comes from the ops API, which is the only holder of the
// service-role key. This client exists purely to sign in, refresh, and hand
// the access token to that API.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. ' +
    'Copy web/.env.example to web/.env and fill them in.'
  );
}

export const supabase = createClient(url || 'https://unconfigured.supabase.co', anonKey || 'unconfigured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export const isConfigured = Boolean(url && anonKey);
