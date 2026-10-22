# Actual testnet and application-ledger trial

This is a separate trial from the completed standalone 5-in/1-out adapter
verification. [Current acceptance](acceptance.json) records actual Base Sepolia
receipts, application balances, tested revision and exact source hashes.
`completed: false` is explicitly incomplete acceptance while finality or
reconciliation remains pending.

The trial **passed** at `7a2482b` on 2026-10-20 05:42:26 UTC. Both exact
Circle-USDC transfer logs are covered by finalized block `48352856`: incoming
`0xfae70ffe318bcc0e43077cf6fe8b699469ee6a84352594dabc41d1c8aae93fde`
and payout
`0x49d9ee86df0d21108263e66fd57b52cfe6ea811c6c82de14dbb9d4f946f97cc8`.
External balances are 9 / 5 / 6 test USDC. The application has 1 available,
zero reserved and zero pending; its 1 plus the old unallocated 4 equals the
custody balance. Funding, immutable signing reservation and repeated final
observations were idempotent. No replacement payout was signed.

The founder-approved fixture uses a new **6 test USDC** incoming transfer and a
subsequent **5 test USDC** withdrawal, with a displayed **zero test-USDC fee**.
Gas is separately supplied valueless test ETH; this does not establish a live
network-fee quote or change the user-paid displayed-fee policy. No paid service,
mainnet asset, live liability or provider account is involved.

The prior **4 test USDC** custody float remains unallocated. It never credits
this fixture account. Only the newly reconciled incoming transfer can issue the
6-test-USDC application liability. Final expected balances are 9 test USDC at
the funder, 5 at custody and 6 at the recipient; the new remaining application
liability is 1, with the prior unallocated 4 accounting for the custody total.

The verifier creates its own persistent loopback PostgreSQL cluster, private
random administrator/owner/runtime credentials and synthetic password-backed
account. It loads no operator `.env`, accepts no external database URL, and pins
the ledger rail to `base-sepolia`. It uses actual application repositories to:

1. Quote and reconcile the new deposit, crediting exactly once only after the
   canonical receipt and exact token log are covered by finalized chain state.
2. Verify a fresh password proof bound to the immutable withdrawal request,
   gross, fee, net, destination, asset/environment and generation/session.
3. Reserve funds transactionally and perform explicit owner manual review.
4. Validate candidate signed bytes, then commit the unique immutable
   `coin_nonce_reservations` request/sender/nonce/hash/bytes mapping before any
   broadcast. On a retry it loads those exact database bytes; it never signs a
   replacement to resolve an unknown outcome.
5. Reconcile the original transfer's canonical/finalized receipt and validated
   log index, and post owner observation plus settlement atomically. Repeated
   funding, nonce and external observations are asserted idempotent.

Receipt evidence digests exclude the moving finalized height and use stable
transaction/block/log/transfer identities. HTTP 429 responses from the public
RPC prompted shared request pacing; errors remain bounded and do not release
reservations.

The private cluster and immutable history survive interrupted or pending runs.
While the first incoming transfer awaited finality, additive migrations 6400
and 6500 were added after the trial had already applied 7000. The migration
runner correctly rejected that historical ordering. The operator verified and
applied exactly those two missing migrations in this disposable cluster, without
resetting its history or changing migration timestamps. Resumed trials now
require the exact complete migration-name inventory; they never auto-migrate.
Fresh trials retain the normal migration runner and its order checks.
The subsequent stable media-intent migration 8000 was likewise explicitly
verified as the only missing additive migration before application; the pending
payout retained its original hash, nonce and bytes throughout.

Keys, passwords, application cookies and raw transactions stay in mode-600 files
under private mode-700 temporary directories. Never delete/reinitialize these
records to retry a payment. Only public receipts, hashes, fixture balances and
non-secret configuration appear here. Cleanup or archival of this disposable
cluster follows successful reconciliation; it cannot touch staging accounts.
After the successful trial, its PostgreSQL process was stopped and its private
history retained. No hosted acceptance identity was created or removed.

Reproduce/resume with Node 24 and PostgreSQL 17/18 tools on PATH:

```sh
COIN_TESTNET_ENVIRONMENT=sandbox node scripts/verify-coin-testnet-ledger.ts
```

The command exits `2` while external finality is pending, `1` on a bounded
failure, and `0` only after both transfers and application/external balances
reconcile. Each invocation is bounded. This establishes neither Canadian
eligibility, conversion routes, provider custody acceptance, hosted deployment,
promotional treasury funding nor live-release approval.
