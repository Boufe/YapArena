# Browser session response ordering

Actual local native Chromium trial: **7 groups passed** at revision
`e8b0e1c3a70a64099e6f998d0205b853968c82d9` (coordinator source from
`7e813e3`; the later commit adds logger redaction). The [results](results.json) record
browser version, timestamp, and exact coordinator source/built-asset hashes.

The verifier starts a dedicated loopback HTTP server and uses two tabs with
native Fetch, Web Locks and an actual synthetic HttpOnly cookie. It does not
intercept requests or infer cookie behavior from JSON. The server models a
credential rotation committing before its delayed response headers.

Verified groups:

- All eleven application session-issuing paths serialize cookie headers.
- A held response body retains the lock; reads remain unlocked and logout waits.
- All four revocation paths send the replacement cookie after committed rotation;
  the fixture models logout-other-sessions preserving that current session.
- A different account's already-queued login is preserved when an old-account
  logout follows: the captured comparison hint produces 409, without authority
  being granted by that hint.
- The actual ten-second issuance queue timeout cancels before HTTP submission.
- The actual thirty-second Fetch timeout prevents delayed old headers overwriting
  a later cookie in the tested Chromium cookie jar.
- Missing Web Locks produces a clear failure before session mutation.

Issuance waits at most ten seconds for the lock and thirty seconds for HTTP.
Revocation waits at most 35 seconds and then ten seconds for HTTP; the caller is
bounded at 45 seconds. Native credential ceremonies are outside the lock. Without
a pending issuer, revocation starts immediately. Timeout is an unconfirmed outcome,
not proof that server work did not commit.

This establishes behavior only for cooperating application browser flows in the
recorded Chromium version. It is separate from the compiled HTTP router tests,
PostgreSQL role/concurrency acceptance, genuine provider journeys, physical-device
and other-browser acceptance. Arbitrary API clients do not use the browser lock.
The synthetic server simplifies individual-session deletion to an account-wide
fixture-state change. Its selected-SID behavior is not application acceptance:
the actual API removes only the selected session and may return 404 if rotation
already removed it. Compiled HTTP and guarded PostgreSQL tests separately cover
that behavior. No real identity, provider, database or funds are used by this fixture.

The implementation uses the current [Web Locks specification](https://w3c.github.io/web-locks/)
and [Fetch specification](https://fetch.spec.whatwg.org/). Supported secure contexts
coordinate across same-origin tabs; unsupported capability fails clearly rather
than silently permitting weaker ordering.

After building, run:

```sh
node scripts/verify-session-coordination-browser.ts
```
