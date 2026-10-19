# Email-first accounts and platform currency

Baseline: clean shared checkout at `fd60543`, equal to fetched `origin/main`
on 2026-10-19. Branch: `feat/email-first-accounts`; no unrelated edits present.
This record distinguishes implementation from acceptance; it is not paid-release approval.

## Direction and phases

Email verification codes are primary. Google and passkeys are optional. Public
discovery/watching stay public; initial profiles are optional. Financial
eligibility is collected at the financial boundary, not ordinary signup.

| Phase | Scope                                                 | Current boundary                                                                            |
| ----- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A     | Privy, onboarding, stable accounts, sessions/settings | Foundation implemented; hosted delivery, recovery/linking and device acceptance outstanding |
| B     | Shared Redis controls and justified caches            | Atomic multi-client/outage checks passed locally; hosted connection outstanding             |
| C     | Redeemable YC, sandbox funding/redemption             | Ledger foundation/read-only balances; no financial adapter or usable money workflow         |
| D     | Authorized reset and final acceptance                 | Guarded operator tool; hosted backup/restore/reset not executed                             |

These phases preserve the combined [pre-funds gates](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds).
Unresolved financial decisions do not block independent authentication work.

## Financial decision sheet

Latest founder decisions supersede earlier CAD/bank/PayPal instructions.

| Term                       | Confirmed decision / unresolved detail                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meaning / representation   | YapArena-issued platform currency held as internal account balances; no ERC-20 or confidential-chain requirement                                                    |
| Value                      | **100 YC = 1 USDC**; six-decimal USDC atomic integers, 10,000 atomic units per YC                                                                                   |
| Region                     | Canada initially; founder requested CRSHMARKET's 18+ and legally permitted access baseline. Provincial/provider eligibility and retention still require review      |
| Purchases                  | Cards and supported crypto, quoted conversion into USDC before crediting YC                                                                                         |
| Requested deposit networks | Ethereum, Base, Solana, BNB Smart Chain and Bitcoin; routes/input assets still require provider verification                                                        |
| Withdrawal                 | External crypto wallet, **USDC only**; no bank/PayPal payout                                                                                                        |
| Bitcoin / BNB              | Input-conversion routes; never assume native USDC support on those networks                                                                                         |
| Welcome                    | 2,500 YC, grant principal permanently spend-only                                                                                                                    |
| Daily                      | 500 YC; each grant requires fresh net profit earned using that grant                                                                                                |
| Qualification              | Welcome lot needs 2,500 YC net profit; each daily lot needs its own 500 YC. Receipt is not profit, does not raise the welcome target, and cannot reuse prior profit |
| Example                    | Welcome 2,500 + qualifying profit 2,500 = 5,000 balance; only 2,500 profit withdrawable                                                                             |
| Promotional backing        | Founder approved YapArena treasury funding of qualified profits; **budget undecided**                                                                               |
| Spending / losses          | Oldest grant first, then purchased coins; mixed-source profit/loss allocated proportionally. Once a grant qualifies, it stays qualified after subsequent losses     |
| Purchased value            | No grant-profit qualification requirement for purchased coins; standard operation authorization and applicable provider/eligibility checks still apply              |
| Limits / timing            | Fees, limits, payout timing, daily claim window/timezone unresolved                                                                                                 |
| Transfers / corrections    | User transfers, refunds, chargebacks and loss allocation unresolved; disabled                                                                                       |
| Custody / reserves         | Recommend segregated backing, fee and operating accounts; treasury custody, signers, reserve caps and reconciliation ownership need approval                        |
| A4                         | Existing `YAP` is **nonredeemable play money**, including starter/refill/bot grants; economics preserved. Redeemable use requires reviewed terms and all gates      |

Paid-product direction is money-backed YC with explicit spend-only promotions.
Historical play, sandbox simulation and live liabilities stay separate. Old grants
never acquire cash value. No live funding, redemption or financial promotion is
enabled; an approved treasury source is not an approved spending budget.

The ledger foundation enforces balanced postings, exact projections, sealed
committed journals, exact reversals and environment/asset consistency. Runtime
has read-only ledger access. Immutable grant lots and profit events support the
read-only progress display: independent targets, exact net profit and remaining
amounts, and permanent qualification based on each lot's profit peak. Header
balance menus and the homepage balance dialog show **Available for withdrawal:
X YC**; Escape closes them and restores focus. No fabricated grant is issued to
a real account. Grant spending/profit attribution, funded issuance,
operation-specific authorization, reservation/redemption orchestration, external
movement/reconciliation and payout webhooks are **not implemented**.

## Provider verification and limitations

Official documentation checked 2026-10-19; locked versions:
`@privy-io/node` 0.36.0, `@privy-io/react-auth` 3.50.0, Redis client 6.3.0.

- [Custom UI](https://docs.privy.io/authentication/user-authentication/whitelabel): supported React hooks in an account-page island within existing server-rendered TypeScript. Provider bundle size/latency still needs measurement.
- [Core JS](https://docs.privy.io/recipes/core-js): provider requests consultation for low-level integration; use the supported React workflow.
- [Tokens](https://docs.privy.io/authentication/user-authentication/access-tokens): supported signature, issuer, audience and expiry verification. Browser email/account/wallet ownership claims are never authoritative.
- [Freeze/unfreeze](https://docs.privy.io/user-management/users/managing-users/freezing-users): freeze revokes refresh sessions; unfreeze does not restore them. Issued JWTs still need the local fence below. Selected-app behavior requires a hosted trial.
- [MFA](https://docs.privy.io/authentication/user-authentication/mfa/overview): embedded-wallet key operations, with caching scope; not arbitrary backend-operation proof.
- [Cookies](https://docs.privy.io/recipes/react/cookies): production Privy HttpOnly cookies require domain/DNS/provider setup. Development uses provider browser token storage; YapArena authorizes only its own HttpOnly cookie.
- [Login settings](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods): Google defaults support development; production branding needs own OAuth credentials. Email sender/branding entitlement still needs verification.
- [CAPTCHA](https://docs.privy.io/authentication/user-authentication/captcha): direct OTP requests depend on Privy controls; custom UI includes its CAPTCHA component. Match the selected provider to CSP.
- [Crypto deposits](https://docs.privy.io/wallets/funding/crypto-deposits/overview): routes differ from supported assets; dedicated addresses require wallets and app-paid source-chain gas sponsorship. No sponsorship credits purchased.
- [Pricing](https://www.privy.io/pricing): free below 500 MAU; automatic upgrades need monitoring. Free/low-cost preference; no paid upgrade approved.
- [Deletion](https://docs.privy.io/user-management/users/managing-users/deleting-users): deletion changes future DID and disassociates wallets. Never delete keys/assets for a fresh-looking signup.
- [Webhooks](https://docs.privy.io/api-reference/webhooks/overview): development testing is free; the current documentation requires Enterprise for production webhooks. No paid upgrade approved. Provider credential-event handling is not implemented; out-of-band provider changes are checked at exchange, not continuously against already-issued app cookies.

The selected dashboard reports a development-app limit of 150 users. This is
distinct from the advertised free production MAU allowance. Sender/branding
entitlement and production business approval remain unverified.

The screenshot is CRSHMARKET. [Blink](https://www.blink.cash/apps) lists that
integration; this identifies its passkey deposit option, not a card processor.
Card/crypto business approval, Canadian/provincial support, commercial terms and
Bitcoin/BNB conversion routes remain unverified. Privy login/wallet support alone
does not establish payout eligibility. Embedded-wallet creation is currently off;
no custody/recovery/export flow is claimed accepted.

## Ownership, sessions and recovery

PostgreSQL owns stable bigint IDs, unique provider-DID mappings, account status,
auth generations, consumed provider sessions and application sessions.
Provisioning is transactional, DID-locked and idempotent. Matching legacy
unverified email text never merges accounts. Retained accounts need existing
credentials and deliberate dual-ownership reconciliation; that linking flow is
not implemented. Privy mode retires new password registration.

The selected app initially had email on, Google/passkeys/CAPTCHA off, no allowed
origins, and email auto-merging on. On 2026-10-19, automatic merging was disabled
under **App settings → Basics → Advanced → Account merging**, Turnstile CAPTCHA
was enabled, and the staging HTTPS origin was added. A supported SDK settings
read independently confirmed all three changes. Google/passkeys remain off in
the selected app. The server requires auto-merging off and rechecks before
exchange; only enabled optional methods appear. No cached positive ownership
decision bypasses this check.

The verified credential identifiers are hashed as an enrollment snapshot. A new
exchange with changed methods is rejected for deliberate ownership reconciliation.
Self-service email changes, method linking/removal and passkey enrollment remain
disabled until operation-specific proof and revocation coverage are implemented.

Each Privy `sid` can issue at most one YapArena session. Token refresh/replay
cannot recreate an expired/revoked app session. Exchange requires exact Origin,
rejects switching an active account, and publishes a cookie only after commit.
Production `__Host-session` is Secure, HttpOnly, host-only, SameSite Strict.
Safe return retains the initiating local path, query and fragment. Account-page
OAuth query strings are omitted from HTTP logs.

Current logout, logout-others and logout-all retain their PostgreSQL semantics.
Generation changes enqueue durable provider-revocation work in the transaction.
The local fence commits before external calls. After a confirmed provider freeze,
the worker unfreezes active accounts and advances the mapping with an issuance
bound strictly after the freeze. This bound works only after old refresh sessions
were revoked; `iat` alone is not fresh authentication. Failures retain the fence
and retry after a lease. Independently pre-frozen accounts require operator
review. Resume after suspension still requires reviewed reconciliation.

Sensitive backend changes retain operation-bound password/SIWE proof. New
provider-only wallet linking, email change, credential removal, financial
recovery, payout destination and redemption remain gated until backend-verifiable
expiring proof binds account, generation, operation, nonce, expiry and financial
terms where applicable. Browser MFA flags and token refresh are insufficient.
Weaker email recovery cannot replace stronger wallet authorization.

Already-open media connections, outstanding grants and in-flight feature writes
retain their documented [revocation boundary](security/account-session-revocation.md#external-and-in-flight-boundaries).
The Privy outbox does not revoke LiveKit/media grants.

## Redis, configuration and measurements

Redis stores shared abuse counters only. Atomic Lua increments/install TTLs
together. Namespaced HMAC IP-subnet/operation keys contain no raw identity or
bearer credential. Direct OTP requests go to Privy; application auth POST
mutations use Redis, with logout and session reads available during outages.
Existing process-local limits remain defense in depth. Verified account-scoped
wallet-operation creation uses a separate 30-per-15-minute budget; auth POSTs
share a 120-per-15-minute IP-subnet budget. Logout/current-session inspection and
account-wide revocation remain usable during Redis outages. These are initial
staging limits, not financial fraud controls.

Connect/command bounds are one second; offline queue and automatic reconnect are
disabled, with five-second retry backoff. Protected mutations fail closed (503);
throttles return 429/Retry-After. Security state uses a separate `noeviction`
instance. No ordinary cache or positive authorization cache was introduced.
PostgreSQL remains authoritative for every authenticated session lookup.

A free Render Key Value instance, `yaparena-staging-security`, was created in
Ohio. The verified staging-service Connect panel lists outbound ranges
`74.220.50.0/24` and `74.220.58.0/24`; only those ranges were allowed on the
authenticated external TLS endpoint. No public allow-all rule was added. Hosted
connectivity is still unverified. Free instances lose counters on restart;
this is not durable financial-security acceptance. Production config requires TLS.

Prometheus measures aggregate auth events/timing and Redis latency/errors/throttles.
Journey bodies reject credentials, email and extra fields. Recovery event names
are a vocabulary, not evidence of a completed recovery flow.

Runtime secret names: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
`REDIS_SECURITY_URL`, `REDIS_NAMESPACE`, `REDIS_KEY_SECRET` (32+ random chars).
`PRIVY_VERIFICATION_KEY` is optional: the SDK fetches public keys.
`PRIVY_CLIENT_ID` is optional unless a separate client is configured. Only App ID
and optional Client ID reach the browser. Keep owner/admin processes separate;
never load a combined operator env file into web/worker processes.

## Authorized staging reset

Confirmed site: **https://yaparena-staging-web.onrender.com**, Render service
`srv-datv1kjncjis73a500cg`, Supabase project `ypteqfmjietdqjzyvgtk`, database
`postgres` via the verified TLS pooler. User confirmed disposable accounts.
Initial counts: users 7, sessions 4, linked wallets 1, owned profiles 3, play runs
15, immutable play journals 101, media records 13. All rounds inspected were
settled; no ready/live debate or redeemable asset found. These are pre-reset counts.

Explicit command: `npm run reset:test-accounts -- --dry-run`, then `--prepare`,
`--rehearse`, `--execute`. Never invoked at startup or by migrations. Requires
exact host/database/project/origin, owner credentials, drained writers, encrypted
private backup, restored table/sequence fingerprints and deletion rehearsal.
Pre-migration backups can be captured/restored first; execution additionally
requires a fresh post-migration backup and successful deletion rehearsal. Canonical
fingerprints use explicit `C` ordering, so source and restore database collations
cannot cause false mismatches. Rehearsal writes only to the guarded disposable
copy; it does not lock the hosted tables. Snapshot export holds source table
write locks, and destructive execution retains the stricter zero-runtime-backend
check. Refuses live coin
records/non-play assets, unsettled rounds and active events. Historical subject
IDs retain immutable history without login credentials; public content and media
are preserved where integrity permits. No TRUNCATE, disabled constraints,
Redis FLUSH or key/asset deletion.

Required operator variables: `RESET_DATABASE_URL`, `RESET_EXPECTED_HOST`,
`RESET_EXPECTED_DATABASE`, `RESET_EXPECTED_PROJECT`, `RESET_ENVIRONMENT=staging`,
`RESET_ORIGIN`, `RESET_BACKUP_DIRECTORY`, `RESET_BACKUP_KEY`,
`RESET_WRITERS_STOPPED=true`; rehearsal also needs guarded loopback
`RESET_RESTORE_DATABASE_URL`. Keep values, backups and raw reports outside Git.

The [sanitized preflight report](evidence/email-first/reset-preflight.json)
records a real encrypted staging snapshot with verified table/sequence restore
fingerprints. The new migrations and deletion were rehearsed on a second local
restore: zero users/sessions/wallets, with 15 play runs, 101 journals and 13 media
records preserved; deletion was rolled back. Both hosted services resumed after
the snapshot. No hosted schema change or user deletion has occurred.

The pooler retains a runtime backend after service suspension; execution still
refuses that condition. Hosted migration/rollout, a post-migration backup/rehearsal,
actual reset, old-credential rejection, genuine fresh signup and final test-identity
cleanup remain outstanding. Reset is not complete until every requested
postcondition is recorded, including the final empty environment.

## Evidence

The refreshed complete local gate passed **524 tests, no skips**, with 94.22%
lines, 92.76% branches and 95.45% functions; fresh/upgrade database isolation and
the core browser release gate passed. Real local Redis checks passed with two
clients, 100 concurrent atomic increments, TTL expiration and bounded outage
failure. The production Docker image built successfully after an authorized
Colima restart recovered a full-disk I/O error. Local databases/containers recovered;
no image/volume/cache pruning was performed.

Locked-install audit reports 10 moderate, zero high/critical findings in the
Privy wallet dependency tree. A forced SDK downgrade is not an accepted fix.
The approximately 5.6 MB minified provider bundle is account-page-only; hosted
transfer/decode and signup latency remain to be measured.

[Screenshots and recorded UI checks](evidence/email-first/README.md) use local
SSR fixtures at identical 1440x1000 and 390x844 viewports. The installed SDK runs
with live public metadata, intercepted OTP endpoints, optional-method fixture
flags and synthetic money balances. These checks include exact return paths,
keyboard/focus, code errors, refresh, independent grant bars, modal/menu closing,
no overflow and automated WCAG tags under the account CSP. They do not prove
email delivery, hosted signup, recovery, screen-reader usability, physical-device
passkeys or complete WCAG 2.2 AA conformance. Real provider sessions, financial
workflows, the authorized reset and final empty-environment acceptance remain open.
