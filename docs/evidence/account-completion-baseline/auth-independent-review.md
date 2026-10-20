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

| Finding                                                                                                          | Correction inspected                                                                                                                                                                                                                  | Evidence and limits                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New payout approval/signing could proceed after suspension, strong-method removal or an uncertain correction     | `a651e8a` rechecks current account status, retained strong method and correction fence before new review approval/signed payout admission; safe rejection/reconciliation stays available                                              | Added real PostgreSQL negative cases. Their initial failures were invalid synthetic credential fixtures, corrected in `8d78b31`; a subsequent combined run is required.                                                                                          |
| A browser cookie change during a blocking confirmation could apply stale UI intent to a replacement session      | Financial POSTs carry a comparison-only observed session ID; account authority remains the verified cookie and PostgreSQL session                                                                                                     | The [coin browser](coin-sandbox-browser/README.md) actually obtains HTTP 409 after a cookie switch and proves no replacement-account stake or funds were created. This is a real local backend with synthetic identities and simulated funds.                    |
| An expired sign-out cookie was cleared by the server while the UI kept member controls visible                   | `b24116f` clears account/header state on 401 and explains that other-device sign-out is unconfirmed; delayed old account reads cannot restore private fields                                                                          | The [email browser results](after/browser-results.json) pass 35 desktop/mobile fixture checks, including held old identity responses and expired-signout screenshots. Provider and application responses are intercepted; this is not hosted logout evidence.    |
| An old pending session DELETE blocked replacement-account controls or could release a newer removal's busy state | `ebcea7b` assigns removal ownership to its account view and discards stale completion                                                                                                                                                 | The same actual browser fixture starts a replacement account's second removal while the old DELETE is held, then proves the old reply cannot unlock it or sign out the replacement account.                                                                      |
| A slow Privy inspection occupied the account lock and runtime pool, delaying local logout                        | Reported by a separate reviewer; `e085dc4` snapshots locally, performs the provider GET outside any checked-out connection/transaction, then revalidates SID, generation, DID/digest and provider-control job fingerprint under locks | Added a one-connection-pool barrier test, including held healthy/outage responses, retained-session generation changes and a transient owned freeze. These new PostgreSQL cases await the next combined run. No positive provider authorization cache was added. |
| An old speaker tab could win an automatic-reconnect race after a manual device replacement                       | `43a6de4` persists the intended current SID and expiry across retirement; only that intended automatic retry can claim the reserved replacement                                                                                       | Source and migration reviewed; deterministic PostgreSQL races were added by the media worker. Earlier combined media tests failed fixture role duplication and were corrected; current combined acceptance must be rerun.                                        |
| A delayed departure callback could pause a replacement speaker, including a check/pause race                     | `withSpeakerDeparture` orders the relevance check and `pauseWithClient` in the same account-fenced database transaction; provider permission updates happen afterward                                                                 | Source reviewed independently. New UUID/numeric-legacy/current/unknown departure and replacement-order PostgreSQL cases are present; actual combined test status remains separate.                                                                               |
| Closing multiple rounds could acquire a later account after earlier shared ledger locks                          | `d5d9c07` freezes a bounded batch in closing-time/ID order, prelocks its account union, then books/setup and all affected cash/promotional accounts before posting                                                                    | Source reviewed independently against funding, reservations, payout reconciliation and voiding lock order. No remaining inversion identified in this review; the new cross-feature concurrency suite must pass.                                                  |
| Existing-round returns skipped final caller expiry/context checks after settlement waits                         | `assertCallerSession` now guards all three `create` return paths and context-aware `advance` before commit                                                                                                                            | Source correction reviewed. A real ledger-lock wait regression checks that provisional settlement rolls back when the caller expires on either existing-round return path. Required execution is pending.                                                        |

The withdrawal consumer checks exact immutable quote terms and account/session
context before consuming a retained password, SIWE or WebAuthn proof in the same
transaction as source reservation and ledger writes. Final quote, proof and
session expiry checks roll back the mutation and passkey counter together.
Operation responses expose only the public challenge/options, expiry and exact
displayed terms. The reviewed owner-only external reconciliation retains
uncertain reserves and globally fences receipt reuse; treasury receipts credit
separate system buckets without issuing purchased coins or promotional principal.
These are source-review conclusions, not a new live-money acceptance claim.

The inspected diagnostic database log records the dedicated receipt-backed Base
treasury suite passing **4/4, zero skips**, on both fresh and upgrade databases.
Its subsequent 108-test combined phase recorded 91 passes and 17 failures before
the fixture fixes above; that diagnostic run is explicitly **not** a passing
combined release gate. The lead must record the next complete revision/run and
replace pending acceptance entries with actual results, without treating these
worker findings as test evidence.

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
Execution is pending the combined harness. Original hosted pre-reset cookies and
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
original-reset replay, final combined repository acceptance and physical/device
gates retain their explicitly recorded limitations.
