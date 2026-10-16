# Compact participation and round inspector — October 16, 2026

This extends the [October 15 workspace](acceptance-2026-10-15.md) on
`feat/neon-debate-dashboard`, using the user's screenshots and countdown request.
The [workspace contract](../../debate-workspace.md) describes current behavior.

## Implementation

Participation replaces the right-hand vertical round list at the same column
width. Its card ends at the main graph boundary; expanded setup can scroll inside
the card. A median/price inspector replaces the strip below the chart. It shows
actual revealed medians, offered `p`, complementary NO price, final YES share and
the authenticated user's own YES-scale limit, with explicit missing/crossed cases.

Hover, touch and keyboard focus show YES/NO rates, the offer and an X-axis diamond
with the round number and argument. Inspection does not switch the commitment
target or issue an API request; click/Enter and the picker select history. New
round setup accepts a server-validated short argument label in existing immutable
run configuration. Historical unlabeled records remain explicitly unlabeled.

A themed progress bar above the graph drains from opening to cutoff every second,
changes color in the last ten seconds, exposes accessible remaining time and
honors reduced motion. Hovering history does not alter the current countdown.
The same interface renders live and replay. No migration or A4 economic change.

## Local evidence

Node 24.19.0, PostgreSQL 17.10, disposable databases and runtime/owner identities:

- `npm run check` via the disposable quality harness: **479 passed, zero
  failed/skipped**, 94.36% line / 92.96% branch / 95.54% function coverage.
- Isolation harness with `A4_VERIFY=true A4_BROWSER=true DATABASE_TEST_MODE=host`:
  **PASS** for fresh and upgrade. All 16 A4 PostgreSQL cases pass in each. Actual
  SQL verifies exact revealed medians/offers, durable labels and account-specific
  own limits; pending and other-creator sandbox records remain excluded.
- Existing A4 and extended workspace browser journeys: **PASS** for real 500-bot
  settlements, real chat, binding review, quantity controls, hover prices/labels,
  unchanged run on hover, right-card/graph alignment, draining progress, selection,
  tabs, search, mobile overflow and no page errors.
- [Browser results](inspector-2026-10-16/browser-evidence.json) and
  [axe scan](inspector-2026-10-16/axe.json): zero reported violations.
- Synthetic replay playback stays mounted and advances during enlarge/restore.
  This is component evidence, not hosted media or physical-device acceptance.

[Live](inspector-2026-10-16/live-desktop.png) ·
[Replay](inspector-2026-10-16/replay-desktop.png) ·
[Mobile](inspector-2026-10-16/mobile.png). Screenshots show an open round with
unrevealed medians/offer correctly blank. The automated hover assertions inspect
settled rounds and verify populated prices and argument labels.

## Staging handoff

The user requested deployment to the existing Render app and will test manually.
The exact deployed commit and deployment IDs are recorded on
[PR #32](https://github.com/Boufe/YapArena/pull/32) after Render reports it live.
No hosted browser journey, synthetic account or smoke round is part of this
handoff. Existing services, plans, settings and A4 history stay in place. Rollback
is a code deployment; no hosted schema change is required.
