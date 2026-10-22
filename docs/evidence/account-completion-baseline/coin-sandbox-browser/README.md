# Coin sandbox browser acceptance

This verifier creates a new loopback-only native PostgreSQL cluster, provisions
owner/runtime roles, applies the current migrations and serves the actual built
`account-coins.js` and `account-security.bundle.js` against the real repositories
and routers. It reads no `.env` or pre-existing database URL. Every account,
credential, amount and wallet destination in these screenshots is synthetic.
The cluster and its generated credentials are removed after each run.

Run after building:

```sh
npm run build
node scripts/verify-coin-sandbox-browser.ts
```

`results.json` identifies the tested revision, exact source/asset hashes,
PostgreSQL version and assertions. Desktop uses 1440 × 1100; mobile uses
390 × 844. Matching `before-*` and `after-*` images show the same widgets and
viewport before and after the workflows. `withdrawal-approval-*` captures the
exact displayed gross deduction, included fee, net delivery and destination.
`recovery-consent-*` captures the exact cost-consent terms and retained-proof
dialog. `financial-hold-*` shows reports and the current quote remaining
accessible while new financial operations are held for correction review.

The workflows cover exactly-once welcome/daily claims, a 10 simulated USDC
purchase issuing 1000 YC, purchased funds without grant qualification, native
WebAuthn approval on desktop, retained-password approval on mobile, a 5 USDC
gross withdrawal including a 0.1 USDC fee and 4.9 USDC net, a manual-review
receipt and transactional reservation. Owner-process simulated treasury funding
allows participation in a real five-minute YES/NO round without accelerating
the application schedule. A cookie switch during the browser's blocking
confirmation must reject spending by the replacement session. A delayed
old-account response must preserve the replacement account's private state and
usable controls. The actual logout event must also remove an unfinished
security approval, erase the detached password input and leave reserves
unchanged; refreshing the account restores usable controls.

The final run passed 22 desktop/mobile groups at the revision and hashes in
`results.json`. A real receipt opens the report form; literal markup remains
text, private operator evidence is absent from the public projection, and a
different account cannot retrieve the report or quote. Native WebAuthn or
retained-password proof binds consent to the exact quote and current session.
The append-only consent authorizes neither a charge nor an external recovery;
balances, receipts, requests and cash journals remain unchanged. A quote that
actually expires while the dialog is open fails with 410 and creates no second
consent. Focus returns to the named report notice after success.

A held replacement-account summary proves old balances, receipts, rounds,
reports and the withdrawal destination leave even hidden DOM immediately. A
real uncertain funding correction then holds financial mutations; Refresh
still loads the current report and quote after settlement returns 403. This
also exercises the numeric report-event ordering fix across the second
account's larger sequence IDs. Its deterministic digit-boundary database
regression is a separate gate.

Automated axe checks use WCAG 2.0/2.1/2.2 A/AA tags. The verifier checks keyboard
activation, dialog focus and horizontal reflow at normal and CSS 200% layout
zoom. These checks do not establish full WCAG conformance, a screen-reader
trial, physical mobile/security-key behavior, or native browser-menu zoom.

This is deterministic financial simulation with Chrome's virtual CTAP2
authenticator. It is **not** genuine Privy authentication, hosted acceptance,
provider sandbox/chain acceptance, live funding or redemption. The page is a
local widget scaffold using the existing theme; full shared-header/SSR parity
has separate evidence.

An initial run found real horizontal overflow at mobile CSS 200% zoom in the
debate selector and balance grid. Scoped layout fixes were applied; the same
overflow assertions then passed. The initial password/section locator failures
were corrected in the verifier without changing product behavior or weakening
acceptance assertions.

Two earlier executions overlapped after coordinator messages crossed. They used
separate disposable databases and unchanged application assets. The later
coordinator execution completed successfully at 2026-10-20 07:09 UTC.
No shared database or hosted identity was mutated.

The subsequent integrated-account build was tested again at 2026-10-20
16:13 UTC, starting at `454468f420dd55a987aaa2914cad80d1dac253ca`.
The command exited zero with all **22** desktop/mobile groups passing and no
browser, accessibility or layout errors. The current `results.json` records
both endpoint revisions and exact source/asset hashes; application assets
remained frozen during the run. Its complete screenshot set supersedes the
earlier current images. Later protected-response cache-header changes and the
full repository release gate are separately verified.

The Privy-only interface was tested again at **2026-10-20 19:12:34 UTC**, at
`14bc559ae8c28948299727499e11d01005907d7f` plus the source hashes recorded in
`results.json`. The command exited zero with all **22** groups passing on
PostgreSQL 17.10 and Chromium 155.0.8059.85; browser, axe and layout error lists
are empty. Every recorded source/asset hash still matched at completion.

This run deliberately prepares a **retained legacy independent key fixture**
through a real password-authorized enrollment challenge, native WebAuthn and
the existing HTTP completion API. It does not expose or click a new independent
key enrollment control. The empty legacy section is hidden, and the verifier
asserts that the removed Add security passkey control is absent. A stale
fixture wait for the former empty-section text failed before financial actions;
replacing that wait with the initialized approval hook and hidden-section
assertions required no application or asset changes. The current screenshot
set supersedes earlier images. Current same-Privy-key setup and approval have
their own independently recorded native/installed-SDK acceptance; this legacy
fixture does not establish that provider journey.

The verifier passed strict operational TypeScript, ESLint and formatting before
this final run. Its browser readiness check narrows the hook's property presence
before checking the function, without adding an assertion or changing the
application. The final withdrawal dialog and mobile CSS200% images were also
visually inspected: the readable exact debit/fee/net/destination remain visible
and the narrow layout remains within the page width.

The latest frozen-asset rerun completed **2026-10-21 14:54:31.305 UTC**,
exiting **0 with all 22 groups passing and no browser, accessibility or layout
errors**. See [the raw terminal output](output.txt), [actual results](results.json)
and [post-run hash comparison](source-verification.json). The report records
`030b60e` because the lead committed the already-frozen work afterward; all
recorded source/asset/dist hashes still match at `43cc9a0`. No rebuild occurred
during this run. Matching mobile before/after and the exact withdrawal dialog
were visually inspected. Scope remains the explicitly labelled synthetic,
deterministic financial sandbox and fixture-only retained legacy key; this
does not establish hosted, genuine provider, chain, physical-device or
screen-reader acceptance.
