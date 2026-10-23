# Decision 0008 — Simpler authentication

Superseded in part by [Decision 0009](0009-auth0.md).

Status: proposed for founder approval, 2026-10-22. Design only; nothing here is implemented.
References were verified against `origin/main` at `fc130d2` and will drift as prompts 9–12 land.

## Why

`src/platform/auth` has 29 files and 10,241 lines. With `src/features/account-wallet` (6,284 lines
of coin sandbox) that is half of the 33,112 `src` lines; frontend account code adds about 6,500.

- Every protected request reads the Privy user, then locks the `users` and `sessions` rows
  (`provider-session-monitor.ts`, wired at `server.ts:157-161` into `sessions.ts:192-198`). A Privy
  outage or rate limit returns 503 to every signed-in user, measurement beacons included.
- `POST /api/auth/logout` ends every session (`router.ts:459-507`), and a trigger on _any_
  `auth_generation` change queues a Privy freeze, confirmation and unfreeze. That needed manual
  staging repairs on 2026-10-20 and 10-21 and left an account frozen on 10-22 ([evidence](../evidence/account-completion-baseline/logout-reset-overlap-20261022/README.md)).

Corrections to the 2026-10-22 review: there are about 20 session cutoffs, not 13. The "three passkey
stacks" are five flows on one table, `account_security_keys`: app-passkey enrolment, app-passkey
login and reconciliation, Privy key activation, first-key restart and the step-up engine. Both wallet
APIs change external SIWE wallets, not the Privy wallet. `reconcileUncertain` is a fourth
freeze/unfreeze path. Password `/login` stays on under Privy, production does not require Privy,
`GET /api/auth/provider` calls Privy on every hit, and key activation mints a second session because
the key trigger (`1792426005000_add-account-security-passkeys.js:42-55`) has just deleted them all.
The [2026-10-22 staging reset](../operations.md#local-verification) left no account to preserve.

## Target model

```text
Browser ─ Privy SDK (email code, Google, passkey) ─► Privy access token (ES256, 1 h, sid)
   └─► POST /api/auth/privy/exchange: verify token locally, read Privy user once,
       map DID → account, consume sid once ─► __Host-session (opaque, 7 days, authoritative)
Each request: one SELECT on sessions and users. No Privy call, no row lock.
Privy re-read: at exchange, at step-up, and after a request once the last read is 15 min old.
```

1. **Privy authenticates; the app session is authoritative.** Privy owns sign-in methods and the
   embedded wallet. Each `sid` is exchanged at most once, and only the exchange creates sessions.
2. **No provider call on the request path.** A response never waits on Privy or fails because of
   it. A request whose `provider_identities.checked_at` is over 15 minutes old schedules an
   asynchronous re-check (deduplicated, no lock held during the call, compare-and-set write). A
   deleted, frozen or guest Privy user loses every session; method changes update the snapshot with
   an audit event and in-app notice. No timer loop: the staging service (Render Free) sleeps.
3. **Webhooks are optional.** Privy requires Enterprise for them and the founder recorded "No paid
   production webhooks approved", so this departs from the brief's principle 2. If approved, the
   route verifies the raw body, stores `svix-id` once and only schedules a re-check.
4. **Sign out ends this device.** It deletes this session row; the browser calls Privy `logout()`.
   Sign out everywhere and sign out other devices stay explicit actions that advance
   `auth_generation` and delete rows. Neither calls Privy: a consumed `sid` cannot mint a session,
   so returning needs a fresh Privy login. Credential changes no longer end sessions.

   Founder decision, 2026-10-22: "signout/logout should be what it is in every app, there
   shouldn't be a signout-all or signout other sessions options". Sign out everywhere and sign
   out other devices are removed instead of kept. The per-device Active sessions list stays, so
   a user can sign out one device they do not recognize; it neither calls Privy nor advances
   `auth_generation`. Implemented and locally tested on branch `fix/single-device-logout`.

5. **One step-up.** `account_operations` proofs approved only by an app-activated Privy passkey
   against a five-minute, one-use server challenge. Step-up re-reads Privy and checks only that key
   (still linked, same public key). A first key needs no approval only without an active key or
   financial history; any other key needs an active key's approval. Interrupted setup just restarts.
6. **One change path.** Sign-in methods change only in Privy's UI. The server-provisioned embedded
   wallet is the only wallet; any future external wallet uses `account_operations`.
7. **Tests and local development without Privy.** The server composition takes an
   `IdentityVerifier` (`privy.ts:23-40`). A test verifier, entry and server-rendered form live under
   `scripts/` and post to the real exchange. They never ship: the build compiles only `src/**` and
   the image copies `dist/` plus four named scripts. The entry refuses `NODE_ENV=production`,
   `RENDER`, any Privy secret or a non-loopback `APP_ORIGIN`; `dist/server.js` refuses to start
   without Privy settings, which CI asserts. CI mounts `scripts/` read-only to run the entry.

## Privy facts used (read 2026-10-22)

- Access tokens are ES256 JWTs with `sid`, `sub`, `iat` and `exp`, usually valid one hour and
  verified locally; refresh tokens last 30 days by default ([access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens),
  [tokens](https://docs.privy.io/authentication/user-authentication/tokens)).
- User webhooks: `user.created`, `user.authenticated`, `user.linked_account`, `user.unlinked_account`,
  `user.updated_account`, `user.transferred_account`, `user.wallet_created`, `user.deleted`,
  `mfa.enabled`, `mfa.disabled`. Svix signs them; `@privy-io/node` checks them with `webhooks().verify`.
  Delivery is at least once, retried for about a day and unordered; production needs Enterprise
  ([overview](https://docs.privy.io/api-reference/webhooks/overview), [`user.deleted`](https://docs.privy.io/api-reference/webhooks/user/deleted)).
- A freeze revokes every Privy session and blocks login and refresh; issued tokens live until
  expiry and no webhook fires. No documented API revokes sessions without a freeze
  ([freezing users](https://docs.privy.io/user-management/users/managing-users/freezing-users)).

## Inventory

Every file in `src/platform/auth` (line counts in brackets) and every auth table appears below.

| File or area                                                                         | Decision     | Step     | Reason                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `provider-session-monitor.ts` (216)                                                  | Delete       | 9        | Per-request Privy read and row locks                                                                                    |
| `sessions.ts` (334)                                                                  | Change       | 9–10     | One SELECT; sign out deletes one row; `revokeAccountSessions` stays for incidents only                                  |
| `session-tokens.ts` (14), `browser-security.ts` (41), `provider-credentials.ts` (41) | Keep         | —        | Token hashing, Privy CSP, snapshot digest for change notices                                                            |
| `provider-config.ts` (38), `users.ts` (51)                                           | Change       | 11       | Privy required outside tests; remove password-era user creation and lookup                                              |
| `privy.ts` (243)                                                                     | Change       | 9–10     | Keep `verify` and `inspect`; delete freeze/unfreeze control and the operator inspector                                  |
| `provider-accounts.ts` (217)                                                         | Change       | 9–10     | Keep one `sid` per session and the signup pause; record method changes; drop provider fences                            |
| `router.ts` (896)                                                                    | Change       | 10–11    | Keep exchange, sign-out actions and session list; delete password, SIWE and wallet routes                               |
| `security-router.ts` (861)                                                           | Change       | 11–12    | Keep key activation and step-up; delete app passkey, reconciliation, link and recovery routes                           |
| `account-operations.ts` (549)                                                        | Change       | 9, 11–12 | The one step-up engine; Privy passkey only; compare the key, not the method digest                                      |
| `provider-passkeys.ts` (770)                                                         | Change       | 9–10     | Keep activation; drop per-request pending-key checks and session minting                                                |
| `provider-passkey-policy.ts` (25)                                                    | Change       | 11       | First-key rule in point 5; stop reading passwords and wallets                                                           |
| `embedded-wallet-provider.ts` (180), `embedded-wallet-provisioning.ts` (420)         | Change       | 10       | Keep the server job; stop parking it on generation or credential changes                                                |
| `passwords.ts` (33), `siwe.ts` (128), `wallets.ts` (193)                             | Delete       | 11       | Password and SIWE sign-in                                                                                               |
| `security-passkeys.ts` (350), `account-access.ts` (782)                              | Delete       | 11       | App passkeys, app-passkey login and credential reconciliation                                                           |
| `legacy-provider-link.ts` (185), `provider-identity-recovery.ts` (302)               | Delete       | 11       | Legacy account linking; DID replacement with an app passkey                                                             |
| `provider-control-phases.ts` (486)                                                   | Delete       | 10       | Runtime freeze/unfreeze state machine                                                                                   |
| `provider-revocation.ts` (1,330), `provider-passkey-reset-repair.ts` (427)           | Delete       | 12       | Owner-only freeze/unfreeze retries and repairs                                                                          |
| `provider-passkey-bootstrap.ts` (448)                                                | Delete       | 12       | First-key restart, unnecessary once activation keeps the session                                                        |
| `wallet-operations.ts` (406), `provider-wallet-operations.ts` (275)                  | Delete       | 12       | Two APIs for external wallets, whose linking is already off                                                             |
| Frontend: reconciliation (~510), SIWE, password and wallet dialogs                   | Delete parts | 11–12    | `account-auth.tsx`, `account.ts`, `account-security.ts`; server-rendered password forms                                 |
| Scripts: provider reset retry (541) and inspect (773), wallet browser check (463)    | Delete       | 12       | Freeze repair and external-wallet tooling; other browser checks and CI's `/register` smoke move to the test entry in 11 |
| `features/account-wallet`, `features/media/account-revocation.ts`, `shared-abuse.ts` | Keep         | 11       | Sandbox strong-method check becomes "active Privy key"; speaker grants end with sessions                                |

| Mechanism                                                                      | Decision     | Step       | Reason                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.expires_at` (7-day absolute)                                         | Keep         | —          | The bounded session lifetime                                                                                                          |
| `users`/`sessions.auth_generation`                                             | Keep, narrow | 10         | One epoch for incident revocation and suspension; about ten trigger functions read it                                                 |
| `users.auth_changed_at` and clock trigger                                      | Delete       | 11, 12b    | Derived from the generation; only app-passkey login reads it                                                                          |
| `users.account_status`, `auth_controls.signup_enabled`                         | Keep         | —          | Operator suspension and sign-in pause (it pauses all Privy sign-ins)                                                                  |
| Provider `auth_generation`, `minimum_issued_at`                                | Delete       | 10, 12b    | Order the freeze only; `iat` changes on every refresh                                                                                 |
| `provider_revocation_jobs`, control phases, enqueue trigger                    | Delete       | 10–11, 12b | Provider freeze/unfreeze                                                                                                              |
| `provider_session_exchanges` (each `sid` once)                                 | Keep         | —          | Makes a local sign-out final without a Privy call                                                                                     |
| Credential snapshot; Privy `frozen_at`, guest, 404; `sessions.incident`        | Change       | 9          | Read at exchange and re-check: method changes become notices; deleted, frozen or guest users lose sessions (reason `provider_change`) |
| Accepted Privy key and key digest                                              | Keep         | —          | Checked at step-up only                                                                                                               |
| Pending key addition (503 on every request)                                    | Delete       | 9          | Concerns only the activation route                                                                                                    |
| Key trigger; session rotation on credential operations                         | Change       | 10–12      | Audit only; no credential operation ends or rotates sessions                                                                          |
| Privy app-settings check                                                       | Change       | 9          | Also require only email, Google and passkey; cache `GET /api/auth/provider`                                                           |
| LiveKit speaker revocation, expected-account header, Web Locks, Redis limiters | Keep         | —          | Media grants end with the session row; the rest are cross-tab guards and rate limits                                                  |

| Table                                                                                               | Decision                                                                   | Step   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| `users`                                                                                             | Keep; drop `password_hash` with its trigger, `email` and `auth_changed_at` | 12b    |
| `provider_identities`                                                                               | Keep; add `checked_at`; drop provider generation and `minimum_issued_at`   | 9, 12b |
| `account_operations`, `account_security_users`, `account_security_keys`, `provider_passkey_intents` | Keep; passkey only, `privy` provenance only                                | 12     |
| `sessions`, `account_subjects`, `account_roles`, `identity_audit_events`, `account_notifications`   | Keep, as are wallet provisioning, media grants and `coin_*` history        | —      |

A Privy webhook inbox is added in step 9 only if Enterprise is approved. Dropped in 12b:
`provider_revocation_jobs`, `provider_passkey_bootstraps`, `provider_identity_recoveries` with the
owner-privileged `apply_provider_identity_recovery`, `account_access_challenges`,
`account_security_challenges`, `wallet_identities`, `wallet_challenges` and `wallet_operations`.

## Founder decisions this supersedes (approval needed)

Line numbers refer to [accounts](../email-first-accounts.md) and
[completion](../email-first-completion.md) on `fc130d2`.

1. Per-request Privy inspection that fails closed: accounts L149, completion L477 and R18 (L317).
   The "no paid production webhooks" part of L477 stands unless Enterprise is approved.
2. "Normal **Sign out** now revokes all YapArena sessions": accounts L261, completion L495 (first
   sentence) and R17 (L316), [revocation procedure](../security/account-session-revocation.md) L23.
   This restores the single-device logout of [Decision 0002](0002-identity-and-social.md) L34.
3. Provider freeze/unfreeze after generation changes, the token cutoff and the owner repairs:
   accounts L38–39 and L263–295; the fences kept by completion L373–378 and L394–399.
4. Retained independent YapArena passkeys and lost-login replacement with them: accounts L218–234,
   completion L475 (second sentence), L494 and L511–516, revocation procedure L125–141.
5. Password and SIWE proofs for step-up and first-key approval, and retained-wallet sign-in and
   removal: accounts L297–303, completion L283–284, L476, R13 (L312) and R52 (L351),
   [embedded wallets](../embedded-wallets.md) L3–6.
6. Credential-delta and dual-ownership reconciliation, where a Privy method change ends sessions:
   accounts L178–180 and L198–202, R11–R12 (L310–311).
7. Decision 0002 L9–25 (SIWE sign-in, wallet link and unlink with password or wallet proof) and the
   legacy login and wallet controllers kept by the visual refresh (accounts L453–461).

Already overtaken by the founder's 2026-10-22 reset: "Preserve IDs 72, 73 and 134" (accounts
L361–366, R40). Kept: email codes first with optional Google and passkey (accounts L66–68); one
Privy passkey for sign-in and step-up (completion L117–120, L475 first sentence); the first-key
limits of completion L373–383, now a plain retry; one session per `sid` and `__Host-session`
(accounts L248–251); merging off; the server-created embedded wallet; return after sign-in; the
speaker queue; the lost-methods boundary (completion L492); and every financial decision.

## Rollout (prompts 9–12)

Migrations run before a release is deployed (`render.yaml`), so each must work with the previous
release: release N stops reading and writing; release N+1's migration drops; 12b holds the final
drops. PostgreSQL does not track columns inside function bodies, so a contract migration drops
dependent functions first and a check fails if any function names a dropped column.

| Step              | Change                                                                                                                                                                                             | Stops reading                                                                                     | Approximate lines removed                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 9 Request check   | Remove the monitor; add `checked_at` and the async re-check; record method changes at exchange; step-up compares the key only; cache `GET /api/auth/provider`; optional webhook route              | Digest as a fence; pending-key state per request                                                  | src −350, +150; tests −500                              |
| 10 Logout         | Sign out ends this session; no sign out everywhere/others (2026-10-22); remove synchronize calls and timer; audit-only key trigger; activation keeps the session; wallet job stops parking         | Provider generation, `minimum_issued_at`, job state (exchange, wallet job, activation, bootstrap) | src −700; tests −1,600                                  |
| 11 Legacy sign-in | Add the test entry and move CI and browser checks first; then delete password, SIWE, app-passkey, reconciliation, link and recovery; require Privy; drop the `enqueue_provider_revocation` trigger | `password_hash` in `lockAccount`; sandbox strong-method check; wallet-challenge cleanup           | src −2,600; frontend −900 to −1,200; tests −2,500       |
| 12 Duplicates     | Delete both wallet APIs, `provider-revocation.ts`, reset repair, bootstrap and three scripts; passkey-only `credential_type`                                                                       | Wallet, recovery and bootstrap tables                                                             | src −2,900; scripts −1,780; frontend −300; tests −3,000 |
| 12b Contract      | Drop the tables and columns marked 12b                                                                                                                                                             | —                                                                                                 | migrations only                                         |

End state: about 4,000 auth source lines instead of 10,241, with roughly 7,600 test and 1,800
script lines gone. Before step 10 deploys, an operator confirms read-only that no
`provider_revocation_jobs` row is unfinished and no linked Privy user is frozen.

## Risks and what we lose

| Risk or loss                                                                                                     | Mitigation                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privy deletions, freezes and method changes reach the app after up to 15 minutes of use, not on the next request | Step-up reads Privy live; in-app suspension is immediate; sessions end after 7 days; webhooks if Enterprise is approved                                                                                                                                                       |
| A live Privy session on another device survives sign out and incident revocation; it can link a method, sign in  | Spending and key changes still need the app-activated passkey; method changes are audited and shown. Incident runbook, replacing the freeze repair modes: suspend in the app, then in the Privy dashboard revoke sessions with freeze, remove the unknown method and unfreeze |
| That session can still use the embedded wallet client-side                                                       | The wallet holds no value; provider-side revocation and an out-of-app notice become financial-activation gates                                                                                                                                                                |
| No in-app recovery when the only passkey is lost                                                                 | Email access continues (completion L492); users can add a second key; a documented operator reset is required before funds                                                                                                                                                    |
| A Privy outage blocks new sign-ins and step-up                                                                   | Browsing, debating and existing sessions continue; re-checks retry on later requests                                                                                                                                                                                          |
| The test sign-in reaches a hosted service                                                                        | Not compiled or copied into the image; four startup refusals; production requires Privy; CI asserts it                                                                                                                                                                        |
| A contract migration breaks a trigger function at runtime                                                        | Drop functions first, check function sources, back up and rehearse on staging before 12b                                                                                                                                                                                      |
| Re-checks hit Privy rate limits                                                                                  | At most one read per active account per 15 minutes; back off on 429                                                                                                                                                                                                           |

## Open questions

1. Approve Privy Enterprise for production webhooks? The design works without them.
2. Confirm the 15-minute re-check, the unchanged 7-day sessions, the first-key and lost-key rules
   in point 5 and the incident runbook.
3. Ask Privy whether a supported API revokes a user's sessions without freezing. If so, sign out
   everywhere could call it once, best effort, with no state machine. (Sign out everywhere was
   removed on 2026-10-22; this now applies only to incident revocation.)

Out of scope: code, migrations and Privy dashboard changes. After approval, link this record from
the README decision list and add superseded-by notes to the documents listed above.
