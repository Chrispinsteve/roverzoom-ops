import { useEffect, useRef } from 'react';

// Shared primitives. Everything here is presentational — no data fetching, no
// permission logic — so each screen stays about its own operational job.

export function Severity({ level = 'neutral', pulse = false }) {
  return <span className={`sev-${level}`} style={{ display: 'inline-flex' }}>
    <span className={`dot${pulse && level === 'critical' ? ' pulse' : ''}`} />
  </span>;
}

export function Pill({ level = 'neutral', children, dot = true }) {
  return (
    <span className={`pill sev-${level}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Panel({ title, action, children, pad = true, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="panel-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {action}
        </header>
      )}
      <div className={pad ? 'panel-body' : ''}>{children}</div>
    </section>
  );
}

export function Empty({ title, note, action }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {note && <p className="empty-note">{note}</p>}
      {action}
    </div>
  );
}

export function Loading({ rows = 5, height = 44 }) {
  return (
    <div className="col" style={{ gap: 8, padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height, opacity: 1 - i * 0.13 }} />
      ))}
    </div>
  );
}

// An error that keeps the last good data visible above it, rather than
// replacing the screen. During an incident, stale data beats no data — as
// long as it is labelled.
export function ErrorNote({ error, onRetry, stale = false }) {
  if (!error) return null;
  return (
    <div className="sev-critical" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 14px', margin: stale ? '0 0 12px' : 0,
      background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
      borderRadius: 'var(--r-xs)', fontSize: 13,
    }}>
      <span className="dot" />
      <span className="grow">
        {error.message}
        {stale && <span className="faint"> · showing the last data that loaded</span>}
      </span>
      {onRetry && <button className="btn btn-sm btn-ghost" onClick={onRetry}>Retry</button>}
    </div>
  );
}

// A metric with its label ABOVE the number. Operators scan a row of figures
// for the one that changed; the number is what should catch the eye, so it
// gets the visual weight and the label gets none.
export function Metric({ label, value, sub, level, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={level ? `sev-${level}` : ''}
      style={{
        display: 'block', textAlign: 'left', width: '100%',
        padding: '13px 15px',
        background: 'var(--surface)',
        border: `1px solid ${level && level !== 'neutral' ? 'var(--sev-line)' : 'var(--line)'}`,
        borderRadius: 'var(--r-sm)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>
      <div className="num" style={{
        fontSize: 25, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
        color: level && level !== 'neutral' ? 'var(--sev)' : 'var(--ink)',
      }}>{value}</div>
      {sub && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </Tag>
  );
}

// A right-hand sheet for detail and for anything destructive. Modal by intent:
// approving a driver or cancelling a ride deserves a moment of full attention,
// not an inline control that can be hit by accident.
export function Sheet({ open, onClose, title, subtitle, children, footer, width = 560 }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Move focus into the sheet so the keyboard follows the eye.
    const timer = setTimeout(() => ref.current?.focus(), 40);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', justifyContent: 'flex-end',
        animation: 'fade 140ms var(--ease)',
      }}
    >
      <style>{`
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slide { from { transform: translateX(18px); opacity: 0 } to { transform: none; opacity: 1 } }
      `}</style>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Details'}
        style={{
          width: `min(${width}px, 100%)`, height: '100%',
          background: 'var(--overlay)',
          borderLeft: '1px solid var(--line)',
          boxShadow: 'var(--shadow-pop)',
          display: 'flex', flexDirection: 'column',
          animation: 'slide 200ms var(--ease)',
          outline: 'none',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '16px 18px', borderBottom: '1px solid var(--line)', flex: 'none',
        }}>
          <div className="grow">
            {typeof title === 'string' ? <h2 style={{ fontSize: 15 }}>{title}</h2> : title}
            {subtitle && <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">Esc</button>
        </header>

        <div className="grow" style={{ overflowY: 'auto', padding: 18 }}>{children}</div>

        {footer && (
          <footer style={{
            display: 'flex', gap: 8, justifyContent: 'flex-end',
            padding: '14px 18px', borderTop: '1px solid var(--line)',
            background: 'var(--surface)', flex: 'none',
          }}>{footer}</footer>
        )}
      </div>
    </div>
  );
}

// A labelled value. The workhorse of every detail view.
export function Detail({ label, children, mono = false }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '112px 1fr', gap: 12, padding: '7px 0', alignItems: 'baseline' }}>
      <div className="eyebrow" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{label}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 13, minWidth: 0 }}>{children ?? '—'}</div>
    </div>
  );
}

// Filter chips with counts. Counts are the point: an operator decides which
// queue to open based on how much is in it.
export function Chips({ options, value, onChange }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value ?? 'all'}
            onClick={() => onChange(opt.value)}
            className={opt.level ? `sev-${opt.level}` : ''}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              height: 28, padding: '0 11px', borderRadius: 999,
              fontSize: 12.5, fontWeight: 500,
              border: `1px solid ${active ? 'var(--ink-4)' : 'var(--line)'}`,
              background: active ? 'var(--surface-3)' : 'transparent',
              color: active ? 'var(--ink)' : 'var(--ink-3)',
              transition: 'all 140ms var(--ease)',
            }}
          >
            {opt.level && opt.level !== 'neutral' && <span className="dot" />}
            {opt.label}
            {opt.count != null && (
              <span className="num" style={{ color: active ? 'var(--ink-2)' : 'var(--ink-4)' }}>{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Shown wherever a role cannot see something, instead of silently omitting it.
// An operator who cannot see a number should know it exists and that their
// role is why — silence reads as "there is no data", which is misleading.
export function Restricted({ what = 'this' }) {
  return (
    <span className="faint" style={{ fontSize: 12.5, fontStyle: 'italic' }}>
      Your role cannot view {what}
    </span>
  );
}
