# Retained-wallet refresh: controlled failure and correction

**PASS:** the controlled old assertion failed for the intended reason; the
corrected maintained fixture passed all four existing groups. Both executions
used new, separate disposable loopback PostgreSQL clusters and the exact same
frozen application/assets, without a build, shared/hosted database, configured
provider or real chain. See [result.json](result.json), the two runner results
and child outputs under `red/` and `green/`.

The failed [a970 CI](../a9706cc/README.md) reached the pre-final mobile screenshot
after all negative proof cases. Its original catch suppressed the exact error
and line, so the historical assertion cannot be recovered. Source inspection
identified a real invalid assumption: successful removal closes its dialog,
then immediately starts `loadAccount()`. That clears private signed-in content
while `/api/auth/me` is pending. Dialog closure does not mean the refresh is done.

The maintained fixture now holds that exact GET after final mobile removal.
It requires a committed one-wallet database state while the private account
section is hidden and the checking notice is visible. The hold is bounded by
the unchanged ten-second budget and always released. It then waits for the
actual refreshed signed-in state, completed unlink notice and notification
before retaining every original count, visibility, replay, negative-proof and
last-method assertion. No application behavior or timeout was changed.

The private RED copy differs only by a type-only absolute import and a safe
observation followed by the old immediate `signedInVisible === true` assertion
under the same barrier. The [exact diff](red-fixture-diff.txt) is preserved.
Actual RED fixture exit was 1, with `AssertionError` at line 296 and the exact
held-refresh phase. Its [observation](red/red-observation.json) records one
remaining wallet, hidden signed-in section and no barrier timeout. This proves
the race mechanism; it does not fabricate the original CI line.

Actual GREEN fixture exit was 0: **four groups, no page errors**. All original
wrong password/account/chain, cancelled signature, expired completion, service
outage, wallet counts, consumed-proof replay, wallet-only login and last-method
checks remain. It additionally proves hidden private state during refresh and
the final restored session/notification. Strict browser TypeScript, scoped
ESLint and formatting passed.

| Executed source         | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Maintained fixture      | `3720a754856057a21398c2995a0fdb7733a258814aeea6d9ead66a07f2774287` |
| Private RED fixture     | `7e4e0560715dff2f5410857a54fb96d568c15d00ee2ed1e9206defdfeee162fd` |
| Reviewed private runner | `4a55a686df3e413e75a365b88c30914fd059025916d90081abe9fb2fc171cee8` |

Both runner results verify dedicated owner/runtime separation, zero remaining
fixture users, stopped/removed owned clusters and identical pre/post compiled
and public asset hashes. Cleanup finishes before runner PASS. Runtime credentials
are generated only in memory and the web process never receives owner/admin
credentials. No existing service, provider, retained account or build output was
modified. The r1 full gate used the earlier fixture; this focused result covers
the new verifier, and exact-revision CI remains a separate release requirement.

Failure output now contains only a fixed phase, allowlisted error class and
numeric script line, plus a synthetic failure screenshot. It withholds raw
exception messages and stack/provider/configuration payloads. These tests still
do not establish genuine embedded-wallet creation, hosted provider acceptance or
physical-device behavior.
