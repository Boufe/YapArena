# Crypto provider comparison — 2026-10-21

Status: **research only; no provider or custody model selected**. Reviewed current
official sources on 2026-10-21 and the existing
[provider review](email-first-provider-review.md),
[financial terms](email-first-accounts.md#financial-decision-sheet) and
[financial operations](financial-operations.md). This continuation makes no
Canadian eligibility or legal classification determination. No provider was
contacted, account registered, paid plan bought, credential provisioned,
financial API invoked, transaction signed or money moved. The founder owns
Tangem but has not selected it for YapArena custody. There is **no authorization
to email NOWPayments or another provider**.

## Recommendation and shortlist

Continue comparing **NOWPayments, CoinGate and BitPay**. None is currently an
approved complete fit for a Canadian individual operating YapArena's exact
redeemable balances and debate instruments. NOWPayments remains the closest
technical investigation candidate; CoinGate has published legal-person
restrictions for both payment processing and payouts;
BitPay is a useful comparator with Canadian onboarding evidence, higher
small-payment costs and an outstanding BNB Smart Chain route.

Do not spend integration effort on a live provider adapter until its actual
operator/activity, five inputs, native-USDC settlement and payout contract are
accepted. Existing deterministic and Base Sepolia adapters remain useful
engineering evidence; neither chooses live custody. Tangem can be evaluated as
an operator signing device alongside a processor, not counted as an approved
payment/conversion provider.

| Candidate   | Canadian individual / actual activity                                                                                                                                                                                                                                                                                                                                                   | Custody and signing                                                                                                                                                                                              | Published cost / material constraint                                                                                                                 | Current disposition                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NOWPayments | Current terms recognize individual partners. Canada is not named in their listed exclusions, but local law and provider risk decisions still govern. Actual YapArena acceptance is unverified.                                                                                                                                                                                          | Current production API introduction routes payments to a primary/Custody balance. Terms call custody a third-party B2B product. Older noncustodial FAQ wording does not resolve the individual/custody contract. | Pricing page advertises 1% service fee; network/conversion costs and conflicting FAQ figures need an actual quote.                                   | First investigation candidate, not selected; individual customer-liability custody/payout eligibility is a blocker.                                                                                                      |
| CoinGate    | Canada is listed. Sole-trader verification can use activity/tax documents. **Both payment-processing and payout special terms clause 1.4 restrict their products to legal persons**, effective 2026-09-01 and 2026-09-14 respectively; older sole-trader verification guidance does not override those current terms. Its prohibited-business terms require lawful/authorized activity. | Custodial account with conversion/settlement. A withdrawal to the operator's own wallet differs from a payout to a beneficiary.                                                                                  | Standard 1% processing; no monthly fee. Third-party payouts 0.50 EUR + 0.5%, or 0.50 EUR + 1.5% with conversion. Own-wallet withdrawal floor 50 EUR. | Published processing and payout terms exclude the current individual operator; reconsider only with a supported legal form and actual activity acceptance, without assuming incorporation alone establishes eligibility. |
| BitPay      | Official merchant-onboarding list includes Canada. Individual/sole-trader eligibility and YapArena acceptance are not established. Restricted-business terms expressly require authorization for relevant e-wallet/exchange/entry-fee-and-prize activities; speculation/derivative restrictions also need an exact classification answer.                                               | Processor receives payments and settles in selected fiat/crypto. Payout API uses onboarded active BitPay recipients, not an assumed arbitrary-address send service.                                              | Under 500,000 USD/month: 2% + 0.25 USD per payment; higher-risk rates may be higher. Published payout calculator uses 1% + 0.25 USD.                 | Comparator, not full-route replacement: current invoice support list omits BNB Smart Chain. No silent four-network launch.                                                                                               |

Sources checked: [NOWPayments current terms, updated 2026-10-19](https://nowpayments.io/doc/fd-tos.pdf?v=1.6),
[current production API](https://documenter.getpostman.com/view/7907941/2s93JusNJt),
[pricing](https://nowpayments.io/pricing),
[FAQ](https://nowpayments.io/help/about-nowpayments/about);
[CoinGate countries](https://coingate.com/supported-countries),
[sole-trader verification](https://support.coingate.com/hc/en-us/articles/4402499294098-Can-freelancers-verify-a-business-account),
[current payment-processing terms](https://coingate.com/policy/special-terms-and-conditions-for-crypto-assets-payment-processing),
[current payout terms](https://coingate.com/policy/special-terms-and-conditions-of-crypto-assets-payouts),
[general terms, section 12](https://coingate.com/policy/general-terms-and-conditions),
[pricing](https://coingate.com/pricing);
[BitPay countries](https://support.bitpay.com/hc/en-us/articles/360000123366-What-countries-or-jurisdictions-does-BitPay-support),
[Inc. terms](https://www.bitpay.com/inc/legal/terms-of-use),
[pricing](https://www.bitpay.com/pricing),
[payout cost calculator](https://www.bitpay.com/savings-calculator) and
[payout API](https://developer.bitpay.com/reference/payouts).

The CoinGate processing and payout restrictions are product-specific evidence, **not** a claim that
incorporation is universally required. Registering a company alone would not
establish approval for YapArena's activity. Likewise, a country's presence on a
list is not approval for custody of customer backing or monetary instruments.

## All five requested input networks

`Listed` below means public technical discovery evidence, not an approved
account route or completed conversion trial. The proposed input allowlist is
still a proposal: native ETH/USDC on Ethereum and Base, SOL/USDC on Solana,
native BNB on BNB Smart Chain, and native BTC. No request for support is removed.

| Requested network | NOWPayments public discovery                                                                                                                                                                      | CoinGate public service list                                                        | BitPay current invoice list                                        | Native-USDC boundary                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Ethereum          | ETH/USDC listed.                                                                                                                                                                                  | ETH/USDC listed.                                                                    | ETH and tokens/stablecoins listed.                                 | Circle-issued Ethereum USDC exists; pin its exact contract.                                                                                    |
| Base              | Earlier payroll search/index evidence labels ETHBASE/USDCBASE; the direct page fetched in this review no longer contains those labels. **Current deposit/conversion availability is unverified.** | ETH and USDC on Base listed; account/asset identifiers still required.              | Base and tokens listed.                                            | Circle-issued Base USDC exists.                                                                                                                |
| Solana            | SOL/USDCSOL listed.                                                                                                                                                                               | SOL/USDC listed.                                                                    | SOL and USDC/USDT listed.                                          | Circle-issued Solana USDC exists; pin the mint.                                                                                                |
| BNB Smart Chain   | BNBBSC listed; exact BNB-to-native-USDC route unverified.                                                                                                                                         | BNB on BSC listed. Its USDC-on-BSC label is not evidence of Circle-native issuance. | BSC/BNB is absent from the current published invoice support list. | BSC is absent from Circle's native-USDC contract table. Use native BNB input plus verified conversion, not an assumed bridged USDC substitute. |
| Bitcoin           | BTC listed; exact BTC-to-native-USDC route unverified.                                                                                                                                            | On-chainBTC listed; Lightning is a distinct optional route.                         | On-chainBTC/Lightning listed.                                      | Bitcoin is absent from Circle's native-USDC table. NativeBTC must be converted before USDC backing is credited.                                |

Route sources: [NOWPayments supported coins](https://nowpayments.io/supported-coins),
[payroll page](https://nowpayments.io/all-solutions/payroll),
[CoinGate per-service currency/network list](https://coingate.com/supported-currencies),
[BitPay invoice support, updated 2026-10-16](https://support.bitpay.com/hc/en-us/articles/203411543-What-cryptocurrencies-can-I-use-to-pay-a-BitPay-Invoice),
and [Circle's authoritative contract table](https://developers.circle.com/stablecoins/usdc-contract-addresses).
Cached search text and older route labels are deliberately not promoted to a
current usable API route. Public lists can also contain old/dynamic entries.

The three relevant Circle mainnet identifiers currently published are:

| Asset/network | Contract or mint                               |
| ------------- | ---------------------------------------------- |
| USDC/Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`   |
| USDC/Base     | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`   |
| USDC/Solana   | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

These identifiers are discovery constraints, not live configuration. A provider
must confirm which exact input contract/mint and output network it processes;
USDC symbols and EVM-compatible addresses alone are insufficient.

## Quotes, settlement, finality and test environments

| Provider    | Quote and settlement evidence                                                                                                                                                                                                                                               | Payout / test acceptance limit                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NOWPayments | Estimate endpoint is approximate and excludes applicable fees. Current terms describe a 10-minute fixed-rate window but also permit declining fixed execution when sent more than 4 minutes after exchange initiation. Production API describes primary-balance settlement. | Payouts require whitelisted IP/address and verification. Fee estimate can change before execution. Only `finished`/`rejected` are documented final payout outcomes; `failed` may resume. Sandbox documentation explicitly says not maintained/in sync since 2025 and simulates via `case`; it cannot establish production parity. |
| CoinGate    | Hosted checkout special terms provide a 20-minute firm quote; reusable Payment Channels convert at receipt-time rate instead. Account currency supports USDC discovery, but exact invoice/account settlement configuration needs acceptance.                                | Own-wallet withdrawal floor 50 EUR; beneficiary payout has no published minimum but is legal-person-only and has a fixed fee. Testnet sandbox requires separate account/API references, supports fewer currencies/platforms and needs its own route checks.                                                                       |
| BitPay      | Invoice reference describes a 15-minute locked rate. USDC appears in settlement/payout references, but the exact USDC output network and account availability are not verified.                                                                                             | Payout instruction floor 5 USD equivalent with recipient onboarding; no assumption that 5 USDC gross minus fee meets the instruction minimum. Separate test account/testnet environment exists; no test performed here. Current BSC input gap remains.                                                                            |

Sources: [NOWPayments production API](https://documenter.getpostman.com/view/7907941/2s93JusNJt),
[terms section 4.4.2](https://nowpayments.io/doc/fd-tos.pdf?v=1.6),
[sandbox notice](https://documenter.getpostman.com/view/7907941/T1LSCRHC);
[CoinGate processing terms section 5](https://coingate.com/policy/special-terms-and-conditions-for-crypto-assets-payment-processing),
[withdrawal versus payout minimums](https://support.coingate.com/hc/en-us/articles/4402505985810-What-is-the-minimum-withdrawal-payout-amount),
[sandbox environments](https://developer.coingate.com/reference/environments);
[BitPay invoices](https://developer.bitpay.com/reference/invoices),
[settlements](https://developer.bitpay.com/reference/settlements),
[payouts](https://developer.bitpay.com/reference/payouts) and
[test environments](https://developer.bitpay.com/reference/environments).
The public NOWPayments collections were also fetched directly from Postman's
linked anonymous documentation endpoint because the rendered pages expose no
body to the text reader. These were documentation GETs, not financial API calls.

**Engineering consequence:** bind the returned quote's exact terms/expiry and
net USDC to the application operation. Never credit an estimate, browser redirect
or authenticated webhook alone. Reconcile authoritative settled backing and
the original external operation before retry; retain uncertain reserves. A
provider service fee is not a network fee and cannot silently be passed through
under the approved network-fee-only withdrawal rule.

Protocol finality also differs. Ethereum finalized checkpoints, Base's multiple
L2/L1 stages, Solana commitment, BSC economic/fallback finality and Bitcoin
confirmation depth cannot be replaced by one wall-clock timer. No selected
provider's route-specific confirmation thresholds, reorg liability or finality
guarantee was verified here. Require those terms plus canonical receipt evidence;
Bitcoin depth reduces rather than eliminates reversal risk. Primary references:
[Ethereum](https://ethereum.org/developers/docs/consensus-mechanisms/pos/),
[Base](https://docs.base.org/specifications/transactions/transaction-finality),
[Solana RPC](https://solana.com/docs/rpc),
[BSC finality APIs](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/),
[Bitcoin processing](https://developer.bitcoin.org/devguide/payment_processing.html).

## What owning Tangem changes

Tangem hardware signing requires scanning the card/ring. WalletConnect supports
Solana and selected EVM networks including Ethereum/Base/BSC. This makes manual
USDC treasury signing a plausible design to test; it does not provide an
unattended signing backend, gateway, guaranteed conversion or Canadian activity
approval. Direct sends have a network fee without an extra Tangem transfer
commission. Its swaps use third parties with provider fees/rates and possible
KYC; the presence of a swap button is not a verified commercial route.
[Signing behavior](https://tangem.com/en/help-center/app-functionality/features-customization/),
[WalletConnect](https://tangem.com/en/help-center/tangem-dapps/),
[transfer fees](https://tangem.com/en-GB/help-center/fund-transfers/transaction-fees/),
[swap rules](https://tangem.com/en/help-center/swap/).

If later selected, use a deliberately separated YapArena treasury, never ask
for/export a seed or card access code, and bind every manual send to the approved
gross/fee/net/destination before signing. Preserve its transaction identity and
reconcile receipt before release. A gateway's 50 EUR own-wallet settlement floor
must not become a hidden new 5 USDC customer minimum; a prefunded payout reserve
would need approval and separate backing. The current user-controlled Privy
wallet also does not decide who holds YapArena's customer backing.

## Lower-priority alternatives checked

- **CoinPayments:** the current official search-cached pricing page states 3% for payment processing,
  plus network/partner conversion costs. Current docs expose country-specific
  instances, individual/business onboarding, per-merchant currencies and a
  sandbox; public evidence reviewed did not settle the exact Canadian individual
  instance, Base route or YapArena acceptance. The direct fee-page fetch returned HTTP521 during the independent review; this is cached official discovery, not a verified account quote. Older 0.5% claims are unsuitable.
  It is not the preferred low-cost next investigation while those gaps remain.
  [Current fees](https://www.coinpayments.net/help-fees),
  [instances](https://docs.coinpayments.net/instances/),
  [individual/business onboarding](https://docs.coinpayments.net/knowledge/multi-user/),
  [merchant currencies](https://docs.coinpayments.net/api/currencies/routes/getMerchantCurrenciesV1/).
- **BTCPay Server:** useful free/self-hosted Bitcoin collection software, with
  hosting/network costs. Its own docs identify Bitcoin as the core focus and
  community/exchange plugins for alternatives. It is not an out-of-box five-input
  native-USDC conversion/payout replacement; choosing it does not remove the
  legal/custody/conversion work.
  [General FAQ](https://docs.btcpayserver.org/FAQ/General/),
  [altcoin scope](https://docs.btcpayserver.org/FAQ/Altcoin/),
  [hosting requirements](https://docs.btcpayserver.org/FAQ/Deployment/).

## Smallest remaining decisions and external answers

No new founder answer is needed merely to continue public comparison. Before
implementing a selected live route:

1. **Operator/custody choice:** select provider-held backing versus a separately
   controlled YapArena treasury with manual Tangem signing. Recommendation for
   the next comparison: price both, preserve manual review, and do not give the
   runtime a spending key. Tangem possession alone is not this choice.
2. **Provider written approval:** disclose the Canadian individual/sole-trader
   operator, redeemable purchasedYC, spend-only grants, qualified promotional
   profit, paid debate participation, customer liabilities and manual payouts.
   Obtain the actual activity/operator approval, custody eligibility, all five
   input routes, exactUSDC settlement/payout networks, minimums/fees, quote/late
   payment/finality/refund rules and idempotency/reconciliation guarantees.
   The prepared [question packet](nowpayments-eligibility-questions.md) remains
   unsent. No contact authorization is inferred from this comparison.
3. **Small-payout economics:** preserve the approved 5 USDC gross minimum and fee
   inside gross. Recommendation: operator absorbs any provider service charge
   unless a different price policy is explicitly approved; never relabel it a
   network fee. BitPay's instruction floor and CoinGate's fixed charge make this
   an account-specific acceptance item.

Approved terms remain unchanged: the gross minimum is 5USDC, the displayed
network fee comes out of that gross debit, there is no daily withdrawal cap, and
only grant-source profit has a qualification target. Purchased value and its
remaining profit have no such target.

Choosing exact adapter types, integer precision, idempotency, receipt storage,
separate environments and fail-closed route allowlists is routine engineering.
Selecting custody/signing, accepting paid service charges, enabling a route or
promising withdrawable liabilities is not. Written Canadian activity/province/
age/identity/retention review and actual provider approval remain required; no
provider country list or hardware wallet supplies them. The approved 50 USDC
promotional budget is still not funded/allocated. All live financial gates stay
closed. This document records source-supported comparisons and explicit
inferences; it establishes no provider-sandbox, production or legal acceptance.
