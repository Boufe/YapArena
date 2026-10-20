# Independent authentication-transition review

Reviewed the account-access work authored by the separate authentication agent
at `44fefb3`, cleanup `07bfe9b`, and the follow-up precision fix `e9a0168`.
This is a source/state-transition review, not a substitute for the lead's final
combined quality, PostgreSQL, hosted or device gates.

Scope: `account-access.ts`, `provider-credentials.ts`, `provider-accounts.ts`,
`provider-session-monitor.ts`, `privy.ts`, `security-router.ts`, migration
`1792426007000`, the reconciliation component in `frontend/account-auth.tsx`,
and server wiring of shared IP/account attempt controls.

One availability finding was identified and fixed:

- **P2 — same-millisecond discoverable-login rejection.** A challenge created
  immediately after a credential/generation change could lose PostgreSQL
  microsecond precision through a JavaScript `Date`, placing the stored challenge
  before the change even when it was newer. `e9a0168` inserts challenge times
  using one database-clock CTE and compares the persisted database rows directly
  with strict `<`. Review confirmed this preserves the revocation fence. The
  added regression constructs distinct microsecond timestamps within the same
  JavaScript millisecond. The lead's actual isolation log
  `/private/tmp/yaparena-email-security-isolation.log` records this regression
  passing in both fresh and upgrade runs (90 tests, zero failures or skips).
  Later financial additions still require a subsequent combined run; this
  recorded auth result does not establish their acceptance.

No additional high-severity issue was identified in the reviewed transitions:

- Reconciliation identifies the account through a server-verified provider DID,
  accepts the same DID only, and binds the exact current provider SID, old/new
  credential digests, account generation and one-use expiring challenge.
- Old unknown credential snapshots require review; email-only reconstruction
  must reproduce the already stored digest. Matching email addresses do not
  merge accounts or invent a Google subject/passkey ID.
- The retained key/password/wallet is verified server-side. Current provider
  state is re-read, challenge consumption and the replacement application cookie
  occur transactionally, and earlier consumed SIDs remain fenced against normal
  exchange. Provider-token refresh and token issuance time are not fresh proof.
- Discoverable app-security-key login checks user handle, RP/origin, user
  verification, credential/counter, current provider state and the database
  generation fence. It does not manufacture a Privy session.
- Protected-cookie inspection fails closed on provider outage; local logout
  and revocation remain separate. Sessionless access routes enforce the exact
  origin and bounded IP/account attempt scopes.

The separate [real-backend browser trial](security-passkey-browser/README.md)
actually ran native browser registration/assertions against runtime PostgreSQL
for enrollment, retained-key approval, removal and replay/cross-account/session
checks. It did not exercise genuine Privy reconciliation or physical hardware.

Remaining material limitation: the supported provider freeze/unfreeze API does
not expose a conditional ownership/CAS primitive in the inspected contract.
The application orders its own work with PostgreSQL locks, but an independent
dashboard freeze can race an automatic unfreeze. Production must not silently
assume exclusive provider mutation. The operator policy/provider capability must
be explicitly resolved and documented; local suspension remains authoritative.
Current hosted optional Google/passkey availability is configuration acceptance,
not genuine login/linking/returning-user acceptance.

## Follow-up integration review, 2026-10-20

The authentication worker independently reviewed the lead's financial router,
session-management integration, and the separate media worker's grant/revocation
changes. This supplements the earlier provider worker's review above. Corrections
authored by the authentication worker are identified below; their own author
review is not presented as an independent security sign-off.

| Finding                                                                                                          | Correction inspected                                                                                                                                                                                                                  | Evidence and limits                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New payout approval/signing could proceed after suspension, strong-method removal or an uncertain correction     | `a651e8a` rechecks current account status, retained strong method and correction fence before new review approval/signed payout admission; safe rejection/reconciliation stays available                                              | Added real PostgreSQL negative cases. Their initial failures were invalid synthetic credential fixtures, corrected in `8d78b31`; the subsequent focused fresh/upgrade run passed both negative cases.                                                                              |
| A browser cookie change during a blocking confirmation could apply stale UI intent to a replacement session      | Financial POSTs carry a comparison-only observed session ID; account authority remains the verified cookie and PostgreSQL session                                                                                                     | The [coin browser](coin-sandbox-browser/README.md) actually obtains HTTP 409 after a cookie switch and proves no replacement-account stake or funds were created. This is a real local backend with synthetic identities and simulated funds.                                      |
| An expired sign-out cookie was cleared by the server while the UI kept member controls visible                   | `b24116f` clears account/header state on 401 and explains that other-device sign-out is unconfirmed; delayed old account reads cannot restore private fields                                                                          | The [email browser results](after/browser-results.json) pass 48 desktop/mobile fixture checks, including held old identity responses and expired-signout screenshots. Provider and application responses are intercepted; this is not hosted logout evidence.                      |
| An old pending session DELETE blocked replacement-account controls or could release a newer removal's busy state | `ebcea7b` assigns removal ownership to its account view and discards stale completion                                                                                                                                                 | The same actual browser fixture queues a replacement account's second removal behind the old DELETE, then proves the old reply cannot unlock it or sign out the replacement account.                                                                                               |
| A slow Privy inspection occupied the account lock and runtime pool, delaying local logout                        | Reported by a separate reviewer; `e085dc4` snapshots locally, performs the provider GET outside any checked-out connection/transaction, then revalidates SID, generation, DID/digest and provider-control job fingerprint under locks | Added a one-connection-pool barrier test, including held healthy/outage responses, retained-session generation changes and a transient owned freeze. All three barrier cases passed in the recorded focused fresh/upgrade run. No positive provider authorization cache was added. |
| An old speaker tab could win an automatic-reconnect race after a manual device replacement                       | `43a6de4` persists the intended current SID and expiry across retirement; only that intended automatic retry can claim the reserved replacement                                                                                       | Source and migration reviewed; deterministic PostgreSQL races were added by the media worker. The recorded focused fresh/upgrade run passes the replacement, lease and expiry races; hosted application/outbox acceptance remains separate.                                        |
| A delayed departure callback could pause a replacement speaker, including a check/pause race                     | `withSpeakerDeparture` orders the relevance check and `pauseWithClient` in the same account-fenced database transaction; provider permission updates happen afterward                                                                 | Source reviewed independently. New UUID/numeric-legacy/current/unknown departure and replacement-order PostgreSQL cases are present; these cases pass in the recorded focused fresh/upgrade run; hosted application behavior remains separate.                                     |
| Closing multiple rounds could acquire a later account after earlier shared ledger locks                          | `d5d9c07` freezes a bounded batch in closing-time/ID order, prelocks its account union, then books/setup and all affected cash/promotional accounts before posting                                                                    | Source reviewed independently against funding, reservations, payout reconciliation and voiding lock order. No remaining inversion identified in this review; the cross-feature concurrency and closing-order cases pass in the recorded focused fresh/upgrade run.                 |
| Existing-round returns skipped final caller expiry/context checks after settlement waits                         | `assertCallerSession` now guards all three `create` return paths and context-aware `advance` before commit                                                                                                                            | Source correction reviewed. A real ledger-lock wait regression checks that provisional settlement rolls back when the caller expires on either existing-round return path. Both return-path wait cases pass in the recorded focused fresh/upgrade run.                             |

The withdrawal consumer checks exact immutable quote terms and account/session
context before consuming a retained password, SIWE or WebAuthn proof in the same
transaction as source reservation and ledger writes. Final quote, proof and
session expiry checks roll back the mutation and passkey counter together.
Operation responses expose only the public challenge/options, expiry and exact
displayed terms. The reviewed owner-only external reconciliation retains
uncertain reserves and globally fences receipt reuse; treasury receipts credit
separate system buckets without issuing purchased coins or promotional principal.
These are source-review conclusions, not a new live-money acceptance claim.

The [recorded focused acceptance](financial-review/README.md) identifies revision
`58e7b2749b644aeac4695cd2bacb2826cd61c20a` and preserves the actual complete
output: **143/143** tests on each fresh/upgraded simulation database and **5/5**
on each physically separate fresh/upgraded Base treasury database, zero failures
or skips. This reviewer read the output, including proof expiry/counter rollback,
provider-inspection barriers, wallet/reset replay, account/session revocation,
media races, settlement lock order, payout eligibility, report consent and
runtime/owner SQL denials. This supersedes the earlier failed 108-test diagnostic;
it is focused local evidence, not the final full repository coverage/browser gate.
The subsequent browser cookie/logout changes at `7e813e3` have separate evidence
below and require the final integrated gate.

The [hosted Cloud trial](media-cloud-revocation/README.md) separately establishes
actual provider disconnection and rejection of both an original token and a
genuine server-refreshed token through the compiled explicit-cutoff provider
method. The independent viewer stayed connected and could rejoin. The raw helper
exit remains nonzero because automatic room expiry exceeded its initial cleanup
window; a separate read-only postflight verified zero rooms within the approved
two-minute bound. This does not establish end-to-end application logout/outbox,
physical media, audio/video quality or screen-reader acceptance.

`f72e3c4` adds a **local disposable PostgreSQL reproduction**, not an original
hosted reset replay: create synthetic legacy password/wallet credentials, session
and known-wallet challenge; delete only that disposable account through the owner
connection; reject its old cookie/password and two delayed signed callbacks;
prove no old ID or wallet is recreated and another retained fixture still works.
The reproduction passes in both recorded focused fresh/upgrade runs. Original hosted pre-reset cookies and
callbacks are unavailable. The reset operator was inspected without execution:
explicit mode/scope, target host/database/project/staging/origin, separate owner,
stopped writers, private encrypted backup, exact-scope restore rehearsal,
exclusive table fence and unchanged source fingerprints remain required. No
additional hosted account deletion or reset was performed.

The current audit's ten moderate entries follow the existing Privy browser wallet
dependency graph to the [uuid buffer-bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
No new SimpleWebAuthn or direct server-financial dependency appears in that
advisory set, and application identifiers use `node:crypto.randomUUID` rather
than the affected uuid APIs. This does not prove every SDK call path harmless.
The suggested forced Privy downgrade is not an accepted remediation; a compatible
upstream wallet dependency update and renewed acceptance are the appropriate
follow-up.

Losing every retained strong method still requires review. There is no approved
automated identity-adjudication process, and an application security key cannot
mint a Privy token. Do not describe that boundary as completed lost-all-methods
or lost-sole-email recovery. Genuine hosted email-change/link/remove/recovery,
original hosted reset replay, final combined repository acceptance and physical/device
gates retain their explicitly recorded limitations.

The subsequent retained-credential UI correction cancels its active dialog and
native ceremony on every account-change notification, invalidates pending old
results, and erases the detached password input. The actual email fixture now
switches accounts while the old dialog is open, enables the same synthetic
password on both identities, proves no follow-on operation was issued, and
opens/cancels a fresh replacement-account approval. These checks do not establish
provider or physical-security-key acceptance.

`979281c` also clears private account fields immediately while checking a changed
session, hides both authentication sections until the result is known, and keeps
a local account-wide sign-out action usable during initial or continuing
inspection outages. The actual fixture holds inspection, switches identity,
returns 503, reloads into the outage and proves a single logout remains usable.
It checks mobile layout and desktop 200% CSS zoom. This is still intercepted
local UI evidence.

A subsequent **P2** was fixed in `7479c1f`: deleting the shared HttpOnly cookie in
an old revocation response could delete a replacement account's cookie before
the browser-side stale-result guard ran. All revocation responses now leave the
opaque cookie untouched; PostgreSQL revocation still makes the old value invalid,
and a new sign-in overwrites it. Missing or expired authorization still returns
401 without claiming account-wide success. A real HTTP cookie-jar regression
registers the replacement account while six older successful/rejected revocation
requests are held, releases them, then proves the replacement cookie still
authorizes `/me`. The final focused compiled HTTP/UI/signing command passes **37/37**, including
20 auth API tests and the six-scenario real HTTP cookie-jar regression. The
PostgreSQL describe requires its guarded URL and is omitted from this standalone
command; its actual acceptance is the focused fresh/upgrade record above. The
earlier JSON-only session fixture establishes UI ownership only.

The provider session-control job has a distinct bounded cumulative 20-second
external-control deadline while holding its account fence. Initial logout queues
that provider work after local revocation; another local revocation can wait for
the remaining bounded control attempt if the job already owns that account lock.
This is not an immediate provider-independent completion guarantee. The browser revocation HTTP request has a ten-second timeout after a bounded
35-second browser-lock wait and reports an unconfirmed result if it cannot observe
completion; its caller deadline is 45 seconds. With no cookie issuer pending,
logout acquires the browser lock immediately. The provider-inspection pool/lock barrier tests
cover the separate GET path, not the control job's bounded lock interval.

The new deposit/payout error-report source restoration contract was independently
reviewed in source. It excludes ordinary debate losses and virtual grant
principal. Account and original-request locks serialize cumulative restoration
across every report for that original debit; immutable persisted slices retain
their purchase/grant categories, and separately funded correction cash, book
credit and report receipt commit together. Qualification net profit and peak
remain unchanged. A separate deterministic in-memory review exercised 1,125 mixed
principal/profit/qualified-grant combinations and partial credit sizes, checking
conservation, per-source cumulative caps, full original-book restoration and
over-restoration rejection. It passed against the TypeScript source through
Node 24's experimental type transform. This is pure helper verification, not a
database, provider or funds test. The report/consent PostgreSQL cases pass in the focused fresh/upgrade record;
native browser and provider acceptance remain separately recorded.

The additive owner-boundary migration `c5de858` was independently inspected:
runtime withdrawal insertion stays quoted, its only status change is quoted to
review, owner approval/signing/external-event evidence is denied to runtime, and
runtime nonce insertion is revoked. Existing immutable kind/terms prevent
retagging around the guard. The focused record includes actual runtime SQL
denials and owner offline signed-identity/nonce idempotency cases on both database
paths. This is role-boundary acceptance, not RPC or live signing acceptance.

## Browser cookie issuance and logout ordering

A separate reviewer identified a second **P2** after the cookie-deletion fix:
credential completion can commit a replacement session while its HTTP headers
are delayed. Logout with the now-invalid old cookie can return 401, after which
the delayed completion could install an active cookie. Browser-only result
epochs cannot prevent that header effect.

`00202e3` adds the origin-wide Web Locks coordinator for all eleven application
cookie-issuing paths. Follow-up `7e813e3` also orders default/all/other/specific
revocation behind issuance, so revocation uses the completed replacement cookie.
Signing/registration ceremonies are outside the lock. Reads stay unlocked;
issuance has a ten-second queue and thirty-second HTTP deadline; revocation has
a 35-second queue and ten-second HTTP deadline. Queue/HTTP failure is reported as
unconfirmed, never successful logout. No provider call or positive authorization
cache is added to this browser ordering.

A queued login for a different account must not turn an old logout into revocation
of that new account. The browser captures its last server-verified account before
waiting; the server compares that optional header only against the account already
authenticated by the cookie and returns 409 on mismatch. The header never selects
an account or grants authority. Missing context supports initial inspection-outage
logout and direct API compatibility. Logs redact the comparison hint. A stale
completion whose known account remains the same requests a fresh server lookup;
it never applies an old provider-logout event or private notice, and cannot release
a newer session removal's busy owner.

The [actual HTTP browser trial](session-coordination-browser/README.md) passes
seven groups using native Chromium, actual two-tab Web Locks and HttpOnly cookies:
all eleven issuer paths, all four revokers after committed rotation with delayed
headers, a different-account queued login followed by old-account logout409,
held response bodies, actual ten/30-second timeouts, and unsupported capability
rejection. This is cookie ordering evidence. The synthetic server simplifies
individual deletion to fixture-wide revocation; actual selected-SID removal and
rotation-induced 404 semantics are covered separately by compiled HTTP and guarded
PostgreSQL tests. The [email/account fixture](after/README.md) separately passes 48
checks at `7e813e3`, including desktop/mobile same-account stale logout convergence,
replacement-account ownership, outage sign-out and 401 handling. Provider/OTP
responses in that fixture are intercepted; it is not hosted provider acceptance.

This design is limited to cooperating supported application browser flows.
Uncoordinated API clients do not participate. Actual observed abort/late-header
behavior is established for the recorded Chromium version, not physical hardware
or every browser engine. Unsupported Web Locks fails clearly rather than silently
using weaker session mutation ordering. The design follows the current
[Web Locks specification](https://w3c.github.io/web-locks/) and
[Fetch specification](https://fetch.spec.whatwg.org/); those standards do not
replace the recorded native test or remaining release gates.

## Pre-deployment continuation, 2026-10-20

Reviewer: authentication workstream (`/root/auth_security`). This continuation
inspected the integrated source, logger/configuration, sessions and fixed-target
staging helpers at `d13a209`, alongside the sanitized read-only staging evidence.
It is independent of the lead's integration work. The reviewer authored the new
identity-replacement module and the two narrow fixes below. The provider reviewer
separately inspected identity replacement; the lead accepted the two narrow fix
diffs. Compiled checks and the final combined gate remain required.

Two concrete defense gaps were identified:

- Financial `X-YapArena-Session` comparison hints were not redacted from HTTP
  headers, although the analogous expected-account hint was. The narrow fix
  adds redaction and a real HTTP completion-log assertion that preserves the
  route/status while omitting the private correlation value. It is not an
  authorization-token exposure.
- The runtime startup guard omitted the newly introduced operator variable
  `COIN_SANDBOX_OWNER_DATABASE_URL`. The narrow fix rejects that variable with
  the existing owner/admin-secret guard. The actual staging inspection found
  no deployed owner credential; this closes accidental future injection.

Both fixes pass strict server checking, lint and formatting. After the shared
build, the actual compiled logger/configuration suite passed **42/42**, with no
skips, at `454468f`; the final combined run remains pending in this note. No additional critical source finding was identified in this scope.
Existing cookie protections, replay/generation fences, provider inspection
outside the pool, exact origin checks and private error serialization remain
intact. Helmet's installed default sends `Referrer-Policy: no-referrer`; the
request logger also strips Privy callback query values. The provider-control
worker can hold an account ordering lock for its bounded 20-second cumulative
provider deadline. A contending local revocation can therefore wait for that
worker even though ordinary inspection outages hold no pool connection or
account lock. A timed-out browser action remains unconfirmed.

The read-only staging preflight records PostgreSQL **17.6**, 28 applied and
exactly 13 reviewed pending migrations, four preserved accounts (three retained
plus the subsequent manual account), no selected-reset accounts and no live
journals/grants. The browser roles have no private-schema access and the runtime
cannot assume owner, own objects or write migration history. These observations
are preflight evidence, not evidence that migration or deployment occurred.
The release helper pins the target/roles/TLS, matches the exact migration list
and hashes, requires an encrypted private backup with exact restore/migration
rehearsal and rechecks retained rows/sequences before owner-only application.
Stopped Render writers and the final deployed revision/readiness must be
verified separately; an environment assertion or idle-connection sample does
not stop writers. The private schema backup is not a complete provider/global
role disaster-recovery backup. New-revision maintenance must actually run to
drain revocation jobs; the separate replay encoder is not that maintenance loop.

A provider-maintenance risk remains distinct from these additive migrations:
Supabase's current [PostgreSQL minor-release notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes)
describes an upgrade from 17.6 to 17.11 with security fixes and compatibility
checks for certain extensions/operators. The observed project is still on
17.6. Availability of that upgrade for this project has not been verified, no
YapArena-specific exploit has been demonstrated, and this review grants no
authority to change database versions, plans or provider settings. Record and
check the provider's maintenance path before production release. Application
sources do not use the notice's legacy PGP encryption or `ltree` features;
this is not a reason to block the independently reviewed 13 additive migrations
on an assumed application vulnerability.

Genuine hosted provider journeys, physical-device/screen-reader acceptance,
provider incident-freeze ownership, all-strong-methods-lost adjudication and the
live financial release gates remain separately required. Local protocol,
intercepted-SDK and native Chromium evidence must retain their distinct labels.

The separate provider reviewer subsequently found an early authentication-error
cache-policy gap: a missing/expired cookie was rejected before downstream
private feature middleware could install its cache headers. The lead accepted
a narrow correction in `createRequireAuthentication`: set `private, no-store`
and merge `Cookie` into `Vary` before any token lookup. New real HTTP assertions
cover missing, expired and accepted cookies, preservation of an existing Origin
vary value, and the real application's provider-outage error handler. Strict
checking, lint and formatting pass; the compiled auth regression and final
combined gate are pending. This changes response headers only, leaves public
routes untouched, and does not claim a new paid Cloud or hosted replay trial.
