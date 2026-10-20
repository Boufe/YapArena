# Isolated Yap Coins sandbox operations

Live funding and redemption remain disabled. The application sandbox initially
uses deterministic simulation. Its USDC labels are accounting fixtures with no
actual money or chain backing. A provider or chain sandbox is a separate form of
evidence; deterministic outcomes do not establish provider acceptance.

## Assets and backing

Purchased balances and earned profits use `USDC`, precision 6. Virtual grant
principal uses `YC_PROMO`, precision 4. At 100 YC per USDC their numerical atomic
valuations coincide, but the assets are different: virtual principal never funds
cash collateral, fees, purchased backing or withdrawals. Each grant keeps its
own principal, profit, current net result and permanent qualification peak.

Every earned grant profit must be financed from an independently funded
promotional treasury at credit time. A4 additionally reserves independent center
cash before admission; consuming virtual principal does not replenish it. The
approved live promotional budget of 50 USDC is **unfunded**, and this implementation
does not seed or allocate it. The explicit simulation seed command creates only
valueless fixture accounting entries.

External clearing buckets classify inflows/outflows by the **current liability
source**. They are not separate custody wallet balances. Purchased profits can
come from center collateral and are later withdrawn through purchased clearing;
promotional profits use promotional clearing. Receipt/event provenance preserves
the actual source, and aggregate custody cash must reconcile against aggregate
cash liabilities. Historical A4/YAP remains isolated and nonredeemable.

## Rail and credential separation

`coin_sandbox_controls` pins the physical database to `simulation` or
`base-sepolia`. The default is simulation. Rail changes require an explicit owner
process **before any initialization or history**; after that use a fresh isolated
database. Shared/exclusive transaction locks prevent a race with first writes.
Never configure a testnet payout adapter against a database containing simulated
USDC. The named staging web application uses simulation only.

The runtime role can append sandbox requests, journals and authenticated webhook
inbox records. It cannot approve requests or acknowledge inbox work. Manual review
and reconciliation use a separate owner process whose `current_user` is exactly
`yaparena_owner`. Owner credentials must never be placed in the web or worker
process. No tool here loads `.env` automatically.

Build before running the strict TypeScript operator:

```sh
npm run build
node scripts/coin-sandbox-operator.ts review < /path/to/private-command.json
```

Supply only these environment variable names through the operator's private
environment: `COIN_SANDBOX_OWNER_DATABASE_URL`, `COIN_SANDBOX_RAIL`, and, for the
isolated Base Sepolia rail, `COIN_SANDBOX_CUSTODY_ADDRESS`. Webhook HTTP runtime
configuration uses `COIN_SANDBOX_WEBHOOK_SECRET` separately. No owner connection
is accepted by the webhook router.

The operator accepts one JSON object on stdin, at most 32 KiB. It prints a bounded
command/status summary, with no addresses, amounts, account identifiers, signing
bytes, connection strings or provider error objects. Keep operator input private.

| Command             | JSON fields                                                                               | Effect                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`            | `requestId`, `decision` (`approve` / `reject`), `idempotencyKey`                          | Approve a gross reservation into pending cash, or reject an unsubmitted request and restore its exact sources.                                                                |
| `simulate`          | `requestId`, `status`; optional `transactionId`                                           | Explicit valueless simulation outcome. Never available on testnet.                                                                                                            |
| `confirm-funding`   | `requestId`, `transactionId`, `sender`                                                    | Base Sepolia only: verify the exact finalized incoming test-USDC transfer before cash issuance.                                                                               |
| `reconcile`         | `requestId`; incoming funding also needs `transactionId`, `sender`                        | Read the pinned external chain and update a single operation. Caller status is never evidence for testnet.                                                                    |
| `reconcile-pending` | optional `limit` (1–100, default 20)                                                      | One bounded pass over approved/pending/uncertain testnet payouts that have a persisted signed identity. Schedule the explicit command in a separate owner process if desired. |
| `drain-inbox`       | optional `limit` (1–100, default 20)                                                      | One bounded pass over authenticated, unacknowledged notifications, then append owner-only outcomes.                                                                           |
| `seed-simulation`   | `userId`, `purpose` (`promotional` / `center` / `correction`), `amount`, `idempotencyKey` | Simulation fixtures only. Does not create actual treasury funds or credit a user's balance.                                                                                   |
| `correct`           | `requestId`, `reason` (`incorrect_funding` / `operator_error`), `idempotencyKey`          | Append an exact reversal of fully unspent original funding; otherwise freeze new financial activity for review.                                                               |
| `retry-correction`  | `correctionId`, `idempotencyKey`                                                          | Retry the exact correction after reconciliation restores its original sources.                                                                                                |
| `void-round`        | `roundId`, `reason` (`debate_unavailable` / `operator_cancelled`)                         | Owner-only refund of an open sandbox round, restoring exact sources and unused backing without earning profit.                                                                |

Completed purchases support USDC withdrawals only. Corrections are auditable
operator repairs; they do not promise original-route unused-purchase refunds or
refunds of trading losses. Withdrawal minimum is 5 USDC **gross debit**. The
displayed network fee is deducted from gross, so gross 5.00 and fee 0.10 pays 4.90.
There is no daily withdrawal cap. Gross, fee, net, rail, network, asset,
destination and quote identity are bound to the fresh, one-use operation proof.

## Authenticated notification inbox

Mount `createSandboxWebhookRouter` before the application's JSON parser. The
factory receives only the runtime pool, pinned rail and a dedicated secret with
at least 32 bytes. HTTP delivery uses JSON with `requestId`, `status`,
`transactionId` (string or null), and optional EVM `sender`. Unknown financial
claims such as `amount`, `accountId` and `finalNoTransfer` are rejected.

Send headers `X-Yap-Timestamp` (Unix seconds), `X-Yap-Delivery` (unique bounded
identifier), and `X-Yap-Signature` (lowercase hexadecimal HMAC-SHA256). The HMAC
input is the exact concatenation of timestamp, `.`, delivery identifier, `.`, and
raw request bytes. Verification is constant-time, delivery age is limited to
five minutes, content encoding is not accepted, and the raw body is limited to
32 KiB. This is YapArena's own notification protocol, not a claim that any
financial provider has accepted a webhook integration.

An identical delivery returns 202 with `duplicate: true`. Reusing its delivery
identity with different authenticated bytes returns 409. Inbox records and
operator outcomes are append-only. The webhook never changes a cash balance,
settles a payout or releases a reserve. A failed webhook alone cannot establish
that no payment happened.

The separate owner command drains the inbox and reconciles actual testnet
operations using fixed Circle test USDC on Base Sepolia. Simulation outcomes are
explicitly labelled and physically isolated. Duplicate owner execution is safe
through financial-event idempotency. A crash after a financial commit but before
acknowledgement can retry the same inbox item without double payment. Transient
database failures leave inbox work unacknowledged. A processed pending observation
needs a later notification or `reconcile-pending` pass; no indefinite busy retry
loop runs in the web process.

## Testnet signing and uncertain outcomes

This operator reconciles but never signs or broadcasts. A separately authorized
sandbox signer may prepare a candidate nonce privately, then call
`reserveSignedPayout` with the approved request and exact signed transfer. The
repository validates recovered sender, chain, token, destination, net amount,
operation ID and hash, then atomically reserves request/hash/sender/nonce. Commit
that reservation **before any broadcast**. A reservation loser must never send
its candidate bytes. Retries use the original persisted signed identity.

Testnet payout reconciliation refuses requests without that immutable identity.
A receipt must match the original nonce and transfer terms and be canonical and
finalized. Missing transactions, RPC failures, unfinalized receipts and conflicting
evidence retain reserves. Only a finalized original reverted transfer proves no
transfer for release; a provider status named `failed` or a different failed
transaction does not. Failed/uncertain source reservations restore purchased
principal/profits and qualified backed grant profits exactly once only after this
proof. The operation never changes historical qualification.

Keep physical-device, automated browser, actual testnet and simulation results
separate in acceptance evidence. An owner approval or a passing unit test does
not enable live liabilities or satisfy jurisdiction/provider release gates.
