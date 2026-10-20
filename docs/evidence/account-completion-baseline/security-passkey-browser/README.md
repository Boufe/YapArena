# Real-backend security-passkey browser acceptance

[Results](results.json) record the tested revision and source/compiled-asset
hashes. Both desktop (1440 × 1000) and mobile (390 × 844) viewports passed with
Chrome's virtual CTAP2 authenticators and the actual application security
router/repositories against a new native PostgreSQL 17 cluster. Provisioning,
migrations and runtime used distinct roles; the cluster was loopback-only and
removed after the trial. No hosted or retained identity was changed.

The account/provider/session setup is synthetic. Registration and operation
authentication responses come from the real browser WebAuthn API and are
cryptographically verified by the real backend. No WebAuthn response, challenge,
signature, credential counter or security API result was mocked.

Checks cover first-key bootstrap before financial history, session rotation,
old-cookie rejection, replay/cross-account denial, retained-key approval of a
second key, removal using a retained key, final-key self-removal prevention,
cross-origin rejection, cancellation/focus, automated WCAG A/AA tags and viewport
overflow. [Desktop](desktop.png) and [mobile](mobile.png) images visibly label the
isolated component fixture. The matched full-account theme/layout screenshots
remain in the parent evidence directory.

The expanded run passes fourteen groups. Desktop replaces a synthetic sole-email
provider identity; mobile replaces a synthetic sole-Google identity with a
different synthetic email identity. The provider verifier is a labelled local
fixture, so this does not prove Privy code delivery or a genuine OAuth session.
The actual `yapRecoverProviderIdentity` component renders the permanent-retirement
terms and permits only the retained application security key. Native WebAuthn
responses pass through the real router and runtime PostgreSQL transaction.
[Desktop recovery](recovery-desktop.png) and
[mobile recovery](recovery-mobile.png) capture that exact approval dialog.

The recovery cases preserve the internal account, real local profile, retained
key and a source-aware book backed by a deterministic 10 simulated-USDC
purchase. Balances, requests and cash-journal counts remain unchanged, and no
extra application user is created. Real SQL rejects missing, wrong-purpose,
expired and revoked-key proofs; an otherwise valid unconsumed operation cannot
commit through the definer's deferred constraint. An actual second account
cannot consume the native assertion. After success, the old current cookie,
the consumed proof and new provider SID cannot be replayed; a fresh SID of the
retired original DID cannot provision another user or reopen the account.
An adversarial current-generation revocation job for the old DID completes with
the actual worker while making zero external control calls. Marking that old
subject's job manual then leaves the replacement identity's actual protected-
session monitor usable. This is local PostgreSQL/provider-stub acceptance;
actual provider revocation has separate Cloud evidence.

The final fourteen-group run identifies `5a7e957` and exact committed
security/recovery/verifier source hashes. The root-owned twelfth-issuer session
coordinator integration was not yet committed when it ran; its separate source
and compiled-asset hashes are recorded too. The complete combined release gate
must cover the final integrated commit. Return-to-action controllers are outside
this isolated component fixture.

Each sequential viewport instantiates its own unchanged security router and
30-request mutation limiter. This keeps desktop's deliberate negative requests
from consuming the separate mobile fixture's IP budget; no limit is disabled or
raised. Cross-instance/Redis abuse acceptance has separate evidence.

Two virtual devices are needed: WebAuthn correctly rejects registering an
already registered authenticator when it appears in `excludeCredentials`.
The test pauses scheduling immediately before a second native registration call
so it can switch virtual devices after authenticating with the retained first
device. It then resumes the unchanged native API. The earlier
[virtual-device exclusion image](failure.png) records that expected fixture
setup issue, rather than a product failure hidden by changing an assertion.

This is separate from genuine Privy signup, provider passkey enrollment or
Google authorization. It proves no physical security key, phone, biometric,
screen-reader announcement, human usability or full WCAG conformance. Mobile
remains an emulated viewport. No credential/private protocol material is stored
in public evidence.

Reproduce after building with Node 24 and native PostgreSQL 17/18 tools on PATH:

```sh
node scripts/verify-security-passkey-browser.ts
```

The script accepts no external database URL and loads no operator `.env`.
`BROWSER_CHROME_PATH` may identify the installed Chrome executable.
