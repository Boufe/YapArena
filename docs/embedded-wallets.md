# Embedded wallet provisioning

Current scope: the founder approved automatically provisioning one user-controlled
Privy Ethereum/EVM wallet with Privy's default recovery. This supersedes the earlier
decision to leave all embedded-wallet provisioning off. New external-wallet linking
is removed from the product. Retained wallet sign-in and security records remain.

The wallet is separate from YapArena's internal YC ledger. Creating it does not
issue YC, enable deposits, authorize transactions, select financial custody or close
the requested Ethereum/Base/Solana/BNB/Bitcoin funding-route requirements. Those
routes still need provider and eligibility acceptance. Solana wallet creation is
not enabled by this EVM-only decision.

## Verified provider and SDK contracts

Rechecked against official documentation on 2026-10-21 and installed
`@privy-io/react-auth` 3.50.0 / `@privy-io/node` 0.36.0:

- [Automatic creation](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation)
  does not run for whitelabel email-code or OAuth hooks. Dashboard EVM/Solana
  automatic creation stays off. Account creation queues a durable server job;
  closing the browser or returning to the initiating page cannot erase that job.
- [Create wallet](https://docs.privy.io/api-reference/wallets/create) supports
  `owner: { user_id: verifiedDID }`. YapArena specifies that user owner, with no
  additional signer, policy, smart wallet or funding. The installed public Node
  SDK accepts `idempotency_key` and translates it to `privy-idempotency-key`.
  The transport test checks the actual request body and header.
- [External IDs](https://docs.privy.io/wallets/wallets/external-ids) are unique per
  app and immutable. A random opaque reference is durably recorded with the
  account's original provider DID. The worker uses `GET /wallets/ext_wal_<id>`
  to reconcile before creating or retrying.
- [Idempotency](https://docs.privy.io/api-reference/idempotency-keys) lasts 24 hours;
  wallet creation errors can be cached too. A retry receives a fresh attempt
  key only after checking that permanent external reference and existing user
  wallet. The unique external reference remains the duplicate fence after the
  request-key window expires.
- [User ownership](https://docs.privy.io/controls/authorization-keys/owners/configuration/user/overview)
  is distinct from entity attribution. The adapter requires the trusted user's
  matching linked wallet with `user_can_sign: true`, then verifies its owner
  quorum through [GET key quorum](https://docs.privy.io/api-reference/key-quorums/get):
  exactly the intended user, threshold one, no public authorization keys or nested
  quorums. Additional signers, policies, archival and ambiguous ownership stop
  acceptance. An undocumented nullable threshold is not assumed to mean one.
- The selected app's provider-managed default recovery remains unchanged.
  The current public configuration confirms
  `require_user_owned_recovery_on_create: false` and mode
  `user-controlled-server-wallets-only`. No YapArena signing/recovery key or
  delegated signer is added.
- [Public pricing](https://www.privy.io/pricing) advertises a free Developer tier
  below 500 monthly active users with 50,000 included monthly signatures. This
  differs from the selected development application's 150-user cap. The lead
  independently read the actual dashboard on 2026-10-21: organization Free plan,
  zero monthly active users, no next invoice and no payment method; development
  app one active user; TEE wallets enabled and smart wallets off. No plan, payment
  method or billable signing/funding feature was purchased.

The [public configuration snapshot](evidence/account-completion-baseline/embedded-wallet/public-settings.json)
contains only an explicit allowlist of public configuration fields. Capability
and free-plan inspection do not establish genuine wallet-creation acceptance.
An authenticated provider create plus independent ownership/status reconciliation
must establish that separately; synthetic transport/SDK fixtures cannot.

## Durable account and wallet state

Migration `1792426014000_add-embedded-wallet-provisioning.js` creates a private,
RLS-protected job table. The verified provider-account transaction enqueues the
job before commit. Existing active, generation-matching Privy mappings receive
jobs during the same migration; retained accounts without Privy mappings are
not changed. Failed signup transactions leave no job.

The job's account, original provider DID, Ethereum chain and opaque external
reference are immutable. Once confirmed, its wallet ID/address cannot be replaced.
No private key, signature, transaction, balance or YC backing is stored in this
table. It is asset provisioning, not authentication or a financial ledger.

`createEmbeddedWalletProvisioning()` exposes owned status, bounded retry scheduling
and a worker drain. The default worker processes one job at a time; a scoped
server-owned account argument is available for operational work and isolated
concurrency tests. No HTTP request may choose another account or provider DID.

The worker claims a short database lease, releases the connection and performs
provider I/O with a 60-second deadline and per-request five-second timeouts, no
SDK retries, fixed API origin, no redirects and SDK logging disabled. It rechecks
active account status, current mapping/generation and the accepted credential
snapshot under account-then-job locks before creation and completion. Provider
I/O never holds a PostgreSQL connection or account lock.

A matching existing user wallet is reconciled and reused. An uncertain create is
retried only after provider reconciliation. A late worker's result cannot consume
a different lease. Eight attempts with increasing backoff bound provider work;
exhausted or ambiguous ownership moves to review. An expired final lease also
moves to review, rather than leaving the user indefinitely in provisioning.
Explicit retry cannot reset attempt counts or bypass backoff/review.

Waiting for account authorization is separate from provider failure. If accepted
credentials or generation do not match, the worker parks the job and stops
automatic provider requests. An attempt that has not called create is refunded;
an actual create remains counted, including an uncertain response. The same
accepted identity and credential digest can rearm the parked job during a
verified account exchange, authenticated retry or final synchronized
provider-session reset. None of these paths clears previous provider failures,
creation history, an exhausted budget or an ownership-review state. The status
projection shows no scheduled automatic check while work is parked.

Provider wallet records are excluded from sign-in methods and the accepted
credential digest only when the trusted server response positively identifies a
Privy embedded, user-signable Ethereum/Solana wallet. Unknown external wallets,
malformed records and unsupported authentication methods still fail closed.
Wallet-only provider identities remain ineligible to create an application account.

Provisioning audit events use `embedded_wallet.provisioned`, separate from retained
wallet authentication events. Empty asset-wallet creation must not falsely count
as a prior strong sign-in method or prevent first security-passkey setup. Existing
retained-wallet and financial-history bootstrap restrictions remain intact.

## Account settings and recovery

The themed account card shows pending, ready, retry-wait, ownership-review and
unavailable states. `GET /api/auth/embedded-wallet` returns account/provider context
in the same repeatable-read snapshot as wallet status and address. The client
fences stale results against SDK identity, the current account hint and its
request generation. It clears stale addresses during provider initialization,
logout and account changes.

The only browser mutation is `POST /api/auth/embedded-wallet` with an empty JSON
object and expected-account comparison header. Authentication, CSRF, shared Redis
account limits and an operation-specific retry budget apply on the server. The
browser does not create, sign, delegate, export or fund wallets. Wallet failure
never prevents email login, public watching, logout or revocation. Status polling
is bounded; a user can explicitly check status afterward.

The new-link button and client linking action are removed from both account
renderers. Existing retained wallet sign-in and proof-protected removal remain;
the retained-wallet section appears only for an account containing those records.
The backend's operation-proof and retained-method guards remain enforced.

The card displays an Ethereum-compatible address only after ownership is confirmed
and states that funding/redemption is unavailable. No private key is rendered by
YapArena, stored, logged or collected in analytics.

A Privy passkey recovery flow that preserves the same DID preserves the wallet
owner. The existing legacy recovery exclusion for embedded-wallet identities is
preserved: replacing a provider DID is rejected when either trusted provider
identity has an embedded wallet, or the original account's local job records a
confirmed wallet or a started creation attempt. An uncertain create also blocks
replacement, because changing the sign-in binding cannot recover that wallet.
The local predicate is checked again inside proof consumption under the account
lock, sharing serialization with the wallet worker's creation checkpoint.

A plain pending job with no wallet or creation attempt does not prevent legacy
recovery. Its immutable original-DID reference then requires ownership review;
the worker neither adopts it into the new DID nor creates an empty replacement.
This preserves the previously documented security scope rather than approving a
new wallet-recovery policy. Recovering an existing wallet across provider-DID
replacement still needs a supported provider recovery design; no application
signing authority is added to work around it. Live funding remains off.

## Verification and remaining gates

The [combined gate](evidence/account-completion-baseline/wallet-phase-integrated/README.md)
and [final SDK run](evidence/account-completion-baseline/embedded-wallet-browser/README.md)
record source/asset hashes and their local fixture limits. The
[read-only provider verifier](embedded-wallet-verification.md) is ready for the
separate actual-provider check after release; its 20 offline checks passed with
zero network, database or provider mutations.

| Requirement                                    | Owner                                         | Dependencies                                                       | Status and acceptance                                                                            | Evidence / blocker                                                |
| ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Remove new external linking                    | Embedded-wallet worker                        | Existing account controllers                                       | Implemented; no new-link control, retained sign-in/removal preserved                             | Full combined gate and strict retained-wallet browser PASS        |
| Separate embedded assets from auth credentials | Embedded-wallet worker                        | Trusted Privy user read                                            | Implemented; exact digest unchanged, unsupported records rejected                                | Final focused 43/43 and combined 854-test gate PASS               |
| Durable automatic EVM provisioning             | Embedded-wallet worker / lead                 | Approved user ownership/recovery; actual free entitlement          | Implemented; transactionally queued, independent of browser navigation                           | Full gate PASS: 854 tests and 235 cases per fresh/upgrade path    |
| Ownership, retries and concurrency             | Embedded-wallet worker / independent reviewer | Current mapping, provider evidence, leases and external reference  | Implemented; uncertainty reconciled and no automatic DID replacement                             | Eight adapter groups and 12 wallet PostgreSQL groups PASS         |
| Preserve legacy recovery asset exclusion       | Embedded-wallet worker / security reviewer    | Trusted provider asset flag; account-locked local creation history | Implemented; confirmed/uncertain assets prevent DID replacement, plain pending stays recoverable | Independent review and all four new PostgreSQL cases PASS         |
| Account status and accessibility               | Embedded-wallet worker / browser reviewer     | Owned paired API; built assets                                     | Implemented; stale-owner fence, visible status/retry and no provider wallet mutation             | Final SDK111 PASS; desktop/mobile ready screenshots inspected     |
| Real provider wallet creation                  | Lead / founder                                | Deployed revision and current verified account                     | Open                                                                                             | Synthetic SDK responses do not establish provider acceptance      |
| Physical-device setup/accessibility            | Lead / founder                                | Deployed changed journey                                           | Open                                                                                             | Automated checks do not establish screen-reader/device acceptance |
| Live funds and all requested routes            | Lead / provider                               | Written eligibility, provider/custody, security and release gates  | Disabled                                                                                         | Wallet provisioning does not satisfy financial requirements       |

The initial restricted-shell HTTP test attempt failed because the sandbox denied
ephemeral listening ports (`listen EPERM`). The same initial focused provider/discovery
suite passed all 35 tests after permission to bind local test ports; no assertion
or runtime behavior was weakened. Those tests preceded the final durable worker
integration and do not substitute for its combined release gate.
