# Exact reset replay and expiry fixture — 2026-10-22

Source **cf4249a979b61dfa30a6f444027bc8992410ba1a** corrects a real concurrent
owner-replay edge and makes an existing accounting session-expiry regression
deterministic. The [final focused log](final/run.log) passed **249 of249** cases
on each fresh/upgrade path, zero failures/skips, plus five treasury cases each.
These are disposable PostgreSQL17.10/Node24 tests with synthetic provider state;
they do not establish a hosted repair, provider mutation or returning login.
No new CI, deployment, full quality or browser acceptance is inferred.

## Failure chronology

The earlier [248-case reset overlap result](../logout-reset-overlap-20261022/README.md)
remains historical evidence for92f11b4. A later combined attempt exposed new
failures; earlier passes are not presented as covering them.

1. [Combined attempt1](history/integrated-permission-failure.log) built, then
   PostgreSQL failed `shmget` with `Operation not permitted` before tests. This
   was a local sandbox permission failure; no product code change was made for
   it. The permitted rerun is a separate attempt.
2. [Combined attempt2](history/integrated-barrier-failure.log) passed247 of248
   focused cases, failing because a short-session accounting test never reached
   its intended ledger lock. The test created a1.5-second session before initial
   transition/account authorization. That permits expiry **before** the barrier
   under load. The pending request's error was discarded in that exact failed
   run, so early expiry is a demonstrated fixture vulnerability and plausible
   explanation, not a captured cause for that run.
3. [The first fixture correction](history/fixture-and-replay-failure.log) passed
   246 of248, failing twice. Its temporary function incorrectly used UUID while
   `sessions.id` is BIGSERIAL/BIGINT, producing42883. It also exposed a **real**
   owner exact-replay race: a second initial audit read missed, the first owner
   committed the rearm, then the second manual-state snapshot rejected.
4. The [controlled RED](red/run.log) retained that old backend and added a
   deterministic audit-miss barrier. It passed247 of249 with exactly two replay
   failures: the original concurrent test and the new controlled interleaving.
   The raw log has no embedded source manifest; the recorded baseline is92f11b4
   with revocation hash `44fee9a8…`. It is not relabeled as the final source.
5. The corrected [final focused run](final/run.log) passed249 of249 on both
   paths and five separate Base-rail treasury cases each. The
   [fresh](final/database/fresh-account-security.log),
   [upgrade](final/database/upgrade-account-security.log) and catalog inventories
   retain their narrower local assertions. Catalog identifier:6112de56.

## Corrective behavior and independent review

The owner API now catches **only** a known snapshot rejection after the initial
audit miss. It rechecks the immutable audit with the exact account, request UUID
and terms digest. Only that committed exact receipt returns `created:false`.
It does not admit a changed state, issue provider requests, write another rearm
or extend the reset budget. Other errors still fail. The deterministic test
holds the first audit miss until another owner commits, then asserts canonical
replay, no extra provider inspection/RPC, unchanged account/queue and one audit.

The expiry test now starts with a valid session, observes initial authorization
and the actual ledger barrier, then expires **that session on its existing
runtime connection** after the held ledger query resumes and before the final
authorization check. A temporary owner-defined function is scoped to the exact
synthetic user, uses a fixed safe search path and fully qualified table, revokes
PUBLIC before granting execution to runtime in one transaction, and is dropped
in `finally`. It has the correct BIGINT signature. Base table grants and role
memberships are unchanged.

No application accounting code, authorization predicate, timeout or assertion
was weakened. The test explicitly requires initial authorization, the observed
ledger barrier, one expiry, final real-session rejection, unchanged round state
and exact book rollback on both existing-round return paths. The longer initial
lifetime removes premature expiry; the in-transaction fixture makes the final
expired state deterministic without sleeping or extending a product lifetime.

Independent review checked the exact final hashes against committedcf4249a:
phase `a69efe83…` unchanged; revocation `afe22136…`; phase tests `1b5c0c89…`;
accounting fixture `589bf70a…`. Full values and review boundaries are in
[summary.json](summary.json). The reviewer read the actual failures, final log,
source and test barriers; the author/root ran the isolated suites. The reviewer
did not run a database/provider operation. No blocking issue remained in this
specific correction; that is not whole-task or hosted-repair acceptance.

[manifest.json](manifest.json) binds the archived bytes. Original `.json.raw`
files have equal-value formatted counterparts. Copied logs were scanned for
database URLs, JWT-shaped values, private keys, DIDs, emails and secret-assignment
markers, with no matches. This bounded scan does not prove all current secrets,
history or screenshot pixels absent. Catalogs contain schema/privilege metadata,
not customer rows. The root's later combined gate remains a separate result.
