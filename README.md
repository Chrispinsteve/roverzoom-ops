# RoverZoom Ops

The operations command center for RoverZoom — the admin surface that sits on
top of the existing rider, driver, dispatch and payments system.

It is a **standalone service**: its own API, its own console, its own domain.
It reads and writes the same Supabase project the rider and driver apps use,
and the rider/driver codebase is not modified.

---

## Why this exists

Two things in the live system are explicitly waiting on an admin console, in
the code's own words.

**1. Every driver signup is auto-approved.** `handle_new_driver()` in
`schema.sql` and `POST /api/driver/ensure-profile` both hardcode
`status: 'active'`, commented as a *"TEMPORARY stance — there's no admin
dashboard yet to approve anyone. Revisit once an admin dashboard exists."*
The only real gate on accepting rides is `requireCompleteProfile` — three
self-uploaded photos. Checkr screening exists, but nothing enforces a clear
result.

**2. `manual_dispatch_required` is a dead end.** It is a legal booking status
that no rider or driver surface can see or resolve. A ride that lands there is
invisible until someone phones in.

This console closes both, and gives operations a place to stand for
dispatch, rides, drivers, and money.

---

## The idea

**A command center's job is not to display numbers. It is to answer "what
needs me right now?" — and to be trusted when the answer is "nothing".**

Three rules follow from that, and they run through every screen:

- **Colour is reserved for state.** Every piece of chrome is neutral grey. The
  only saturated pixels in the console describe the condition of a ride, a
  driver, or the money. A red dot means something because nothing else is red.
- **One severity vocabulary.** `neutral · active · warn · critical`, used
  identically for rides, drivers and finance. A colour means exactly one thing
  everywhere.
- **Every alert is actionable and names its subject.** Never "3 rides are
  late" without saying which three and offering the action.

---

## Getting started

```bash
npm install

cp .env.example server/.env        # Supabase service-role key, bootstrap email
cp web/.env.example web/.env       # Supabase URL + anon key (public)

npm run dev                        # API on :4100, console on :5300
```

Then grant yourself access. The first owner can't be granted by an existing
admin, because there isn't one:

1. Create a Supabase Auth user for yourself (Supabase dashboard → Authentication).
2. Set `ADMIN_BOOTSTRAP_EMAIL` in `server/.env` to that email.
3. Sign in at http://localhost:5300 — you are an owner.
4. **Then assign yourself a real role and clear the variable.** It's a ladder,
   not a permanent door; the console shows a standing warning until you do.

Optional but recommended — a durable audit trail:

```bash
psql "$DATABASE_URL" -f db/001_admin_audit_log.sql
```

Without it the console still records every action, but only to the server log,
where it can't be searched later. The Audit screen says so plainly rather than
showing an empty table.

---

## Roles

Roles are defined by the job someone does, not by seniority. The role lives in
the admin's Supabase Auth `app_metadata` — server-controlled and not editable
by the user it describes — so **no DDL is required**.

| Role | Can | Deliberately cannot |
|---|---|---|
| **Owner** | Everything, including granting roles | — |
| **Dispatcher** | Run the board, assign, reassign, cancel, reach riders | Vet drivers, see identity documents, touch money |
| **Support** | Answer riders and drivers, cancel a ride | Dispatch, vet, see money |
| **Trust & Safety** | Vet drivers, **view identity documents**, act on screening, suspend | Dispatch or reassign rides |
| **Finance** | Fares, ledgers, balances, payouts | **See rider contact details** |
| **Viewer** | Read-only operations | Any mutation, any PII |

**Rider PII is its own permission.** A dispatcher needs a phone number to
resolve a live pickup; a finance analyst reconciling payouts does not.
Redaction happens at the API's serialization boundary, so a role without
`riders.pii` never receives the data — and rider fields aren't searchable for
those roles either, so search can't be used as a PII oracle.

**Identity documents are a permission above `drivers.read`.** A dispatcher
needs a driver's standing to place a ride; nobody needs a scan of their licence
to do that. Only Owner and Trust & Safety hold `drivers.documents`, and every
retrieval is written to the audit trail — "who looked at this person's licence,
and when" is a question worth being able to answer.

Everything **fails closed**: no token, no role, an unknown role, or an
unreachable auth service all deny. There is no shared key and no bypass.

---

## What's in it

**Overview** — the attention feed, ranked by urgency, each item naming its ride
or driver and its action. Then live counts, driver trust, and the day's money.

**Dispatch** — every ride with no driver, and ranked candidates to place them.
The ranking explains itself: distance, standing, and each driver's blockers and
warnings. Hard blockers (suspended, documents incomplete) can't be overridden.
Soft warnings (never reviewed, offline, stale location) can be — but only
deliberately, by acknowledging them, so an unvetted driver is never assigned by
reflex during a rush.

**Rides** — the searchable ledger, and a detail view with the real lifecycle
timeline, the dispatch offer history (the only way to answer "why did nobody
take it?"), and the full fare breakdown.

**Drivers** — the trust queue, ordered by urgency. Four independent gates shown
as four marks, so you see *which* one is missing: account active, documents
uploaded, screening clear, approved by a person. The dossier renders the
driver's actual photo, licence and insurance certificate so identity can be
validated on the spot — see below for how those are retrieved.

**Finance** — revenue, driver balances, payouts, and **reconciliation** that
catches the two silent failure modes in the live payout path: a completed ride
with no earnings row (a `complete_booking()` integrity failure), and card
earnings that were never transferred (the Stripe Connect call runs after
completion and its failures are swallowed by design, so money can sit unpaid
with no alarm anywhere).

**Audit** — every state-changing action, who took it, and why. Cancels,
releases, suspensions and rejections all require a typed reason.

---

## Driver identity documents

Validating identity needs the real uploads, and the rider/driver app stores the
three documents **two different ways**:

| Document | Bucket | Visibility | Column holds |
|---|---|---|---|
| Profile photo | `driver-photos` | **public** — riders load it once matched | a full public URL |
| Driver's licence | `driver-documents` | **private** | a raw storage path |
| Insurance certificate | `driver-documents` | **private** | a raw storage path |

That asymmetry is deliberate upstream, where the comment reads *"never rendered
as an image, just checked for presence"* — true while nothing needed to look at
them. Reviewing identity is precisely this console's job, so it has to render
them, and a raw path into a private bucket is useless to a browser.

`GET /api/admin/drivers/:id/documents` mints **short-lived signed URLs**
server-side (5 minutes, `DOCUMENT_URL_TTL`). Raw storage paths never reach the
browser. The endpoint requires `drivers.documents` and writes a
`driver.documents_viewed` audit entry **before** returning the URLs, so a crash
between the two can't produce an unrecorded disclosure.

A document that is recorded on the driver but missing from storage — a
half-failed upload — is surfaced as *unreachable* rather than rendering a
silently broken image, because that is itself a reason not to approve someone.

---

## Architecture

```
server/                Express API — the ONLY holder of the service-role key
  domain/              lifecycle · money · trust · attention · geo
  lib/                 roles · audit · redact · directory · supabase
  middleware/          requireAdmin, requirePermission
  routes/              session · overview · rides · dispatch · drivers · finance · audit
  test/                28 tests over money, trust, permissions, redaction, auth
web/                   React + Vite console
  src/design/          tokens.css · base.css  ← the whole design system
  src/screens/         one file per surface
db/                    001_admin_audit_log.sql (optional)
archive/               the original static prototype, kept for reference
```

The console's browser bundle **never talks to Supabase for data.** It holds an
admin Auth session and calls this API, which is the sole holder of the
service-role key.

### Keeping the money model honest

The console duplicates the fare and payout model, because it's a separate
service and can't import from the rider/driver backend. A mirror that drifts
would report confident, wrong numbers about what drivers are owed. Two
defences:

- Every constant reads the **same env var** as its upstream twin.
- `npm run verify:sync -- /path/to/roverzoom` diffs this repo's domain modules
  against the real sources and exits non-zero on a mismatch. **Run it in CI.**

See `server/domain/README.md` for the full contract.

---

## Commands

```bash
npm run dev          # API + console together
npm run dev:api      # API only, :4100
npm run dev:web      # console only, :5300
npm test             # domain + auth test suite
npm run build        # production console bundle
npm run verify:sync -- /path/to/roverzoom
```

---

## Deploying

`vercel.json` ships the console and the API as **one Vercel project**: the
static bundle from `web/dist`, and the Express app as a serverless function via
`api/index.mjs`, with `/api/*` rewritten to it.

They therefore share an origin, which is the simplest safe arrangement — leave
`VITE_API_URL` empty and CORS never enters the picture.

Set these in the Vercel project's environment variables:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | Same project as the rider/driver app |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Never expose to the browser |
| `ADMIN_BOOTSTRAP_EMAIL` | Set once to grant yourself owner, then clear it |
| `VITE_SUPABASE_URL` | Public; baked into the bundle at build time |
| `VITE_SUPABASE_ANON_KEY` | Public by design, constrained by RLS |
| `DRIVER_CUT_PCT`, `FARE_MULTIPLIER*`, `SERVICE_TZ` | Must match the rider/driver deployment |

If you instead split the API onto its own host, set `CORS_ORIGINS` to the
console's origin and `VITE_API_URL` to the API's. `CORS_ORIGINS` empty allows
all origins — fine locally, never in production; the server warns at boot.

---

## Known gaps

Honest list of what this does **not** do yet:

- **No live map.** Driver positions are served by `GET /drivers-map/live` and
  rendered as data, not on a map. Google Maps is already in the rider/driver
  stack; wiring `@react-google-maps/api` to that endpoint is the next step.
- **No realtime.** Screens poll (12–30s, paused when the tab is hidden). The
  driver app already uses Supabase Realtime; the console could subscribe to the
  same `bookings` changes instead.
- **Admin role management is not yet a UI.** Roles are set via `app_metadata`
  in the Supabase dashboard. The `admins.manage` permission exists and is
  enforced; the screen behind it isn't built.
- **Documents are shown, not verified.** The console renders the licence and
  insurance so a person can check them. There is no automated document OCR or
  authenticity check — the "approved by a person" gate means exactly that.
- **Cancelling doesn't refund.** It sets the booking state. Stripe refunds go
  through the payments service and aren't wired here.
- **`canceled_by` records `'system'` for admin cancellations**, because the
  live `bookings_canceled_by_check` constraint only permits
  `rider | driver | system`. Who actually did it is in the audit trail and the
  reason text. Adding `'admin'` needs DDL on the live table.
- **The auto-activation hole is surfaced, not closed at the source.** This
  console makes unvetted drivers impossible to ignore and gives you the tools
  to act. Actually gating signup means flipping `handle_new_driver()` back to
  `pending_verification` — a one-line schema change worth making now that there
  is somewhere to do the approving.
