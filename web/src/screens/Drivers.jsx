import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { PageHeader } from '../components/Shell';
import { Panel, Pill, Empty, Loading, ErrorNote, Chips } from '../components/ui';
import { relative, initials } from '../lib/format';

// Ordered by urgency, not alphabetically. The queue is the product: an
// operator opening this screen should land on the drivers who need a decision.
const STANDINGS = [
  { value: '',                   label: 'Everyone' },
  { value: 'unvetted_driving',   label: 'Driving unvetted',  level: 'critical' },
  { value: 'screening_consider', label: 'Screening flagged', level: 'critical' },
  { value: 'awaiting_review',    label: 'Awaiting review',   level: 'warn' },
  { value: 'awaiting_documents', label: 'Awaiting documents',level: 'warn' },
  { value: 'screening_pending',  label: 'Screening running', level: 'warn' },
  { value: 'provisional',        label: 'Provisional',       level: 'warn' },
  { value: 'cleared',            label: 'Cleared',           level: 'active' },
  { value: 'suspended',          label: 'Suspended' },
  { value: 'rejected',           label: 'Rejected' },
];

export function Drivers({ initialFilters = {}, onOpenDriver }) {
  const [standing, setStanding] = useState(initialFilters.standing || '');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setTerm(q), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const { data, loading, error, refresh } = useApi(
    () => api.drivers({ standing, q: term }),
    { deps: [standing, term] }
  );

  const drivers = data?.drivers || [];
  const counts = data?.counts || {};

  const options = STANDINGS.map((s) => ({
    ...s,
    count: s.value === '' ? data?.total : counts[s.value],
  })).filter((s) => s.value === '' || (s.count ?? 0) > 0 || s.value === standing);

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle="Who is allowed to carry passengers, and who has actually been checked."
        actions={<button className="btn btn-sm" onClick={refresh}>Refresh</button>}
      />

      <div style={{ padding: '0 24px 32px' }}>
        {/* The standing explanation. This console exists partly because
            "active" in the database does not mean "vetted", and an operator
            has to understand that distinction to use this screen correctly. */}
        {counts.unvetted_driving > 0 && (
          <div className="sev-critical" style={{
            display: 'flex', gap: 11, alignItems: 'flex-start',
            padding: '12px 14px', marginBottom: 16, borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          }}>
            <span className="dot pulse" style={{ marginTop: 6 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--sev)' }}>
                {counts.unvetted_driving} driver{counts.unvetted_driving > 1 ? 's are' : ' is'} carrying passengers without review.
              </strong>
              <div className="muted" style={{ marginTop: 3 }}>
                Driver signup activates accounts automatically, and uploading three photos is
                all the API requires to see ride requests. Approving someone here records a
                real decision against their account.
              </div>
            </div>
          </div>
        )}

        <div className="row-between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <Chips options={options} value={standing} onChange={setStanding} />
          <input className="field" style={{ maxWidth: 260 }} placeholder="Name, phone, plate…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {error && <ErrorNote error={error} onRetry={refresh} stale={drivers.length > 0} />}

        <Panel pad={false}>
          {loading && !data ? <Loading rows={6} /> : drivers.length === 0 ? (
            <Empty title="No drivers match" note="Try a different standing, or clear the search." />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }} />
                    <th>Driver</th>
                    <th>Standing</th>
                    <th>Checks</th>
                    <th>Vehicle</th>
                    <th className="r">Rides</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.map((d) => (
                    <tr key={d.id} className={`sev-${d.standing.risk}`} data-clickable onClick={() => onOpenDriver(d.id)}>
                      <td>
                        <div style={{
                          width: 30, height: 30, borderRadius: '50%',
                          background: 'var(--surface-3)', border: '1px solid var(--line-strong)',
                          display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600, color: 'var(--ink-2)',
                          backgroundImage: d.photo_url ? `url(${d.photo_url})` : undefined,
                          backgroundSize: 'cover', backgroundPosition: 'center',
                        }}>
                          {!d.photo_url && initials(d.name)}
                        </div>
                      </td>

                      <td>
                        <div className="row" style={{ gap: 7 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{d.name}</span>
                          {d.is_online && <span className="sev-active" style={{ display: 'inline-flex' }}><span className="dot" /></span>}
                        </div>
                        <div className="faint mono" style={{ fontSize: 11.5 }}>{d.phone}</div>
                      </td>

                      <td><Pill level={d.standing.risk}>{d.standing.label}</Pill></td>

                      {/* The four trust factors as four marks. Far faster to
                          scan than four words, and it shows exactly which one
                          is missing. */}
                      <td>
                        <div className="row" style={{ gap: 5 }}>
                          <Check on={d.trust.accountActive} title="Account active" glyph="A" />
                          <Check on={d.trust.documentsComplete} title="Documents uploaded" glyph="D" />
                          <Check on={d.trust.screeningClear} title="Background check clear" glyph="S" />
                          <Check on={d.trust.humanApproved} title="Approved by a person" glyph="R" />
                        </div>
                      </td>

                      <td className="faint truncate" style={{ fontSize: 12.5, maxWidth: 170 }}>
                        {d.vehicle || '—'}
                        {d.vehicle_plate && <div style={{ fontSize: 11.5 }}>{d.vehicle_plate}</div>}
                      </td>

                      <td className="r num" style={{ fontSize: 13 }}>
                        {d.rides_completed}
                        {d.rating != null && <div className="faint" style={{ fontSize: 11.5 }}>{Number(d.rating).toFixed(2)}★</div>}
                      </td>

                      <td className="faint" style={{ fontSize: 12 }}>
                        {d.last_sign_in_at ? relative(d.last_sign_in_at) : 'never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="row wrap faint" style={{ gap: 14, marginTop: 12, fontSize: 11.5 }}>
          <span><strong>A</strong> account active</span>
          <span><strong>D</strong> documents uploaded</span>
          <span><strong>S</strong> screening clear</span>
          <span><strong>R</strong> reviewed by a person</span>
        </div>
      </div>
    </>
  );
}

function Check({ on, title, glyph }) {
  return (
    <span
      title={`${title}: ${on ? 'yes' : 'no'}`}
      className={on ? 'sev-active' : 'sev-neutral'}
      style={{
        width: 18, height: 18, borderRadius: 5,
        display: 'grid', placeItems: 'center',
        fontSize: 10, fontWeight: 700,
        background: on ? 'var(--sev-wash)' : 'transparent',
        border: `1px solid ${on ? 'var(--sev-line)' : 'var(--line)'}`,
        color: on ? 'var(--sev)' : 'var(--ink-4)',
      }}
    >{glyph}</span>
  );
}
