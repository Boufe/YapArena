# Integrated Privy passkey corrective gate

On 2026-10-20 the complete local browser release command exited **0** from the
corrective worktree based on `ac59dc0`, including the uncommitted same-key bridge,
first-setup restart and scoped route integration. This is a worktree result;
exact clean-revision CI is recorded separately after committing it.

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host \
  BROWSER_ARTIFACT_DIR=/private/tmp/yaparena-privy-only-core-release-r2 \
  npm run verify:browser
```

[Raw output](output.log) and [terminal result](result.json) record:

- Full runtime-backed `npm run check`: **798/798**, zero failures/skips;
  **95.29% lines, 91.24% branches, 95.19% functions**, unchanged 90% thresholds.
- Focused account/security/financial PostgreSQL suites: **198/198** on each
  fresh and upgraded disposable database; A4 **17/17** and separate treasury
  **5/5** on each path.
- Fresh/upgrade isolation, browser-role denial, runtime/worker permissions,
  triggers, future defaults and core account/A4, arena, shared-data, homepage
  and Live/replay browser gates passed.

The [first attempt](first-attempt-failed.log) failed eight new restart cases
because PostgreSQL rejects regex repetition bounds above 255. Migration 13000
now checks credential length separately from its character set; the full rerun
passed without dropping assertions or changing coverage thresholds.

[Backend source hashes](backend-source-hashes.json) were archived after the run;
those server, migration and test sources did not change between the passing gate
and archive. Subsequent frontend focus restoration and explanatory-copy changes
require their own rebuilt browser evidence. The dedicated SDK, native same-key,
coin and cookie browser reports identify their own source/asset hashes.

Environment: local PostgreSQL 17, disposable owner/runtime identities and synthetic
browser/media/provider fixtures. This establishes neither genuine Privy credential
export availability, hosted acceptance, physical devices, screen readers nor
live financial eligibility. The valueless receipt-backed testnet trial is separate.
