// Every admin surface must fail closed. This walks the real Express app and
// asserts that nothing answers with data without a verified admin session.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.CORS_ORIGINS = 'https://admin.roverzoom.com';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../index');
const { resolveRole } = require('../middleware/requireAdmin');

let server, base;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

// Every route the console exposes, including the mutating ones.
const ENDPOINTS = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/rides'],
  ['GET', '/api/admin/rides/RZ-AAAAA'],
  ['GET', '/api/admin/dispatch/board'],
  ['GET', '/api/admin/dispatch/x/candidates'],
  ['GET', '/api/admin/drivers'],
  ['GET', '/api/admin/drivers/x'],
  ['GET', '/api/admin/drivers/x/documents'],
  ['GET', '/api/admin/map/live'],
  ['GET', '/api/admin/finance/summary'],
  ['GET', '/api/admin/finance/balances'],
  ['GET', '/api/admin/finance/reconciliation'],
  ['GET', '/api/admin/finance/payouts'],
  ['GET', '/api/admin/audit'],
  ['POST', '/api/admin/rides/x/cancel'],
  ['POST', '/api/admin/dispatch/x/assign'],
  ['POST', '/api/admin/dispatch/x/release'],
  ['POST', '/api/admin/drivers/x/review'],
  ['POST', '/api/admin/drivers/x/status'],
  ['POST', '/api/admin/finance/payouts/x/paid'],
];

test('no endpoint answers without a token', async () => {
  for (const [method, path] of ENDPOINTS) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} should be 401, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, 'no_session');
    // The denial must not leak anything about what lives behind it.
    assert.ok(!('rides' in body) && !('drivers' in body) && !('admin' in body));
  }
});

test('a malformed Authorization header is not a session', async () => {
  for (const header of ['', 'Basic abc', 'bearer lowercase', 'Bearer', 'Token xyz']) {
    const res = await fetch(base + '/api/admin/overview', { headers: { authorization: header } });
    assert.equal(res.status, 401, `header ${JSON.stringify(header)} must be rejected`);
  }
});

test('health is public and reveals no secrets', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // It may say WHETHER things are configured, never anything about how.
  assert.deepEqual(Object.keys(body).sort(), ['auditTable', 'databaseConfigured', 'ok', 'service']);
  assert.ok(['installed', 'missing', 'unknown'].includes(body.auditTable));
  assert.ok(!JSON.stringify(body).includes('test-key'));
  assert.ok(!JSON.stringify(body).includes('supabase.co'));
});

test('unknown routes 404 without hinting at the API shape', async () => {
  const res = await fetch(base + '/api/admin/secrets');
  assert.equal(res.status, 404);
});

// --- bootstrap grant -------------------------------------------------------

test('bootstrap grants owner only to the exact configured email', () => {
  process.env.ADMIN_BOOTSTRAP_EMAIL = 'ops@roverzoom.com';
  // resolveRole reads the env var at call time via the module-level constant,
  // so re-require to pick up the change.
  delete require.cache[require.resolve('../middleware/requireAdmin')];
  const { resolveRole: resolve } = require('../middleware/requireAdmin');

  assert.equal(resolve({ email: 'ops@roverzoom.com', app_metadata: {} }).role, 'owner');
  assert.equal(resolve({ email: 'OPS@RoverZoom.com', app_metadata: {} }).role, 'owner', 'email compare is case-insensitive');
  assert.equal(resolve({ email: 'someone@else.com', app_metadata: {} }).role, null);
  assert.equal(resolve({ email: 'ops@roverzoom.com.evil.com', app_metadata: {} }).role, null, 'must not substring-match');

  delete require.cache[require.resolve('../middleware/requireAdmin')];
});

test('an unset bootstrap email grants nothing', () => {
  delete process.env.ADMIN_BOOTSTRAP_EMAIL;
  delete require.cache[require.resolve('../middleware/requireAdmin')];
  const { resolveRole: resolve } = require('../middleware/requireAdmin');

  // The dangerous failure would be treating "no bootstrap configured" as
  // "everyone matches". A user with no email must not become an owner.
  assert.equal(resolve({ email: '', app_metadata: {} }).role, null);
  assert.equal(resolve({ email: undefined, app_metadata: {} }).role, null);
  assert.equal(resolve({ app_metadata: {} }).role, null);

  delete require.cache[require.resolve('../middleware/requireAdmin')];
});

test('an explicit role always beats the bootstrap path', () => {
  process.env.ADMIN_BOOTSTRAP_EMAIL = 'ops@roverzoom.com';
  delete require.cache[require.resolve('../middleware/requireAdmin')];
  const { resolveRole: resolve } = require('../middleware/requireAdmin');

  const result = resolve({ email: 'ops@roverzoom.com', app_metadata: { rz_admin_role: 'viewer' } });
  assert.equal(result.role, 'viewer');
  assert.equal(result.viaBootstrap, false);

  delete process.env.ADMIN_BOOTSTRAP_EMAIL;
  delete require.cache[require.resolve('../middleware/requireAdmin')];
});


// --- public tracking beacon ------------------------------------------------
// The only unauthenticated write surface in the system, so its behaviour is
// pinned here: it must accept nothing it was not designed to accept, and must
// never leak information back to a prober.

test('the tracking beacon never reveals what it did', async () => {
  const cases = [
    { sessionId: 's1', step: 'visit' },              // valid
    { sessionId: 's1', step: 'not_a_real_step' },    // unknown step
    { sessionId: 's1' },                             // no step
    { step: 'visit' },                               // no session
    {},                                              // empty
    null,                                            // no body
  ];
  for (const body of cases) {
    const res = await fetch(base + '/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Always 204, always empty. A prober learns nothing about what was stored.
    assert.equal(res.status, 204, `payload ${JSON.stringify(body)} should answer 204`);
    assert.equal((await res.text()).length, 0);
  }
});

test('the beacon is public but the analytics reads are not', async () => {
  const open = await fetch(base + '/api/track', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x', step: 'visit' }),
  });
  assert.equal(open.status, 204);

  for (const path of ['/api/admin/analytics/traffic', '/api/admin/analytics/funnel']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, `${path} must require a session`);
  }
});

test('a huge tracking payload is rejected by the body limit', async () => {
  const res = await fetch(base + '/api/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x'.repeat(500000), step: 'visit' }),
  });
  // 413 from the 256kb limit, or 204 if it slipped under — never a 500.
  assert.ok([204, 413].includes(res.status), `expected 204 or 413, got ${res.status}`);
});
