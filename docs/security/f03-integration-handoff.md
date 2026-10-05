# F03 implementation handoff

Standalone F03 implementation ready for coordinated integration review, 2026-10-05.
No deployment, hosted probes, production accounts or PR merges were performed.

## Checkout and commits

- Assigned checkout: `/private/tmp/yaparena-f03`.
- Branch: `fix/f03-account-revocation`.
- Starting commit: `bc3e92f42aa067c08e4834301a99602323db395a`, clean dedicated worktree.
- Shared F04 checkout was not edited. F04 was merged only into this dedicated worktree,
  with coordinator authorization; latest implementation/test dependency is `8904fad`.
- F03 prerequisite: `ed790ff` — account generation, migration, shared transaction helpers.
- F03 issuance/revocation: `9e66b8a` — guarded password issuance, atomic wallet completion,
  explicit logout controls, least-privilege follow-up, Node/PostgreSQL tests.
- F03 account UI/operating contract: `ad9a28d`.
- F01/F04 integration fixture adaptation: `858555c`.
- Operator-versus-owner incident audit attribution: `d68a838`.
- Verified listener-family test dependency: F04 `8904fad`, merged as `98f1ec5`.
- The final evidence commit adds this handoff, the reproducible browser script, screenshots,
  private-runtime privilege assertions and explicit legacy-session/challenge upgrade checks.
  Obtain its immutable identifier from the branch tip supplied in the integration message.

## F03-owned changed files

- Authentication: `src/platform/auth/sessions.ts`, `users.ts`, `wallets.ts`, `router.ts`.
- Additive migrations: `migrations/1791158500000_account_session_revocation.js` and
  `migrations/1791158501000_limit_revocation_privileges.js`.
- Account experience: `src/features/discovery/web.ts`, `public/account.js`,
  `public/account-sessions.js`.
- Tests: `tests/account-sessions.test.js`, `auth.test.js`, `logger.test.js`,
  `session-revocation-postgres.test.js`, `sessions.test.js`, `wallet-repository.test.js`.
- Verification: `scripts/verify-database-isolation.js`, `verify-identity-social.js`,
  `verify-session-controls-browser.js`, and the `test:revocation` package script.
- Documentation: `README.md`, `docs/decisions/0002-identity-and-social.md`,
  `docs/operations.md`, this handoff, `docs/security/account-session-revocation.md` and
  the three PNGs in `docs/security/evidence/f03/`.

The branch also includes the coordinated F01/F04 dependencies and shared transport helper;
those are reviewed in their own changes. F02's final credential routes/UI and corresponding
fixture adaptations replace the legacy wallet portions during one-way integration.

## Implemented guarantees and contracts

The [operating contract](account-session-revocation.md) contains endpoint semantics,
`lockAccount`, `assertActiveSession`, `insertSession`, `revokeAccountSessions`, the required
issuance snapshot, lock order, revocation ordering proof, owner-only administrative password
procedure, audit, mixed-version restart, rollback and backup-restore precautions.

The account generation is the only revision mechanism. Revocation is PostgreSQL-backed,
checked at issuance and on every protected lookup. Wallet challenges include an account,
wallet UUID and generation snapshot. Password authentication rechecks generation, exact
verified password hash and email after hashing. Credential mutations and revocation commit
atomically; no replacement cookie is emitted by logout-all. Logout-others retains the
revalidated current token and its original expiry. Independent ordinary sign-ins and the
existing single-session logout remain supported.

Migration order: F04 `1791158400000` → F03 `1791158500000` → F03 least-privilege
`1791158501000` → F02 `1791158600000`. Legacy sessions/challenges are retired. Both F03
down paths refuse a rollback that would remove revocation guarantees. Runtime gains only
required account/session generation UPDATE capability; it cannot UPDATE email/password or
directly execute the new trigger functions. The existing F04 schema/RLS/sequence grants
remain in force.

## Actual validation

The URL variables below were supplied only to isolated local synthetic databases. They are
not committed and are not production connections.

| Command                                                                                              | Actual result                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`, with `REVOCATION_TEST_DATABASE_URL` owner and `REVOCATION_TEST_RUNTIME_URL` runtime | **257/257 passed, zero skips**. Lint, format and strict types passed. Coverage **97.42% lines / 90.32% branches / 98.06% functions**, with the original 90% gates.                                                                                                                                                                                                                   |
| `npm run test:revocation`, same private owner/runtime connections                                    | **15/15 passed** on PostgreSQL 18.4. Two separate Express instances/pools; both cookies revoked by logout-all; current retained by logout-others; single logout preserves another session; credential change/unlink/relink, stale password and wallet proofs, both lock-wait orderings, rollback, precommit successor invisibility, legacy-binary denial and least-privilege checks. |
| `npm run verify:database-isolation`                                                                  | **Fresh and legacy upgrade passed** on disposable PostgreSQL 18.4 bookworm. Browser-role SQL denial, actual runtime backend journeys and worker cleanup, explicit legacy session/challenge retirement, repeated provisioning/migration, trigger behavior, future defaults, provider-schema preservation.                                                                             |
| `node scripts/verify-session-controls-browser.js` against local port 53023                           | **Passed** with fresh headless Chrome profiles, two contexts and the actual runtime-backed account page. Logout-others rejected the second context on reload and retained the first; logout-all rejected the first and displayed sign-in; reload remained signed out.                                                                                                                |
| `git diff --check`                                                                                   | Passed.                                                                                                                                                                                                                                                                                                                                                                              |

Browser plugin discovery returned no connected browser. The existing repository
`playwright-core` dependency and local Chrome were used in fresh profiles; no existing
browser/session store or raw cookie was inspected. The browser script accepts only loopback
origins. Screenshots contain fictional account UI, not real users or bearer credentials:

- [Signed-in session controls](evidence/f03/signed-in-controls.png).
- [Other-session action](evidence/f03/other-sessions-signed-out.png).
- [Logout-all returns to sign-in](evidence/f03/all-sessions-signed-out.png).

Two intermediate verification runs each returned an unexpected 401 in a test expecting a
valid session (password-update rollback and one protected upgrade journey). The isolated
rollback test, full PostgreSQL suite, fresh/upgrade harness rerun and final full gate passed.
No assertion or coverage threshold was weakened. Explicit restored-session-row and account
generation assertions were added to the rollback test. Preserve these observations during
independent integration review; investigate if either recurs. Ten subsequent consecutive
coverage-instrumented runs on `fc1c427` passed all 150 PostgreSQL scenarios without reproducing
the 401. This did not establish a cause; it bounded the actual local observations.

The coordinator subsequently reproduced a concrete transport failure: Supertest bound an
IPv6 listener but connected to a different IPv4 service on the same port, returning its 401.
An additional F02 run received an SSH banner on an intended HTTP request. Commit `8904fad`
adds a deterministic competing-listener regression and maps test connections to their actual
listener family while preserving the cookie-jar origin. F03 imports that shared helper for
its PostgreSQL requests. The precise listener involved in each historical 401 was not
captured, so those observations are retained; the verified failure mode and corrected
transport are now part of the required gate.

A final audit-attribution review adds the executing database role to session-revocation
events. Owner controls still identify their authenticated actor; administrative incident
revocation does not misleadingly identify the affected account as the operator.

## Agent coordination and remaining release evidence

F02 owns the final fresh-proof credential-operation routes, operation table, account wallet
UI and proof-authorized successor. It imported the actual F03 helper commits and reported
17/17 real-runtime PostgreSQL cases passing, including proof races and mutation rollback.
That report is agent evidence, not a claim that the final combined tip was tested here.
The coordinator explicitly requested F03 freeze without merging F02, preserving the stack
F04 → F03 → F02. F02 will merge this final F03 tip and run both suites. Its adaptations of
legacy link/unlink tests and verification scripts take precedence; preserve all F03 logout,
snapshot, legacy-retirement and privilege assertions.

Do not release F03's baseline credential-management routes as the final F02 remediation.
The combined F02 branch must prove retained-credential authorization and replacement cookie
publication only after COMMIT; the F03 helpers intentionally do not infer proof from a session.
F02 owns the disposable PostgreSQL CI service change and both suite environment variables.
This F03 test suite skips without its database URL; a skip is not concurrency evidence.
F01's actual Pino-capture fixture is adapted to the new atomic wallet issuance contract and
its credential-absence/cookie-preservation assertions remain intact.

No password recovery/change endpoint, suspension endpoint, distributed rate-limit store,
LiveKit invalidation queue or external-grant cancellation is introduced. Password UPDATE
revocation is implemented and verified; proof ownership for future recovery remains its
owner's responsibility. F12 must separately handle LiveKit access/connected speakers and
bearer grants. Sensitive feature mutations already authorized before revocation may finish
unless they adopt the commit-time session contract.

Remaining staging evidence: combined deployment with every old instance drained/stopped;
provider-hosted isolation checks owned by F04; real contract-wallet RPC behavior; mobile
browser/account controls; external media containment/retry checks owned by F12; and
representative contention/load on account locks. Passing local checks does not enable
financial activity or close those separate findings.

## PR template handoff

**Summary:** Removing a sign-in credential previously left issued account sessions usable.
F03 adds account-scoped logout-all/logout-others and one transactional account generation,
rechecks stale credential proofs before session issuance, atomically revokes on credential
updates, and exposes clear owner controls without changing opaque-cookie authentication.

**Verification:** `npm run check` passed with PostgreSQL enabled; fresh/upgrade/runtime
migration behavior and browser controls passed as listed above. Hosted deployment and media
provider behavior remain explicit staging gates.

**Deployment notes:** Apply the ordered additive migrations once as owner with all older
instances drained/stopped, expect legacy users to sign in again, deploy the combined compatible
F01–F04/F02 image, verify synthetic sign-ins/revocation before admitting traffic. Keep the
schema on rollback; never restore invalidated cookies/approvals. Follow private security
reporting; no public exploit issue is required for this handoff.
