# Durable wallet status: installed SDK browser acceptance

These are local Chromium trials using the installed Privy SDK, synthetic OTP
identities and synthetic application status/retry responses. They do not create
real provider wallets or demonstrate default provider recovery, hosted sessions,
physical-device behavior or live crypto funding. Real PostgreSQL and provider
transport results are separate evidence.

The maintained command is:

```sh
PRIVY_APP_ID=cmvfjb3r800vy0hl3heg2cuvv AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/embedded-wallet-browser/r2 node scripts/verify-email-auth-browser.ts
```

Each run records revision, verifier/source fingerprints, generated asset hashes,
actual checks, errors and limitations in its result JSON. Run directories are
kept distinct so later fixes do not overwrite an earlier result or screenshot.

## R1: fixture failure preserved

The initial restricted-shell invocation could not fetch public provider
metadata. The permitted local browser run then reached the new wallet journey
but failed on a fixture selector: replacement-account login reopened the
existing code-entry step, while the fixture tried to fill the email-entry step.
The fixture was corrected to click the visible Change email control first.
The app was not changed to satisfy that selector. The failure JSON and screenshot
remain in `r1/`; all identities and displayed codes there are synthetic.

## R2: 111 checks passed, visual correction still needed

Actual terminal result: **PASS, 111 checks, exit 0**, on 2026-10-21. See
[browser-results.json](r2/browser-results.json). This run records checkout HEAD
`030b60ea0974b70edecf74b322935dc991a17fb1` with uncommitted working sources;
the exact source and asset fingerprints establish its boundary.

The 99 earlier authentication, passkey, account-switch and confirmation-return
checks remained in the run. Twelve added checks across desktop and mobile cover:

- Login completion while wallet setup is pending, with logout still available
  and no automatic retry POST.
- A single explicit empty-body retry with the observed-account comparison,
  duplicate prevention, and confirmed ready projection.
- Unavailable/review states hiding private addresses while leaving account
  access usable and refusing automatic wallet replacement.
- Held status and retry responses from an old account being discarded after
  actual synthetic SDK account replacement, without clearing the new actor's
  state or leaving its controls busy.
- Immediate private wallet clearing after account/logout notification, and no
  browser provider creation, signing, funding or transfer request.

The keyboard diagnostic is retained for both viewports. When the retry button
disappears, Chromium reports BODY as the active element but retains the logical
sequential position: the next Tab reaches Check wallet status inside the same
card. The actual test did not justify adding forced focus behavior.

There were no recorded console errors or requirement failures. Public provider
metadata was fetched live; OTP, passkey and application responses were explicitly
intercepted synthetic fixtures. The run uses Chromium virtual-authenticator
ceremonies for native passkeys and does not establish genuine provider linkage.

Visual review of the R2 ready screenshots found a real contradictory status:
the SSR Checking your wallet fallback remained above the React ready message.
Those images are intentionally preserved as the before state. The source now
hides that fallback during the React mount and the verifier additionally requires
exactly one visible wallet status, but that correction requires its own final
built-asset trial. R2 is not acceptance of the later fallback correction.

## R3: final status correction verified

Actual terminal result: **PASS, 111 checks, exit 0**, at
`2026-10-21T14:52:44.820Z`. See [browser-results.json](r3/browser-results.json)
and the preserved [terminal output](r3/run.log). The initial restricted-shell
attempt stopped before launching the browser because public metadata was
unreachable; its [log](r3/restricted-metadata.log) is preserved separately. The
same maintained command with the R3 artifact directory then ran with the
required local-browser/network permission.

All 111 existing checks remain. The ready projection now additionally requires
exactly one visible status in the wallet card and the SSR checking fallback to
be hidden. No assertion was weakened or replaced. Errors and requirement failures
are both empty. The reviewer recomputed every recorded current source and public
asset hash after completion; all matched. The final verifier fingerprint is
`b20b74b67aefee5fe27d28663b0d9a673e499f121794c57d2a03a488cbc72c72`;
the auth bundle is
`14a61184fd9506e3001e333a51e4813752c36ee6ec06dc6332e1818fcc2dc154`.

The same desktop and mobile ready views were visually inspected. Both show one
ready message, the confirmed synthetic address and the existing account theme;
the contradictory SSR checking text is absent. Matching before/after images:

| View    | Before correction                                | After correction                                 |
| ------- | ------------------------------------------------ | ------------------------------------------------ |
| Desktop | [R2 ready](r2/embedded-wallet-ready-desktop.png) | [R3 ready](r3/embedded-wallet-ready-desktop.png) |
| Mobile  | [R2 ready](r2/embedded-wallet-ready-mobile.png)  | [R3 ready](r3/embedded-wallet-ready-mobile.png)  |

The exact source/build boundary is recorded in the R3 JSON. This remains local
synthetic provider/application acceptance with real installed-SDK rendering and
Chromium virtual WebAuthn; it does not establish genuine provider creation,
default wallet recovery or physical-device acceptance.
