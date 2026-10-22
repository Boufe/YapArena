# Independent local community and replay gates

Performed on 2026-10-20 with Node 24.19.0, macOS arm64, native PostgreSQL 17.10
and FFmpeg 9.0.2. The source/build manifest was captured at
`ebf57805124650572c8b2df7202d464f833a55af` after the lead's shared build.
No additional build ran in this verifier. Both maintained scripts exited **0**.
See [structured results](results.json), [community output](community.txt) and
[replay output](replay.txt).

```sh
LC_ALL=C LANG=C COMMUNITY_POSTGRES_MODE=host COMMUNITY_DURABLE_TRIAL=1 COMMUNITY_SOAK_SECONDS=30 node scripts/verify-community-local.ts
LC_ALL=C LANG=C REPLAY_POSTGRES_MODE=host node scripts/verify-replay-pipeline.ts
```

Both scripts generated their own loopback SCRAM-authenticated PostgreSQL clusters
and separate owner/runtime identities, applied the current migrations and removed
their local processes/database resources. They read no `.env`, accepted no hosted
database URL and changed no retained or staging accounts. The first restricted
community attempt failed before PostgreSQL startup because macOS shared memory
was denied; the recorded successful run used approved execution outside that
sandbox. This failure is not represented as an application failure or a pass.

## Observed results

| Gate                      | Actual result                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Community SQL             | Migration compatibility, runtime UTF-8 readback, transactions/rollback, duplicate/conflicting submissions, purged acknowledgements, listener failure and missed-hint repair passed. Default reconciliation took 5,007 ms.                                                      |
| Community browser         | Independent desktop/mobile browser journeys, healthy-stream HTTP races, draft/IME/focus, cursor/history/retention/reconnect, narrow/reduced-height layouts, 200% CSS zoom and automated Axe WCAG 2.2 checks passed.                                                            |
| Media operation isolation | Two independent controllers had at most one provider write per room. Five rooms with 500 viewers on one IP made 5,301 local HTTP requests, with no public delivery refusal and one expected protected-write refusal. The provider was synthetic.                               |
| Community load            | 500 viewers / 50 rooms for 30 seconds; 300 authenticated writes and 3,000 delivery samples; p50 34 ms / p95 91 ms; reconnect storm 422 ms; restart recovery 1,406 ms.                                                                                                          |
| Backpressure and cleanup  | 460 slow-client stress mutations, ten buffer-pressure observations, 85.92 MiB RSS growth, at most eight runtime pool connections and zero final streams; 60 second-process mutations were observed.                                                                            |
| Replay database           | Concurrent enqueue/claim, exact source pin, publication rollback including terminated backend, idempotent completion, removal races, stale leases, caption invalidation, deletion tombstones, five-attempt budget, runtime privileges and room-scoped canary isolation passed. |
| Actual local encoding     | Six-second fixture produced 13 package files / 3,059,629 bytes and a 36,946-byte thumbnail. Encoding took 0.786 seconds; peak encoder RSS 98.38 MiB and worker peak RSS 132.77 MiB.                                                                                            |
| Stalled-database shutdown | Real PostgreSQL heartbeat stalled; worker shutdown completed in 1,515.86 ms against the unchanged 8,000 ms budget, releasing the job back to queued state and removing temporary package work.                                                                                 |

## Source integrity and limits

The [before](source-manifest-before.json) and [after](source-manifest-after.json)
manifests compare 451 application, build, migration and harness files. Server
source, compiled server, migrations and the exercised harness dependencies stayed
byte-identical. Three unrelated account-control files changed during the run:
`frontend/account-sessions.ts`, `public/account-sessions.js` and
`public/account-auth.css`. Their exact before/after hashes are recorded. The lead
reviewed that these account controls do not change community or replay behavior;
this evidence does not claim a fully frozen revision of every browser asset.

Thirty seconds of synthetic local load is smoke acceptance, not hosted audience
capacity or a long-duration soak. Replay uses real local FFmpeg/PostgreSQL with
synthetic in-memory object storage. These results do not establish hosted S3/R2,
edge delivery, LiveKit media quality, genuine identity-provider journeys,
screen-reader spoken output or physical-device acceptance. Automated Axe and
viewport checks remain distinct from those gates.

## Final runtime and privacy source review

An independent read covered runtime, server/worker wiring, logger, metrics,
shared-abuse controls, report routes and native consent. This is source review,
separate from the executed gates above. Follow-up browser acceptance exposed a
report sequence cast-alias sort: an older numeric sequence ending in 9 could
sort after a newer 10 as text. Both latest-review and public-history queries now
order by the qualified numeric table column; a deterministic PostgreSQL
digit-boundary regression awaits the combined rerun. The report refresh path
was also corrected to keep reports readable when financial settlement is held.
The review identified missing terminal telemetry for successful discoverable-key
sign-in, which the lead is correcting separately. Those later fixes are not
represented as acceptance from these community/replay runs.

- Runtime/owner authority stays separate. Both normal web and maintenance workers
  use runtime connections; manual financial review/reconciliation uses the
  explicit owner CLI. The web factory pins simulation and never loads signing
  credentials.
- PostgreSQL owns sessions, revocation and financial state. Redis exposes only
  HMAC-derived scoped limits with bounded outcomes/latency. No authorization
  success, credential or OTP state is cached there.
- Authentication counters distinguish server-confirmed signup/sign-in exchange
  outcomes from bounded browser journey/resend/recovery events. Browser events
  are untrusted aggregate telemetry. Metric labels contain fixed categories and
  route templates, not emails, account IDs, destinations or report descriptions.
- HTTP logs omit request bodies; credentials/cookies/webhook signatures and
  provider error objects are redacted. Reports render via `textContent`; customer
  projections omit private owner notes/evidence. Fresh recovery consent binds
  exact server terms and authorizes neither a debit nor external execution.
- Independent A4 jobs use `allSettled` and hold their in-flight guard until both
  finish. Media revocation retries are durable, scoped to exact grant identities,
  and provider calls run outside financial/account transactions. General runtime
  shutdown waits for active tracked jobs before closing the database.

Privy freeze/unfreeze control remains a separately bounded operation while
holding its account fence. A concurrent local revocation can wait for that
control attempt. The server's ten-second hard shutdown may terminate a longer
provider attempt; durable provider/media jobs, PostgreSQL rollback and retry
fences remain necessary. These results do not promise zero-delay logout or
graceful completion under every provider outage.
