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
