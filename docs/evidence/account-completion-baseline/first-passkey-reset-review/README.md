# Independent first-passkey reset repair review

Reviewed on 2026-10-21 by the independent Redis/financial acceptance worker,
against the working tree at `f422dfdc722a159c926dc75d2f1f65c6ea9a5bd3`.
The new repair implementation and operator changes were uncommitted at review;
the hashes below identify the exact inspected files.

| File                                                   | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `src/platform/auth/provider-passkey-reset-repair.ts`   | `114cc3859af602a216c05e3a2dff09237dd75e141517d37c6ca22678c06f0c8d` |
| `scripts/retry-account-provider-reset.ts`              | `3aa90cd273de7f1dc1ce8f981165583741755c748f9d793c51122548ab03a26a` |
| `tests/provider-passkey-reset-repair-postgres.test.js` | `4f41654c99d93e8b959b482b45d91e43be3b07ce24926dd5f7cd50efe8b9e888` |
| `src/platform/auth/provider-passkey-policy.ts`         | `6058fea5c594a1b92bf2f73ec7f164064877c37dd5dcee473900e7ecc6849d81` |
| `src/platform/auth/privy.ts`                           | `44abc20effa67e9437caf9fca6fcc15a471737f8d8e25f2e852b9b927d339e60` |
| Compiled repair module                                 | `717409a91db0f93f689381d47488156a7237787aeb730c17d9817b053c9150f3` |

No blocking authorization or replay defect was identified in this read-only
review. The checked boundaries were:

- Dedicated owner and session role, active account, exact current mapping/job
  generation and attempt, expired lease, and a recognized revocation/freeze
  window bound to a separately reviewed evidence digest.
- Valid unchanged accepted credential baseline; exactly one newly observed
  provider passkey with a supported trusted COSE key; no prior strong-method or
  financial history. An already captured candidate must match exactly.
- A durable one-use review marker committed before the only provider unfreeze.
  A different request ID cannot repeat the mutation after that marker. Failed
  or uncertain provider/SQL outcomes retain the marker and generation fence.
- GET-only finalization bound to the same recorded review, key and reset facts.
  It requires an explicitly present `frozen_at: null`; missing or invalid state
  is not interpreted as unfrozen.
- Reset completion preserves the accepted credential digest/snapshot, creates
  no session or key, and cannot authorize a sensitive operation. A fresh
  provider login and the separate native user-verified first-key bootstrap
  remain necessary.
- Fixed staging project/service/app, strict TLS, dedicated database role,
  explicit command/environment/UUID, private review-file digest, bounded
  requests, and sanitized aggregate output. No credential or provider response
  body is printed.

The reviewer separately ran this offline command using Node v24.19.0:

```sh
node scripts/retry-account-provider-reset.ts --verify-transport
```

It exited 0. The installed SDK exercised retry `GET /user`, `POST /freeze`,
`DELETE /freeze`; repair transport permitted only GET/DELETE; finalizer transport
permitted only GET. Ten wrong method/path/body/content-type requests were
rejected before the injected sender. The result reported `networkCalls: 0`.

This is independent source and offline transport review, not hosted execution,
genuine Privy acceptance, or a second execution of the PostgreSQL suite. The
lead/author's separate fresh/upgrade PostgreSQL results must be cited with their
own logs. Provider state can change independently after a read; the operator's
activity review is required evidence and never substitutes for user
authentication. No provider, retained account or hosted database was mutated by
this reviewer.
