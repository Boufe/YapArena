# Account session revocation

Since [Decision 0009](../decisions/0009-auth0.md), people sign in only through
Auth0 (email code or Google), and sensitive operations are confirmed by a fresh
Auth0 sign-in. Password, wallet and native-passkey sign-in, legacy linking and
identity recovery were removed. Privy is unmounted: no request, re-check or
background job calls it, although its code remains until prompt 12 deletes it.
The Privy sections below that describe that unmounted code are marked as such.

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

| Action                          | Result after successful commit                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/logout`         | Deletes only the invoking session row (audited `sessions.logout_one`). The generation is unchanged and other devices stay signed in. Returns the Auth0 logout URL; creates no replacement cookie. |
| `DELETE /api/auth/sessions/:id` | Revokes only a session owned by the authenticated account. Session IDs are server-issued selectors, not ownership evidence.                                                                       |
| Incident revocation (operator)  | `revokeAccountSessions` advances the generation and deletes all existing account sessions in the same transaction.                                                                                |

By founder decision on 2026-10-22, Sign out works as in other apps: it ends this device only.
Sign out all sessions and Sign out other sessions (`POST /api/auth/logout-all` and
`/logout-other-sessions`, audited `sessions.logout_all`/`sessions.logout_others`) were
removed; older audit rows keep those names. The account page's Active sessions list signs out
one chosen device at a time. Neither control advances the generation. After Sign out the
browser navigates to Auth0's logout endpoint, which ends this browser's Auth0 session and
returns to the home page; other tabs of this browser follow through the `yaparena-account`
BroadcastChannel. An Auth0 session on another device is not ended. A YapArena session is
created only by a completed authorization-code callback with a one-use state, so an old
Auth0 response cannot mint a new session.

Session controls require a live authenticated session, accept no account selectors, derive
the account from server authentication, and recheck the invoking session inside the
transaction. The account page explains that signing out ends only that device. Cookie
attributes and the existing Origin protection remain unchanged. The existing authentication
limiter remains defense in depth. Logout, owned session reads and revocation bypass
the shared abuse limiter and never call Auth0, so they remain available during
Redis/Auth0 outages. PostgreSQL must still confirm the revocation.
An absent, expired or unknown cookie returns 401 ("this session has already ended");
a database failure must not claim successful revocation.
Revocation responses do not expire the browser cookie: an old delayed response
must not delete a newer account's cookie. The remaining opaque cookie has no
authority after its database session is retired; a new sign-in overwrites it.
The interface also discards outcomes from the previous account/view generation.

Sign-in is a full-page navigation through Auth0, so no browser request issues a
session cookie. Session revocations (sign out and removing one session) take an
origin-wide Web Lock so two tabs never revoke at once. A revocation waits at most
35 seconds for another in-flight revocation, then allows 10 seconds for its HTTP
response; a timeout reports that sign-out is unconfirmed. Read-only requests do not
take that lock. Browsers without the required secure-context lock support receive
an explicit upgrade message.

Before waiting, the browser captures its last server-verified account as a
comparison hint. The server compares that hint with the cookie-authenticated
account and refuses a mismatch; it never uses the hint to select an account or
establish ownership. This prevents an old tab's queued sign-out from revoking a
different account that signed in first. The hint is redacted from HTTP logs.
These ordering protections cover cooperating application browser flows;
arbitrary API clients do not participate in the browser lock. PostgreSQL
authorization and revocation still apply to every client.

A protected request makes one indexed `SELECT` on `sessions` and `users`. It never
calls Auth0 and takes no row lock. Auth0 is consulted only at sign-in and when an
operation is confirmed; sessions still end after 7 days. A change made in the Auth0
dashboard (a blocked user, for example) reaches the app at the next sign-in or
confirmation. To end existing sessions sooner, use the incident procedure below.

The unmounted Privy re-check (a request whose last Privy read was over 15 minutes old
scheduled an asynchronous read, which could revoke sessions as `sessions.incident` with
`reason: "provider_change"`) and the Privy freeze/unfreeze reset queue no longer run.
Their code and the `provider_revocation_jobs` table remain until prompt 12; their
historical contract is in the [provider session contract](../email-first-accounts.md#ownership-sessions-and-recovery).

## Confirmation by fresh sign-in

Sensitive operations (opening the financial sandbox once per account, each withdrawal and
each recovery consent) start a pending `account_operations` row bound to the account,
the invoking session, its generation, a purpose and exact terms. The browser then goes
to `GET /api/auth/confirm?operation=…`, which sends the person to Auth0 with
`prompt=login` and `max_age=0`. The callback accepts the confirmation only when:

- the signed-in Auth0 subject is linked to the same account (otherwise `other_account`);
- the ID token's `auth_time` is not earlier than the operation's creation second
  (otherwise `stale_sign_in`); and
- the operation is still pending, unexpired and its session and generation are current.

The callback marks the row confirmed with the subject and `auth_time`, creates no
session and returns to the starting page with `?confirmed=<id>`. The page then submits
the operation; the server consumes the confirmation in the same account-locked
transaction as the mutation, after rechecking session, generation and terms. A
confirmation is single-use, expires with its operation and cannot be moved to another
session, account, purpose or set of terms. A suspended account cannot confirm.

## One Privy passkey (unmounted)

This section describes code that no longer runs since Decision 0009. Privy passkey
activation and step-up were unmounted, and native YapArena passkeys were removed.

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

The common lock order is subject/email advisory locks (sign-in only) → account row →
active session row → account operation row → feature mutation. Auth0 token exchange and
ID-token validation finish before the transaction; their result is checked again under
the account lock.

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
  generation, deletes every session and records the account audit event. It serves security
  incidents only: `action` is `sessions.incident`, with an optional `reason` such as
  `provider_change`. Sign out uses the repository's `revokeSession`, which deletes one
  owned session row without changing the generation.
- `sessions.create(userId, tokenHash, expiresAt, expected)`: owns its transaction and requires
  `expected.authGeneration`. It commits before returning.

Auth0 sign-in locks the account (or, for a new account, the subject and email advisory
locks first), checks status, and inserts the session at the current generation in the
same transaction that links or provisions the identity. Confirmed operations bind the
same generation, session and exact terms; generation changes invalidate pending
confirmations. Suspension is enforced at sign-in, lookup, confirmation and sensitive
commit boundaries; revocation alone still permits a fresh sign-in.

## Compromised-account procedure

1. Identify the affected account through an authenticated owner request or the existing
   private support process. Never treat an email string as recovery proof.
2. The owner signs out every unrecognized device under **Active sessions**. A still-compromised
   mailbox or Google account can sign in again; the owner secures it with their email or
   Google provider. Until then, an operator suspends the account (step 4).
3. Use a separately authorized operator database connection for administrative remediation.
   Never put a token, cookie, authorization code or confirmation in command history, issue
   text or logs.
4. With bound parameters in an owner session, hold the account lock, then either call
   `revokeAccountSessions(client, accountId, { action: 'sessions.incident', requestId })`
   for session-only containment, or set `users.account_status = 'suspended'` and revoke as
   well to keep the account out. Commit. `account_id` and `request_id` are reviewed
   parameters, not text substituted into SQL.

No public administrative revocation endpoint is introduced. Verify old cookies fail and a
fresh sign-in behaves as intended in a synthetic drill before applying the procedure to real
users. Do not disable triggers, use replica-mode writes, restore old auth rows, or drop the
guards. The revocation guarantees do not establish recovery ownership or authorize arbitrary
SQL.

Audit records use the existing 90-day identity audit mechanism. Account-wide events include
actor account/session ID for owner controls, database role, request correlation, action,
outcome and generation. Operator incident actions record the database actor and do not
attribute the action to the affected account owner. Sign-in method links record the
method and outcome with optional `yaparena.request_id`. They contain no raw cookies,
token hashes, authorization codes or ID tokens.
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
Node tests use real account/session rows, two separate app pools, an in-process OIDC
issuer, transaction barriers and observed PostgreSQL lock waits; mocked tests alone are not
the race evidence. The handoff records actual commands/results and browser evidence.

This design applies server-side logout/invalidation and session lifecycle controls from the
[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and fresh authorization after credential-risk events from the
[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
[NIST SP 800-63B-4 Session Management](https://pages.nist.gov/800-63-4/sp800-63b/session/)
distinguishes application authentication sessions from longer-lived service access tokens;
that distinction informs the explicit external-access boundary above. Guidance reviewed
2026-10-05; this change does not claim an authentication assurance level or NIST conformance.
