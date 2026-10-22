# Privy passkey Redis attempt scopes

Actual local execution on 2026-10-20: **PASS, exit 0**, all 10 recorded check groups. The maintained verifier used Node 24.19.0, Redis 7.4.11 in its own labelled disposable Docker container, and two separate Node HTTP worker processes. It did not use hosted Redis or application accounts.

```sh
node scripts/verify-auth-redis.ts --disposable --evidence=docs/evidence/redis-acceptance/privy-passkey-scopes/results.json
```

The recorded HEAD is `14bc559ae8c28948299727499e11d01005907d7f`; the shared checkout also contained uncommitted work. [results.json](results.json) records the exact SHA-256 hashes of the executed verifier and `src/platform/shared-abuse.ts`. [run.txt](run.txt) preserves terminal output.

For each of `provider.passkey.link` and `provider.passkey.restart`, 20 concurrent requests across the two processes produced exactly 2 allowed and 18 throttled responses. Independent synthetic accounts and an independent environment retained separate budgets. Four stored keys contained only HMAC digests and had positive TTLs no longer than 60 seconds. Both new operation scopes returned 503 when the store was unavailable.

The same execution retained the existing atomic-increment, IP/account budget, timeout/backoff, noeviction-policy, memory-exhaustion, paused-command, restart and aggregate-observability assertions. Its 177 observed store calls had p50 9.96 ms, p95 10.21 ms and maximum 1,002.13 ms; the maximum includes deliberately failed deadline tests, not a hosted latency measurement.

This verifies the attempt-limiter factory and isolated Redis behavior. Synthetic fixture identities do not establish PostgreSQL authentication acceptance. No hosted capacity, provider, physical-device or screen-reader result is inferred. A nonpersistent restart resets attempt counters; financial history, permission and revocation remain PostgreSQL responsibilities.
