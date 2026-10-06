# Wallet credential-change authorization

Wallets are alternative account sign-in credentials. Connection alone is not authentication;
SIWE messages authorize only the stated account operation, never spending. This gate does not
add MFA, automatic recovery, email delivery, or financial functionality.

## Operation flow

1. The signed-in account chooses **link** or **unlink**, a full address and chain, and an
   existing credential: current password, or a linked wallet. Unlink also identifies the
   exact wallet record. The account browser displays this target before approval.
2. `POST /api/auth/wallet/operations` creates a five-minute server-side operation with a
   random UUID and separate random 128-bit SIWE nonces. Its immutable fields bind the account,
   current session digest, account authentication generation, action, target address/chain,
   target wallet UUID (unlink), and authorizing wallet UUID (wallet approval).
3. The browser supplies the current password or signs the existing wallet's purpose-specific
   **Authorize link/unlink** SIWE message. Link additionally requires a separate **Prove control
   of this new wallet** message. Both wallet messages include the operation UUID. A login or
   proposed-wallet signature cannot approve the account change.
4. `POST /api/auth/wallet/operations/:id/complete` takes the exact action/address/chain and
   proofs. The server verifies signatures, then checks the live session and existing credential
   again in PostgreSQL. Password verification uses the existing Argon2 implementation inside
   the locked transaction. No bearer approval token or reusable recent-authentication flag is issued.
5. The transaction consumes the operation once, changes the credential, rotates the session,
   records identity activity, and inserts an account notification. A replacement cookie is sent
   only after commit. Failures roll everything back. Another pending operation bound to the old
   token is invalid under the replacement token; there is no general approval carried forward.

The old `/wallet/link/challenge`, `/wallet/link/verify`, and `DELETE /wallets/:id` mutation
routes and their ungated repository methods are removed. Older clients fail closed and must
load the updated account page. Wallet login endpoints remain separate.

## Credential eligibility and serialization

The authorizer must exist when the operation is created and remain eligible at mutation commit.
A target wallet cannot approve its own addition or removal. Wallet identity includes chain;
the authorizer's record UUID also prevents an old proof from surviving removal and re-addition.
F03's account generation invalidates pending proofs on credential replacement/removal and
account-wide revocation, even if a previous password is later restored. Unlink approval uses
an existing method that remains on the account. A count check under the account lock also
protects the final usable method. Losing a sole wallet still has no automatic recovery.

Lock order follows F03: account row, current session row, operation row, then target identity
advisory lock (`chain:address`). Credential reads are serialized by the account lock; wallet
removal's database trigger locks that account before it can commit. Cross-account target
conflicts additionally use the shared advisory lock and unique chain/address constraint.
This serialization works across application instances. Supported operator credential work must
also lock the account first; an inverse lock order can be aborted as a PostgreSQL deadlock.

Signature/RPC verification runs before transaction locks. A logout that deletes the session
before the mutation locks it makes mutation fail. Revocation that advances the generation first
also makes mutation fail. If mutation commits first, later logout of the replaced old token does
not remove the committed wallet or its replacement session. Later account-wide revocation
invalidates that replacement session, but does not undo an earlier credential change.

Unlink follows F03's conservative policy: removing a wallet revokes all old account sessions;
the retained-credential proof permits one replacement at the new generation. Linking rotates
only the current session. The final consumption query checks expiry with `clock_timestamp()`
after all writes, immediately before commit; expiry during lock waits cannot leave success data.

## Notifications, verification and request controls

Existing identity triggers record wallet/session insertion and deletion. An additional
`wallet.operation_authorized` identity event records action, operation UUID, actor session ID,
credential type and request correlation without passwords, signatures or bearer values.
The existing `account_notifications` table carries the target and outcome, visible on `/account`.
This is an in-app channel. There is no outbound email/push adapter and no independent
out-of-band delivery claim. Both audit and notification writes share the mutation transaction.

Cookie-origin protection and no-store responses remain. Issuance uses the existing wallet IP
limiter (40/15 minutes by default); completion uses the authentication limiter (10/15 minutes
by default), covering unlink and password verification too. F07's distributed/account-scoped
throttling remains separate work; these existing process-local limits are not claimed to solve it.
No request body or proof is added to logs.

SIWE checks the exact stored message's origin, URI, scheme, address, chain, nonce, issuance and
expiry. A configured RPC must answer on the expected chain; timeouts fail closed. Contract-wallet
verification remains through the existing viem implementation. Synthetic EOA/browser tests
and local unavailable-RPC checks do not establish representative live ERC-1271 behavior.

The browser encodes the exact server-issued message as UTF-8 hex bytes before `personal_sign`,
for login, retained-wallet authorization and the new-wallet proof. This preserves the signed
message while supporting providers that require hex input, as in the
[Coinbase Wallet example](https://github.com/coinbase/coinbase-wallet-sdk#basic-usage).
The synthetic browser provider enforces that format and signs the decoded bytes.

## Migration and release

Apply F04 `1791158400000`, F03 `1791158500000` and `1791158501000`, then F02
`1791158600000_wallet_operation_authorization`. F04 admin provisioning precedes owner migrations.
F02 creates `wallet_operations` in the private application schema with runtime RLS and explicit
SELECT/INSERT/DELETE plus UPDATE only on `consumed_at`. It adds no browser/API-role grants.
The existing cleanup task removes operations one day after expiry.

Stop old application instances before these migrations and deploy the compatible auth code and
browser assets together. F03 retires existing sessions/challenges and rejects old session issuance;
users must sign in again. Do not roll back to the old unsafe credential mutation binary. Prefer a
forward fix; containment can remove the credential-change routes while leaving wallet login.
F02's additive table can be dropped only after compatible code no longer uses it; this loses pending
operations and is not an application security rollback. F03's revocation guards stay installed.

## Guidance applied

Reviewed 2026-10-05. [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
supports existing-credential reauthentication for sensitive changes.
[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
supports replacing session identifiers after reauthentication.
[OWASP changing enrolled authenticators](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#changing-mfa-factors)
informs the retained-credential gate and notification decision; YapArena's alternative methods
are not enforced MFA. [NIST SP 800-63B-4 §4.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html#binding-an-additional-authenticator)
informs fresh authenticator binding, one-use state and lifecycle invalidation. Its independent
notification guidance exceeds the preview's supported in-app channel; no AAL or standards
compliance is claimed. [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361)
defines SIWE message and verification requirements.

## Verified integration evidence

The [F02 handoff](f02-integration-handoff.md) records the exact combined PostgreSQL, quality,
migration, browser and production-image checks, dependency commits and remaining release trials.
The account flow was inspected at desktop and mobile widths with fictional local accounts:

- [Current-password approval](evidence/f02/password-approval-desktop.png).
- [Existing-wallet approval](evidence/f02/retained-wallet-approval-desktop.png).
- [Retained-wallet unlink on mobile](evidence/f02/unlink-approval-mobile.png).
- [Sole-wallet protection on mobile](evidence/f02/sole-wallet-protection-mobile.png).
