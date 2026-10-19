# Recording thumbnails — October 16, 2026

Integration note — 2026-10-19: PRs #31 and #32 are merged. The branch/draft status
below describes this trial's original handoff. Current source and verification
instructions are in [the Live preview guide](../../homepage-preview.md).

Current state: [Live discovery](live-feed-2026-10-16.md) now uses these same
per-recording thumbnails in its hero and video cards at `/live`.

The homepage now shows the featured recording's own JPEG behind its video. It
remains visible while the preview loads, buffers, is paused or is disabled by
motion/data preferences. The YES/NO backdrop is removed from featured debates.

The existing encoder extracts one representative 960×540 frame from the first
720p segment after its encoding batch drains. This backfills already packaged
recordings without encoding their full source again. Images are immutable private
objects bound to the original recording key. A bounded idle task checks storage
on restart and retries transient failures. No schema or hosting-plan change.

The public image endpoint rechecks debate/topic publication and verified replay
eligibility. It returns only a bounded JPEG, never a source key or signed recording
URL. FFmpeg stays in the replay worker; the web process only reads a small image.
Stalled object streams are aborted and released. A missing image keeps a plain navy
surface with the question; artwork from other debates is never substituted.

## Local evidence

- Disposable runtime-backed `npm run check`: **491 passed, zero failed/skipped**;
  93.95% line / 93.04% branch / 95.59% function coverage. Fresh/upgrade database
  isolation passed.
- Real disposable PostgreSQL/FFmpeg pipeline passed, including selection of
  thumbnail candidates, exclusion hints, extraction from a ready HLS segment and
  private image persistence. Source media and object storage are synthetic.
- [Browser results](thumbnail-2026-10-16/evidence.json) confirm that the paused
  image belongs to the displayed debate, stays visible without autoplay/SDK loading
  under Save-Data, and preserves entry, pause/cleanup, mobile and accessibility
  behavior. Zero page errors or axe violations.
- Media tests cover publication/recording gating, private object reads, JPEG/size
  bounds, immutable/idempotent writes, retries, cancellation and shutdown.

[Paused-thumbnail screenshot](thumbnail-2026-10-16/thumbnail.png). The colored
frame is taken from the synthetic local test recording, not shipped as a debate.

## Deployment handoff

The shared checkout remains clean at `c63308e`, matching fetched `origin/main`.
The change continues in `feat/neon-debate-dashboard`, stacked on unmerged A4
PR #31. Existing [draft PR #32](https://github.com/Boufe/YapArena/pull/32) records
the source, release checks and exact Render deployment status. The user performs
staging UI acceptance; no hosted test account or smoke round is created.
