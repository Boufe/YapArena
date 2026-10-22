# Genuine passkey and wallet acceptance — 2026-10-21

Prepared by the account-security reviewer and inspected against the actual aggregate artifacts by the lead on 2026-10-21.
Runtime revision at these observations was `eba1dc5cfe6680a9a41e98482b64d3c725163a1b`.
This review made no database/provider/service calls or mutations. It inspected
the lead-executed aggregate reports and the lead-relayed human report. It is not
a second execution of either inspector or independent observation of the human
browser ceremony.

## Human-reported journey

The founder reported that setup succeeded, the same passkey worked when testing
the withdrawal simulation in Account settings, and an embedded wallet appeared
assigned. Returning sign-in initially did not work after signing out; the lead
subsequently relayed the founder's report that passkey sign-in worked. Preserve
both outcomes. This is a genuine user report, not a virtual-authenticator result,
automated browser trace, identified physical-device test, full recovery test,
screen-reader trial, financial payout or proof of the exact timing/cause of the
initial failed sign-in. No credentials or individual account details belong in
the public evidence.

## Actual read-only inspection sequence

1. At **22:31:49.592 UTC**, the maintained wallet verifier returned PENDING. Its
   local job was already `ready`, but local/provider-mapping generations did not
   match. The guard stopped after three Render GETs and one read-only database
   snapshot, **before any provider request**. Thus its false/default provider
   credential/ownership flags are unqueried, not evidence of a provider mismatch
   or incorrect ownership. It made zero mutations.
2. At **22:37:59.462 UTC**, the separate fixed-target phase diagnostic recorded
   one active mapped account, one accepted active Privy-origin key, wallet
   `ready`, and **zero generation mismatches**. Same-subject jobs were five
   complete, zero busy and zero manual. The current/latest job was `done`, with
   one attempt and two reads; both freeze/unfreeze acknowledgements, exact
   accepted control binding and acknowledged-freeze request-window checks were
   true. The release postflight already contained two historical complete jobs:
   do not call all five new normal-engine runs. Only the displayed current/latest
   job has those inspected phase fields. This single local snapshot establishes
   neither provider state nor the cause/timing of the earlier mismatch. It used
   verified client TLS/read-only owner SQL and made zero external requests or
   mutations.
3. At **22:38:05.119 UTC**, the maintained wallet verifier returned **PASS:
   confirmed_user_owned_wallet** on exact deployed `eba1dc5`. Its two read-only
   database snapshots and repeated provider reads agreed: job ready, generation
   match, accepted snapshot present, current credentials matching, expected
   user-only owner and no additional signer/policy. It made eight provider GETs,
   four Render GETs, two database snapshots and zero mutations; database owner
   connections closed before provider reads. This establishes the current
   inspected user-controlled wallet ownership/configuration. It does not
   establish default recovery execution, signing, funding, withdrawals, all five
   financial routes, physical-device behavior or live eligibility.

The reports therefore support current successful local synchronization and
provider wallet ownership inspection, alongside the genuine user's later
successful sign-in report. They do **not** establish a backend phase defect or
prove that the first sign-in failed because of a specific in-flight job. No
supersession/coalescing repair or security-fence relaxation follows from this
timeline. Separately, an actual classification defect in the generic frontend passkey
error message was independently reproduced and corrected in `3096ca7`;
its [separate 125-check acceptance](../../passkey-signin-errors-20261021/README.md)
does not diagnose this earlier genuine failure. Deployment evidence retains its
own exact-source scope.

## Evidence provenance for archival

- Phase helper: `provider-phase-diagnostic.mts`, SHA256
  `f67f922f98bb3714f00577ddb01cdb01c4e84848bfcf868c058263ec59ed9e4d`.
  Strict NodeNext/noUncheckedIndexedAccess/exactOptionalPropertyTypes no-emit
  checking and formatting passed. This reviewer authored the helper; the lead
  reviewed and executed it. This is an authorship limitation, not an independent
  execution claim.
- Phase output: `provider-phase-diagnostic-1792622279462.json`, SHA256
  `c82971a8353ccb47a6d3d826aabbce529317ab7c356b93f9fbf0091b067a2aaf`.
- Successful wallet output: `embedded-wallet-1792622285121.json`, SHA256
  `f63f1c7b4758c04445c2e4c9d2d6f8c7f3a28809fc45d67120bdd01caf84dfaa`.
- The wallet verifier remains SHA256
  `5000fcc118e5be8be9d1c62a8c0263c9eb13f8020e09a79e71d9bc9cf92e90ff`;
  its report pins its exact imported sources and manifests.
- The earlier 43-to-45 fingerprint helper remains unchanged at SHA256
  `5bfb0d3676cda21f455eda08f8e8a8bec3b9a3c3f56db7166a1a32aced791b37`.

The aggregate reports are archived beside this record as [earlier pending state](wallet-before-synchronization.json), [local phase snapshot](provider-phase-readonly.json) and [provider ownership PASS](wallet-ownership-pass.json). Earlier release-time PENDING evidence remains unchanged. The overall task remains
incomplete at the remaining genuine recovery/email/Google/retained-wallet,
physical/accessibility, hosted-operational and live legal/provider/custody/
network/backing requirements. No live financial activity, additional account
deletion, provider mutation or new paid service is authorized by these results.

## Persisted sandbox authorization match

At **22:59:27 UTC**, the lead executed a separately reviewed, strict-TypeScript
fixed-target [read-only inspection](sandbox-authorization-readonly.json). It
matched **one consumed Privy-passkey withdrawal authorization**, its success
audit and exact request terms/digests to one same-account sandbox reservation:
exact sandbox/USDC/precision/operation/gross scope and the two available-debit /
reserved-credit postings. One simulation book and one completed simulated funding
request exist; journal sums balance and stored user balances match postings in
this snapshot. Live journal/grant-lot counts remain zero. No amounts, destinations,
IDs, session hashes, signatures or individual financial timestamps were exported.
The check used verified client TLS, one non-superuser owner read-only snapshot,
zero provider/service calls and zero mutations. An initial sandboxed connection
attempt failed before a result; the permitted network invocation produced the
archived report.

The private helper SHA256 is
`3d13d2b2770480b93047cfd345ffcfd4e2bfc2560ba9733119c373352452e9ec`.
The lead authored/reviewed/executed it; a separate account-security reviewer
strengthened and reviewed the SQL/evidence guard and independently read the
actual aggregate report, without claiming a second execution. Strict no-emit and
format checks passed. Empty results explicitly give `NOT_ESTABLISHED`; this
positive match is not inferred from vacuous invariants.

This supports the recorded genuine native operation-proof requirement alongside
the separate local replay/cross-account/expiry/atomicity regression suite. It
does not establish a manual approval, current request status, provider/chain
funding, a payout, recovery or full device coverage. There are **zero welcome
lots, daily lots and grant events**: the grant constraint booleans do not establish
any genuine hosted grant issuance. The completed funding record is a deterministic
simulation, not external backing. Earlier statements that the exact proof/receipt
had not been independently matched are superseded only within this narrow scope.

The later [guarded owner simulation trial](../../operator-pooler-20261021/README.md)
records approval and a completed deterministic receipt for this same existing
proof-matched request at runtime3096/operator e8. That later observation does
not rewrite the read-only snapshot above or establish provider/chain settlement.
