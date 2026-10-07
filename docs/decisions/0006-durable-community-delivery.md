# Decision 0006 — Durable public community delivery

Status: implemented locally behind `COMMUNITY_STREAM_ENABLED=false`; hosted release acceptance
remains open. Provisional budgets were recorded before implementation and are not approved capacity.

Use the existing HTTPS write APIs, private PostgreSQL state and one SSE connection per eligible
event page. A transactional locked room counter orders reference-only room events with their public
mutations; NOTIFY wakes one runtime LISTEN session per web process after commit. Active-room repair,
current public projections, bounded fanout/backpressure and application-acknowledged cursors make
recovery independent of notification reliability and native EventSource received IDs.

Keep personal state and private moderation data outside shared delivery. Public likes remain
visible interest. Chat closure follows event lifecycle and chat pause; no financial participation
closure, official support, winner or settlement state is introduced. Existing media behavior remains
separate. Community fanout can cross processes. Subsequent
[media delivery controls](../media-delivery-controls.md) coordinate clock advancement
and provider repair, but process-local abuse counters and remaining hosted acceptance
still prevent treating this as whole-app multi-instance release approval.

The [delivery operating guide](../community-delivery.md) defines the protocol allowlists, lock order,
writer inventory, retention, limits, rollback and repeatable hosted procedure. It extends decision
0005's transport while preserving its submission, authorization, moderation and retention policy.
No existing product or hosting release gate is waived.
