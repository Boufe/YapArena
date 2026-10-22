# Account setup feedback and protected readiness — 22 October 2026 UTC

This leaf records local acceptance of the visible passkey progress/confirmation,
protected-account readiness, bounded wallet status refresh and honest email-code
verification errors. It does not diagnose the genuine user's earlier failure or
claim hosted, genuine-provider, physical-device or complete accessibility acceptance.

The application source was frozen and then committed as
`819421d30b10acb29b38a0f75ed46360af373870`: account authentication source
`0823cb8d…`, embedded-wallet source `aa4f40b8…`, and authentication bundle
`152ebb6…`. [The source receipt](source-receipt.json) contains complete hashes.
It records the later verifier-only commit separately.

## Actual acceptance and provenance

| Run                                                                | Actual result                                            | Scope                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Full installed-SDK suite](full-sdk/browser-results.json)          | 184 unique checks; errors and requirement failures empty | Final application bytes; verifier `b2c88ac7…`; all 173 prior checks retained, including the earlier 145/125 assertions                    |
| [Corrected focused suite](focused/browser-results.json)            | 32 unique checks; errors and requirement failures empty  | Same application bytes; selected maintained helper bodies, with truthful no-draft reporting and nine additional card accessibility checks |
| [Viewport-only zoom follow-up](zoom-viewport/browser-results.json) | 11 overlapping focused checks passed                     | Same app/asset bytes; one desktop helper, added DOM observations and viewport-only zoom capture                                           |
| [Combined repository coordinator](integrated/result.json)          | All four steps passed                                    | Build; disposable fresh/upgrade database and browser gates; homepage; Live/replay synthetic fixtures                                      |

These are overlapping runs: **184 plus 32 does not mean 216 unique checks**.
The full run's initial-account-outage case had no pre-existing profile draft but
used a shared draft-preservation label and a true shortcut. Its raw result remains
unchanged. The corrected focused run records `profileDraftPreserved: null` in that
case, and requires actual draft preservation in normal desktop/mobile scenarios.
Done restores focus in all three cases. Each performs one provider enrollment and
one application completion; neither the status check nor readiness retries enroll
another key.

The maintained verifier is `aa844969…`, committed as `7bb6e7f`. The executed focused
source is `7130b89d…`. [The derivation receipt](focused-derivation-receipt.json)
verifies an identical prefix and all eight top-level function bodies; only the main
selection and focused scope prefix differ. [The verifier diff](verifier-report-axe.diff)
shows the full-run-to-maintained report correction and added automated assertions.
These test-only changes do not establish a second full-SDK run at the later verifier.

The combined coordinator started at `cf4249a` with frozen frontend work later
committed as `819421d`; its retained-wallet child records `819421d` during the run.
Do not describe its starting checkout as a clean later commit. The
[raw coordinator log](integrated/run.log) and [quality log](integrated/database/quality.log)
record **870 tests, zero skipped**, with line/branch/function coverage
**93.79% / 91.28% / 95.12%**. Fresh and upgrade paths each passed 249 account-security,
17 A4 and 5 treasury cases. The guarded disposable catalog namespace was
`23b2c7e6`. [Retained-wallet acceptance](integrated/retained-wallet/acceptance.json)
passed all four groups against real local runtime HTTP. The coordinator does not
execute this installed-SDK fixture and does not establish the later card axe checks.
Earlier coordinator failure/replay chronology remains in the separate
[reset replay leaf](../logout-reset-replay-20261022/README.md).

## Controlled negative cases and matching images

- [Held-refresh RED](red-held/observation.json): exactly one enrollment/completion;
  the signed-in account and confirmation card were both hidden. Compare its
  [before image](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/red-held/desktop.png) with the final
  [visible confirmation](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/screenshots/full-sdk/passkey-confirmation-held-desktop.png).
- [Verification RED](red-code/observation.json): a synthetic provider403 produced the
  wrong-code notice, with one send/authentication attempt and zero app exchanges.
  Compare [before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/red-code/desktop.png) and
  [after](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/screenshots/full-sdk/verify-email-provider-denied-desktop.png).
- [Draft/Done RED](red-draft/observation.json): the previous candidate erased the
  actual entered profile draft and lost focus after Done. Compare
  [before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/red-draft/desktop.png) and
  [after](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/screenshots/focused/passkey-done-desktop.png). The failed assertion follows
  both recorded false observations; this was not counted from a timeout.

The held-refresh and draft negatives retain their actual failure diagnostics with
source/asset hashes. The verification negative records exact request/outcome counts
but its diagnostic did not embed hashes; its7e baseline is the recorded execution
context, not an additional per-run hash measurement.

The original7e application produced the held-refresh and verification negatives;
the intermediate56c application produced the draft/Done negative. Before images
are labeled before and after images after, using the same fixtures/viewports.
The initial verification preparation failed on an undefined fixture identifier,
and the draft RED first hit sandbox metadata networking restrictions before browser
creation. Those preparation failures are not the controlled negatives above.
An earlier WIP run also exposed and then corrected a retained-dialog focus regression;
it is not described as passing acceptance.

Normal desktop/mobile confirmation, Done, wallet pending/ready, and mobile error
screenshots are retained. The raw full-page 200% CSS zoom images are also preserved:
[full](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/screenshots/full-sdk/passkey-confirmation-zoom.png) and
[focused](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/screenshots/focused/passkey-confirmation-zoom.png). They show repeated
sticky/header content caused by full-page capture and **are not clean visual zoom
proof**. Their DOM reflow/reachable-control assertions passed. The separately labeled [1280×900 viewport capture](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-setup-feedback-20261022/zoom-viewport/passkey-confirmation-zoom-viewport.png)
closes that screenshot limitation without replacing these raw images. It has
[actual DOM observations](zoom-viewport/zoom-viewport-observation.json): CSS zoom2,
one shared header, one setup card and no document overflow. The existing reachable
control assertions passed. The synthetic fixture badge overlaps part of the header
by design; the setup heading and Done control remain visible.

That follow-up passed11 overlapping focused checks, with no errors or requirement
failures; it is not another full suite or a native browser-zoom/physical-device trial.
[Executed source](zoom-viewport/executed-verifier.source.txt) is `8beb3856…` and
[the delta](zoom-viewport/derivation-from-focused.diff) shows its only changes from
focused7130: select desktop, record/assert the zoom DOM counts and capture just that
zoom image with `fullPage=false`, plus accurate scope copy. No application or
maintained verifier source changed. The derived strict browser TypeScript check
passed. The32 and11 runs overlap the184 and each other; do not add their counts.

Nine sanitized `focused/passkey-accessibility-*.json` reports cover checking, waiting
and ready states across desktop/mobile and initial-account outage. All have no
violations under the existing WCAG 2.2 tagged axe policy. Keyboard focus, actor
replacement, bounded retry and 200% CSS reflow assertions remain distinct from
these automated checks. Screen-reader and physical-device testing remain separate.

## Environment and limits

The SDK runs used Node24 and local loopback SSR fixtures in an isolated detached7e
worktree plus the recorded frontend patches. The actual installed Privy SDK and
Chromium virtual authenticator ran; OTP, provider and application responses were
intercepted/synthetic. Public provider metadata was read live; most fixtures disable
CAPTCHA while dedicated cases use a synthetic Turnstile API. No real inbox,
provider identity, hosted database, real wallet creation/signing, media session or
money was modified. Runtime/provider/backend acceptance is recorded separately.
All17 final full-run assets and the other seven non-verifier source hashes matched
the root build. The test-only verifier delta is explicit above.

No coverage threshold, required check or meaningful existing assertion was removed.
[The manifest](manifest.json) hashes each retained file; raw result/log bytes are
preserved. Each copied JSON also has a `.json.raw` sibling preserving its original bytes;
formatted counterparts are for review. The three top-level browser result JSONs
already matched canonical formatting and retain their original hashes. The lead
separately reviews the archive and scans current secrets before publication.
