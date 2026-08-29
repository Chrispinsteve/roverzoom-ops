import { useAuth } from '../lib/auth';

// Navigation is ordered by how a shift actually runs: what needs me now
// (Overview), what I'm placing (Dispatch), what's running (Rides), who's
// driving (Drivers), what it earned (Finance), what we did (Audit).
//
// Each item declares the permission it needs. An item a role cannot use is not
// rendered at all — showing a dispatcher a Finance tab that 403s on click
// teaches them the console is unreliable.
export const NAV = [
  { id: 'overview', label: 'Overview', permission: 'overview.read', glyph: '◈' },
  { id: 'dispatch', label: 'Dispatch', permission: 'dispatch.read', glyph: '◎' },
  { id: 'map',      label: 'Live map', permission: 'drivers.read',  glyph: '◇' },
  { id: 'rides',    label: 'Rides',    permission: 'rides.read',    glyph: '◍' },
  { id: 'drivers',  label: 'Drivers',  permission: 'drivers.read',  glyph: '◐' },
  { id: 'growth',   label: 'Growth',   permission: 'analytics.read', glyph: '◭' },
  { id: 'finance',  label: 'Finance',  permission: 'finance.read',  glyph: '▤' },
  { id: 'audit',    label: 'Audit',    permission: 'audit.read',    glyph: '▦' },
];

export function Shell({ route, onNavigate, badges = {}, children }) {
  const { admin, can, signOut } = useAuth();
  const visible = NAV.filter((item) => can(item.permission));

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside style={{
        width: 'var(--sidebar-w)', flex: 'none',
        borderRight: '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9,
              background: 'var(--ink)', color: 'var(--bg)',
              display: 'grid', placeItems: 'center',
              fontWeight: 800, fontSize: 12, letterSpacing: '-0.03em',
            }}>RZ</div>
            <div className="col" style={{ gap: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 13.5, letterSpacing: '-0.01em' }}>RoverZoom</strong>
              <span className="faint" style={{ fontSize: 11 }}>Operations</span>
            </div>
          </div>
        </div>

        <nav style={{ padding: 10, flex: 1, overflowY: 'auto' }} aria-label="Sections">
          {visible.map((item) => {
            const active = route === item.id;
            const badge = badges[item.id];
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={active ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '8px 10px', marginBottom: 2, borderRadius: 'var(--r-xs)',
                  fontSize: 13.5, fontWeight: active ? 600 : 450,
                  color: active ? 'var(--ink)' : 'var(--ink-3)',
                  background: active ? 'var(--surface-3)' : 'transparent',
                  transition: 'all 130ms var(--ease)',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 14, textAlign: 'center', opacity: active ? 1 : 0.55, fontSize: 12 }}>{item.glyph}</span>
                <span className="grow" style={{ textAlign: 'left' }}>{item.label}</span>
                {/* A count in the nav appears ONLY when something needs a
                    person. A permanent badge is wallpaper. */}
                {badge > 0 && (
                  <span className="sev-critical num" style={{
                    minWidth: 19, height: 19, padding: '0 5px',
                    borderRadius: 999, background: 'var(--sev-wash)',
                    border: '1px solid var(--sev-line)', color: 'var(--sev)',
                    fontSize: 11, fontWeight: 600,
                    display: 'grid', placeItems: 'center',
                  }}>{badge}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div style={{ padding: 12, borderTop: '1px solid var(--line)' }}>
          {admin?.viaBootstrap && (
            <div className="sev-warn" style={{
              padding: '8px 10px', marginBottom: 10, borderRadius: 'var(--r-xs)',
              background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
              fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-2)',
            }}>
              <strong style={{ color: 'var(--sev)' }}>Bootstrap access.</strong>{' '}
              You are an owner via <span className="mono">ADMIN_BOOTSTRAP_EMAIL</span>. Assign a real
              role and unset it.
            </div>
          )}
          <div className="row" style={{ gap: 9 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%', flex: 'none',
              background: 'var(--surface-3)', border: '1px solid var(--line-strong)',
              display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, color: 'var(--ink-2)',
            }}>
              {(admin?.email || '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
              <span className="truncate" style={{ fontSize: 12 }}>{admin?.email}</span>
              <span className="faint" style={{ fontSize: 11 }}>{admin?.roleLabel}</span>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={signOut} title="Sign out">↩</button>
          </div>
        </div>
      </aside>

      <main className="grow" style={{ overflowY: 'auto', minWidth: 0 }}>{children}</main>
    </div>
  );
}

// A consistent page header. `live` marks screens that poll, with the time of
// the last successful update — on a board that refreshes itself, an operator
// needs to know whether they are looking at now or at a frozen screen.
export function PageHeader({ title, subtitle, actions, live, updatedAt, refreshing }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'flex-end', gap: 16,
      padding: '22px 24px 18px',
    }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 21, letterSpacing: '-0.02em' }}>{title}</h1>
        {subtitle && <p className="muted" style={{ fontSize: 13, marginTop: 3 }}>{subtitle}</p>}
      </div>
      {live && (
        <div className="row faint" style={{ fontSize: 11.5, gap: 6, flex: 'none' }}>
          <span className={`sev-${refreshing ? 'warn' : 'active'}`} style={{ display: 'inline-flex' }}>
            <span className="dot" />
          </span>
          {refreshing ? 'Updating…' : updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Live'}
        </div>
      )}
      {actions}
    </header>
  );
}
