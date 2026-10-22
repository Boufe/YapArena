# Account session revocation

Current email-first work adds account status, PostgreSQL provider-session replay
fences, an asynchronous Privy re-check ([Decision 0008](../decisions/0008-auth-simplification.md)
step 9), a durable Privy freeze/unfreeze
queue and a separate durable LiveKit speaker-revocation queue. See the
[provider session contract](../email-first-accounts.md#ownership-sessions-and-recovery)
and [requirement/evidence matrix](../email-first-completion.md). Combined local,
hosted provider, legacy-token and physical-device acceptance remain separate;
the historical F03 trials do not establish acceptance of these additions.

This implementation preserves opaque cookies, server-side token hashes, independent normal
sign-ins, wallet-only accounts, stable account ownership, and the nonfinancial preview. It
addresses F03, merged in PR #21 before the final F02 credential routes in PR #22. The original
auth audit is an untracked historical local artifact, not a portable repository source of truth.
Use the current contract below and [F03 handoff](f03-integration-handoff.md) for implementation
evidence. The new Cloud trial separately demonstrates provider-token rejection;
it does not replace the final hosted rollout and legacy-grant checks.

## Owner controls and semantics

| Action                                 | Result after successful commit                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/logout`                | Normal Sign out advances the account generation and retires all existing account sessions. Creates no replacement cookie.                                                                          |
| `POST /api/auth/logout-all`            | Advances the account generation and deletes every existing account session, including the invoking session. Creates no replacement.                                                                |
| `POST /api/auth/logout-other-sessions` | Advances the generation, deletes every other session and advances the authorized current row to the new generation. Retains its token and original absolute expiry; creates no replacement cookie. |
| `DELETE /api/auth/sessions/:id`        | Revokes only a session owned by the authenticated account. Session IDs are server-issued selectors, not ownership evidence.                                                                        |
| Wallet removal                         | The credential deletion trigger advances the generation and deletes all existing account sessions in the same transaction.                                                                         |
| Password or email credential update    | The users trigger advances the generation and deletes all existing account sessions in the same transaction.                                                                                       |

Account-wide controls require a live authenticated session, accept no account/session
selectors, derive the account from server authentication, and recheck the invoking session
inside the transaction. The account page explains whether this device stays signed in. Cookie
attributes and the existing Origin protection remain unchanged. The existing authentication
limiter remains defense in depth. Logout, owned session reads and revocation bypass
the shared abuse limiter and never schedule a Privy re-check, so they remain available
during Redis/Privy outages. PostgreSQL must still confirm account-wide revocation.
An absent, expired or unknown cookie returns a 401 warning that other devices were
not confirmed signed out; a database failure must not claim successful revocation.
Revocation responses do not expire the browser cookie: an old delayed response
must not delete a newer account's cookie. The remaining opaque cookie has no
authority after its database session is retired; a new sign-in overwrites it.
The interface also discards outcomes from the previous account/view generation.

Supported browser flows serialize cookie-issuing requests and session revocation
with the same origin-wide Web Lock. Native passkey/wallet dialogs run before
acquiring it. A revocation waits at most 35 seconds for an in-flight account
change, then allows 10 seconds for its HTTP response; a timeout reports that
sign-out is unconfirmed. With no pending account change, revocation proceeds
immediately. Read-only requests do not take that lock. Browsers without the
required secure-context lock support receive an explicit upgrade message.

Before waiting, the browser captures its last server-verified account as a
comparison hint. The server compares that hint with the cookie-authenticated
account and refuses a mismatch; it never uses the hint to select an account or
establish ownership. This prevents an old tab's queued sign-out from revoking a
different account that signed in first. The hint is redacted from HTTP logs.
These ordering protections cover cooperating application browser flows;
arbitrary API clients do not participate in the browser lock. PostgreSQL
authorization and revocation still apply to every client.

A protected request makes one indexed `SELECT` on `sessions`, `users` and
`provider_identities`. It never calls Privy, takes no row lock and never fails
because Privy is unavailable. When `provider_identities.checked_at` is more than
15 minutes old, the request schedules an asynchronous re-check and continues. The
re-check claims `checked_at` atomically, so one process reads Privy once per
account per interval, and holds no connection or lock during the read. Its
result is written only if the session generation, identity mapping, stored
methods and provider-control job are unchanged under the account lock:

- a deleted, frozen or guest Privy user (or one with an unsupported or no sign-in
  method) loses every session through `revokeAccountSessions`, audited as
  `sessions.incident` with `reason: "provider_change"`;
- a sign-in method change is recorded with a `provider.credentials.changed` audit
  event and an `account.signin_changed` notice; sessions continue;
- a change that is the passkey this account is activating, or a frozen response
  during the app's own freeze/unfreeze reset, is left alone;
- a Privy outage or rate limit pauses re-checks in that process for 60 seconds;
- an inconclusive check (outage, own reset, a concurrent change or an error)
  hands its claim back, so the account is due again about a minute later.

Sign-in and passkey setup record method changes the same way, instead of
requiring ownership reconciliation or failing setup. A change that is the passkey
being activated stays with that activation, which records it. Step-up re-reads Privy and checks only the approving key (still
linked, same public key). Privy-side deletions, freezes and method changes
therefore reach the app within about 15 minutes of activity, live at sign-in and
step-up, and sessions still end after 7 days. A refreshed or replayed provider token cannot reuse a consumed
Privy session ID to recreate an expired/revoked YapArena session. Local revocation
commits before external calls; Privy queue failures retain their fence and retry.
An uncertain provider mutation requires incident reconciliation. Provider freeze/
unfreeze is not a compare-and-swap ownership API: use a single operator for a
provider incident rather than racing dashboard edits against the worker.
The provider-control worker holds the account ordering lock during its bounded
freeze/unfreeze sequence (up to 20 seconds). A concurrent local revocation may
wait for that sequence. The provider re-check holds no such lock or
checked-out connection while awaiting Privy.

An acknowledged reset superseded by a successful authenticated logout drains
only its existing bounded cleanup, with an exact audit/job for every intervening
generation. Its completion cannot advance a stale mapping/token cutoff or wake
wallet work; the current logout still performs its own reset. A committed live
unfreeze intent remains owned by its original lease. Unknown intents, changed
credentials, suspension and unaudited generation changes stay fenced. The
separate reviewed owner rearm can restore one stopped acknowledged/inherited
pair's confirmation budget once; an exact concurrent request returns the same
immutable audit receipt without another provider call or budget allocation.

An inspection failure during the matching pending/running provider reset, or
its uncertain manual outcome, denies protected access temporarily. It must not
mistake the application's own freeze for another credential incident and revoke
the deliberately rotated session again. A valid observation of changed
credentials or changed accepted public-key material still triggers revocation.

## One Privy passkey

New enrollment uses Privy from Account settings, and sign-in offers one passkey
option. YapArena obtains the credential ID and COSE public key from its trusted
server-side Privy read, then verifies an application-issued native assertion
with required user verification, exact origin/RP and a one-use challenge. This
second ceremony uses the same credential; it does not register a second key.
The accepted credential's provenance, provider subject and public-key fingerprint
remain bound to the internal account. Future operation proofs check current
provider evidence and bind the exact application session, generation and terms.
Neither token refresh nor a frontend MFA flag substitutes for that proof.

The original enrollment intent lasts at most five minutes. Its original cookie
can finish the exact pending addition through narrowly scoped routes while
ordinary protected reads stay unavailable. A refresh stores only the intent ID;
passwords, signatures and approval proofs stay in memory. Resumed strong
approvals are still consumed with the key adoption transaction. Account/provider
changes abort queued application requests and the application's native assertion.
The installed Privy registration hook exposes no public abort option for an
already-started registration; its continuation is fenced instead.

The founder also approved restarting unfinished first setup after expiry. It
requires a fresh unconsumed Privy session, the same provider identity, the exact
old baseline plus one current provider key, a new short-lived native UV challenge
and no financial or previously accepted stronger-method history. A captured
original key must match exactly; when no key was captured, the explicitly
approved fallback accepts the sole current added key. It cannot prove an
unrecorded historical key was never replaced. Existing reset, minimum-token-time,
SID and generation fences still apply. The expired original challenge is never
extended or reused. Established accounts and financial access require retained
strong proof; email alone cannot reset it.

Previously enrolled independent application keys remain retained credentials.
Only those legacy keys can use the older direct application-key login and
new-provider-identity replacement below. A new Privy passkey instead signs into
its existing Privy identity, after which retained-proof settings can verify a new
email and remove an unavailable Google method without changing account ownership.

The retained legacy lost-login replacement has a separate authority boundary: a new
Privy-verified email identifies the replacement provider user, while a retained
YapArena security passkey authorizes replacing the existing account's sole email
or Google binding. A refreshed token or email match does not supply that
authorization. Retiring the old binding advances the account generation,
revokes old local sessions and speaking grants, consumes the operation and new
provider session, and creates one successor cookie after commit. The old
provider subject stays permanently tombstoned. Provider-control jobs and
inspection fingerprints must be scoped to the currently bound subject so old
work cannot affect the successor identity. No old provider user is deleted or
modified. Acceptance is recorded in the linked completion matrix.

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

Provider provisioning and replacement additionally take the relevant DID
advisory locks before the account row. Replacement locks both old and new
subjects in a fixed order, then rechecks account, session, credential and
operation state. Its remote provider inspections finish before acquiring a
database connection or these transaction locks. The database exposes a narrow
replacement function rather than granting runtime general ownership-update
permission on provider mappings.

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

The original F03 baseline had no recovery or suspension implementation. Current
email-first security operations bind retained password/wallet/security-passkey
proof to account, session generation, nonce, expiry and exact operation terms.
They consume proof and mutate in one account-locked transaction. Provider login
refresh is not that proof. Suspension is enforced at login, lookup and sensitive
commit boundaries; revocation alone still permits a fresh sign-in. Email recovery
must not replace a lost strong financial credential; all-strong-methods-lost
accounts require reviewed recovery.

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
actor account/session ID for owner controls, database role, request correlation, action,
outcome and generation. Operator incident actions record the database actor and do not
attribute the action to the affected account owner; credential
triggers include database actor role, credential subject, outcome/generation and optional
`yaparena.request_id`. They contain no raw cookies, token hashes, passwords or signatures.
Existing insert/delete events remain available for lifecycle correlation. Monitor unexpected
session-generation errors, account revocation volume, credential events and transaction
failures/deadlocks. A failed transaction must not be reported as successful containment.

## External and in-flight boundaries

A completed request cannot be cancelled retrospectively. Feature writes already authorized
before revocation may finish if they do not recheck the session at commit. Credential
management and new sandbox financial commits use `assertActiveSession` under the shared account lock; future sensitive
mutations must do likewise. Existing matching/community/media/measurement writes mostly
check account/role/feature state rather than locking the session at commit, and this change
does not claim to revoke already authorized work in those features.

Tracked speaker grants have a separate durable lifecycle. Issuance requires an
active assigned speaker, a current YapArena session and a recent device check.
Viewers receive watch-only access. Each speaker grant uses a unique provider
identity; refresh keeps that identity only for the same valid session. Changing
devices requires an explicit Join action and confirmed removal of the old grant
before the replacement is issued. A durable replacement intent prevents the old
device's automatic retry from winning that slot. Delayed departure callbacks are
checked and paused under the same account lock so they cannot pause an already
active replacement.

Session expiry, revocation, suspension and credential-generation changes enqueue
removal transactionally. Web/worker processes reconcile expiry and retry bounded
provider failures; claim tokens prevent late acknowledgments from completing
another worker's claim. Provider work occurs outside database locks. A successful
Sign out confirms local revocation and durable containment work, not instantaneous
external disconnection during a provider outage. Observe queue outcomes/latency
and investigate sustained failures.

Protected issuance currently requires LiveKit Cloud token revocation. Removal
supplies an explicit cutoff to cover freshly refreshed tokens, with a bounded
provider-clock health check. Self-hosted removal alone cannot revoke previously
issued bearer tokens and is not accepted for this path. Fresh/refreshed-token
hosted replay remains a distinct acceptance gate. Before rollout, inventory
legacy `speaker-<accountId>` connections and drain their outstanding JWT lifetime;
these predate the tracked grant queue. Do not remove viewers or delete unrelated
rooms. Public watching and existing bearer playback lifetimes remain separate
from account speaker revocation.

## Rollout, migration and rollback

The following records the historical F03/F02 rollout. Current additive email-first
and media migrations must also run as owner before the compatible runtime starts;
see the current implementation matrix and coin operations guide. Historical
integration order: F04 database isolation → F03 → F02 retained-credential proof. Additive
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
