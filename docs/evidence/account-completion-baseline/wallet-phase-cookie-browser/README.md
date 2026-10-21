# Cookie coordination after wallet integration

The maintained Chromium verifier exited **0** on 2026-10-21 with all **seven
groups passing across 14 cookie-issuing routes**. `results.json` records the
observed revision and exact helper source/asset hashes. The helper and generated
asset remained unchanged during the run.

```sh
SESSION_COORDINATION_ARTIFACT_DIR=docs/evidence/account-completion-baseline/wallet-phase-cookie-browser \
  node scripts/verify-session-coordination-browser.ts
```

This exercises actual local HTTP cookie headers, Fetch, Web Locks, delayed
headers/bodies, two-tab races, scoped logout, timeouts and unsupported-browser
failure. Server identities and cookies are synthetic. It does not establish
Privy, database, hosted, other-browser or physical-device acceptance.

The initial restricted-shell attempt failed to bind its local port (`EPERM`)
before acceptance began. The same verifier passed with the required local
execution permission; no assertion or application behavior changed.
