# Base Sepolia external-chain acceptance

This directory records **actual chain testnet** verification using disposable
operator-controlled keys and valueless Circle test USDC. It is separate from
deterministic ledger simulation, NOWPayments' provider-hosted sandbox and live
financial acceptance. No incorporation, business eligibility, custody-provider
approval, conversion quote, or live funds movement is established by this trial.

The founder approved this test-only signing path and free faucet verification.
Mainnet, paid services, user wallets and embedded-wallet provisioning remain out
of scope. This exercises a single USDC transfer route; Ethereum, Base, Solana,
BNB Smart Chain and Bitcoin conversion requirements remain in the provider
acceptance checklist rather than being silently removed.

## Pinned configuration and state

The standalone trial is now **completed**: the 5-test-USDC funding and
1-test-USDC payout both reconciled under finalized block `48351493`, including
validated token-log indexes `7` and `252`. External balances were independently
15 test USDC at the funder, 4 at custody and 1 at the recipient. A subsequent
[separate application-ledger trial](ledger/README.md) uses new transfers; these
recorded standalone balances must not be relabelled as later current balances.

The adapter hard-codes sandbox environment, Base Sepolia chain `84532`, six
decimals, and Circle's test-USDC contract
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. It rejects other environments,
chains and tokens. The default public RPC is `https://sepolia.base.org`; chain ID
is verified again before operations. No operator .env is loaded.

[Circle's contract registry](https://developers.circle.com/stablecoins/usdc-contract-addresses)
identifies this test contract and explicitly states test tokens have no real
financial value. [Base's current finality documentation](https://docs.base.org/specifications/transactions/transaction-finality)
distinguishes preconfirmation/inclusion from finalized chain state. The adapter
waits for a canonical successful receipt covered by the RPC's `finalized` block;
an arbitrary number of elapsed seconds is not acceptance.

[acceptance.json](acceptance.json) records the tested Git revision, exact adapter
source SHA-256, public test addresses, atomic balances, original transaction
hashes, receipt/block identities and current finality. A pending result is
deliberate incomplete acceptance. `completed: true` requires both the actual
5-test-USDC funding transfer and subsequent 1-test-USDC payout to reconcile in
finalized chain state, plus expected external balances.

## Faucet evidence and resolved setup

- Circle's [public faucet](https://faucet.circle.com/) was used in the browser
  without account signup. It reported 20 test USDC sent. Independent Base Sepolia
  `balanceOf` confirmed exactly `20000000` atomic units for the disposable funder.
- Quicknode's [Base faucet](https://faucet.quicknode.com/base/se) rejected that new
  address with an actual requirement for a small **Ethereum mainnet** balance.
  This contradicted the contemporaneous published FAQ. No mainnet funding or
  paid workaround was attempted.
- The alternate [Base Sepolia faucet](https://faucet.zalalena.com/base) displayed
  hCaptcha. The founder completed the challenge; the agent filled the disposable
  public address and submitted the free claim. No CAPTCHA was bypassed.
- The gas faucet reported transaction
  `0xb05ba35b6bcff4689ed13f798b8d34d432de8f4efdd13b81e2d95002ef226b3d`.
  Independent RPC confirmed `1000000000000000` test ETH wei for the funder.
- The verifier separately seeds the second disposable signer with `0.0002`
  valueless test ETH, preserving its signed identity privately. This is gas
  setup, not purchased-user or promotional backing, and avoids another faucet
  challenge. Its hash and receipt observation appear separately in the report.

## Authorization, persistence and reconciliation

Preparing a USDC transfer requires an explicit candidate nonce and operation ID.
The application caller must commit the nonce uniquely by environment/network/
sender and immutable request before broadcasting. The adapter does not allocate
nonces or establish a database uniqueness guarantee itself.
The standalone verifier instead holds an exclusive filesystem lock for the
three disposable keys, and persists per-operation nonce reservations and exact
signed bytes/hash before any broadcast, syncing both file and directory. A
candidate can be signed privately, but DB uniqueness must commit before any
application payout broadcast. A losing candidate must never broadcast. The
separate ledger trial exercises that production-shaped ordering.

Keys and raw transactions live only under a private temporary directory, with
directory mode `700` and file mode `600`; symlinked storage is rejected. Neither
keys nor signed bytes enter Git, public evidence or normal output. Existing
private operation files must survive interrupted runs. Do not delete them or
generate a replacement operation to resolve an uncertain result.

The adapter verifies the recovered signer, pinned chain/token, destination,
amount, zero native value, nonce and exact ERC-20 transfer call before sending.
Reconciliation separately checks transaction and receipt identity, chain,
canonical block, successful status, finalized coverage and exact
`Transfer(from,to,value)` log with matching block/transaction metadata. Missing
receipts, RPC outages and a consumed nonce remain uncertain; they cannot release
reserves. Only a finalized canonical reverted original transaction proves no
USDC transfer. Retries use the original signed identity and never allocate a new
nonce or substitute payout.

Application ledger posting, external-identity uniqueness, reservation locks and
account-specific financial authorization belong to the integrated financial
workflow and require their own PostgreSQL acceptance. This standalone trial
does not claim they were exercised merely because chain transfers succeeded.

## Repeat/resume

Only the public/secret **variable names** are documented:
`COIN_TESTNET_ENVIRONMENT`, optional `COIN_TESTNET_DIRECTORY`. The latter must
resolve to private non-symlinked temporary storage outside the repository.

```sh
COIN_TESTNET_ENVIRONMENT=sandbox node scripts/verify-coin-testnet.ts --prepare
COIN_TESTNET_ENVIRONMENT=sandbox node scripts/verify-coin-testnet.ts --status
COIN_TESTNET_ENVIRONMENT=sandbox node scripts/verify-coin-testnet.ts --execute
```

`--prepare` generates disposable test keys only if none exist and reports public
addresses. `--status` reads external balances without signing. `--execute`
resumes persisted identities, waits for funding finality before preparing a
payout, and exits `2` while reconciliation remains pending. It performs bounded
requests rather than waiting indefinitely. If test funding is unavailable,
request only free test assets; never buy or move mainnet funds.

Setup/status writes `setup.json`, preserving the completed `acceptance.json`.
Do not rerun the standalone fixed-balance acceptance after the separately
approved ledger trial changes the same disposable addresses' balances. Its
recorded transaction receipts remain immutable evidence of the earlier trial.

Focused local verification: server TypeScript and strict verifier checking,
owned-file ESLint, and 17 synthetic RPC/signing/receipt contract tests passed.
Focused adapter coverage was **97.38% lines, 97.44% branches, 92.86% functions**. Those
unit tests establish internal behavior and remain distinct from the actual RPC
report. Full integrated repository release checks are lead-owned.

Implementation references: [viem transaction preparation](https://viem.sh/docs/actions/wallet/prepareTransactionRequest),
[signing](https://viem.sh/docs/actions/wallet/signTransaction),
[receipts](https://viem.sh/docs/actions/public/getTransactionReceipt), and
[blocks](https://viem.sh/docs/actions/public/getBlock).
