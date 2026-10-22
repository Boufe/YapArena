# Embedded wallet retry scope: real local Redis

Actual verifier result: **PASS, 10 groups, exit 0** on 2026-10-21. The exact
revision and source fingerprints are recorded in [results.json](results.json).
This is a separate run; the earlier passkey-scope evidence remains unchanged.

```sh
node scripts/verify-auth-redis.ts --disposable --evidence=docs/evidence/redis-acceptance/embedded-wallet-scopes/results.json
```

The verifier created its own labelled disposable Redis 7.4.11 Docker container
bound only to loopback, with two separate Node v24.19.0 HTTP worker processes.
It cleaned up its workers and owned container at completion. The initial
restricted-shell attempt could not access the local Docker socket; the same
command then ran with the required local-container permission. It did not use
an existing Redis target or mutate hosted Redis.

For each of `provider.passkey.link`, `provider.passkey.restart` and the new
`embedded.wallet.retry`, twenty concurrent requests across the two processes
produced exactly two allowed and eighteen throttled responses. Independent
accounts, purposes and environment namespaces retained separate budgets. Six
account/purpose keys were opaque HMACs with a positive bounded TTL and contained
no raw account, operation name or secret. All three purposes returned 503 during
the unavailable-store fixture; the public read remained available.

The run also preserved the existing atomic-increment/expiry, IP/account budget,
evictable-policy rejection, noeviction exhaustion, stalled connection/command,
restart and aggregate observability assertions. Across 179 measured store
operations, p50 was 9.20 ms and p95 9.40 ms; the maximum 1.001 s was a deliberately
bounded outage. These measurements describe this local fixture, not hosted
capacity or production latency.

This test exercises the actual Redis client and shared limiter source. Its HTTP
principals are synthetic; it is not PostgreSQL authorization, provider wallet
creation, a hosted outage, or financial acceptance. Logout/revocation routing
is covered separately by the application suites. Nonpersistent restarts reset
abuse budgets, so PostgreSQL remains authoritative for revocation, ownership,
financial limits and history.
