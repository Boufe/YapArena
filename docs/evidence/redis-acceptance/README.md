# Redis abuse-control operational acceptance

The [sanitized local report](local.json) records the 2026-10-20 isolated trial.
Its `revision` is the parent commit at test time; `sourceHashes` identifies the
exact uncommitted store and verifier sources tested. This is local operational
evidence, not hosted financial-security acceptance. No hosted Redis instance,
retained account, manually created account, money record or provider setting was
changed.

## Implemented and verified

The actual locked Redis client is used throughout. The real-server trial ran
Redis **7.4.11** in a uniquely labeled, verifier-owned Docker container, bound to
an automatically allocated loopback port, without persistence. Only that owned
container was paused, restarted, reconfigured and removed. The verifier checks
its random ownership label before each lifecycle action. It never flushes a
shared datastore.

| Requirement                                                     | Owner / dependency                              | Acceptance and evidence                                                                                                                                                | Status / remaining boundary                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Shared atomic limits                                            | Redis workstream / Redis EVAL                   | 100 concurrent increments produce exactly 100 distinct counts; TTL expiry starts a fresh window                                                                        | Locally verified                                                                                |
| Cross-instance IP/account budgets                               | Redis workstream / shared namespace and secret  | Two independent Node HTTP worker processes submit 40 concurrent requests; exactly 12 pass and 28 throttle; the same synthetic account shares its budget across workers | Locally verified; principals are fixtures, not PostgreSQL sessions                              |
| IP, operation, account and environment separation               | Redis workstream / trusted application identity | Independent operation, account and namespace budgets; unit test groups IPv6 /56 subnets; every observed key is namespaced and HMAC hashed                              | Locally verified                                                                                |
| Privacy and observability                                       | Redis workstream / Prometheus                   | Aggregate success/error/throttle/unavailable counts and latency histogram; keys and metrics omit raw subjects and secrets                                              | Locally verified; no population latency claim                                                   |
| Timeout and retry bounds                                        | Redis workstream / locked node-redis            | Accepted TCP connection with no handshake response and paused real Redis command both fail near one second; failed connections close; cooldown returns immediately     | Locally verified                                                                                |
| Backoff recovery and queue bounds                               | Redis workstream / connection ownership         | Requests during cooldown do not extend it; reconnect after five seconds works; 300 queued requests fail closed under the 256-command cap                               | Locally verified, including protocol-fixture unit assertions                                    |
| Eviction and memory pressure                                    | Redis workstream / separate noeviction instance | New connection rejects evictable policy before 16 concurrent increments; OOM rejects writes and preserves existing keys, with zero evicted keys                        | Locally verified; operator must preserve policy and memory headroom                             |
| Restart behavior                                                | Redis workstream / persistence mode             | Real nonpersistent restart removes counters; subsequent increment starts at one                                                                                        | Locally verified; confirms this state cannot secure money or revocation                         |
| Logout, session reads and account-wide revocation during outage | Auth workstream / PostgreSQL authority          | Actual `createApp` unit suite returns 200 for session inspection and 204 for logout/logout-all/logout-other-sessions while exchange returns 503                        | Focused local suite passed; PostgreSQL integration is tracked by the combined acceptance record |
| Hosted permission/policy and deployment compatibility           | Lead / staging runtime                          | Updated store must successfully read `INFO memory`, observe `maxmemory_policy:noeviction`, and pass a protected request after deployment                               | Not established by this local trial                                                             |
| Hosted multi-instance/outage exercise                           | Lead / isolated hosted trial                    | Separate hosted instances share limits; protected writes fail closed during an isolated fault while PostgreSQL-backed revocation works                                 | Not claimed; do not pause or reconfigure the shared staging datastore for this trial            |
| Financial authorization/history                                 | Financial/security workstreams / PostgreSQL     | Reservations, daily financial limits, operation proofs, idempotency, revocation and ledger history must remain durable in PostgreSQL                                   | Redis counters are explicitly ineligible for this role                                          |

The real trial observed 173 parent-process store operations, with p50 **2.87 ms**,
p95 **3.76 ms** and maximum **1.002 seconds**, including deliberate failures.
Worker-process samples are not included in those latency figures. These are
workstation observations, not a service-level promise.

The focused actual-application and Redis unit run passed **20 tests, no skips**:

```sh
node --test tests/shared-abuse.test.js tests/email-first-auth.test.js
```

The server and database-tools TypeScript projects, focused ESLint and formatting
checks passed. The lead owns the final integrated repository quality and database
runs; these focused results do not replace those gates.

## Timeout findings and response

The real fault trial found two gaps in the previous implementation: the client's
TCP connection timeout did not bound initialization after an accepted connection,
and its `abortSignal` listener was removed after a command was sent. A stalled
server could therefore leave an application request waiting indefinitely.

The store now uses an explicit one-second deadline around initialization plus
policy validation, and another one-second deadline around the command response.
A failure destroys the connection, discards queued work and starts a five-second
retry cooldown. The queue holds at most 256 pending commands. Concurrent callers
wait for policy validation before using a ready connection. Invalid counters,
TTLs, fractional/nonfinite windows and unsafe memory policy fail closed.

A timeout cannot undo a command already received by Redis. The pause trial allows
that uncertain counter increment to have executed once, proves the next explicit
attempt does not replay it, and checks a successful reconnect after cooldown.
No financial operation may infer non-execution from a Redis timeout.

## Reproduction and runtime configuration

Run the complete isolated trial with Docker available:

```sh
npm run verify:auth-redis -- --disposable --evidence=/private/tmp/redis-acceptance.json
```

This mode creates and cleans up its own instance and refuses `REDIS_TEST_URL`.
The existing-target mode accepts loopback hosts only and uses unique expiring
keys. It does not alter policy, pause, restart, fill memory or delete existing
keys:

```sh
npm run verify:auth-redis
```

Runtime variable names remain `REDIS_SECURITY_URL`, `REDIS_NAMESPACE` and
`REDIS_KEY_SECRET`. The namespace and a random HMAC secret must differ between
staging and production; multiple instances of the same environment must share
them. Production requires a TLS URL. Never expose these values in browser code,
logs, screenshots or acceptance reports. A separate security datastore must use
`noeviction`; ordinary caches do not belong there.

The runtime Redis identity needs `INFO memory`, `EVAL` and the script's
`INCR`/`PEXPIRE`/`PTTL` commands on its environment's security keys, plus the
client's connection/authentication handshake. It does **not** need `CONFIG`,
`KEYS`, lifecycle commands or administrative privileges. Those commands occur
only in the explicitly owned disposable verifier. An ACL denial or a missing
policy response fails protected mutations closed with 503/Retry-After. Validate
these permissions before deploying to a new managed provider.

Continue monitoring aggregate `yaparena_redis_security_total` outcomes and
`yaparena_redis_security_seconds`, plus the provider's memory and connection
metrics. Errors/unavailability, sustained throttling and latency near the
one-second deadline require investigation. Inspect policy, memory headroom,
network access and connection limits without logging the endpoint or identities.
Logout and revocation must stay on PostgreSQL and remain usable while this store
is unavailable. No general cache or positive authorization cache was added.

## Current official provider facts and limits

Checked 2026-10-20:

- [Render Key Value](https://render.com/docs/key-value) documents Redis-compatible
  connections, new instances running Valkey 8, configurable `noeviction`, and
  memory/connection metrics. The page does not establish the selected staging
  identity's `INFO memory` permission; the deployment trial must verify it.
- [Render free-instance limits](https://render.com/docs/free#free-key-value)
  state that free Key Value is in-memory only and can restart at any time,
  losing all counters. No paid upgrade was selected or purchased.
- [Redis INFO](https://redis.io/docs/latest/commands/info/) defines the
  `maxmemory_policy` memory field.
- [Redis eviction](https://redis.io/docs/latest/develop/reference/eviction/)
  describes noeviction write errors under memory pressure.
- [Node-redis production guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
  documents offline queues and connection controls. Actual locked-client fault
  tests establish the stronger request deadline used here.

Keep free staging Redis for abuse budgets if restart resets are acceptable.
Durable financial controls and ownership remain in PostgreSQL regardless of
Redis plan. The local Redis 7.4 trial is not a Valkey 8 or selected hosted
configuration acceptance claim.
