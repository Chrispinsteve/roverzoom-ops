# Domain layer — the sync contract

These modules **duplicate** logic that lives in the rider/driver backend
(`roverzoom/backend`). That duplication is deliberate, and it is the single
biggest risk in this codebase, so it is worth being explicit about.

## Why duplicate at all

The ops console is a separate service on a separate domain. It cannot
`require('../../roverzoom/backend/services/payout')`. The choice was between:

1. **Duplicate the model** (what we do) — the console computes fares and
   payouts itself, and must be kept in step.
2. **Ask the rider/driver API** — would mean adding admin endpoints to that
   codebase, which is exactly what deploying a standalone console was meant to
   avoid.

## What is mirrored, and from where

| This file | Mirrors | What drifts if it breaks |
|---|---|---|
| `money.js` | `backend/services/payout.js`, `backend/services/fare.js` | The console reports the wrong driver earnings and the wrong platform margin. Reconciliation starts flagging healthy rides as mismatched. |
| `lifecycle.js` | `backend/db/schema.sql` (`bookings_status_check`), `backend/routes/driver.js` (`TRANSITIONS`) | A new ride status renders as a raw database string, or worse, is silently dropped from a filter and disappears from the board. |
| `geo.js` | `backend/services/fare.js` (`haversineMiles`) | Dispatch candidate ranking degrades. Low severity — this only orders a list. |

`trust.js` and `attention.js` are **not** mirrors. They are this console's own
model and have no upstream counterpart.

## Keeping it honest

Every constant reads the **same environment variable** as its upstream twin
(`DRIVER_CUT_PCT`, `FARE_MULTIPLIER`, `FARE_MULTIPLIER_MORNING`, `SERVICE_TZ`),
so one deployment config keeps both services in step without touching code.

For the literals, run:

```bash
npm run verify:sync -- /path/to/roverzoom
```

It reads the upstream sources and diffs them against these modules, exiting
non-zero on a mismatch. **Run it in CI**, and any time the rider/driver repo
changes how a fare or payout is calculated.
