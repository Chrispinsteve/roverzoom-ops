import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { isConfigured } from '../lib/supabase';

// The console's front door. Deliberately plain: the only thing it should do is
// let the right person in and say clearly what happened when it does not.
export function SignIn() {
  const { signIn, denial } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div className="row" style={{ gap: 11, marginBottom: 26 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'var(--ink)', color: 'var(--bg)',
            display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 13, letterSpacing: '-0.03em',
          }}>RZ</div>
          <div className="col" style={{ gap: 1 }}>
            <strong style={{ fontSize: 15, letterSpacing: '-0.01em' }}>RoverZoom</strong>
            <span className="faint" style={{ fontSize: 12 }}>Operations console</span>
          </div>
        </div>

        {!isConfigured && (
          <div className="sev-critical" style={{
            padding: '11px 13px', marginBottom: 16, borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
            fontSize: 12.5, lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--sev)' }}>Not configured.</strong> Set{' '}
            <span className="mono">VITE_SUPABASE_URL</span> and{' '}
            <span className="mono">VITE_SUPABASE_ANON_KEY</span> in <span className="mono">web/.env</span>.
          </div>
        )}

        {/* A valid account that simply has no admin role. This is the most
            confusing possible outcome, so it gets its own explanation rather
            than a generic failure. */}
        {denial && (
          <div className="sev-warn" style={{
            padding: '11px 13px', marginBottom: 16, borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
            fontSize: 12.5, lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--sev)' }}>Signed in, but no console access.</strong>
            <div className="muted" style={{ marginTop: 3 }}>{denial.message}</div>
          </div>
        )}

        <form onSubmit={submit} className="panel" style={{ padding: 20 }}>
          <div style={{ marginBottom: 13 }}>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="field" type="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div style={{ marginBottom: 17 }}>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" className="field" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {error && (
            <div className="sev-critical" style={{ fontSize: 12.5, color: 'var(--sev)', marginBottom: 13 }}>
              {error}
            </div>
          )}

          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !isConfigured}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="faint" style={{ fontSize: 11.5, marginTop: 14, textAlign: 'center', lineHeight: 1.5 }}>
          Console accounts are RoverZoom accounts with an admin role.
          <br />Driver accounts cannot sign in here.
        </p>
      </div>
    </div>
  );
}
