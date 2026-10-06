# F02 implementation handoff

Implemented and verified locally on 2026-10-05. This is the combined F04 → F03 → F02
review branch. No deployment, production data, financial operation, or merge into another
agent's assigned branch was performed. Follow [private security reporting](../../SECURITY.md).

## Checkout and dependency commits

- Worktree: `/private/tmp/yaparena-f02`; branch: `fix/f02-wallet-reauthorization`.
- Baseline: `bc3e92f42aa067c08e4834301a99602323db395a`; dedicated checkout initially clean.
  The dirty shared F04 checkout was only read, never edited.
- F02 core implementation: `11cda2d`; runtime concurrency/browser refinements: `dcaf1c6`.
- Final account UI, migration inventory and screenshots: `88cec07`.
- Shared test transport adoption: `95a70b5`.
- Prerequisites: F04 implementation `365ced3` and deterministic HTTP transport `8904fad`;
  F03 final implementation `4097ec4`, including database actor attribution `d68a838`;
  coordinator F03 CI verification `48bd360` with the identical PostgreSQL workflow.
- Early F03 helper commits `ed790ff`/`9e66b8a` were cherry-picked as `15585e2`/`5ff533f`
  during parallel work. Final prerequisite tips were subsequently merged, preserving ancestry.
  Use the supplied final F02 tip for integration; do not replay these duplicate prerequisites.
- The final handoff commit also removes a duplicate synthetic session insertion in the CI
  identity journey. Obtain its immutable hash from the coordinator handoff/branch tip.

## Implemented behavior

Every link or unlink requires fresh proof of a credential already trusted by the account:
the current password through the existing Argon2 verifier, or a purpose-specific SIWE
signature from a retained linked wallet. The proposed wallet needs its own separate signature
and cannot approve its addition. Wallet-only accounts remain supported; removing the last
usable method and automatic recovery of a lost sole wallet remain prohibited.

A five-minute, one-use PostgreSQL operation binds account, session digest, authentication
generation, link/unlink purpose, exact target address/chain, target wallet UUID for unlink,
and authorizing wallet UUID. Restoring a password or removing/re-adding a wallet cannot
revive an old proof. Login signatures and proposed-wallet proofs cannot authorize the change.
There is no bearer approval token or general recent-authentication flag.

Signature/RPC verification precedes the transaction. Account → current session → operation
→ target identity advisory locking serializes live-session validation, credential eligibility,
mutation, final-method protection, single-use consumption and session rotation across instances.
The final consumption query checks wall-clock operation/session expiry after all writes. A
revocation/logout that wins makes mutation fail without a new credential or successor. If
linking commits first, later logout of the replaced token does not undo that committed link;
later account-wide revocation invalidates the successor. F03 generation guards remain authoritative.

Successful linking rotates the invoking session. Unlinking revokes preexisting account sessions
through F03 and creates one proof-authorized replacement at the new generation. Its cookie is
published only after COMMIT. Identity audit and the supported in-app account notification share
the transaction; a failed write or expiry rolls all success effects back.

The account dialog displays the full target and chain, offers only retained credentials, asks
users to switch to the existing wallet before its approval and then to the proposed wallet for
its separate proof, clears expired/canceled state, and reports rejected signatures and mismatches.
Sole-wallet removal is visibly disabled. Existing origin/CSRF controls, opaque-cookie sessions,
SIWE fields and configured contract-wallet verification remain; unavailable RPC fails closed.

## API, schema and owned files

| Area                | Changes                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication      | `src/platform/auth/wallet-operations.ts`; gated routes in `router.ts`; purpose-specific SIWE in `siwe.ts`; wallet repository exposes operations and removes ungated mutation methods in `wallets.ts`.                                                                                                                                                |
| Schema              | Additive `migrations/1791158600000_wallet_operation_authorization.js`: private `wallet_operations`, immutable binding fields, backend RLS, explicit SELECT/INSERT/DELETE and UPDATE only on `consumed_at`. Expired operations are cleaned after one day.                                                                                             |
| API                 | `POST /api/auth/wallet/operations` creates an operation; `POST /api/auth/wallet/operations/:id/complete` supplies the exact purpose/address/chain and proofs. Successful completion returns wallet data and a rotated cookie. Legacy link challenge/verify and cookie-only wallet DELETE routes return 404. Wallet login/inventory endpoints remain. |
| Product UI          | `public/account.js`, `public/site.css`, `src/features/discovery/web.ts`; account notifications reuse `/api/matching/notifications`. F03's session controls are retained.                                                                                                                                                                             |
| Regression evidence | `tests/wallet-operation-routes.test.js`, `tests/wallet-operations-postgres.test.js`; adapt obsolete tests in `siwe.test.js`, `wallet-repository.test.js` and F03's unlink assertions in `session-revocation-postgres.test.js`.                                                                                                                       |
| Integration         | `scripts/verify-wallet-browser.js`, `verify-identity-social.js`, `verify-database-isolation.js`; `.github/workflows/reusable-quality.yml` provisions disposable PostgreSQL and runs both suites under the unchanged coverage thresholds.                                                                                                             |
| Documentation       | `README.md`, `docs/decisions/0002-identity-and-social.md`, `docs/operations.md`, [authorization design](wallet-authorization.md), this handoff and four synthetic screenshots. Historical audit evidence is unchanged.                                                                                                                               |

F03's `lockAccount`, `assertActiveSession`, `insertSession` and generation triggers are used
without interface changes. Account-first lock order and the `chain:address` advisory key match
session issuance/logout/revocation. No new shared session interface, recovery mechanism,
mandatory email, dependency or financial capability was added.

## Actual verification

Node 24.19.0 and disposable PostgreSQL 18.4 were used. Owner connections provision/migrate
and create/remove fixtures; independent runtime connections perform credential operations.
The PG suites reject non-loopback connections and non-test database names. Accounts and wallets
are synthetic and uniquely scoped. No shared development or staging database was mutated.

| Command                                                                                 | Actual result                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`, with both suites' owner/runtime URL variables                          | **275/275 passed, zero failures/skips**; lint, Prettier, strict types and original 90% gates passed. Coverage **97.80% lines / 90.62% branches / 98.11% functions**.                                                                                                                                                          |
| F02 PostgreSQL suite, included in that gate                                             | **18/18 passed** with real runtime-role transactions and deterministic contention. Covers stolen-session denial, password/wallet-only success, separate new-wallet proof, all binding/replay failures, credential replacement, retention, rotation, revocation ordering, conflict and rollback.                               |
| F03 PostgreSQL suite, included in that gate                                             | **15/15 passed**, retaining revocation, guarded issuance, legacy retirement, rollback and runtime privilege assertions while adopting the proof-authorized unlink successor.                                                                                                                                                  |
| `npm run verify:database-isolation`                                                     | **Fresh and legacy upgrade passed**: ordered migrations, inventory including the operation table, SQL browser-role denial, actual runtime backend/worker journeys, trigger behavior, future defaults and provider-schema preservation. Final sanitized snapshots were written to `/tmp/yaparena-isolation-56460e09-evidence`. |
| `node scripts/verify-identity-social.js` with owner URL, after fictional discovery seed | **Passed** the exact CI journey and owner-only fixture cleanup. A separate runtime invocation completed the journey but correctly could not perform owner-only profile cleanup; runtime operations are independently covered above.                                                                                           |
| `node scripts/verify-wallet-browser.js`                                                 | **Passed** on the actual local runtime-backed app in fresh headless Chrome: password and retained-wallet approval, wallet-only link, wrong account/chain, rejected signature/retry, server expiry, mobile retained-wallet unlink, notifications, sole-method protection and no horizontal overflow/page errors.               |
| `docker build --target production --tag yaparena-f02-review:local .`                    | **Passed**, Node 24.19.0 production image. Local image manifest `sha256:5d997e7f5e9fb21fc96d17c6de5cfd8b64623eec495e09c1c91c17af600224f2`.                                                                                                                                                                                    |
| Production-image local smoke against disposable runtime DB                              | **Passed**: readiness 200, account approval UI rendered, legacy mutation 404, both operation endpoints rejected unauthenticated requests with 401. This is packaging/startup evidence, not a hosted deployment.                                                                                                               |
| `git diff --check`                                                                      | Passed.                                                                                                                                                                                                                                                                                                                       |

Reproduce the combined quality gate using secret-store/local-shell values:

```sh
WALLET_TEST_DATABASE_URL="$AUTH_TEST_RUNTIME_URL" \
WALLET_TEST_OWNER_DATABASE_URL="$AUTH_TEST_OWNER_URL" \
REVOCATION_TEST_DATABASE_URL="$AUTH_TEST_OWNER_URL" \
REVOCATION_TEST_RUNTIME_URL="$AUTH_TEST_RUNTIME_URL" npm run check
```

Use a disposable database named `yaparena_f02...` or `revocation_test...`, provision separate
identities, and apply migrations as owner before running. Missing URLs skip integration suites
and do not establish concurrency guarantees. CI supplies all four variables to its isolated service.

The contention tests wait for actual PostgreSQL lock waiters through `pg_stat_activity`, then
release held account/advisory locks. They verify logout/revocation-first rejection; link-first
ordering; exactly one success from duplicate approval consumption and competing links; one
owner from cross-account linking; one retained method after competing removals; and complete
rollback of credential/audit/notification/session changes after a forced late failure. There is
no mock-only claim about database serialization.

Intermediate full gates returned unrelated HTTP 401/reset failures and one SSH banner instead
of an HTTP response. The coordinator reproduced Supertest's IPv6-listener/IPv4-destination
mismatch using two different services on one port. Shared commit `8904fad` routes requests to
their actual owned listener and proves the peer and cookie jar in a controlled regression.
The final gate includes that test. The historical cause of each earlier connection remains
unproven; no authentication assertion, retry or coverage threshold was weakened.

The Browser plugin had no connected browser. Existing `playwright-core` and local Chrome
were used with fresh profiles and a synthetic signer adapter. No real extension, existing
browser cookies or private user session was inspected. Screenshots are committed and linked
from the [design](wallet-authorization.md#verified-integration-evidence).

## Migration, rollout and rollback

Apply admin provisioning and F04 `1791158400000`, F03 `1791158500000` and `1791158501000`,
then F02 `1791158600000` as migration owner. Stop/drain every old application instance first;
deploy compatible code and browser assets together. F03 retires legacy sessions/challenges,
so users must sign in again. The private operation table adds no browser/API-role grants.
No existing migration was rewritten. Validate synthetic sign-in, both approval methods,
session invalidation and notification/audit records before reopening traffic.

Older credential-management clients fail closed and must refresh the account page. Preserve
F03's generation/schema guards on application rollback. Never roll back to the old cookie-only
mutation binary or restore retired session/approval state. Prefer a forward fix; containment
can disable credential-change routes while retaining wallet login. The F02 table can be dropped
only after code no longer uses its routes or cleanup, discarding pending operations. That is
not a safe rollback of the credential-management behavior.

## Remaining release evidence and separate work

- Representative live ERC-1271 wallet/RPC verification, real wallet extension signing and
  physical mobile devices need a staging trial. Local EOA/signature and unavailable-RPC checks
  do not establish those behaviors. Configured verification continues to fail closed.
- Notification delivery is the existing in-app account channel. There is no independent email,
  push adapter or out-of-band delivery guarantee, and no NIST compliance/AAL or enforced MFA claim.
- Existing IP limits cover operation issuance (40/15 minutes) and completion/reauthentication
  (10/15 minutes), with origin/CSRF protection. Distributed/account-scoped throttling is separate
  F07 work; no known throttling owner was assigned during this implementation.
- F04 owns provider-hosted Data API/GraphQL/Realtime evidence and deployment configuration;
  SQL isolation checks alone do not close that finding. F03 owns account-wide revocation policy.
  LiveKit connections/external grants remain separate F12 work.
- Hosted rollout, draining all old instances, CI on the pushed PR and representative account-lock
  contention/load remain coordinator/release checks. Nothing here authorizes financial activity.

## Pull-request template handoff

### Summary

Wallet credential changes previously accepted session possession plus proposed-wallet control.
Require a fresh retained credential for each exact five-minute link/unlink operation, separate
new-wallet control, transactional consumption/live-session checks and a committed session
rotation. Update the account dialog, identity audit and supported account notifications.

### Verification

- [x] `npm run check` with both real PostgreSQL suites enabled: 275 passed, unchanged 90% gates.
- [x] Additive migration behavior verified on fresh and legacy-upgrade disposable databases.
- [x] Production image build and local runtime startup/smoke verified; hosted rollout remains pending.
- [x] Security, operations and rollback impact considered; four desktop/mobile screenshots linked.

### Deployment notes

Integrate the supplied final F02 branch tip after the preserved F04/F03 prerequisites. Apply
the ordered additive migrations as owner with old instances stopped, expect forced sign-in,
deploy account assets and compatible auth code together, then validate synthetic account
operations and committed notifications. Keep revocation guards on rollback and disable
credential mutations if containment is needed. Report/discuss security details privately.
