# Independent provider control phase review

Read-only review on 2026-10-21 at checkout HEAD
`030b60ea0974b70edecf74b322935dc991a17fb1`, with the following uncommitted
implementation fingerprints:

| File                                                      | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/platform/auth/provider-control-phases.ts`            | `3623eab43917997a1aba9fdd3d68cffa922307f2eda906e00a9805a9f10058a7` |
| `migrations/1792426015000_add-provider-control-phases.js` | `07163766753d22498e9c9308817dbd9c6c6fb7928abb3ea7cd4ccded37e4c3ad` |
| `src/platform/auth/provider-revocation.ts`                | `50b37b1e0ca155ed5923708f4129ec971ebe7c94136c485cf29b67a567798bcc` |
| `tests/provider-control-phases-postgres.test.js`          | `9c7df10f23f9f792ac45314fa039a63bbfaf1e65d1c134e083c8593336cdf18b` |

No remaining blocking authorization, credential-adoption or mutation-replay
defect was identified in this source review after two findings were corrected:

1. A normal phase worker could mark a newly claimed owner retry manual in the
   gap between its claim commit and its next account lock. The phase worker now
   respects that distinct attempt's unexpired legacy lease; after expiry it
   remains conservative. The added test places a competing normal tick exactly
   after the owner's claim commit and requires zero provider calls, the owner
   claim still running, and its eventual single reset completion.
2. Final mutation admission now checks both the phase deadline and claim lease
   after waiting for the account lock, rather than relying only on the earlier
   read-result check.

The reviewed implementation commits an intent before each mutation. Only a
positively acknowledged freeze/unfreeze enters a resumable GET confirmation
phase. Lost responses, acknowledgement-persistence failure and expired intent
leases cannot automatically repeat the mutation. Confirmation phases keep a
finite read/deadline budget and release pool connections during propagation
reads. Account generation, provider subject, accepted digest, attempt and lease
fences reject late results and superseding work. Unresolved earlier control
attempts fence newer generations. Local session revocation remains authoritative
while remote reset is pending or manual; mapping generation and token cutoff
advance only after the required observed outcome.

The migration preserves legacy/manual uncertainty instead of manufacturing an
acknowledgement for old work. Suspension keeps the provider frozen. Reset
completion does not accept new credentials, enroll a key or issue a cookie.
The existing separately guarded operator repair remains a distinct path.

This reviewer inspected the deterministic PostgreSQL regression source but did
not execute that suite in this review. Actual fresh/upgrade results belong to
the lead's separately recorded run. No hosted database or provider mutation was
performed. A successful provider response and a matching timestamp window are
provider observations, not a provider-issued operation ownership identifier;
unknown or independently changed outcomes remain manual. This document does not
establish hosted propagation latency or guarantee against an administrator
changing provider state independently after a read.

## Same-day selector and held-owner follow-up

The original snapshot above is preserved. The lead's r3 integrated execution
subsequently exposed an availability defect that the earlier source review and
claim-commit barrier did not catch: the normal selector still selected an
owner-reviewed attempt, then waited for its account lock before the claim-level
guard could decline it. A held owner provider read made that ordering observable.

The independently reviewed correction excludes an unexpired running owner
attempt with a distinct legacy/control attempt at the selector, before any
account lock is taken. The claim-level lease guard remains a second check if
selection races with a new claim. Expired mismatches remain conservative; this
does not authorize mutation replay or accept credential changes. The additional
deterministic regression holds the owner's provider GET while requiring a
competing normal tick to finish within 1.5 seconds with no provider calls and
without changing the owner's running job; the owner then finishes its one reset.
No remaining blocking issue was identified in this narrow re-review.

| File                                             | Follow-up SHA-256                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `src/platform/auth/provider-control-phases.ts`   | `3623eab43917997a1aba9fdd3d68cffa922307f2eda906e00a9805a9f10058a7` |
| `src/platform/auth/provider-revocation.ts`       | `49a4e3bc97f5602d640b305b8dcd3de24f1cc4b35220dc232cd25d8cb2599897` |
| `tests/provider-control-phases-postgres.test.js` | `91a5fbb0aedeb729a4b1c0fae95d1674756649e3c4895a441142eddcce034c9e` |

This reviewer inspected the actual lead-run r4 output at
`/private/tmp/yaparena-wallet-phase-integrated-r4.log`: the fresh isolated account
suite passed 235/235 with zero skips, including all 11 phase cases. That gate then
stopped at a historical evidence JSON formatting check, so this is **not** an
overall r4, upgrade, hosted or genuine-provider acceptance claim. The lead's next
complete gate must establish those separate current results. This re-review
performed no provider calls or database mutations.

## Final integrated output inspected

The reviewer subsequently inspected the lead's actual r5 log at
`/private/tmp/yaparena-wallet-phase-integrated-r5.log`: final exit was successful,
with 854/854 quality tests, zero skips, 235/235 focused account tests on each of
fresh and upgrade databases, and all 11 phase cases in both. The A4 database
suites passed 17/17 on each, and the separately isolated Base treasury suites
passed 5/5 on each. The integrated browser release gate also passed. These are
the lead-executed local results inspected by this reviewer, not a second
independent execution or a hosted/provider propagation trial. The selector and
phase fingerprints in the same-day follow-up remain unchanged.

## Accepted-credential wallet wake follow-up

After the r5/a970 boundary, the wallet retry-budget issue required a narrow
normal-reset completion hook. This reviewer inspected the new source at
`11935ce851d67589258032a8033c2db871491cfc703c75107669d5cef6937a3f`
and phase tests at
`8a344febfeaec90b27f389e19aa4b2323ec632409bd6835a40872e0ea0432865`.

The hook runs only after confirmed unfreeze, nonnull accepted digest, the exact
mapping generation/cutoff update and job completion, inside the same account
transaction. The wallet helper independently matches active owner, DID,
generation and digest and can only rearm the parked verification state, without
resetting its retry budget. It does not accept provider credential changes or
weaken the reset fence. Wallet claims commit their row lock before acquiring the
account checkpoint, so this account-to-job hook adds no opposing lock order.

The new twelfth case uses actual signed same-key activation, observes the
generation mismatch/park, completes the normal reset, then races two wallet
workers and requires exactly one create with preserved ownership/provenance.
No blocking source issue was identified. Execution of that new case belongs to
the next lead-run PG/combined gate; the earlier 11-case and 854-test results must
not be relabelled as its acceptance.

## Dated wake-hook execution inspected — 2026-10-21

The pending execution boundary above is preserved. The reviewer then read the
actual new fresh and upgrade account logs under
[`wallet-verification-pause/integrated/database`](../wallet-verification-pause/integrated/database/fresh-account-security.log).
Both pass **239/239** with zero skips, including all **12 phase cases** and the
real signed activation → parked wallet → confirmed normal reset → two-worker
single-create case. The combined local gate passes **858/858** with zero skips
and the new native run passes **18 groups**, errors empty.

All eight supplementary source/compiled fingerprints and all 62 copied artifact
hashes were independently recomputed against the archive manifest. No mismatch
was found; formatted/raw JSON copies were also checked for semantic equality.
The five files in commit `2efc95cff5f112653a392ba4e8edbaf9ef2ec557` match the
frozen correction hashes, including this phase hook and its tests. These are
inspected lead-executed local runs, not a second PG execution by the reviewer or
genuine provider propagation acceptance. New exact-source CI/release remains a
separate requirement; the failed earlier a970 CI is preserved.
