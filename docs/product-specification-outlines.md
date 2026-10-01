# YAP Arena — Specification Outlines and Release Evidence

Version 1.0 · September 29, 2026 · Companion to the [YAP Arena product PRD](product-prd.md)

This document contains four separate specification outlines and a pre-funds acceptance checklist. It is an implementation brief, not an approved technical design. **Confirmed** refers to founder choices in the PRD; **Proposed** and **Open decision** require explicit resolution. Mathematical deductions and prototype options below are reviewer analysis. Source identifiers P1–P9 refer to the linked primary sources listed at the end.

## A. Event-market economics specification outline

### A1. Purpose, definitions, and source of truth

Specify a fully funded event market in which paid positions affect the winner and a separate continuous curve determines token payouts. Preserve locked accepted positions, five-day post-live participation, historical money-weighted baselines, and principal-plus-event-fee refunds on draws and voids.

Define: topic and side identity; qualifying historical event; baseline snapshot; accepted financial position; principal; fee; token quantity; collateral unit U; event cutoff; settlement finality; draw; void; and correction. Use one chosen asset denomination consistently. “$” in the examples means a normalized collateral unit; it does not select CAD, USD, a stablecoin, or a network.

**Proposed accounting convention for every example:** support equals accepted acquisition principal, excluding fees. Only funded event purchases count. Deposits, unfilled orders, sponsorship payments, and ongoing-market trades do not count. Founder purchases do count. Approve this convention before production; changing it requires recomputing the examples and analysis.

The event record must bind its topic mapping, baseline numerator/denominator, rule version, s, applicable fees, opening/closing conditions, and refund rule before participation. Sensitive values can be committed for later verification without publishing their plaintext, subject to the secrecy design. A rule version must be retrievable after settlement.

### A2. Issuance, pricing, and acceptance

**Confirmed:** an event pair contains one A-token and one B-token, backed by U; event pricing follows the Polymarket order-book reference. Polymarket describes matched complementary purchases and complete sets backed by collateral. Its normal secondary trading and binary resolution are not automatically adopted. [P1, P2]

For an illustrative issuance match of n pairs at prices p_A and p_B:

\[
p_A+p_B=U,\qquad P_A=np_A,\qquad P_B=np_B,\qquad K=P_A+P_B=nU.
\]

**Proposed minimum implementation:** complementary primary purchases create positions only when full pair backing is secured; no resale of accepted event positions. Actual matching priority, price improvement, tick/lot size, order types, and partial-fill handling remain open. Do not adopt an automated market maker or bonding curve without a new decision.

If the founder pre-funds complete pairs or holds inventory, specify ownership of both tokens, attributed support, inventory cost basis, and how later allocation affects refunds. Merely counting the same collateral twice as two contributions is invalid. The examples below use direct paired purchases and do not settle inventory-allocation rules.

Unmatched requests cannot create unbacked payout obligations. **Proposed:** distinguish reserved but uncommitted balances from accepted positions; release unmatched reservations at expiry. The founder’s no-withdrawal rule applies to accepted positions; cancellation rules for unfilled orders require approval.

### A3. Reserve and fee invariants

Maintain distinguishable balances for event collateral, refundable event fees, uncommitted user funds, ongoing-market assets, sponsor funds, and earned platform revenue. Technical segregation method and legal custody treatment require separate design.

For N outstanding pairs, collateral K = NU. For valid nondraw settlement:

\[
L_A=NUy_A,\quad L_B=NUy_B,\quad L_A+L_B=NU.
\]

This proves aggregate backing under the stated issuance assumptions for every q and positive s, including saturation. It does not prove correct custody, correct user allocation, resistance to manipulation, stable collateral value, or fair outcomes.

For a draw or void, refund each purchase lot’s actual acquisition principal and actual charged event fee. Under direct complementary issuance, total principal is NU. If fees collected and held separately total F, required refund reserves are NU + F. Token quantities alone are insufficient to calculate cost-basis refunds. No fee on the fee-free bootstrap lot may be invented.

**Confirmed:** event fees stay reserved until settlement. Exact fee rates and rounding remain open. **Proposed:** release fees as revenue only on valid nondraw final settlement, with a defined dispute/finality policy. If a settled event can later be voided, identify a separate funded correction reserve; already-paid tokens and released fees cannot be assumed recoverable.

Sponsor income is not required to make this paired event model solvent. Founder liquidity creates actual funded positions rather than an unlimited platform guarantee. A future founder deposit is not an asset available today.

### A4. Worked ledger examples

All examples assume U = 1 and direct paired issuance. Where used, **s = 0.20 and a 1% fee are illustrative only**. They are not approved production settings. All token returns are gross amounts before subtracting acquisition principal and fees.

#### Example 1 — Ordinary settlement

Frozen historical baseline: A = 50.5%, B = 49.5%. Issue 100 pairs: A buyers pay 62 for 100 tokens; B buyers pay 38 for 100 tokens. Final event money shares are 62% and 38%. Thus q = 0.62 − 0.505 = 0.115; y_A = 0.7875 and y_B = 0.2125.

| Ledger item                 |      A |      B |  Total |
| --------------------------- | -----: | -----: | -----: |
| Acquisition principal       |  62.00 |  38.00 | 100.00 |
| Illustrative 1% event fee   |   0.62 |   0.38 |   1.00 |
| Participant cash supplied   |  62.62 |  38.38 | 101.00 |
| Gross curve settlement      |  78.75 |  21.25 | 100.00 |
| Net participant profit/loss | +16.13 | −17.13 |  −1.00 |

A wins through positive relative movement. Event collateral of 100 pays exactly 100; the separate 1 fee becomes revenue only under the approved finality rule. This reconciles entry prices, final money shares, and the recovered curve rather than choosing an inconsistent final share.

#### Example 2 — Draw

Use the same purchase lots and fees but a historical baseline of 62%–38%. The final split is unchanged, so q = 0. The draw exception returns A’s 62 principal plus 0.62 fee, and B’s 38 plus 0.38. Total refund = 101; event fee revenue = 0.

Paying 50 to each side would violate the approved rule. Refunds are cost based, not token-face-value or 0.5 redemption payments.

#### Example 3 — Void

Use Example 1’s purchases, but invalidate the event under a published integrity or failure rule. Return 62.62 and 38.38, regardless of apparent support movement. Total refund = 101; event fee revenue = 0. Sponsor obligations and debater compensation are handled by their separate contracts. Network-cost reimbursement is an open decision.

#### Example 4 — Participation immediately before close

Historical baseline is 60%–40%. Initially, 100 pairs are bought at 0.60/0.40, creating principal of 60/40 and collateral of 100. Just before the cutoff, an accepted complementary match creates ten more pairs at 0.80/0.20, adding 8/2 principal and 10 collateral.

Final principal = 68/42; N = 110; final A support = 68/110 = 61.81818…%. Therefore q = 1/55 ≈ 0.0181818, y_A = 6/11 ≈ 0.5454545, and y_B = 5/11 ≈ 0.4545455.

| Ledger item                               |       A |       B |  Total |
| ----------------------------------------- | ------: | ------: | -----: |
| Final principal                           |   68.00 |   42.00 | 110.00 |
| Illustrative fees                         |    0.68 |    0.42 |   1.10 |
| Gross settlement, all 110 tokens per side |   60.00 |   50.00 | 110.00 |
| Net participant profit/loss, all lots     |   −8.68 |   +7.58 |  −1.10 |
| Gross return on ten late tokens only      | 5.4545… | 4.5454… |  10.00 |

A wins, but A buyers collectively lose money. The late A buyer receives about 5.45 against 8 principal; the late B buyer receives about 4.55 against 2 principal. This is an intended consequence of separating winner selection, entry price, and continuous payout—not an accounting shortfall.

Before the late purchase this example was a draw; after it, the curve applies to everyone. A small accepted purchase can therefore switch the settlement regime. Exact cutoff, acceptance, chain-finality, and appeal rules must be fixed. An order merely received before cutoff must not be assumed eligible if it never secures backing. A rejected post-cutoff match creates neither votes nor tokens.

#### Example 5 — First-topic bootstrap

Before the first live event, 100 pairs at 0.60/0.40 establish the fee-free baseline: 60/40 principal. Later, another 100 pairs at 0.20/0.80 add 20/80 principal. Final principal is 80/120, so A ends at 40% and q = −0.20. At illustrative s = 0.20, y_A = 0 and y_B = 1.

All 200 A-tokens receive 0; all 200 B-tokens receive 200 in total. Collateral is 200. At an illustrative 1% fee charged only on the later purchases, fees total 1, not 2. If the event is void, principal 200 plus the actual 1 fee is refunded. Bootstrap positions retain their payout rights and remain included in the first event’s final support.

### A5. Consequential deductions to test

**Draw discontinuity.** At baseline 62% and A entry cost 62 per 100 tokens, an exact draw refunds 62 plus fees, while arbitrarily small nonzero movement produces approximately 50 gross under the curve. This is a direct consequence of confirmed rules. Do not smooth it away, add a draw band, or change refunds without founder approval. Test strategic transactions near the cutoff and require users to understand the exception.

**Price/support linkage under paired primary issuance.** For fully allocated matches j with quantities n_j and prices p_Aj:

\[
c_A=\frac{\sum_j n_jp_{Aj}}{U\sum_jn_j}.
\]

Final support equals the quantity-weighted average A entry price divided by U under these assumptions. It is not the current quote or displayed midpoint. Publishing the complete event execution tape would reveal this support. The historical record therefore measures money-weighted financial participation; it cannot be claimed to isolate persuasion from pricing or strategic incentives.

**Manipulation and concentration.** Simulate both-side purchases, repeated wallets, last-moment trades, strategic bootstrap pricing, topic relabeling, concurrent events, founder inventory, and cross-market positions. Report what each actor can gain and which public or private information they need. Solvency does not imply incentive compatibility. Preserve the approved model unless the founder explicitly changes it.

### A6. Required decisions and acceptance outputs

Specify production s; asset/network and U; principal eligibility; bootstrap timing; historical inclusion of draws/voids/corrections; unmatched-order cancellation; trade priority; quote disclosure; supported order types; precision/dust handling; custody; fee schedule; network costs; closure/finality; inventory attribution; later corrections; and sponsor allocation.

Outputs: a versioned rules document, ledger specification, state-transition specification, independent reference calculator, scenario test fixtures, reserve reconciliation report, threat/economic analysis, and signed review of remaining risks. Mathematical properties include pair conservation, nonnegative reserves, complementary shares, exact draw determination, and no duplicate financial action.

## B. Hidden-tally design specification outline

### B1. Define the promise and adversaries

**Confirmed audience restriction:** no official event tally, leader, relative movement, or result before the five-day cutoff. Founder access is initially allowed; later administrators may have narrowly authorized security access. Sponsors, ordinary staff, debaters, and public viewers have no such privilege. A participant may inspect their own transactions.

Protect confidential orders, attributed principal, aggregate state, receipts belonging to others, and staff-only analytics. Public debate content, visible engagement, already-published historical results, and information participants voluntarily reveal are outside an absolute secrecy guarantee. A historical baseline assembled from public closed-event data may be reconstructable; do not promise that it is secret merely because a current event hides it.

Distinguish preventing exact reconstruction from reducing statistical inference. Neither an unpredictable outcome nor universal ignorance of the likely winner is promised. Include outsiders, colluding participants, bots probing quotes, service vendors, compromised staff accounts, and the authorized founder in the threat model, with their different permissions.

### B2. Leakage analysis

| Surface                              | What an observer could learn                              | Required investigation                                                                 |
| ------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Public-chain purchases and transfers | Side, amount, token quantity, wallet links, timing        | Map every transaction, log, balance, token identifier, and metadata field              |
| Execution tape or cumulative volume  | Reconstruct c_A under A5’s paired-purchase assumptions    | Replay observed fills and compare reconstruction to the internal ledger                |
| Prices and depth                     | Demand clues, fill sizes, or inventory constraints        | Probe quotes across sizes, accounts, and time; a midpoint alone is not a tally         |
| Wallet activity                      | Associate funding, receipts, and positions                | Test deposit-to-order linkage and cross-wallet correlation                             |
| Analytics, APIs, logs, support tools | Hidden aggregates despite a clean public interface        | Verify field-level access, caches, notifications, exports, errors, and backups         |
| Founder/admin access                 | Direct knowledge and trading advantage                    | Log access, define permissions, investigate misuse; do not claim blindness             |
| Ongoing ideas market                 | Expectations or advantage from privileged event knowledge | Test that no private tally automatically feeds prices, charts, bots, or notifications  |
| Public receipts and small cohorts    | Colluding users reconstruct most or all support           | State residual limits; do not claim protection against universal participant collusion |

Ethereum documents its public, transparent ledger design. [P3] The specific leakage conclusions above follow from YAP Arena’s proposed data flows and require testing on the chosen architecture.

### B3. Candidate designs to prototype, not approved architecture

**Private matching and accounting with later public settlement.** Keep side-specific orders and fills in an access-controlled service; expose the participant’s own receipt; publish an auditable settlement record after close. Potentially fits founder visibility and locked positions, but introduces operator/custody trust and does not hide amounts if deposits remain directly linkable to votes. Prototype pooled funding or another reviewed flow that breaks that linkage without assuming it works.

**Confidential on-chain state and matching.** Use a privacy-capable execution environment or cryptographic protocol to hide sides/amounts while demonstrating backing and authorized settlement. Network support, performance, metadata exposure, security, and administrative access require specialist evaluation. This is a candidate research path, not a claim that an available component satisfies the full requirement.

**Commit-and-reveal.** A commitment can delay disclosure of a choice, but amounts, deposits, or publicly issued side tokens may still reveal it. Withheld reveals and adaptive participation require a specified outcome. Private price matching and founder visibility are additional requirements; a bare hash commitment is not a complete solution.

A literal public Polymarket-style event tape conflicts with the intended confidentiality under the paired model. Retain its pricing principle while choosing a different disclosure design, or return the contradiction to the founder. Do not silently weaken the promise to “we hide the counter.”

### B4. Prototype evidence required

Produce an end-to-end data-flow inventory; an access matrix; captured chain/API/client/log output; an adversarial reconstruction script; matched tests with and without public debate/engagement signals; active quote-probing experiments; and evidence that founder/admin actions are recorded.

Vary market size, liquidity, transaction timing, founder share, wallet reuse, and participant collusion. Attempt to recover the exact tally and to infer the winner better than the public-information baseline. Predefine leakage tolerances and security scope with the founder and reviewer; no numerical privacy threshold is assumed approved.

Verify correct receipts and payouts despite confidentiality; key loss and operator outage; publication only after cutoff/finality; no early disclosure through ongoing markets; and no secret values in telemetry or caches. Independent reviewers must describe residual inference channels in user-facing language. Choose the architecture only after evidence addresses the selected promise.

## C. Ongoing-market instrument specification outline

### C1. Confirmed purpose and connection

Define a continuing tradable position associated with a user-created topic/idea. Participants can buy, sell, and withdraw available proceeds. Debate results inform market participants; price movement arises from their orders. There is no required monthly settlement, formula pegging price to results, sponsor-revenue right, dividend, or company ownership.

At event finalization, update the related public performance history. Keep performance measures, historical money share, and trading prices separate. Private event tallies cannot be piped into public ongoing prices or data. Founder trading and other privileged-information policies require explicit treatment.

### C2. Instrument decisions required before coding financial behavior

- **Identity and mapping:** What exact topic and side does a unit represent? How are related arguments linked without a rigid ideology taxonomy? Who can correct duplicate or misleading topics, and what happens to existing holders?
- **Holder rights:** What can a holder demand from the issuer, if anything? Is value solely resale-based, or is there a redemption right? What happens at platform or topic closure?
- **Issuance and supply:** Who creates units, how many, against what consideration, and who receives issuance proceeds? Can supply change? Who holds initial inventory?
- **Collateral and accounting:** Is there any redemption liability to back? Are ongoing units paired? The founder’s approved event-pair mechanism does not automatically answer this for a perpetual instrument.
- **Opening market:** How does the historical baseline inform funded opening quotes? What happens for a topic with no history? A quoted anchor is not a guaranteed executable price.
- **Trading rules:** Limit/market order support, priority, tick/lot sizes, partial fills, cancel behavior, slippage limits, fees, settlement, and stale-data handling.
- **Exit and continuity:** Withdrawal processing, trading pauses, missing counterparties, topic correction, delisting, insolvency, and any cash-out mechanism.

These are specification questions left open, not a new request for a long interview. Codex must not fill them with a performance derivative or equity claim. The product PRD is complete while this instrument definition remains a real-fund release blocker.

### C3. Price-display behavior

Polymarket describes a midpoint display with last-trade fallback when the bid/ask spread exceeds $0.10. [P1] Adopt its order-driven principle; copying that numeric fallback requires a known price denomination and instrument range. A perpetual idea asset has no approved 0–1 redemption bound, so do not import binary probabilities into its user interface by assumption.

The specification must distinguish best bid/ask, last trade, displayed reference, and executable price for a chosen size. Label unavailable or stale prices. A topic baseline is not a price oracle. Debate wins do not create platform-issued price increases or guaranteed trading profits.

### C4. Required evidence

Produce a plain-language term sheet, supply and ownership ledger, any required reserve proof, funded liquidity scenarios, fee examples, buy/sell/withdrawal tests, thin-book and gap-price simulations, and topic-change/closure procedures. Demonstrate that event funds and ongoing obligations cannot be double counted. Test zero liquidity, manipulated last trades, account switching, partial fills, retries, network disruption, and correlated activity across both markets.

## D. Launch-eligibility specification outline

### D1. Scope and decision authority

**Confirmed:** Québec operating base; intended users in Canada and the United States; both real-money markets together; wallet-first preference. **Requires specialist review:** what may actually be offered, to whom, from which entity, and with which controls.

Qualified Canadian/Québec and US advisers must review the exact structure, not the phrase “like Polymarket.” Give them both instrument definitions, the winner and payout rules, examples, custody/funding flows, ongoing-market rights, founder access and participation, fees, sponsorship rewards, and distribution plan. An incomplete ongoing instrument prevents a complete classification review.

### D2. Questions counsel must answer

| Review area                      | Required questions and deliverable                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canada and Québec classification | Are the event or ongoing instruments securities, derivatives, gaming/betting arrangements, or another regulated activity? Does paid influence over the outcome change the analysis? Provide a written structure-specific assessment.  |
| Canadian operating permissions   | Which issuer, dealer, marketplace, custody, money-services, or other authorizations/exemptions apply? Which provinces/territories may be served, and under what limits?                                                               |
| United States                    | Which federal and state regimes apply to issuance, exchange operation, clearing, custody, event contracts, gaming, and money transmission? Are licenses, registrations, partner structures, or exclusions required for either market? |
| Identity and location            | What age, residency, geolocation, KYC, AML, sanctions, wallet-screening, monitoring, and recordkeeping requirements apply? Can the desired wallet-only flow lawfully operate?                                                         |
| Participant protections          | What disclosures, risk warnings, limits, exclusions, complaints, appeals, and refund rights are required? How should exact-draw discontinuity and participant influence be described?                                                 |
| Founder and related parties      | What duties apply when the founder both sees confidential tallies and manually supplies voting liquidity? What disclosures and market-conduct controls are necessary?                                                                 |
| Asset and custody                | Who legally holds collateral and keys? How are customer claims protected during insolvency, depeg, frozen assets, or interrupted withdrawals?                                                                                         |
| Content and sponsorship          | Which topic restrictions, promotions, creator compensation, advertising disclosures, and contest rules apply? What language and consumer requirements apply in Québec?                                                                |
| Data and reporting               | Which privacy, cross-border processing, retention, breach, tax, financial-reporting, and regulator-access requirements apply?                                                                                                         |

These are questions for qualified advisers, not findings that each named regime applies. AMF and CSA identify possible crypto-platform securities/derivatives obligations; CFTC describes its DCM oversight; FINTRAC and FinCEN address money-services frameworks. None grants YAP Arena permission by analogy. [P5–P9]

### D3. Release gate

Produce an eligibility matrix by market, jurisdiction, participant type, and operating entity. Each entry must state permitted/prohibited/pending; adviser, date, supporting basis, required permissions, and operational controls. Keep pending geographies disabled for paid access. Implement and test the controls required by the reviewed structure before activation.

Do not describe all Canada or all US as approved merely because they are targets. If the selected structure cannot launch as intended, present the conflict and alternatives to the founder rather than silently changing economics, geography, access requirements, or the two-market release decision. Re-review material instrument, custody, or jurisdiction changes.

## E. Evidence required before accepting real funds

Passing a checklist is demonstrated evidence, not a promise. Record owner, artifact link, date, version, reviewer, outcome, and unresolved defects for each gate. Founder product approval and qualified specialist review are distinct signoffs.

| Gate                                | Required evidence and acceptance condition                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01 — Rules frozen                  | No unspecified production s, fee rate, collateral asset, cutoff rule, refund method, baseline convention, or financial instrument right remains on an active market. Terms and rule versions match the implementation.                                           |
| E02 — Economics                     | Independent calculator reproduces ordinary, draw, void, late-entry, bootstrap, saturation, both-side, and concentrated-participation cases. Accounting reconciles every unit of principal, fees, collateral, and payouts.                                        |
| E03 — Reserve invariants            | Generated and adversarial sequences cannot mint unbacked claims, double-count funds, release refundable fees early, or spend client reserves on operations. Founder inventory is included in liabilities.                                                        |
| E04 — Precision and boundaries      | Verify zero totals, smallest units, exact draw, movements immediately around zero and ±s, rounding, dust, very large amounts, partial fills, and no overflow or sign errors.                                                                                     |
| E05 — Timing and finality           | Test transactions just before/at/after cutoff, stale clients, clock disagreement, network delays/reorganizations, duplicate messages, and outages. Acceptance, close, reveal, and payout transitions are deterministic and auditable.                            |
| E06 — Refunds and corrections       | Full principal-plus-event-fee refund rehearsals pass, including fee-free bootstrap lots. Late corrections have a defined source of funds and cannot pay a claim twice. Network-cost treatment is disclosed.                                                      |
| E07 — Secrecy                       | Execute the B4 adversarial prototype, including public-chain reconstruction and quote probing; reviewers approve the defined promise and documented residual leakage. All unauthorized interfaces pass disclosure tests.                                         |
| E08 — Financial security            | Independent review of contracts where used, wallet authorization, custody/key management, access control, upgrades, emergency powers, signing domains, replay protection, dependencies, and incident recovery. No unresolved critical financial/security defect. |
| E09 — Operational resilience        | Demonstrate backup restoration, reconciliation after interruption, account switching, withdrawal recovery, paused trading, incident escalation, and replay availability. Define and approve service objectives before load testing.                              |
| E10 — Ongoing market                | Approved term sheet, supply/accounting model, funded liquidity scenarios, buy/sell/withdrawal tests, fee receipts, closure handling, and no mechanical result repricing.                                                                                         |
| E11 — User comprehension and demand | Complete counterbalanced research on history, paid influence, and ongoing positions; report results against proposed thresholds and obtain acceptance of any final thresholds. Users can explain a winning-side loss and a draw refund.                          |
| E12 — Integrity and moderation      | Published no-show, interruption, abuse, market-manipulation, self/related-party participation, void, appeal, and correction rules; realistic operational drills; consistent enforcement without ideological winner selection.                                    |
| E13 — Sponsors and rewards          | Actual contracted coverage of launch debates, delivery measurements, event attribution, creator reward formula, and payment/refund reconciliation. Model founder liquidity losses separately from operating margin.                                              |
| E14 — Eligibility                   | Written structure-specific specialist review, required permissions secured, approved jurisdiction matrix, and tested age/location/identity/AML/sanctions controls as applicable. No inference of approval from wallet connection.                                |
| E15 — Combined release              | Both markets and their shared wallet, topic, data, liquidity, and incident flows pass together. Explicit final release signoff; development/testing completion alone cannot enable real funds.                                                                   |

## Sources and provenance

Founder-confirmed rules derive from the project conversation culminating September 29, 2026. The payout curve was recovered from August 5 and later explicitly confirmed; its sample s and historical 1% fee remain illustrative. The approved paired-collateral and separately reserved event-fee model comes from the founder’s final affirmative answer. Public documents inform implementation references and review scope, not founder approval.

- **P1 — Pricing:** Polymarket, [How Are Prices Calculated?](https://help.polymarket.com/en/articles/13364488-how-are-prices-calculated). Supports order-based opening prices and midpoint/last-trade display mechanics; does not define YAP’s historical baseline or perpetual instrument.
- **P2 — Backing:** Polymarket, [Manage Positions](https://docs.polymarket.com/trading/positions/manage). Supports collateral split into equal complementary tokens and complete-set merge/redemption concepts. YAP’s continuous curve and cost-based draw refunds are its own rules.
- **P3 — Public ledger:** Ethereum, [Privacy](https://ethereum.org/privacy/). Supports the public-ledger exposure concern; the YAP leakage equations and candidate architectures are reviewer analysis.
- **P4 — Accessibility:** W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Reference for the proposed accessibility verification target.
- **P5 — Québec review:** AMF, [Éclairage sur la législation](https://lautorite.qc.ca/professionnels/fintech-technologie-financiere/entreprises-ayant-un-projet-novateur/indications-sur-la-legislation).
- **P6 — Canadian review:** CSA, [Regulation of Crypto Assets](https://www.securities-administrators.ca/investor-tools/crypto-assets/regulation-of-crypto-assets/).
- **P7 — US market oversight:** CFTC, [Designated Contract Markets](https://www.cftc.gov/IndustryOversight/TradingOrganizations/DCMs/index.htm).
- **P8 — Canadian money services:** FINTRAC, [Money services businesses](https://fintrac-canafe.canada.ca/msb-esm/msb-eng).
- **P9 — US virtual-currency business models:** FinCEN, [FIN-2019-G001](https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-certain-business-models).

All external sources consulted September 29, 2026. Legal sources identify domains requiring review; current applicability must be assessed by qualified advisers for the final design.
