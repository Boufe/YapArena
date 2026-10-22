# Local Valkey 8.1.10 compatibility — 2026-10-22

The [actual result](result.json) and [raw run output](run.log) record a successful
ten-group trial at 00:51:23 UTC using Node24.19.0 and the real locked Redis
client. The verifier exited zero, cleaned up its owned container and workers,
and a separate Docker postflight found no remaining acceptance containers.
No staging Redis target, account, database, provider configuration, plan or
hosted resource was changed.

This is **local engine compatibility**, not hosted multi-host, fault, capacity or
ACL/INFO acceptance. Render's control-plane report of8.1.10 elsewhere is not a
raw hosted INFO result and is not verified by this trial. Earlier Redis7.4
evidence remains separate and unchanged.

## Exact engine and source

The uniquely named/labeled container used an automatically allocated **loopback**
port, 16MiB `maxmemory`, `noeviction`, and no persistence. Only the verifier-owned
container was paused, restarted, reconfigured and removed. The image was the
[Valkey community's official](https://github.com/valkey-io/valkey-container)
`valkey/valkey:8.1.10-alpine` image, listed by [Valkey](https://valkey.io/),
downloaded for the existing arm64 Colima Docker runtime. Its recorded image ID
and repository digest are
`sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507`.

Actual `INFO server` returned `server_name:valkey` and
`valkey_version:8.1.10`; both were asserted before the checks. Its
`redis_version:7.2.4` denotes protocol compatibility, as specified in the
[official INFO documentation](https://valkey.io/commands/info/), not the running
Valkey release. These fields and the image digest remain distinct in the result.

The result's revision is parent7e5c0a3. Its exact verifier change was uncommitted
at execution: SHA256 `3711e314…`, with unchanged runtime abuse store
`34a10238…`. The focused argument test is `2408e39b…`.
[validation.json](validation.json) retains full hashes, commands and tool results.
No application bundle or source was rebuilt for this trial.

## Preserved checks

All ten existing operational groups passed, including 100 concurrent atomic
increments/TTL expiry; two independent HTTP middleware instances and two real
Node HTTP worker processes; IP/account/operation/environment separation; opaque
HMAC keys; and independent budgets for `provider.passkey.link`,
`provider.passkey.restart` and `embedded.wallet.retry`.

Closed ports, accepted-but-stalled handshakes and paused commands meet the
existing deadlines. Protected fixture mutations fail closed while a public read
continues. Evictable policy is rejected, real memory exhaustion retains old
counters with no eviction, failed connections are destroyed and cooldown is
bounded. Restart explicitly loses nonpersistent counters. Aggregate
latency/error/throttle metrics disclose no fixture identities, namespace or key
secret. No threshold, assertion or scope was weakened to use Valkey.

The parent observed179 store operations: p50 **11.54ms**, p95 **11.92ms**, maximum
**1.0002s**, including deliberate failures. Worker samples are not included.
These are workstation observations, not hosted latency or availability promises.
PostgreSQL remains responsible for ownership, revocation and financial history;
resettable abuse counters cannot secure financial limits or authorize payments.

The maintained verifier adds a finite allowlist rather than an arbitrary Docker
image override. `--disposable-engine=valkey-8.1.10` requires `--disposable`;
the default remains Redis7.4. Offline `--options-only` tests passed two groups,
covering the default/exact image and rejection of arbitrary/empty engine names,
duplicate/conflicting/unknown flags, worker/evidence options in preflight and
`REDIS_TEST_URL` in disposable mode before Docker execution. Strict operational
TypeScript, scoped ESLint and formatting passed.

Reproduce with Docker available, without any hosted URL:

```sh
node scripts/verify-auth-redis.ts --disposable \
  --disposable-engine=valkey-8.1.10 --evidence=/private/tmp/valkey-result.json
```

[manifest.json](manifest.json) binds the archived bytes. The `.json.raw` result
preserves original output; its formatted counterpart has equal parsed values.
The runtime/server code has not changed for this engine trial. Hosted Redis
topology, outage permissions, memory behavior and actual role ACLs remain their
separate recorded limitations. No paid resource or hosted fault was attempted.
