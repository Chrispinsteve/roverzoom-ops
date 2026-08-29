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

## 2. Add funnel tracking

Copy `roverzoom-track.js` to `roverzoom/frontend/src/lib/track.js`, then set in
`frontend/.env`:

```
VITE_OPS_API_URL=https://<your-ops-console-domain>
```

And on the ops API, add the rider site to the CORS allowlist:

```
CORS_ORIGINS=https://admin.roverzoom.com,https://www.roverzoom.com
```

### Where to call it

Seven calls. Each is one line, and each is safe to add anywhere in the relevant
component — `track()` never throws.

| Step | Where | Call |
|---|---|---|
| `visit` | `App.jsx`, once on mount | `track('visit')` |
| `booking_started` | Landing, when Form **or** AI is chosen | `track('booking_started')` |
| `pickup_set` | After a pickup address is confirmed | `track('pickup_set')` |
| `dropoff_set` | After a destination is confirmed | `track('dropoff_set')` |
| `quote_viewed` | When the fare is first shown | `track('quote_viewed', { value: fare })` |
| `checkout_started` | On reaching payment selection | `track('checkout_started')` |
| `booked` | On the confirmation screen | `track('booked', { bookingRef: booking.reference })` |

`quote_viewed` carries the fare on purpose: it lets the console compare the
price abandoners saw against the price bookers saw. If abandoners consistently
see higher fares, the problem is pricing, not the flow.

---

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

## 4. Install the table

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
