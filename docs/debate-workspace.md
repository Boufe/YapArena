# Live and replay debate workspace

The October 15 visual reference selects a navy interface, blue-gray panel borders,
green YES/red NO accents, and a shared header with Live, Explore, Create, debate
search, a Yap Coins balance menu and account avatar. The same workspace renders
live, upcoming, ended and replay events. Existing discovery/account/matching pages
use the shared header and palette; `/coins` retains advanced experiment controls.

Desktop has three columns: broadcast/replay and community, settlement chart and
commitments, and round history/info plus settled sentiment. Narrow screens stack
these panels without removing controls. Video enlargement changes CSS on the
existing surface: it preserves media nodes, tracks, playback and chat. Hover,
keyboard focus and touch expose the control; Restore or Escape returns its exact
original bounds. Keyboard focus stays inside the enlarged video until restored.

## Data and interaction

- Header search submits to the existing published-debate search. Navigation opens
  actual discovery/matching/account routes. The balance menu uses authenticated
  runtime data, and the debate balance is explicitly scoped to its current run.
- `GET /api/a4/debates/:id/timeline?scope=human|sandbox` returns at most 100
  settled, revealed rounds in settlement order. It rechecks account/session validity
  and debate/topic publication. Human rounds and the creator's own mixed bot runs
  are separate; observer runs and another creator's sandboxes never enter this feed.
- `GET /api/a4/debates/:id/workspace?runId=...` combines the authorized run,
  scoped balance, run list and timeline into one account-bound polling response.
  One request per five-second refresh preserves the ordinary API request budget;
  unrelated debate IDs and observer runs are rejected. Account/session rechecks
  remain inside the repository transactions. No existing rate limit is increased.
- Every chart point is the exact unweighted YES share for one final round; NO is
  its complement. Empty rounds break the line and have no invented percentage.
  Chart markers and the round list load the selected run and its own receipts.
  Visible tabs refresh every five seconds, including after the selected run completes.
  A reconnect catches up from durable PostgreSQL state. No speculative values,
  pending counts, provisional payouts, hidden books or secret seeds enter the feed.
- Volume is executed premium for the displayed settled window, in Yap Coins.
  Counts are labeled human/bot **commitments**, not people or adoption. Sentiment
  explicitly names its settled round; it is not an assertion about truth, a price,
  a rolling five-minute sample or an official debate winner.
- Position buttons, quantity shortcuts and the purchase ceiling use the existing
  server-side review/commit API. NO ceiling conversion, fee allowance, full
  reservation, idempotent retry, first-binding submission and delayed finality are
  unchanged. Open commitments cannot be cancelled. History shows actual receipts.
- Existing live/replay controls, signed replay access, captions, operator controls,
  moderated chat, delivery/recovery, likes, sharing and reports remain connected.
  Replay chat follows the existing read-only policy. Synthetic demo listings label
  their unavailable community rather than pretending to contain a real audience.
- Playback presence uses a bounded, ephemeral in-process roster (5,000 connections,
  65-second expiry) behind the existing publication/origin/body/admission gates.
  Only visible, playing video tabs heartbeat. Pause/exit/expiry remove connections.
  It counts active playback connections on the existing single instance, not unique
  people; it does not write measurement events or bypass measurement consent.
  Shared cross-instance audience measurement is outside this implementation.

## Verification and operation

No database migration, new dependency, provider configuration or paid mode is needed.
Use the same owner-provisioned/runtime-only database configuration as A4. Existing
disabled/Yap Coins/Bots switches keep their meanings. A code rollback leaves
append-only A4 history intact; existing obligations keep their settlement recovery.

Run the disposable quality/browser gates with:

```sh
A4_VERIFY=true A4_QUALITY=true A4_BROWSER=true DATABASE_TEST_MODE=host \
  node scripts/verify-database-isolation.js
```

This runs fresh/upgrade database checks and the quality/browser gates. `verify-arena-browser.js` extends that disposable browser
trial with real settlements, a real published-profile chat message, search, tab
selection, mobile checks, axe and uninterrupted synthetic replay playback during
enlargement. It refuses a hosted target. Synthetic browser playback establishes
component behavior, not LiveKit transport, R2 delivery quality or physical-device
acceptance. See the [dated evidence](evidence/debate-workspace/acceptance-2026-10-15.md).
