# Early independent security and financial review

Reviewed the working tree based on `d405845` on 2026-10-20. This is an early
read-only review of evolving implementation, not a final completion audit.
Inspected the account-operation/passkey modules and migrations, provider monitor
and revocation flow, session APIs/browser controller, ledger writer, external
state reducer, Base Sepolia adapter and their available tests. No shared code was
edited during review. Findings were sent to the lead before further implementation.

| Priority                   | Finding                                                                                                                                                                                         | Required response / evidence                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High                       | External reducer accepts a truthy nonboolean `finalNoTransfer`; a fixture with string `"false"` and otherwise valid failed reconciliation returned `release` in the built module.               | Validate boolean shape and require literal true; malformed provider-input test. No exposed financial route existed at review time.                                                                                                            |
| High integration condition | Identical terms can have identical digests across distinct local operations. A first observation can supply any external ID when the prior ID is null.                                          | Persist unique environment/provider/external-operation ownership; bind authoritative lookup to original local operation/idempotency identity; deduplicate transfer locators. A pure per-operation reducer cannot establish global uniqueness. |
| High integration condition | Concurrent Base Sepolia operations can read the same custody-sender nonce and prepare competing signed identities if only each operation is locked.                                             | Serialize/reserve nonce by environment/network/sender, persist assignment before broadcast, and reconcile replacement identity without early reserve release.                                                                                 |
| Medium                     | Session-removal UI lacks the version guard used by session-list reads. A delayed prior-account response can trigger signed-out UI/provider events after account change.                         | Bind pending removal effects to the initiating account/session version and test delayed response across sign-out/re-login.                                                                                                                    |
| Provider limitation        | Provider state/read/freeze/unfreeze has no conditional write or ownership identifier. PostgreSQL orders local writers but cannot exclude a concurrent independent dashboard/integration freeze. | Test/document the race; obtain a supported control policy or provider mechanism before claiming arbitrary independent incident freezes are preserved. Pre-existing freeze tests cover a narrower boundary.                                    |
| Availability boundary      | Provider control holds the account lock across calls bounded together to 20 seconds. Account-wide revocation can wait behind it; current-session deletion can remain independent.               | Record measured bound and test local logout/revocation routing during provider outage. Do not claim immediate account-wide revocation under this lock.                                                                                        |

Positive observations: account approvals lock account, session and operation in
order; recheck generation, retained credential and wall-clock expiry; consume
proof with mutation in one caller-owned transaction; bind exact terms and session.
Passkey assertions require user verification and update counters under lock.
Ledger writes lock financial accounts in stable order, compare idempotent terms,
and rely on database balanced/sealed/exact-reversal constraints. Runtime ledger
access remains read-only. These observations do not establish complete integrated
workflows or hosted/provider/device acceptance.

Requested additional tests: operation expiry during mutation; session expiry
during mutation; passkey counter/proof rollback after callback failure; concurrent
same-terms external-operation mapping; conflicting custody nonce; delayed session
removal response after account change. The lead owns disposition and final
integrated evidence.
