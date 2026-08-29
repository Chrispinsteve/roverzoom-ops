require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { isConfigured } = require('./lib/supabase');
const sessionRoutes = require('./routes/session');
const overviewRoutes = require('./routes/overview');
const ridesRoutes = require('./routes/rides');
const dispatchRoutes = require('./routes/dispatch');
const driversRoutes = require('./routes/drivers');
const financeRoutes = require('./routes/finance');
const auditRoutes = require('./routes/audit');

const app = express();

// CORS. The console is served from its own origin (admin.roverzoom.com), so
// this API is genuinely cross-origin and the allowlist is load-bearing, not
// ceremony. An empty CORS_ORIGINS allows all — acceptable for local dev, and
// warned about loudly at boot so it cannot ship that way unnoticed.
const allowed = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!allowed.length) {
  console.warn('[roverzoom-ops] CORS_ORIGINS is empty — all origins allowed. Set it before deploying.');
}

app.use(cors({
  origin(origin, callback) {
    if (!allowed.length) return callback(null, true);
    // A missing Origin header is a same-origin or non-browser caller (curl,
    // a health check). Those are not what CORS defends against.
    if (!origin) return callback(null, true);
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed.`));
  },
  credentials: false, // auth travels in the Authorization header, not cookies
}));

app.use(express.json({ limit: '256kb' }));

// Never let an admin response be cached by a proxy or the browser. These
// payloads contain rider PII and driver trust decisions.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'roverzoom-ops-api',
    databaseConfigured: isConfigured,
  });
});

app.use('/api/admin', sessionRoutes);
app.use('/api/admin', overviewRoutes);
app.use('/api/admin', ridesRoutes);
app.use('/api/admin', dispatchRoutes);
app.use('/api/admin', driversRoutes);
app.use('/api/admin', financeRoutes);
app.use('/api/admin', auditRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A rejected CORS origin arrives here. Answer 403 rather than a 500, so the
  // console can tell an operator their domain is not on the allowlist.
  if (err && /is not allowed/.test(err.message || '')) {
    return res.status(403).json({ error: err.message, code: 'origin_not_allowed' });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 4100;
  app.listen(PORT, () => {
    console.log(`RoverZoom Ops API on http://localhost:${PORT}`);
    if (!isConfigured) console.warn('  ! Supabase is not configured — every data call will fail.');
    if (!process.env.ADMIN_BOOTSTRAP_EMAIL) {
      console.log('  i ADMIN_BOOTSTRAP_EMAIL is unset. Set it once to grant yourself the first owner role.');
    }
  });
}

module.exports = app;
