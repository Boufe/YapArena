# Provider Settings account-switch regression

Final local execution on 2026-10-21: **PASS, exit 0, all 99 checks**, with empty page-error and requirement-failure lists. The previous passing 92-check execution remains unchanged in `../single-privy-passkey-browser/`.

```sh
PRIVY_APP_ID=cmvfjb3r800vy0hl3heg2cuvv AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/provider-settings-actor-browser/after-r4 node scripts/verify-email-auth-browser.ts
```

[after-r4/browser-results.json](after-r4/browser-results.json) records launch HEAD `d6e2d355da255e03c257802c890c036c4d572a62`, the exact verifier/SSR and served asset hashes, and all assertions. Shared uncommitted source included the actor correction and the separately owned stable wallet UI changes. The later root commit during this run changed evidence/documents only. [source-state.json](after-r4/source-state.json) independently verifies the tested verifier and all assets still matched after execution. [run.txt](after-r4/run.txt) preserves terminal output.

The concrete pre-fix failure is preserved in [before-bounded](before-bounded/single-passkey-failure-desktop-provider-settings-races.json). A successful original-account Remove Email approval response was held while the installed SDK performed a different synthetic user's login. Releasing the old response caused an actual SDK request to `/api/v1/passwordless/unlink`; replacement controls also remained disabled by the original operation. The diagnostic records that request path and the replacement sequence, with a screenshot and raw failure log. The old authentication/security assets were independently observed to match the earlier 92-check run (`c0b74062…` / `8816f17f…`) before rebuilding. This failed trial does not claim a pristine committed verifier snapshot.

The final correction binds every Settings operation to its initiating application comparison account, provider subject and epoch. It checks again after authorization and each SDK/token await. Account/provider changes invalidate the actor, clear private email/code/pending/provider/key state and invalidate read projections; an old catch/finally cannot alter a new actor. Google linking uses the installed per-call headless OAuth promise instead of global callbacks whose error event lacks account/flow identity. Its bounded account/subject marker can only resume a server-owned, read-only reconciliation review. It cannot accept credentials or authorize a provider change.

Five new race assertions use the installed SDK and real local browser activity:

- Held removal, Google and email authorization responses cannot launch a provider mutation under a replacement SDK login.
- A held, already-started email-code-send response cannot recreate the original private form or success notice after replacement; the new actor's draft and controls remain usable.
- A held original email-verification failure cannot open reconciliation or overwrite the replacement actor's state.

The latter replacements use native virtual-authenticator login because the installed SDK serializes its email OTP operations. All provider identity/session and application responses are intercepted synthetic fixtures; the native ceremony does not establish ownership of any genuine provider account. All previous 92 assertions remain, and the added variant repeats two setup checks before its five new races.

The confirmed passkey-completion notice is retained only for its provider subject and hidden until trusted mapped metadata matches. Normal Settings starts/errors and identity changes discard it. The existing native completion assertion caught an initial integration regression in which invalidation erased that notice; `after/`, `after-r2/` and `failed-after-success-notice/` preserve those failed attempts. `before/` preserves the earlier inadequate timing fixture, whose wait allowed the old request timeout to mask the race; only `before-bounded/` is the actual red reproduction.

Independent security review found no remaining source finding in the actor/OAuth/notice delta. This local trial does not diagnose the separate genuine staging signup/passkey/provider-reset issue. No genuine provider email, key, account, hosted database or funds were modified. Already-started SDK provider requests cannot be claimed cancelled; their later application continuations are fenced. Physical-device, genuine provider, hosted and full WCAG acceptance remain separate.
