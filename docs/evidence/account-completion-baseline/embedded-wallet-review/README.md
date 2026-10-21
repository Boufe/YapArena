# Independent embedded wallet boundary review

Read-only review on 2026-10-21 at checkout HEAD
`030b60ea0974b70edecf74b322935dc991a17fb1`. This review covers the new durable
user-owned wallet source, not genuine provider wallet creation acceptance.

| File                                                           | SHA-256                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/platform/auth/embedded-wallet-provider.ts`                | `3476ec1d15d40e940ee1ec0686a63d34029dc3ebbbf2d14473eeb86410aedc2d` |
| `src/platform/auth/embedded-wallet-provisioning.ts`            | `dc6da253b9bbab085fd02fe1167efb2e63fc226e2ece12edeb7319af7a20ba4d` |
| `frontend/embedded-wallet.tsx`                                 | `cffbb9428d31d469327e00a90060972dd11e5dfe27c8451feb33f3ccbd26b0ce` |
| `migrations/1792426014000_add-embedded-wallet-provisioning.js` | `ed48b610e77793bf4df1d49637f594660598d27dd98684f3dce890fd9f4db1b0` |
| `src/server.ts`                                                | `4517778d0457a52e48051b68ad084ed01154eeda952ed2dc885a27e2393b80f8` |
| `src/platform/auth/router.ts`                                  | `e55b2ebc2ce4b91526a9b2be1f7e2b1cc0c2e0292da67c74da1e120a25423e02` |
| `src/platform/auth/security-router.ts`                         | `96f0e7b0774e482442bd12a305a360c943599a649b3dc0f9c60c42299b89b53c` |
| `src/platform/auth/wallets.ts`                                 | `5fce2d99dca9ed6b6372a848cf0c0e20094e460563ea034d00a674ecebf2e1f6` |
| `src/app.ts`                                                   | `c0642da80007fe7f909e9bf70d5a70b5a62321c533dea183c51db9435a20729e` |

No remaining blocking ownership or signing-authority defect was identified in
this source pass. The review found and followed corrections for:

- A client-only creation effect could disappear during the immediate safe auth
  return navigation. Creation now uses a durable PostgreSQL job queued inside
  the verified provider-account transaction; browser status lifetime does not
  determine whether creation runs.
- Provider account and wallet address must be paired in one read, rather than
  two requests that can straddle an account switch. The status projection now
  includes server-derived account ID, provider subject and address from the same
  repeatable-read snapshot. The browser cancels and clears private state on
  account/provider changes and checks the owner on reads and retry responses.
- The initial wallet audit namespace matched the retained-authentication wallet
  history guard and would block first-passkey bootstrap. The new asset event is
  `embedded_wallet.provisioned`; legacy strong-wallet history remains protected.
- A crashed final attempt could remain running forever. Its expired lease now
  becomes an explicit review state, without another provider mutation.
- General background-job configuration initially gated auth jobs despite the
  separate maintenance worker lacking those jobs. Both auth loops now run on
  the Privy-configured web process independently, preserving the prior reset
  behavior. Database leases and local non-overlap guards coordinate execution.

The provider adapter uses a verified provider DID as `owner.user_id`, requests
only Ethereum, and supplies no app key, signer, policy, entity-only assignment,
funding or signing instruction. Current official documentation and the
installed Node 0.36.0 public wrapper were inspected: public `idempotency_key`
is translated to the HTTP `privy-idempotency-key` header. The reviewer initially
consulted the raw resource type and raised an incorrect field warning; checking
the public wrapper resolved it without an implementation change.

Creation retries inspect the immutable app-unique external ID and existing
trusted user-linked wallet first. Reuse requires matching wallet/address,
Ethereum chain, nonarchived state, no policies/additional signers and an owner
quorum containing only the exact user with threshold one and no other keys or
nested quorums. Uncertain outcomes cannot silently create a replacement.
Lease-fenced checkpoints validate current account/mapping/digest, perform
provider I/O outside DB locks, and reject stale completion. The immutable job
subject prevents a replacement provider DID from adopting the old wallet or
automatically creating a second wallet. That case requires ownership review;
the login-recovery flow does not by itself transfer user-controlled assets.

The UI calls only owned status and explicit empty-body retry endpoints. Creation,
signing and funding never run in this controller. Retry is authenticated,
comparison-bound to the observed account, subject to shared account and specific
Redis limits, and takes no account/DID/address selector. Status is private and
not cached. New external-wallet signup/link/complete are disabled in configured
email-first mode, while retained wallet sign-in and proof-protected unlink stay
available. Stored operation purpose/digest binding prevents relabelling an old
link proof as unlink.

The trusted authentication parser treats positively identified, user-signable
Privy embedded wallets as assets, without changing the authentication credential
digest. Unsupported wallet records still fail closed. No wallet callback grants
application ownership, fresh sensitive-operation proof, YC or financial access.
The address warning keeps crypto deposits/redemption disabled.

This is static independent review. Actual isolated PostgreSQL tests, SDK/browser
UI tests, any genuine provider creation, hosted revision and physical-device
evidence must be cited separately. No provider, hosted database or retained
account was mutated by this reviewer. The real local Redis retry-scope run is
recorded separately under `redis-acceptance/embedded-wallet-scopes` and is not
provider creation acceptance.

## Same-day recovery and UI follow-up

The earlier source fingerprints remain above. The reviewer found a material
integration gap in legacy independent-key recovery: after assets were removed
from the authentication credential digest, its sole-email/Google checks no
longer detected an embedded wallet. Changing the provider DID cannot transfer
that user-controlled asset. The root-authored correction was reviewed against
the provisioning checkpoint and the four new disposable PostgreSQL cases.

The trusted verifier now reports embedded-asset presence separately from the
authentication digest. Both the old and proposed provider identities are refused
when that server observation contains an embedded wallet. Independently, a local
confirmed wallet or a durable `creation_started_at` marker blocks replacement
regardless of its current queue state. The final local check executes inside
proof consumption under the same account lock used by the worker before it
persists a create checkpoint. A creation that wins the race therefore rolls
back the recovery's key counter, proof consumption and identity changes.

A pending job that has never started creation remains eligible for the already
approved legacy recovery. Its immutable original DID is retained; the worker
then marks that job for review without inspecting, adopting or creating a wallet
for the replacement DID. No remaining blocking defect was identified in this
narrow recovery integration review. A trusted provider observation is still a
point-in-time read; this is not a guarantee against an independent provider or
administrator asset change after that read.

The reviewer also read the SSR fallback correction: mounting the React status
temporarily hides the existing fallback and restores its prior hidden state on
cleanup. The SDK verifier now requires exactly one visible wallet status and no
visible contradictory checking fallback once ready. This new assertion and the
fallback correction still require the next built-asset browser run.

| File                                                | Follow-up SHA-256                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `src/platform/auth/privy.ts`                        | `d11a41fc460d521703a3d4d59543654f8502f8ff3763ea6566109010871fceea` |
| `src/platform/auth/provider-identity-recovery.ts`   | `6021f9117b3f0c802b8e23a799dcc37e3ffef01848bd914db2884f258ac044ee` |
| `tests/account-security-passkeys-postgres.test.js`  | `3b59b1c9854d323ff3d4f3d21ca5302c1e2be3c1c79855fe3a129e6eee0a2c43` |
| `src/platform/auth/embedded-wallet-provisioning.ts` | `dc6da253b9bbab085fd02fe1167efb2e63fc226e2ece12edeb7319af7a20ba4d` |
| `frontend/embedded-wallet.tsx`                      | `9a91a1700b8758614ad0dee75ba5f9c6e8cd2d95fbb83a7d2596286c0db799c4` |
| `src/features/discovery/account-web.ts`             | `9e081acb1c4bf1ca46925253ee0bf974ea05b0193dd8a6ef21a634346695f6df` |
| `scripts/verify-email-auth-browser.ts`              | `b20b74b67aefee5fe27d28663b0d9a673e499f121794c57d2a03a488cbc72c72` |

This reviewer inspected the actual lead-run r4 log: the fresh isolated account
suite passed 235/235 with zero skips, including 12 wallet cases and the four new
asset/recovery cases. R4 later stopped at an unrelated historical evidence JSON
format check; no whole-gate or upgrade success is inferred from it.

Separately, this reviewer executed the r2 SDK/browser fixture against its recorded
source and asset hashes: 111 checks passed, with no console errors or request
failures. Those app/provider responses are synthetic; the run establishes the
status/retry, stale-owner and keyboard behavior, not real wallet creation. Its
ready screenshot exposed the duplicate fallback that prompted the correction
above, so the r2 result must not be used as visual acceptance of that correction.
Both successful and failed earlier artifacts remain under
`embedded-wallet-browser/`. Genuine provider creation/default recovery, final
integrated and hosted acceptance remain separate gates.

## Final local output inspected

The lead's final r5 integrated log was inspected after terminal success: 854/854
quality tests with no skips, 235/235 focused cases on each fresh and upgrade
database, including the 12 wallet and four asset/recovery cases, plus the
separate A4 and Base treasury gates. This is inspection of the lead's execution,
not a second database run by this reviewer and not hosted wallet acceptance.

This reviewer then ran the final SDK browser fixture against the frozen built
assets: **111 checks passed, exit 0**, with no console errors or requirement
failures. The new single-visible-status/fallback-hidden assertions passed on
desktop and mobile. Both ready screenshots were independently viewed; the
contradictory fallback is absent and the account layout/theme is retained.
Every recorded current source and asset hash matched after completion. The
verifier and reviewed widget fingerprints in the follow-up table are unchanged;
the exact final generated assets and results are in
[`embedded-wallet-browser/r3/browser-results.json`](../embedded-wallet-browser/r3/browser-results.json).
The initial restricted metadata-only failure and the earlier selector failure
remain documented separately. This final local browser result still uses
synthetic OTP/provider/application responses and does not prove genuine provider
wallet creation or recovery.

## Read-only provider acceptance verifier review

The reviewer independently read the proposed private draft, then compared the
repository translation at `scripts/verify-embedded-wallet-staging.ts` against
that draft. The final reviewed helper SHA-256 is
`5000fcc118e5be8be9d1c62a8c0263c9eb13f8020e09a79e71d9bc9cf92e90ff`.
The draft fingerprint was
`93912fbb6865373a99f90ffa469ec97d22b094316571a885036ff3b85ed249bc`.

The initial draft checked committed source bytes while executing separately
compiled modules. That could incorrectly associate stale executed code with a
new revision. It was corrected before acceptance: inspection verifies the exact
committed helper, package manifests and relevant application sources, then
dynamically imports those TypeScript sources using the explicitly required
Node 24 transform-types flag. The repository translation preserves that ordering
and changes only relative imports, repository/output paths, the draft comment
and the additional committed-byte checks.

The reviewed transport refuses every provider mutation before sending it. It
permits only bounded HTTPS GETs to the fixed app/user and provider wallet/quorum
read paths, without request bodies, query strings, user information or redirects.
Responses are bounded by content type, shape, bytes, request count and deadlines;
missing or invalid freeze state is refused. Render access is limited to the fixed
staging service's read-only service/environment/deployment endpoints. No creation,
signing, funding, provider freeze/unfreeze or database mutation is invoked.

The dedicated owner connection pins port 5432, strict CA/hostname verification,
safe search path and exact current/session role. Each snapshot is explicitly
repeatable-read/read-only and closes before provider reads. The final result
requires unchanged accepted credentials and matching account/mapping generation,
repeated unchanged database/provider observations, the exact queued wallet ID and
address, trusted provider user linkage and the user-only ownership quorum with no
additional signers or policies. Output is explicitly constructed from bounded
statuses/counters/booleans and source fingerprints; identifiers, addresses,
credential digests, keys, provider bodies and configuration are not serialized.

The reviewer actually ran both the final private draft and repository helper in
offline self-test mode. Each exited 0 with **20 checks passed**, zero network
calls, zero database connections and zero provider mutations. The repository
copy also passed scoped ESLint. The only extra terminal text was Node's fixed
experimental transform-types warning. No real inspection was run by this
reviewer. Strict operational compilation and any actual staged read-only
inspection are separate lead-owned evidence; the helper's existence and offline
PASS do not establish genuine provider wallet acceptance.
