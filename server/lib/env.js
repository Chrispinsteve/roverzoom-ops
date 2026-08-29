// Loads .env exactly once, from wherever it actually lives.
//
// Required by every module that reads process.env at import time — notably
// lib/supabase.js, which builds its client on first require. Without this,
// configuration depended on IMPORT ORDER: a script that reached supabase.js
// before index.js got a client built from a placeholder URL, and every query
// then failed with an opaque "fetch failed" that looks like a network problem
// rather than a config one.
//
// Which path exists depends on how the process was started: `npm run dev:api`
// runs with cwd = server/, `node server/index.js` runs from the repo root, a
// script in server/scripts/ from somewhere else again, and Vercel bundles the
// function elsewhere entirely. dotenv only ever checks cwd, so both candidates
// are tried explicitly. dotenv never overwrites a variable that is already
// set, so real platform environment variables (Vercel, CI) always win.
const path = require('path');
const dotenv = require('dotenv');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const envPath of [
    path.join(__dirname, '..', '.env'),        // server/.env
    path.join(__dirname, '..', '..', '.env'),  // repo root .env
  ]) {
    dotenv.config({ path: envPath });
  }
}

loadEnv();

module.exports = { loadEnv };
