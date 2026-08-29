import { supabase } from './supabase';

const BASE = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body || {};
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  // Read the token per request rather than caching it: supabase-js refreshes
  // in the background, and a console left open overnight must not start
  // sending yesterday's token to every endpoint.
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;

  let res;
  try {
    res = await fetch(`${BASE}/api/admin${path}`, {
      method,
      signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // A network failure is not an auth failure. Saying "signed out" here would
    // send an operator to re-login during what is really an API outage.
    throw new ApiError('Cannot reach the ops API. Check your connection.', { code: 'network' });
  }

  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }

  if (!res.ok) {
    throw new ApiError(payload.error || `Request failed (${res.status})`, {
      status: res.status,
      code: payload.code,
      body: payload,
    });
  }
  return payload;
}

export const api = {
  me: () => request('/me'),
  overview: () => request('/overview'),

  rides: (params = {}) => request(`/rides?${new URLSearchParams(clean(params))}`),
  ride: (id) => request(`/rides/${encodeURIComponent(id)}`),
  cancelRide: (id, body) => request(`/rides/${id}/cancel`, { method: 'POST', body }),

  dispatchBoard: () => request('/dispatch/board'),
  candidates: (bookingId) => request(`/dispatch/${bookingId}/candidates`),
  assign: (bookingId, body) => request(`/dispatch/${bookingId}/assign`, { method: 'POST', body }),
  release: (bookingId, body) => request(`/dispatch/${bookingId}/release`, { method: 'POST', body }),

  drivers: (params = {}) => request(`/drivers?${new URLSearchParams(clean(params))}`),
  driver: (id) => request(`/drivers/${id}`),
  driverDocuments: (id) => request(`/drivers/${id}/documents`),
  reviewDriver: (id, body) => request(`/drivers/${id}/review`, { method: 'POST', body }),
  setDriverStatus: (id, body) => request(`/drivers/${id}/status`, { method: 'POST', body }),
  setProvisional: (id, body) => request(`/drivers/${id}/provisional`, { method: 'POST', body }),
  liveMap: () => request('/map/live'),

  financeSummary: (params = {}) => request(`/finance/summary?${new URLSearchParams(clean(params))}`),
  balances: () => request('/finance/balances'),
  reconciliation: (params = {}) => request(`/finance/reconciliation?${new URLSearchParams(clean(params))}`),
  payouts: () => request('/finance/payouts'),
  markPayoutPaid: (id, body) => request(`/finance/payouts/${id}/paid`, { method: 'POST', body }),

  traffic: (params = {}) => request(`/analytics/traffic?${new URLSearchParams(clean(params))}`),
  funnel: (params = {}) => request(`/analytics/funnel?${new URLSearchParams(clean(params))}`),

  audit: (params = {}) => request(`/audit?${new URLSearchParams(clean(params))}`),
};

function clean(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
}
