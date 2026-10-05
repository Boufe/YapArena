# Account session revocation — F03

This implementation preserves opaque cookies, server-side token hashes, independent normal
sign-ins, wallet-only accounts, stable account ownership, and the nonfinancial preview. It
addresses F03; the original audit is historical evidence and has not been rewritten.

## Owner controls and semantics

| Action                                 | Result after successful commit                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/logout`                | Deletes only the presented token. Clears its cookie. Other devices stay signed in.                                                                                                                 |
| `POST /api/auth/logout-all`            | Advances the account generation and deletes every existing account session, including the invoking session. Clears its cookie and creates no replacement.                                          |
| `POST /api/auth/logout-other-sessions` | Advances the generation, deletes every other session and advances the authorized current row to the new generation. Retains its token and original absolute expiry; creates no replacement cookie. |
| Wallet removal                         | The credential deletion trigger advances the generation and deletes all existing account sessions in the same transaction.                                                                         |
| Password or email credential update    | The users trigger advances the generation and deletes all existing account sessions in the same transaction.                                                                                       |

Both account-wide controls require a live authenticated session, accept no account/session
selectors, derive the account from server authentication, and recheck the invoking session
inside the transaction. The account page explains whether this device stays signed in. Cookie
attributes and the existing Origin protection remain unchanged. The existing authentication
limiter covers both controls; it is process-local, so shared throttling remains F07 work.

F02 supplies fresh retained-credential proof for credential-management operations. A mutation
may return a new session only when that proof authorizes it; the old invoking session is never
implicitly exempted from credential revocation. The replacement is inserted at the new
generation inside the mutation transaction and its cookie is published after COMMIT. The
standalone F03 baseline unlink path clears the cookie and requires a fresh sign-in; the final
combined product uses F02's operation routes and authorized successor.

## Database ordering and shared interfaces

`users.auth_generation` is the single account authentication revision. Each session stores the
generation checked at issuance. There is deliberately no session generation default. The
session INSERT/UPDATE trigger takes the account row lock and rejects missing/obsolete
generations. Lookup joins the current account generation and checks absolute expiry with
`clock_timestamp()`. Revocation also physically deletes retired rows, protecting old lookups
that do not understand the generation.

The common lock order is account row → active session row → credential operation/challenge
row → target wallet advisory lock/mutation. Wallet credential reads happen under the account
lock. An unknown wallet has no existing account to lock: its address/chain advisory lock
serializes new-account provisioning; discovering an existing mapping rejects the old unknown
challenge and requires a new one. No path acquires an existing account lock while holding a
wallet advisory lock. Password hashing and SIWE/RPC verification happen before the issuance
transaction; their authoritative state is checked again under the account lock.

The generation advance under that lock is the revocation ordering point. COMMIT makes it
visible to every instance. An issuance which commits first is deleted by the revocation. An
issuance waiting behind revocation compares its old snapshot and fails. Fresh authentication
using a still-valid credential reads the new generation and can succeed. There are no
in-memory revocation caches or cross-instance broadcasts to lose.

`src/platform/auth/sessions.ts` exports these transaction-scoped contracts:

- `lockAccount(client, userId)`: locks the account and returns current credential fields and
  `authGeneration`, or null.
- `assertActiveSession(client, userId, tokenHash)`: after the account lock, locks and checks the
  owned session, generation, and live absolute expiry. Throws `SessionUnavailableError`.
- `insertSession(client, userId, tokenHash, expiresAt, authGeneration)`: inserts a checked
  session in the caller's transaction. Its result does not authorize publishing a cookie
  before the caller successfully commits.
- `revokeAccountSessions(client, userId, options)`: after the account lock, advances the
  generation, deletes sessions and records the account audit event. `retainTokenHash` is only
  for an already revalidated current session; the repository's `revoke` method enforces that
  precondition. `action` is `sessions.logout_all`, `sessions.logout_others`, or
  `sessions.incident`; options include `actorSessionId` and `requestId`.
- `sessions.create(userId, tokenHash, expiresAt, expected)`: owns its transaction and requires
  `expected.authGeneration`. Password sign-in also supplies the exact verified hash/email;
  optional `walletId` checks credential ownership. It commits before returning.

Wallet login challenge issuance stores the then-current account ID, wallet UUID, and
account generation. Completion rechecks the snapshot and wallet ownership, atomically
consumes the challenge and inserts the session before COMMIT. Unknown legacy challenges
are consumed during migration. F02 operations bind their proofs to the same generation,
session, trusted credential UUID and exact action/target; generation changes invalidate
pending approvals even when logout-others retains the token.

No password-change/reset/email-verification endpoint exists in this baseline; none is claimed
secured. Future recovery code must verify its purpose-bound proof under the account lock and
UPDATE the credential inside that transaction. The trigger handles atomic session revocation;
recovery proofs must also bind to this generation. Suspension must additionally enforce an
account status at login, lookup and sensitive commit boundaries; revocation alone permits a
fresh sign-in. There is no suspension implementation in this change.

## Compromised-account procedure

1. Identify the affected account through an authenticated owner request or the existing
   private support process. Never treat an email string or wallet connection as recovery proof.
2. The owner uses **Sign out all sessions** to retire all device cookies. A still-compromised
   credential can sign in again, so remove/replace it using retained trusted credential proof
   (F02), or the verified owner/operator procedure below. A lost sole wallet has no recovery
   bypass; the final-method guard remains in place.
3. Use a separately authorized operator database connection for administrative remediation.
   Stop unknown older application instances before a mass incident action. Hash any new
   password with the existing Argon2id function outside the database transaction. Never put
   a plaintext password, hash, token, cookie or signature in command history, issue text or logs.
4. With bound parameters in an owner session, run the following transaction shape. This is
   account-scoped; `account_id`, `new_hash`, `request_id` and `reason` are reviewed parameters,
   not text substituted into SQL. Runtime has no password/email UPDATE permission.

```sql
BEGIN;
SELECT id FROM users WHERE id = $1 FOR UPDATE;
SELECT set_config('yaparena.request_id', $2, true);
-- If replacing a verified password credential:
UPDATE users SET password_hash = $3 WHERE id = $1 AND email IS NOT NULL;
-- The credential trigger already advances generation and deletes sessions.
COMMIT;
```

For session-only incident containment, hold the same account lock, call
`revokeAccountSessions(client, accountId, { action: 'sessions.incident', requestId })`, then
commit. This provides the supported audited generation advance and row deletion. No public
administrative revocation endpoint is introduced. Verify old cookies fail and the retained
credential signs in freshly in a synthetic drill before applying the procedure to real users.

A normal UPDATE of `users.password_hash`/`email` with the installed trigger atomically
revokes sessions, including an owner SQL update. Do not disable triggers, use replica-mode
writes, restore old auth rows, or drop the guards. Wallet-removal operator SQL must acquire
the account lock before DELETE; unsupported wallet-first SQL can deadlock with application
transactions and PostgreSQL will abort a participant. Trigger rollback preserves atomicity.
The revocation guarantees do not establish recovery ownership or authorize arbitrary SQL.

Audit records use the existing 90-day identity audit mechanism. Account-wide events include
actor account/session ID, request correlation, action, outcome and generation; credential
triggers include database actor role, credential subject, outcome/generation and optional
`yaparena.request_id`. They contain no raw cookies, token hashes, passwords or signatures.
Existing insert/delete events remain available for lifecycle correlation. Monitor unexpected
session-generation errors, account revocation volume, credential events and transaction
failures/deadlocks. A failed transaction must not be reported as successful containment.

## External and in-flight boundaries

A completed request cannot be cancelled retrospectively. Feature writes already authorized
before revocation may finish if they do not recheck the session at commit. Credential
management (F02) uses `assertActiveSession` under the shared account lock; future sensitive
mutations must do likewise. Existing matching/community/media/measurement writes mostly
check account/role/feature state rather than locking the session at commit, and this change
does not claim to revoke already authorized work in those features.

Previously issued LiveKit grants, connected speakers and bearer playback URLs have their own
lifetimes. Application cookie revocation does not terminate them. F12 needs provider removal
and a durable retry/issuance boundary using the same account ID/generation. The transactional
revocation helper returns the new generation so F12 can enqueue work inside the caller's
transaction; no provider/outbox implementation exists here. Credential triggers also emit
account audit events but that audit is not currently a provider-revocation queue. Handle
provider access separately during incidents; do not advertise application logout as stopping
an already connected speaker.

## Rollout, migration and rollback

Integration order: F04 database isolation → F03 → F02 retained-credential proof. Additive
migrations run as owner in this order:

1. `1791158400000_isolate_server_database.js` (F04).
2. `1791158500000_account_session_revocation.js`.
3. `1791158501000_limit_revocation_privileges.js`.
4. `1791158600000_wallet_operation_authorization.js` (F02).

F03 retires every existing session and pending wallet challenge because they lack trustworthy
revision binding. Expect all users to sign in again. New functions are SECURITY INVOKER with
an explicitly resolved private-schema search path and PUBLIC EXECUTE revoked. Runtime has
only the additional `users.auth_generation` / `sessions.auth_generation` UPDATE grants; the
privilege-limiting follow-up removes unnecessary credential and trigger EXECUTE grants.

Use a coordinated restart: drain/stop every old web/worker instance, migrate once, deploy the
combined compatible F01–F04 image, verify runtime-role access and synthetic fresh sign-ins,
then admit traffic. Old session INSERT statements fail closed because they omit generation;
old lookup statements cannot use physically deleted cookies. Running old binaries afterward
causes sign-in failures and still exposes their unrelated F02 defects, so mixed versions are
not a supported steady state. Do not deploy only F03's legacy credential-management routes
as the final resolution of F02.

Both migration `down` paths intentionally fail. Keep the schema and forward-fix or use a
revocation-compatible prior image. An old pre-fix image cannot create sessions safely with
this schema. Never restore revoked session rows during application rollback. After a backup
restore, retire all restored sessions/challenges and advance every account generation before
serving traffic; invalidate F02 approvals and external grants separately. A schema-only
rollback or restoring old session tables can revive access and is prohibited.

## Verification and primary guidance

`REVOCATION_TEST_DATABASE_URL` must name a disposable `yaparena_f03*` or `revocation_test*`
database. Apply migrations as owner, optionally set `REVOCATION_TEST_RUNTIME_URL` for the
least-privileged runtime, then run `npm run test:revocation` and `npm run check` with those
variables. The suite skips when no database URL is provided; that skip is not PostgreSQL
verification. CI/integration must explicitly run it against a disposable PostgreSQL service.
Node tests use real account/session rows, two separate app pools, synthetic EOA signatures,
transaction barriers and observed PostgreSQL lock waits; mocked tests alone are not the
race evidence. The handoff records actual commands/results and browser evidence.

This design applies server-side logout/invalidation and session lifecycle controls from the
[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and fresh authorization after credential-risk events from the
[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
[NIST SP 800-63B-4 Session Management](https://pages.nist.gov/800-63-4/sp800-63b/session/)
distinguishes application authentication sessions from longer-lived service access tokens;
that distinction informs the explicit external-access boundary above. Guidance reviewed
2026-10-05; this change does not claim an authentication assurance level or NIST conformance.
