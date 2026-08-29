# Rider-app integration

Two changes to the **rider/driver repo** (`roverzoom/`). Neither affects booking
behaviour; both are additive.

---

## 1. Fix the Google Ads conversion (one line, highest value)

`frontend/src/lib/gtag.js` currently has:

```js
const CONVERSION_LABEL = ''; // <-- paste the Purchases conversion label here
```

While that is empty, `reportBookingConversion()` returns early and **no
conversion is ever sent**. That is why every region in your Google Ads report
shows `0 conversions` even though bookings exist. Google cannot optimise
towards bookings, so Performance Max is buying clicks with no idea which ones
are worth anything.

To fix:

1. Google Ads → Goals → Conversions → the **Purchases** action.
2. Copy the conversion label (looks like `AbC-D_1efGhIjkLmN`).
3. Paste it into `CONVERSION_LABEL`, deploy.

---

## 2. Add funnel tracking — patch provided

**`rider-app.patch` in this folder does the whole thing.** Apply it in the
rider/driver repo:

```bash
cd /path/to/roverzoom
git apply /path/to/roverzoom-ops/integration/rider-app.patch
npm run build          # verify
```

It adds `frontend/src/lib/track.js` and instruments `KioskApp.jsx`. Then set in
`frontend/.env`:

```
VITE_OPS_API_URL=https://<your-ops-console-domain>
```

and add the rider site to the ops API's allowlist:

```
CORS_ORIGINS=https://admin.roverzoom.com,https://www.roverzoom.com
```

**Both domains, not just the console.** The beacon is a cross-origin request
from `www.roverzoom.com`; leaving the rider domain out of the allowlist blocks
every event while the console itself keeps working, which looks exactly like
"nobody visited".

Note also that the beacon is sent as `text/plain`, not `application/json`.
That is deliberate: `application/json` is not a CORS-safelisted content type,
so it forces a preflight, and a preflighted `sendBeacon` is dropped by the
browser. The body is still JSON — the ops API parses it out of the string.
It works either way same-origin, so this only ever breaks in production.

### What the patch changes, and why only one file

Every booking field in the kiosk flow already funnels through a single `patch()`
function in `KioskApp.jsx`, so three of the seven steps are recorded in one
place rather than scattered across the screens:

| Step | Where |
|---|---|
| `visit` | mount effect |
| `booking_started` | "Book here" **and** "Talk to the assistant" |
| `pickup_set` · `dropoff_set` · `quote_viewed` | inside `patch()`, with the fare |
| `checkout_started` | leaving PhoneStep for PayStep |
| `booked` | `onConfirmed`, beside the existing Google Ads conversion — **and** in `closeAssistant`, because the voice flow books without ever passing through PayStep |

Two details worth knowing if you review the diff:

- The import is aliased to `trackEvent`. `KioskApp.jsx` already has a local
  `track()` for the ride-tracking deep link; importing as `track` would shadow
  it and silently break those links.
- Steps fire at most once per visit, guarded by a ref. Without that, `patch()`
  would re-report `pickup_set` on every keystroke that touches the address.

## 3. Tag your non-Google links

Google and Meta add their own click ids (`gclid`, `fbclid`) automatically, so
paid traffic from those is detected with no work. **Everything else needs a
tagged link**, or it lands in the report as plain "referral" or "direct" and
you cannot tell which post or flyer produced it.

Add UTM parameters to any link you control:

```
https://www.roverzoom.com/?utm_source=facebook&utm_medium=social&utm_campaign=medical_aug
https://www.roverzoom.com/?utm_source=nextdoor&utm_medium=social&utm_campaign=neighbours
https://www.roverzoom.com/?utm_source=flyer&utm_medium=qr&utm_campaign=medical_offices
https://www.roverzoom.com/?utm_source=yelp&utm_medium=referral
```

Rules of thumb:

- `utm_medium=cpc` **only** when you paid for the click. That is what the
  console counts as ad spend traffic.
- Use `qr` for printed material — your flyers and business cards should each
  carry a distinct `utm_campaign` so you can tell which print run works.
- Keep names lowercase and consistent (`facebook`, never `Facebook` or `FB`).
  The API normalizes case, but consistent naming keeps campaigns from
  fragmenting.

Detected automatically, with no tagging needed: Google Ads, Meta ads, TikTok,
Bing, X, LinkedIn, Pinterest, Snapchat, and organic referrals from Facebook,
Instagram, Nextdoor, Yelp, Tripadvisor, Reddit and the major search engines.

---

## 4. Install the tables

In the ops repo, against the same Supabase project:

```bash
psql "$DATABASE_URL" -f db/002_site_events.sql              # if not already run
psql "$DATABASE_URL" -f db/003_site_events_attribution.sql  # multi-source columns
```

Both are additive and idempotent. Until they run, the Growth screen says so
plainly rather than showing zeros.

---

## What is and is not collected

**Collected:** a random per-visit id (sessionStorage, dies with the tab), which
step was reached, the traffic source (UTM tags, platform click ids, and the
referring site's *origin* only), coarse device class, the fare shown at the
price step, and city/region resolved at the edge by the ops API from its own
request headers.

**Not collected:** no name, phone, email, pickup or dropoff address, no IP
address stored, no user agent string, and no identifier that persists across
visits or follows anyone between sites.
