import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Sheet, Detail, Pill, Loading, ErrorNote, Restricted } from '../components/ui';
import { money, dayAndClock, relative, day } from '../lib/format';

// The dossier a vetting decision is actually made from. Everything a reviewer
// needs is on one surface: who they are, what they uploaded, what the
// background check said, what they have driven, and what they are owed.
export function DriverDetail({ driverId, onClose, onChanged }) {
  const { data, loading, error, reload } = useApi(() => api.driver(driverId), { deps: [driverId] });
  const [dialog, setDialog] = useState(null); // 'review' | 'suspend' | 'reinstate'

  const d = data?.driver;

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        width={640}
        title={loading ? 'Loading…' : (
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{d?.name}</span>
            {d && <Pill level={d.standing.risk}>{d.standing.label}</Pill>}
          </div>
        )}
        subtitle={d ? `${d.phone}${d.email ? ` · ${d.email}` : ''}` : undefined}
        footer={d && data.actions && (
          <>
            {data.actions.canSuspend && (
              d.status === 'suspended'
                ? <button className="btn" onClick={() => setDialog('reinstate')}>Reinstate</button>
                : <button className="btn btn-danger" onClick={() => setDialog('suspend')}>Suspend</button>
            )}
            {data.actions.canGrantProvisional && !d.trust.screeningClear && d.status !== 'suspended' && (
              <button className="btn" onClick={() => setDialog('provisional')}>
                {d.trust.provisionallyAuthorized ? 'Change authorization' : 'Authorize to drive'}
              </button>
            )}
            {data.actions.canReview && (
              <button className="btn btn-primary" onClick={() => setDialog('review')}>
                {d.trust.humanApproved ? 'Change decision' : 'Review'}
              </button>
            )}
            <button className="btn" onClick={onClose}>Close</button>
          </>
        )}
      >
        {loading && <Loading rows={5} />}
        {error && <ErrorNote error={error} onRetry={reload} />}

        {d && (
          <>
            {/* The four gates, spelled out. This is the heart of the screen:
                it answers "why is this person's standing what it is?" without
                the reviewer having to infer it. */}
            <Section title="Clearance">
              <div className="col" style={{ gap: 7 }}>
                <Gate on={d.trust.accountActive} label="Account is active"
                  detail={`drivers.status = ${d.status}`} />
                <Gate on={d.trust.documentsComplete} label="Documents uploaded"
                  detail={d.profile_completed_at ? `completed ${relative(d.profile_completed_at)}` : 'photo, licence and insurance required'} />
                <Gate on={d.trust.screeningClear} label="Background check clear"
                  detail={`Checkr: ${d.trust.screening.status.replace('_', ' ')}`} />
                <Gate on={d.trust.humanApproved} label="Approved by a person"
                  detail={d.trust.review.at
                    ? `${d.trust.review.state} by ${d.trust.review.by} · ${relative(d.trust.review.at)}`
                    : 'nobody has reviewed this driver'} />
              </div>

              {d.trust.provisional?.granted && (
                <div className={`sev-${d.trust.provisional.active ? 'warn' : 'critical'}`} style={{
                  marginTop: 11, padding: '10px 12px', borderRadius: 'var(--r-xs)',
                  background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
                  fontSize: 12.5, lineHeight: 1.5,
                }}>
                  <div style={{ fontWeight: 600, color: 'var(--sev)', marginBottom: 3 }}>
                    {d.trust.provisional.active
                      ? `Authorized to drive pending screening — ${d.trust.provisional.daysLeft} day${d.trust.provisional.daysLeft === 1 ? '' : 's'} left`
                      : 'Provisional authorization EXPIRED'}
                  </div>
                  <div className="muted">
                    {d.trust.provisional.active
                      ? <>Granted by {d.trust.provisional.by}, expires {day(d.trust.provisional.until)}.</>
                      : <>Lapsed {day(d.trust.provisional.until)}. They are driving with no valid authorization and no completed check.</>}
                  </div>
                  {d.trust.provisional.reason && (
                    <div className="faint" style={{ marginTop: 4 }}>&ldquo;{d.trust.provisional.reason}&rdquo;</div>
                  )}
                </div>
              )}

              {d.trust.review.note && (
                <div style={{
                  marginTop: 12, padding: '10px 12px',
                  background: 'var(--surface-2)', border: '1px solid var(--line)',
                  borderRadius: 'var(--r-xs)', fontSize: 12.5, lineHeight: 1.5,
                }}>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Review note</div>
                  {d.trust.review.note}
                </div>
              )}
            </Section>

            <Section title="Identity documents">
              <Documents driverId={d.id} summary={data.documents} />
            </Section>

            <Section title="Details">
              <Detail label="Vehicle">{d.vehicle || '—'}</Detail>
              <Detail label="Plate" mono>{d.vehicle_plate}</Detail>
              <Detail label="Rating">{d.rating != null ? `${Number(d.rating).toFixed(2)} ★` : '—'}</Detail>
              <Detail label="Rides">{d.rides_completed}</Detail>
              <Detail label="Joined">{dayAndClock(d.created_at)}</Detail>
              <Detail label="Last sign in">{d.last_sign_in_at ? relative(d.last_sign_in_at) : 'never'}</Detail>
              <Detail label="Location">
                {d.locationFreshness.state === 'never'
                  ? <span className="faint">never reported</span>
                  : `${d.locationFreshness.state} · ${relative(d.location_updated_at)}`}
              </Detail>
              {!d.auth_present && (
                <Detail label="Account">
                  <span style={{ color: 'var(--state-warn)' }}>
                    No linked sign-in account — a review cannot be recorded against this driver.
                  </span>
                </Detail>
              )}
            </Section>

            {data.earnings ? (
              <Section title="Earnings">
                <Detail label="Lifetime">{money(data.earnings.lifetime)}</Detail>
                <Detail label="Cash collected">{money(data.earnings.cashCollected)}</Detail>
                <Detail label="Paid out">{money(data.earnings.paidOut)}</Detail>
                <Detail label={data.earnings.payable < 0 ? 'Owes platform' : 'Payable now'}>
                  <span style={{ color: data.earnings.payable < 0 ? 'var(--state-warn)' : 'var(--ink)', fontWeight: 600 }}>
                    {money(Math.abs(data.earnings.payable))}
                  </span>
                  {data.earnings.payable < 0 && (
                    <span className="faint"> · cash commission exceeds unpaid card earnings</span>
                  )}
                </Detail>
              </Section>
            ) : (
              <Section title="Earnings"><Restricted what="driver earnings" /></Section>
            )}

            <Section title={`Recent rides · ${data.activity.rides.length}`}>
              {data.activity.rides.length === 0 ? (
                <div className="faint" style={{ fontSize: 13 }}>No rides yet.</div>
              ) : (
                <div className="col" style={{ gap: 4 }}>
                  {data.activity.rides.slice(0, 12).map((r) => (
                    <div key={r.id} className="row" style={{ gap: 10, fontSize: 12.5, padding: '3px 0' }}>
                      <span className="ref" style={{ width: 74, flex: 'none' }}>{r.reference}</span>
                      <span className="grow truncate faint">{r.statusLabel}</span>
                      <span className="faint num" style={{ flex: 'none' }}>{dayAndClock(r.scheduled_at)}</span>
                      <span className="num" style={{ width: 62, textAlign: 'right', flex: 'none' }}>{money(r.fare)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </Sheet>

      {dialog === 'provisional' && d && (
        <ProvisionalDialog
          driver={d}
          limits={data.provisionalLimits}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); reload(); onChanged?.(); }}
        />
      )}
      {dialog && dialog !== 'provisional' && d && (
        <DecisionDialog
          kind={dialog}
          driver={d}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); reload(); onChanged?.(); }}
        />
      )}
    </>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 9, paddingBottom: 7, borderBottom: '1px solid var(--line)' }}>{title}</div>
      {children}
    </section>
  );
}

function Gate({ on, label, detail }) {
  return (
    <div className={`row ${on ? 'sev-active' : 'sev-warn'}`} style={{ gap: 10, alignItems: 'flex-start' }}>
      <span style={{
        width: 17, height: 17, borderRadius: '50%', flex: 'none', marginTop: 1,
        display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 700,
        background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', color: 'var(--sev)',
      }}>{on ? '✓' : '!'}</span>
      <span className="col" style={{ gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        <span className="faint" style={{ fontSize: 11.5 }}>{detail}</span>
      </span>
    </div>
  );
}

// Identity documents.
//
// The licence and insurance columns hold raw paths into a PRIVATE storage
// bucket, so they cannot be rendered directly — the API mints short-lived
// signed URLs, and only for roles that may see them. Fetched on demand rather
// than with the dossier, because every fetch is recorded in the audit trail as
// a disclosure.
function Documents({ driverId, summary }) {
  // Auto-loads for reviewers: looking at these IS the job, and one audit entry
  // per dossier opened is exactly the record worth keeping. `enabled` keeps a
  // role without the permission from even attempting the call.
  const { data: links, loading, error, reload, updatedAt: loadedAt } = useApi(
    () => api.driverDocuments(driverId),
    { deps: [driverId], enabled: summary.viewable }
  );
  const load = reload;

  const items = links?.documents || summary.items || [];

  return (
    <>
      {!summary.completedAt && (
        <div className="sev-warn" style={{
          padding: '9px 12px', marginBottom: 12, borderRadius: 'var(--r-xs)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', fontSize: 12.5,
        }}>
          Upload is incomplete, so this driver cannot see ride requests yet.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9 }}>
        {items.map((doc) => (
          <DocumentTile key={doc.type} doc={doc} viewable={summary.viewable} loading={loading} />
        ))}
      </div>

      {error && <div style={{ marginTop: 10 }}><ErrorNote error={error} onRetry={load} /></div>}

      {links?.anyUnreachable && (
        <div className="sev-warn" style={{
          padding: '9px 12px', marginTop: 10, borderRadius: 'var(--r-xs)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          fontSize: 12.5, lineHeight: 1.5,
        }}>
          A document is recorded against this driver but could not be retrieved from storage.
          The upload may have failed part-way. Ask them to re-upload before approving.
        </div>
      )}

      {summary.viewable ? (
        <div className="row-between" style={{ marginTop: 10 }}>
          <span className="faint" style={{ fontSize: 11.5 }}>
            {loadedAt
              ? `Links expire ${Math.round((links?.ttlSeconds ?? 300) / 60)} min after loading. Opening a document is recorded.`
              : 'Loading secure links…'}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh links'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <Restricted what="identity documents" />
        </div>
      )}
    </>
  );
}

function DocumentTile({ doc, viewable, loading }) {
  const frame = {
    aspectRatio: '4/3',
    borderRadius: 'var(--r-xs)',
    display: 'grid', placeItems: 'center',
    fontSize: 11.5, textAlign: 'center', padding: 6,
  };

  if (!doc.present) {
    return (
      <div style={{ ...frame, border: '1px dashed var(--line-strong)', color: 'var(--ink-4)' }}>
        {doc.label}
        <br />not uploaded
      </div>
    );
  }

  if (doc.kind === 'unreachable') {
    return (
      <div className="sev-warn" style={{
        ...frame, border: '1px solid var(--sev-line)',
        background: 'var(--sev-wash)', color: 'var(--sev)',
      }}>
        {doc.label}
        <br />unreachable
      </div>
    );
  }

  // Recorded as present, but this role may not see it, or the link has not
  // arrived yet.
  if (!viewable || !doc.url) {
    return (
      <div style={{ ...frame, border: '1px solid var(--line)', background: 'var(--surface-2)', color: 'var(--ink-4)' }}>
        {loading ? '…' : <>{doc.label}<br />uploaded</>}
      </div>
    );
  }

  return (
    <a href={doc.url} target="_blank" rel="noopener noreferrer"
      title={`Open ${doc.label} full size`}
      style={{ display: 'block', borderRadius: 'var(--r-xs)', overflow: 'hidden', border: '1px solid var(--line)' }}>
      <div style={{
        aspectRatio: '4/3',
        backgroundImage: `url(${doc.url})`,
        backgroundSize: 'cover', backgroundPosition: 'center',
        backgroundColor: 'var(--surface-2)',
      }} />
      <div className="faint row-between" style={{ fontSize: 11, padding: '5px 7px', background: 'var(--surface-2)' }}>
        <span className="truncate">{doc.label}</span>
        <span>↗</span>
      </div>
    </a>
  );
}

// Approving or rejecting someone changes whether they can earn a living. The
// dialog states the consequence in plain language before it asks.
function DecisionDialog({ kind, driver, onClose, onDone }) {
  const [decision, setDecision] = useState('approved');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isReview = kind === 'review';
  const isSuspend = kind === 'suspend';
  const needsNote = (isReview && decision === 'rejected') || !isReview;

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (isReview) await api.reviewDriver(driver.id, { decision, note });
      else await api.setDriverStatus(driver.id, { status: isSuspend ? 'suspended' : 'active', reason: note });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const title = isReview ? `Review ${driver.name}` : isSuspend ? `Suspend ${driver.name}` : `Reinstate ${driver.name}`;

  return (
    <Sheet
      open onClose={onClose} width={470} title={title}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${(isReview && decision === 'approved') || kind === 'reinstate' ? 'btn-primary' : 'btn-danger'}`}
            disabled={busy || (needsNote && !note.trim())}
            onClick={submit}
          >
            {busy ? 'Saving…' : isReview ? (decision === 'approved' ? 'Approve driver' : 'Reject driver') : isSuspend ? 'Suspend' : 'Reinstate'}
          </button>
        </>
      }
    >
      {error && <div style={{ marginBottom: 14 }}><ErrorNote error={error} /></div>}
      {error?.body?.rides?.length > 0 && (
        <div className="sev-warn" style={{
          padding: '10px 12px', marginBottom: 14, borderRadius: 'var(--r-xs)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', fontSize: 12.5,
        }}>
          Live rides that must be resolved first:{' '}
          {error.body.rides.map((r) => r.reference).join(', ')}
        </div>
      )}

      {isReview && (
        <div style={{ marginBottom: 16 }}>
          <label className="label">Decision</label>
          <div className="col" style={{ gap: 7 }}>
            <Choice
              checked={decision === 'approved'} onChange={() => setDecision('approved')}
              title="Approve" note="Records that a person checked this driver. Activates them if they were pending."
            />
            <Choice
              checked={decision === 'rejected'} onChange={() => setDecision('rejected')}
              title="Reject" note="Records the rejection AND suspends the account, so they stop receiving rides immediately."
              danger
            />
          </div>
        </div>
      )}

      {!isReview && (
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.55 }}>
          {isSuspend
            ? 'They are taken offline immediately and can no longer accept rides. Their earnings history is untouched.'
            : 'They can accept rides again, subject to their documents and screening.'}
        </p>
      )}

      <label className="label">
        {isReview ? (decision === 'rejected' ? 'Reason (required)' : 'Note (optional)') : 'Reason (required)'}
      </label>
      <textarea
        className="field" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={decision === 'rejected' || !isReview
          ? 'Insurance certificate expired in June; asked them to re-upload.'
          : 'Licence and insurance both verified against the DMV record.'}
        autoFocus
      />
      <div className="faint" style={{ fontSize: 11.5, marginTop: 7 }}>
        Recorded in the audit trail with your name.
      </div>
    </Sheet>
  );
}

// Granting time to drive before a check completes. The dialog's job is to
// make the trade explicit — what is missing, for how long — rather than to
// present it as an approval.
function ProvisionalDialog({ driver, limits, onClose, onDone }) {
  const [days, setDays] = useState(String(limits?.defaultDays ?? 30));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('grant');

  const max = limits?.maxDays ?? 90;
  const n = Number(days);
  const validDays = Number.isFinite(n) && n >= 1 && n <= max;

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.setProvisional(driver.id, mode === 'revoke'
        ? { revoke: true, reason }
        : { days: n, reason });
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const has = driver.trust.provisional?.granted;

  return (
    <Sheet
      open onClose={onClose} width={470}
      title={has ? `Change authorization for ${driver.name}` : `Authorize ${driver.name} to drive`}
      subtitle="While the background check is outstanding"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${mode === 'revoke' ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || !reason.trim() || (mode === 'grant' && !validDays)}
            onClick={submit}
          >
            {busy ? 'Saving…' : mode === 'revoke' ? 'Revoke' : has ? 'Update' : `Authorize for ${validDays ? n : '…'} days`}
          </button>
        </>
      }
    >
      {error && <div style={{ marginBottom: 14 }}><ErrorNote error={error} /></div>}

      <div className="sev-warn" style={{
        padding: '11px 13px', marginBottom: 16, borderRadius: 'var(--r-sm)',
        background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
        fontSize: 12.5, lineHeight: 1.55,
      }}>
        <strong style={{ color: 'var(--sev)' }}>What this does and does not do.</strong>
        <div className="muted" style={{ marginTop: 4 }}>
          Screening for {driver.name} is{' '}
          <strong>{(driver.trust.screening.status || 'not started').replace('_', ' ')}</strong>.
          This records that you know that and accept it for a fixed period. It does not
          mark them screened, and they will keep showing as a warning until the check
          actually clears. When the window lapses they return to <em>Driving unvetted</em>{' '}
          automatically.
        </div>
      </div>

      {has && (
        <div className="row" style={{ gap: 6, marginBottom: 16 }}>
          <button className={`btn btn-sm ${mode === 'grant' ? 'btn-primary' : ''}`} onClick={() => setMode('grant')}>Extend</button>
          <button className={`btn btn-sm ${mode === 'revoke' ? 'btn-danger' : ''}`} onClick={() => setMode('revoke')}>Revoke</button>
        </div>
      )}

      {mode === 'grant' && (
        <div style={{ marginBottom: 14 }}>
          <label className="label" htmlFor="prov-days">Valid for (days, max {max})</label>
          <input id="prov-days" className="field" type="number" min="1" max={max}
            value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 130 }} />
          {validDays && (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              {/* A preview only — the SERVER stamps the authoritative expiry from
                  its own clock when the grant is written. Recomputing this per
                  render is intentional and any drift is cosmetic. */}
              {/* eslint-disable-next-line react-hooks/purity */}
              Expires {new Date(Date.now() + n * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.
            </div>
          )}
        </div>
      )}

      <label className="label">Reason (required)</label>
      <textarea className="field" value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={mode === 'revoke'
          ? 'Screening came back; no longer needed.'
          : 'Licence and insurance verified in person. Checkr not yet enabled; re-check before this lapses.'}
        autoFocus />
      <div className="faint" style={{ fontSize: 11.5, marginTop: 7 }}>
        Recorded in the audit trail with your name.
      </div>
    </Sheet>
  );
}

function Choice({ checked, onChange, title, note, danger }) {
  return (
    <button
      onClick={onChange}
      className={checked && danger ? 'sev-critical' : ''}
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left',
        padding: '11px 13px', borderRadius: 'var(--r-sm)',
        border: `1px solid ${checked ? (danger ? 'var(--sev-line)' : 'var(--ink-4)') : 'var(--line)'}`,
        background: checked ? (danger ? 'var(--sev-wash)' : 'var(--surface-3)') : 'var(--surface)',
        transition: 'all 130ms var(--ease)',
      }}
    >
      <span style={{
        width: 15, height: 15, borderRadius: '50%', flex: 'none', marginTop: 2,
        border: `1.5px solid ${checked ? (danger ? 'var(--sev)' : 'var(--ink)') : 'var(--line-strong)'}`,
        display: 'grid', placeItems: 'center',
      }}>
        {checked && <span style={{ width: 7, height: 7, borderRadius: '50%', background: danger ? 'var(--sev)' : 'var(--ink)' }} />}
      </span>
      <span className="col" style={{ gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>{note}</span>
      </span>
    </button>
  );
}
