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
