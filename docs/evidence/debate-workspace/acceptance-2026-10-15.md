# Debate workspace acceptance — October 15, 2026

Source baseline: clean `origin/main` at `c63308e`, with the already implemented and
staging-deployed A4 commit `fcb162d` one commit ahead. The UI branch
`feat/neon-debate-dashboard` starts from that A4 commit; the original shared main
checkout and A4 worktree are preserved. No A4 economics or applied migration changed.

The [workspace contract](../../debate-workspace.md) describes the connected UI,
reveal policy and bounded audience semantics. The implementation adds an
authenticated settlement timeline and ephemeral playback presence, retains the
existing media/community APIs, and uses real ledger balances and receipts.

Local verification records include fresh/upgrade PostgreSQL runtime-role isolation,
the full quality gate with all disposable database identities, and the existing A4
browser journey. Additional browser evidence covers automatic chart updates from
real 500-bot settlements, exact-size restoration, receipt/review/quantity controls,
chart selection, search, mobile overflow and axe. The repeated trial also exercises
live chat and the replay layout with an explicitly synthetic video stream.

The chart starts empty and appends final settlement points. Tests separately reject
pending/observer/other-creator data and unpublished debates. The enlarged video
keeps its original node, stream and advancing playback time and restores on Escape.
No physical-device or full-session media quality acceptance is inferred.

The final local quality gate passed **476 tests, zero failures, zero skips** with
96.67% line, 92.90% branch and 95.60% function coverage. The 16 A4 PostgreSQL
cases passed in both fresh and upgrade scenarios. The existing A4 browser journey
and the workspace journey passed. The axe report has zero violations.

[Checks](checks.json) · [Browser results](browser-evidence.json) · [axe](axe.json)

[Live desktop](live-desktop.png) · [Replay desktop](replay-desktop.png) · [Mobile](mobile.png)

These are local synthetic fixtures with real PostgreSQL and settlement workers;
the replay component uses an explicit synthetic stream. Hosted deployment and its
own postflight evidence are recorded on the release PR, separately from this trial.
The original reference contains cash labels, provisional sentiment
and cancellable matching orders; this implementation maps the visual arrangement to
the approved nonredeemable Yap Coins/A4 contract.
