import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { PageHeader } from '../components/Shell';
import { Panel, Empty, Loading, ErrorNote } from '../components/ui';
import { dayAndClock, relative } from '../lib/format';

// Every state-changing action, in order. Read during an incident review, so
// the summary sentence comes first and the machine detail is secondary.
export function Audit() {
  const { data, loading, error, refresh } = useApi(() => api.audit({ limit: 200 }));

  return (
    <>
      <PageHeader
        title="Audit"
        subtitle="Every action taken in this console, and who took it."
        actions={<button className="btn btn-sm" onClick={refresh}>Refresh</button>}
      />

      <div style={{ padding: '0 24px 32px' }}>
        {error && <ErrorNote error={error} onRetry={refresh} />}

        {data && !data.available && (
          <div className="sev-warn" style={{
            display: 'flex', gap: 11, alignItems: 'flex-start',
            padding: '12px 14px', marginBottom: 16, borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          }}>
            <span className="dot" style={{ marginTop: 6 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--sev)' }}>The durable audit trail is not installed.</strong>
              <div className="muted" style={{ marginTop: 3 }}>
                Actions are still being recorded, but only to the server log, where they cannot be
                searched later. Run <span className="mono">db/001_admin_audit_log.sql</span> against your
                Supabase project to turn this on.
              </div>
            </div>
          </div>
        )}

        <Panel pad={false}>
          {loading && !data ? <Loading rows={8} height={40} /> : !data?.entries?.length ? (
            <Empty
              title={data?.available ? 'Nothing recorded yet' : 'No entries to show'}
              note={data?.available
                ? 'Actions appear here as soon as anyone cancels a ride, assigns a driver, or makes a vetting decision.'
                : 'Install the audit table to start keeping a searchable record.'}
            />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th><th>Who</th><th>What</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="faint num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        <div>{dayAndClock(e.created_at)}</div>
                        <div style={{ fontSize: 11 }}>{relative(e.created_at)}</div>
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        <div className="truncate" style={{ maxWidth: 190 }}>{e.actor_email}</div>
                        <div className="faint" style={{ fontSize: 11 }}>{e.actor_role}</div>
                      </td>
                      <td style={{ fontSize: 13, maxWidth: 380 }}>
                        <div>{e.summary}</div>
                        {e.detail?.reason && (
                          <div className="faint truncate" style={{ fontSize: 11.5 }}>{e.detail.reason}</div>
                        )}
                      </td>
                      <td className="mono faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{e.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
