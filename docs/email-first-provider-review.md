# Email-first accounts: financial provider and eligibility review

Reviewed **2026-10-19**, against the account implementation at `03ecffb` and
current official sources linked below. This is desk research and two anonymous
read-only HTTP probes. It is not a provider account approval, legal opinion,
provider-sandbox trial, chain testnet trial, or live-release authorization.
No account was registered, provider contacted, plan bought, key provisioned,
transaction signed, or money moved during this review.

**Current comparison continuation (2026-10-21):** the founder selected continued
provider comparison and identified Tangem as their existing wallet, without
selecting custody/signing or authorizing external contact. The
[new comparison](provider-comparison-20261021.md) checks NOWPayments, CoinGate
and BitPay against all five requested inputs. CoinGate's current payment-processing and payout terms
restrict both products to legal persons; BitPay's published invoice list omits
BNB Smart Chain. NOWPayments' current custody/individual contract and Base route
remain unverified. None is an approved complete fit. These current findings
supersede earlier technical/cost observations where they differ, while preserving
this dated review and the original acceptance limits.

The approved commercial terms remain in [the decision sheet](email-first-accounts.md#financial-decision-sheet).
The existing [A4 contract](a4-mechanism.md), [financial plan](financial-implementation-plan.md)
and combined [pre-funds gates](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds)
continue to apply. Historical A4 `YAP` never acquires redemption value.

## Findings and recommended next actions

There is no verified live provider eligible for YapArena's exact activity and
current personal-project operator status. That does not establish that a company
is universally required. A supported chain, an individual signup form, a
competitor integration, and a provider's marketing category are each insufficient
to prove approval for customer balances and debate-market payouts.

Approved engineering path, **test-only**: continue deterministic
accounting tests and add a separate Base Sepolia USDC transfer adapter using
disposable operator-controlled **test-only** keys. This can verify actual chain
funding, payout receipts and reconciliation without assigning value to test
tokens. It does not select live custody or establish the requested multichain
conversion routes.

Approved investigation candidate, **pending provider
acceptance**: NOWPayments. Its current product range is the closest documented
fit for crypto conversion and merchant payouts. The founder must obtain an
explicit answer about the actual activity, personal operator, custody and routes
before live integration is selected. Contact is not authorized by this review.

## Provider comparison

| Option                                 | Verified capability                                                                                                             | Material limit for this project                                                                                                                                                                                                                      | Acceptance state                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| NOWPayments                            | Payment conversion, merchant balances, custody and payouts are documented; current site lists individuals, trading and casinos. | Individual registration exists, but custody is described as B2B. High-risk activity and local-law restrictions remain. Exact Canadian personal-project acceptance requires confirmation.                                                             | Candidate only; no account approval or authenticated sandbox test.      |
| Privy crypto deposits                  | Automated asset conversion into a destination wallet.                                                                           | Requires source-chain app-paid gas sponsorship and wallets. Deposit detection excludes Bitcoin. Quotes are estimates, not a held price.                                                                                                              | Existing auth provider; funding feature not accepted or enabled.        |
| Circle Mint                            | Institutional custody/mint services; Canada appears on the country list.                                                        | Institutions only; the current individual operator does not meet that published category. Country availability does not approve this business.                                                                                                       | Not selected.                                                           |
| Circle developer-controlled wallets    | App controls wallet execution and signing through APIs.                                                                         | YapArena retains custody; this does not outsource its custody duties to Circle Mint.                                                                                                                                                                 | Optional infrastructure alternative; no account/configuration verified. |
| Coinbase Commerce / Payment Acceptance | Stablecoin payment APIs document payment/refund functions.                                                                      | Commerce terms restrict gambling/high-risk uses and require prior written approval for fee-entry prize games. New Payment Acceptance documentation is a distinct product; its availability does not inherit Commerce approval or prove these routes. | No accepted alternative established.                                    |

Sources: [NOWPayments API products](https://nowpayments.io/api),
[NOWPayments terms, revision 1.6](https://nowpayments.io/doc/fd-tos.pdf?v=1.6),
[Privy deposits](https://docs.privy.io/wallets/funding/crypto-deposits/overview),
[Circle Mint agreement](https://www.circle.com/legal/),
[Circle Mint countries](https://help.circle.com/support/en/circle-mint-supported-countries-and-regions?id=kb_article_view&sysparm_article=KB0010688),
[Circle wallet control](https://developers.circle.com/wallets/dev-controlled),
[Coinbase Commerce terms](https://www.coinbase.com/legal/commerce/terms-of-service),
and [Coinbase Payment Acceptance](https://docs.cdp.coinbase.com/api-reference/payment-acceptance/overview).

NOWPayments' current [pricing page](https://nowpayments.io/pricing) advertises a
1% service fee. This is a research observation, not an approved YapArena fee or a
complete quote. Network costs, exchange output, minimums and account-specific
terms must be disclosed separately. Older 0.5% marketing must not be used as the
current price without verification.

## Every requested deposit network remains in scope

Proposed minimum input assets below require founder confirmation; a network
request does not mean accepting every token on that network. Symbols alone are
not asset identifiers. Pin chain, token contract/mint, precision, environment and
provider route identifier.

| Requested network | Concrete input route to investigate | Current public evidence                                                                  | Still required                                                                                                |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ethereum          | ETH and Circle-issued USDC          | NOWPayments lists ETH/USDC; Circle lists native Ethereum USDC.                           | Authenticated conversion quote, exact provider asset ID, fee/minimum and settlement trial.                    |
| Base              | ETH and Circle-issued USDC          | NOWPayments' current payroll page lists ETHBASE/USDCBASE; Circle lists native Base USDC. | Confirm deposit and conversion availability for this account, rather than inferring it from payout marketing. |
| Solana            | SOL and Circle-issued USDC          | NOWPayments lists SOL/USDCSOL; Circle lists native Solana USDC.                          | Mint/address validation, conversion quote and settlement trial.                                               |
| BNB Smart Chain   | Native BNB                          | NOWPayments lists BNBBSC.                                                                | Verify BNB-to-native-USDC destination route. Do not replace it with a bridged token without approval.         |
| Bitcoin           | Native BTC                          | NOWPayments lists BTC.                                                                   | Verify BTC-to-native-USDC route, confirmation policy and late/refund behavior.                                |

[NOWPayments supported assets](https://nowpayments.io/supported-coins) and
[current asset labels](https://nowpayments.io/all-solutions/payroll) are discovery
evidence. The account-specific API must decide current availability.
[Circle's authoritative USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses)
include Ethereum, Base and Solana; Bitcoin and BNB Smart Chain are absent. The
inference for this design is that Bitcoin/BNB are conversion inputs, never an
assumed native-USDC settlement route. This preserves all five requested networks
as outstanding acceptance work; no unsupported route is silently dropped.

Anonymous `GET https://api.nowpayments.io/v1/full-currencies` on 2026-10-19
returned `403`, `INVALID_API_KEY`. Public lists therefore cannot establish the
actual account's routes. Smallest next step: configure a provider sandbox API key
in the approved secret store after the provider/candidate choice; never send it
in chat. This permits sandbox capability checks, subject to the limitation below.

## Sandbox evidence has three distinct meanings

1. **Deterministic simulation:** repository fixtures prove internal arithmetic,
   state transitions and concurrency. They establish no external execution.
2. **Provider-hosted simulation:** NOWPayments' [official sandbox collection](https://documenter.getpostman.com/view/7907941/T1LSCRHC)
   explicitly says the sandbox has not been actively maintained or synchronized
   since 2025. Its `case` parameter simulates payments without funds. API/status
   behavior can differ from production. A passing trial must retain this limit.
3. **Actual chain testnet:** Base Sepolia transfers can be reconciled against
   external receipts and balances using valueless test assets. This proves that
   specific testnet adapter path, not provider custody, conversion, live finality
   performance or Canadian eligibility.

Anonymous `GET https://api-sandbox.nowpayments.io/v1/status` returned
`{"message":"OK"}` on 2026-10-19. This is endpoint reachability only.
The current production API [collection linked by NOWPayments](https://documenter.getpostman.com/view/7907941/2s93JusNJt)
was read directly from Postman's public collection endpoint; no production
financial request was made. Do not follow the sandbox documentation's suggestion
to validate production by making real transactions without separate authorization.

### Approved maintained testnet acceptance path

Use Base Sepolia, chain ID `84532`, and Circle's listed six-decimal test USDC
contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
[Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses)
explicitly states test tokens have no financial value or real-dollar backing.
The [public Circle faucet](https://faucet.circle.com/) requires no account and
offers 20 test USDC per address per chain every two hours.
[Quicknode's own Base faucet](https://faucet.quicknode.com/base/se) advertised free
test ETH without a mainnet balance, but the actual claim rejected the disposable
address for lacking a mainnet balance. That marketing did not establish usable
access. Circle test USDC and alternate free test ETH were subsequently obtained,
with a human completing the alternate faucet's CAPTCHA. Actual signed funding,
payout receipts and finality are recorded separately in the
[chain trial](evidence/coin-testnet/README.md); a pending receipt remains pending.

Recommended engineering safeguards are test-only key storage outside Git,
chain-ID verification on every endpoint, a fixed token allowlist, no mainnet
configuration path, and distinct testnet ledger assets. Separate the test
operator key from runtime read-only credentials. Neither this key nor a user's
external wallet becomes an embedded wallet at ordinary signup.

Acceptance must include funding and outgoing transfer amounts, destinations,
canonical successful receipts, transfer logs, finality and pre/post balances;
duplicate observations and interrupted sends must resolve to the same transfer.
Persist the signed transaction's identity before broadcast so a timeout cannot
cause a new payment. Lack of a receipt alone never proves no payment.

## Quotes, finality and uncertain outcomes

The [current NOWPayments API](https://documenter.getpostman.com/view/7907941/2s93JusNJt)
distinguishes `finished`/`rejected` final payout states from `failed`, which can
resume. Retain reserves on `failed` and timeouts; reconcile the original payout
before retrying. `unique_external_id` exists but its atomic deduplication guarantee
is not established. Expired payments stop emitting IPNs even though late deposits
can arrive. Polling/reconciliation is mandatory. IPNs use recursively sorted JSON
and HMAC-SHA512; authentication does not itself make an event final or new.

NOWPayments' [current terms](https://nowpayments.io/doc/fd-tos.pdf?v=1.6) describe a
ten-minute fixed-rate period and permit refusal when payment is sent more than
four minutes after exchange initiation. Refunds require review; wrong-asset and
repeat deposits have special handling. These constraints need provider
clarification before promising a held conversion quote or automatic refund.
Credit only the actual reconciled net native-USDC settlement, with any deviation
handled under an approved user policy. A browser success redirect is insufficient.

Recommended finality contract is a verified canonical finalized receipt, not a
fixed wall-clock delay. Official chain sources establish different mechanisms:

| Chain           | Verified protocol distinction                                                   | Recommended acceptance treatment                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ethereum        | Proof-of-stake checkpoint finality.                                             | Finalized chain state covering the receipt; outage remains pending.                                                                                                              |
| Base            | Preconfirmation, L2 inclusion, L1 batch inclusion and L1 batch finality differ. | Finalized block covering the transfer. A normal Base send is distinct from a bridge withdrawal to Ethereum.                                                                      |
| Solana          | Processed/confirmed/finalized commitments differ; recent blockhash expires.     | Observe finalized successful transfer; reconcile expiry and signature before any replacement.                                                                                    |
| BNB Smart Chain | Fast economic finality and fallback probabilistic finality differ.              | Use documented finalized-state APIs; fail closed on unavailable finality.                                                                                                        |
| Bitcoin         | Confirmation depth reduces, rather than eliminates, reversal risk.              | Provider's approved depth/risk policy plus actual settled conversion; no zero-confirmation issuance. Six confirmations is a reference recommendation, not a universal guarantee. |

Sources: [Ethereum consensus](https://ethereum.org/developers/docs/consensus-mechanisms/pos/),
[current Base finality](https://docs.base.org/specifications/transactions/transaction-finality),
[Solana confirmation/expiry](https://solana.com/developers/cookbook/transactions/confirmation),
[BSC finality APIs](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/),
and [Bitcoin payment processing](https://developer.bitcoin.org/devguide/payment_processing.html).
These protocol descriptions do not establish a selected provider's settlement or
reversal-risk guarantee. Provider insolvency, freezes and USDC risk need separate
disclosures and an approved custody contract.

## Canadian eligibility and retention

No province is currently evidenced as eligible for live YapArena balances or
monetary debate instruments. Recommended release configuration is an empty live
allowlist until a written structure-specific review identifies permitted
activity, operator, provinces, ages, KYC, retention and disclosures. This preserves
Canada as the initial target rather than inventing nationwide permission.

The [AMF](https://lautorite.qc.ca/en/general-public/investments/crypto/how-to-buy-and-sell-cryptoassets)
describes structure-dependent securities/derivatives and custody requirements.
[Criminal Code section 206](https://laws-lois.justice.gc.ca/eng/acts/C-46/section-206.html)
and [section 207](https://laws-lois.justice.gc.ca/eng/acts/C-46/section-207.html)
require review against A4's exact random pricing, paid entry, payout and
promotional design. These sources do not classify YapArena automatically.

[FINTRAC's MSB guidance](https://fintrac-canafe.canada.ca/msb-esm/msb-eng)
includes virtual-currency exchange/transfer activities and states registration is
free when required. Registration alone is not permission to offer the markets.
Its [recordkeeping rules](https://fintrac-canafe.canada.ca/guidance-directives/recordkeeping-document/record/msb-eng)
specify category-dependent records and minimum periods, often five years. Do not
apply an invented five-year rule to every signup record or assume small balances
remove all obligations.

An 18+ baseline does not settle activity/provider rules. The
[Government of Canada's age-of-majority table](https://www.canada.ca/en/correctional-service/corporate/acts-regulations-policy/commissioners-directives/710-8.html#annexB)
lists Québec at 18 and British Columbia at 19, for example. Recommended financial
eligibility threshold is the greatest of 18 and the applicable province,
activity and provider requirements, once reviewed. Collect country/province and
necessary attestations at the financial boundary; use provider-hosted identity
verification where accepted, storing a result/reference rather than unnecessary
document images. Exact residency checks and retention await review.
[Canadian privacy guidance](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/gd_rd_201406/)
supports a defined minimum/maximum retention schedule and disposal, with legal
holds documented separately.

## Decision boundaries

The execution decision log records founder answers. Test-only signing,
pre-exposure promotional backing checks and existing YES/NO sandbox integration
were approved. Live custody and route/provider acceptance remain outstanding.
The approved service/correction rules below do not establish a selected
provider's ability to perform them.
The [founder question packet](nowpayments-eligibility-questions.md) is prepared
for a written eligibility/custody/routes answer; no message has been sent.

| Decision                 | Recommended concrete option                                                                                                                                        | Consequence / remaining dependency                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox signing          | Approved: disposable app-controlled keys restricted to Base Sepolia.                                                                                               | Actual test-only execution is recorded separately; does not choose live custody.                                                                                                                                             |
| Live custody candidate   | NOWPayments approved for investigation only; request confirmation for the disclosed personal operator, customer liabilities and debate instruments.                | Founder handles contact; written answer must address B2B custody and exact routes. Self-custody remains an alternative requiring its own signing, recovery and eligibility design.                                           |
| Input asset allowlist    | ETH/USDC on Ethereum and Base, SOL/USDC on Solana, native BNB and BTC.                                                                                             | Meets five-network investigation scope without accepting every token. All conversion routes remain unverified.                                                                                                               |
| Promotional reserve      | Approved: reserve worst-case additional promotional profit exposure before each stake; stop new exposure when the separate 50-USDC budget is fully spent/reserved. | Existing earned claims retain backing. No purchased backing or later cap can take it away. Include profit unlocked by qualification in the bound. Separate A4 center collateral remains necessary. No live budget is funded. |
| Review target            | Approved: review within two business days, using Toronto weekdays excluding Canadian federal holidays; show network processing/finality separately.                | Live operation still requires staffing, provider capability and release approval; a review target does not guarantee chain arrival.                                                                                          |
| Completed purchases      | Approved: completed purchases leave through USDC withdrawals only. The earlier unused-purchase original-route refund proposal was removed by the founder.          | Failed, incorrect or reversed deposits still need support, external reconciliation and append-only corrections under the approved error policy.                                                                              |
| Errors and disputes      | Approved: accept reports whenever submitted, review evidence and append linked corrections; operator-caused shortfalls/costs use separate operator funds.          | Quote recoverable external costs and obtain consent before attempting recovery. Ordinary trading losses remain final. External reversibility/provider capabilities still need verification.                                  |
| All-strong-lost recovery | Approved: ordinary email access may continue; operations requiring retained strong proof remain inaccessible when every strong credential is lost.                 | Physical loss is not detected and does not automatically create an account-wide hold. Email cannot reset keys; provider-approved recovery remains unresolved.                                                                |
| Instrument integration   | Approved: keep historical A4 unchanged; connect separately identified sandbox funds to existing YES/NO debate participation.                                       | Future longer-lived idea trading remains gated; live instrument funding, provider eligibility and combined release gates remain open.                                                                                        |
| Financial eligibility    | Empty live jurisdiction allowlist until written activity-specific assessment and provider approval.                                                                | Founder supplies any existing review or obtains it; no secrets needed. Public discovery and email signup remain independent.                                                                                                 |

## Kalshi comparison requested by the founder

Current primary sources were read on 2026-10-20. Kalshi's
[crypto-withdrawal article](https://help.kalshi.com/en/articles/13823804-crypto-withdrawals),
dated August 24, describes typical wallet arrival within 30 minutes and no
Kalshi crypto-withdrawal fee. It may require document verification and a prior
crypto deposit. US users use Zero Hash; international users use a separate
provider. Those facts do not establish YapArena's routes, costs or eligibility.
YapArena's approved initial manual review target is two Toronto business days,
with network processing separate and the displayed network fee inside the
authorized gross debit.

Kalshi's [security-holds article](https://help.kalshi.com/en/articles/13823801-security-holds),
dated August 14, lists no crypto deposit hold. It separately requires settled
cash and excludes funds in open positions from available withdrawals. This
does not override YapArena's approved grant-principal or independent
grant-profit qualification rules.

The current [member agreement](https://kalshi.com/docs/kalshi-member-agreement.pdf)
sections II and VI.F treat completed funding as generally nonrefundable except
as specified in the rulebook, including withdrawal of deposited/earned funds.
The same agreement lists Canada among restricted jurisdictions for event-contract
trading. Its distinct treatment of membership or other products is not approval
for Canadian event trading or YapArena. This is a policy comparison; YapArena
still needs its own provider and qualified activity/province review.

## Privy cost and capability boundaries affecting this design

[Current pricing](https://www.privy.io/pricing) lists a free Developer tier for
0–499 MAU, Core at $299/month and Scale at $499/month. Authentication includes
email, socials and passkeys. Selected development-app settings were verified
below; production Google OAuth credentials remain an owner configuration step.
Paid tiers can automatically upgrade.
No paid change is approved.

[Webhooks](https://docs.privy.io/api-reference/webhooks/overview) can be tested
without cost in development; production requires Enterprise. Polling and
server-side credential comparison must therefore be evaluated independently of
an unapproved webhook plan. [Crypto deposits](https://docs.privy.io/wallets/funding/crypto-deposits/overview)
need app-paid source gas and an available quoted route; recognizing an asset is
not proof of a conversion route. Embedded-wallet creation remains off.
[Privy's acceptable-use policy](https://www.privy.io/acceptable-use-policy)
forbids unlawful operations and acting as a custodian/payment/money-transmission
service without appropriate licensing. Its prediction-market marketing does not
approve YapArena's activity.

### Selected Privy app: current configuration and production gates

On 2026-10-20 the public configuration for `cmvfjb3r800vy0hl3heg2cuvv` was fetched
independently before changes. The [baseline evidence](evidence/account-completion-baseline/privy-public-settings.json)
contains configuration only, with no users, credentials or tokens:

- Only `https://yaparena-staging-web.onrender.com` is an allowed web origin.
- Email is enabled. Google, provider passkey login and passkey-only signup are
  disabled. Email-based account merging is disabled.
- Turnstile is enabled. Embedded-wallet creation on login is off for Ethereum
  and Solana. No MFA methods are configured. `custom_api_url` is null.
- Public application name is YapArena; no provider logo/icon is configured.
  This does not reveal the account's billing tier or sender entitlement.

The native Chrome dashboard initially required owner sign-in. The founder
completed that sign-in directly; no code entered chat. The agent then enabled
Google using the optional default development OAuth credentials, and provider
passkey login. Passkey-only signup stayed off. The
[independent after fetch](evidence/account-completion-baseline/privy-public-settings-after.json)
confirms both methods are on, merging remains off, the exact staging origin and
Turnstile remain, and Ethereum/Solana embedded-wallet creation remains off.
No provider identity, secret, paid plan or production setting was modified.

Dashboard inspection verified development mode with a **150-user limit**, the
organization's Free plan and no payment method. Provider HttpOnly cookies and
login-method transfer are off. Provider settings show session duration 30 days,
access token one hour, refresh inactivity 30 days and identity token 10 hours;
these were read, not changed. No test-account, guest, CLI/agent or OAuth-token
return feature was enabled.

[Login configuration documentation](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods)
supports enabling Google with Privy's default OAuth credentials for development.
It recommends an application's own Google Web OAuth client before production,
using redirect URI `https://auth.privy.io/api/v1/oauth/callback`. Custom credentials
take effect immediately when saved. Their private values belong only in the
provider's secure configuration, never chat, source or evidence. Google may
reject OAuth inside embedded social-app browsers. Production custom credentials
remain an owner/provider-UI step, not a reason to buy a Privy plan now.

[Provider passkey login](https://docs.privy.io/authentication/user-authentication/login-methods/passkey)
has a separate dashboard enablement from signup. Preserve email-first signup;
the approved availability configuration enables returning passkey login, while
explicit linking/enrollment still needs integration acceptance. The founder
subsequently required a **single Privy passkey** for sign-in and sensitive
actions; that instruction supersedes the earlier separate YapArena enrollment
design. Login alone supplies no fresh operation authorization. The authentication owner confirmed that toggling available methods does
not itself change retained users' credential snapshots; actually linking one
does and requires the new retained-proof reconciliation flow.

### One Privy credential, independently verified operation challenges

Rechecked on 2026-10-20: the official [GET-user response](https://docs.privy.io/api-reference/users/get)
includes a linked passkey's `credential_id` and `public_key`. The installed
Node SDK makes `public_key` optional. The documented example decodes to a
base64-encoded COSE EC2/ES256 public key; this was checked offline with the
installed WebAuthn library. The installed React SDK performs its registration
ceremony in the application's browser context using the provider's returned RP
configuration. These findings support reusing that credential for a standard
assertion; they do not establish that every selected-app credential supplies a
usable key or that its actual RP matches staging.

The approved bridge uses Privy's actual enrollment once, followed by an
authentication assertion from that **same credential** over a YapArena-issued
challenge. It also supports activating an already linked Privy credential with
an unchanged accepted provider snapshot. It never creates a second credential.
Following the [WebAuthn verification requirements](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion),
the server checks the selected credential, signature, challenge, configured
origin/RP, user presence and user verification, then stores signed counter and
device/backup flags. Browser success callbacks, token refresh and token issuance
time remain insufficient proof.

The five-minute intent binds the original application session and generation,
provider DID, old credential snapshot, selected activation mode, candidate
public-key fingerprint and provider SID. Missing, malformed or unsupported
provider public keys fail closed. First activation is allowed only before any
financial history and before any local retained strong credential ever existed.
Adding a new key cannot use bootstrap when a provider passkey already exists;
activate the existing key first. Later setup needs a fresh retained-credential
approval for the exact intent. Activation atomically consumes its challenge,
accepts the exact provider snapshot, revokes other local sessions and rotates
one cookie. It preserves provider SID fences and waits for confirmed provider
session reset before ordinary provider tokens can cross the new generation.

The founder also approved a narrowly scoped restart of interrupted first setup,
only for an account with no financial history and no prior trusted security
method. A new one-use challenge requires native user verification, the same
server-verified provider DID, an unconsumed provider SID and the existing reset/
generation fences. A recorded original candidate must match its exact credential
ID and COSE bytes. When the original intent never recorded a candidate, the
approved fallback may select the current sole added provider key and must prove
possession of that key. This does not extend an expired challenge, reset an
existing strong method or authorize a funded account through email alone.

Every protected request and sensitive proof must recheck that each accepted
provider key is still linked to the same DID with the same trusted public-key
bytes. There is no positive authorization cache or embedded-wallet dependency.
Actual provider enrollment, exported-key availability, RP compatibility and
returning login remain genuine-provider acceptance gates; synthetic protocol
or SDK fixture tests cannot close them.

### Lost sole provider method and local identity replacement

Rechecked on 2026-10-20: Privy's current
[support policy](https://docs.privy.io/user-management/users/managing-users/supporting-your-users)
states that a user who loses their only login method cannot recover that Privy
account. The application cannot unilaterally change the original user's linked
email, and Privy has no recovery backdoor. Its
[email update flow](https://docs.privy.io/user-management/users/updating-accounts)
requires an authenticated provider user. Enterprise MFA resets are a separate
capability and do not establish sole-email recovery. No paid feature is approved.

The founder previously approved a separate YapArena policy for loss of a sole provider
email or sole Google login: a person who retains a YapArena **security passkey**
may verify a different email using Privy and explicitly replace the old local
provider mapping. Other multi-method or embedded-wallet identities are outside
this recovery scope. The approved Google route may use the same email address
associated with the lost Google login; the replacement must still be a distinct,
unbound and never-retired provider email identity with retained-key approval.
This does not allow same-address text to establish account ownership. The internal account ID,
profile, keys and balances stay with the original account. The old DID remains
permanently retired; an already mapped or retired new DID must not be merged or
reassigned. This is local identity replacement authorized by the retained app
key, not recovery or mutation of the original Privy account. Implementation and
its separate acceptance are tracked in the completion matrix. After the
Privy-only instruction, this replacement path remains restricted to **retained
legacy independent keys**. Newly activated Privy-origin keys cannot authorize
new-DID replacement, including through the database's narrow replacement
function. A Privy backup passkey instead signs into the original DID so the
provider's normal authenticated email-update flow can preserve its mapping.

Fresh sensitive authorization comes from a server-verified, operation-bound
retained application-key assertion. The new provider token and server-fetched
sole-email identity establish control of that new provider identity. Token
issuance time, `latest_verified_at`, and a browser code-success flag are not a
nonce-bound fresh-authentication attestation. Privy still issues and verifies
all email codes. No duplicate OTP service, provider account deletion, email-only
financial recovery or automatic email-based merging is authorized.

The separate all-strong-methods-lost policy remains unchanged: the app cannot
detect physical loss or automatically place a hold. Ordinary email access may
continue, but retained-proof operations remain inaccessible; email cannot reset
the keys. A selected identity-review recovery service is still unapproved.
Linking a backup provider Google account or provider passkey
while still authenticated helps prevent loss of the sole provider route; genuine
enrollment and returning-user acceptance remain separate from configuration.

[Allowed origins](https://docs.privy.io/recipes/dashboard/allowed-domains)
restrict client SDK use, not server-secret API access. Keep the exact staging
origin and no generic hosting wildcard. [Privy's HttpOnly-cookie recipe](https://docs.privy.io/recipes/react/cookies)
requires separate development/production app IDs, a stable owned production
domain and DNS verification. It warns against sandbox hosting domains. The
current public configuration establishes no production custom-domain approval;
do not enable this on the staging app. YapArena's PostgreSQL application cookie
is a distinct session mechanism and remains independently required.

[Appearance settings](https://docs.privy.io/basics/get-started/dashboard/configuring-appearance)
describe application name/logo use in OTP messages. The more specific
[email-login guide](https://docs.privy.io/authentication/user-authentication/login-methods/email)
places custom OTP emails, sender reply address and branding behind Enterprise
enablement. No free custom sender entitlement is established by the generic
appearance guide. Keep the working provider sender; verify any intended custom
sender with the actual dashboard entitlement before promising it or spending.

Current [pricing](https://www.privy.io/pricing) lists free 0–499 MAU and says paid
tiers can upgrade automatically when their MAU threshold is exceeded. The actual
development-app 150-user limit is distinct from this production MAU allowance.
[Server setup](https://docs.privy.io/basics/nodeJS-node/setup)
confirms endpoint rate limits but supplies no numeric app-specific authentication
limit. The Free plan and development-user cap are verified; custom sender
entitlement and numeric app-specific authentication rate limits remain
unverified. Do not infer them from synthetic UI fixture success.

## External acceptance checklist

| Item                                               | Owner                        | Status / evidence                                                        | Smallest next action                                                                   |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Current public capabilities                        | Provider-review workstream   | Official sources read 2026-10-19; two anonymous probes recorded above.   | Recheck after provider selection or terms change.                                      |
| Actual provider activity/custody eligibility       | Founder + provider           | Not evidenced; individual registration and B2B custody differ.           | Written decision on full flow, operator and jurisdictions.                             |
| Canadian activity classification / KYC / retention | Founder + qualified reviewer | Not evidenced by repository or this desk review.                         | Written province/activity matrix, obligations and approved data schedule.              |
| Exact five-network routes, fees and minimums       | Integration owner + provider | Public candidates only; authenticated API rejects missing key.           | Approved sandbox configuration; query every pair and record environment/revision.      |
| Provider sandbox                                   | Integration owner            | Endpoint reachable; official unmaintained warning verified.              | Exercise simulation, label its limitations; no live substitute without authorization.  |
| Actual testnet transfers                           | Integration owner            | Finalized standalone and actual application-ledger trials completed.     | Preserve exact receipt/source-hash evidence; no live or conversion-provider inference. |
| Funded promotional allocation                      | Founder + ledger owner       | Pre-exposure backing policy approved; 50-USDC real budget unfunded.      | Test separate funded treasury admission and solvency; no live funding request implied. |
| Payout/correction/dispute terms                    | Founder + integration owner  | Two-business-day Toronto review and evidence/correction policy approved. | Verify selected provider capability and publish approved policy before live release.   |
| Live release                                       | Lead + independent reviewers | Disabled; provider, financial, security and combined gates remain open.  | Satisfy all pre-funds gates and obtain explicit live authorization.                    |
