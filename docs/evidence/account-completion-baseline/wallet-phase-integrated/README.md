# Integrated wallet and provider-reset gate

The complete maintained `npm run verify:browser` command exited **0** on
2026-10-21 from the coordinated worktree based on `030b60e`. Source fingerprints
are recorded in [source-hashes.json](source-hashes.json); clean-revision CI is
separate. The command used native PostgreSQL 17, disposable owner/runtime roles,
and synthetic browser/provider/media fixtures, without reading `.env` or using
an existing database.

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host \
  BROWSER_ARTIFACT_DIR=/private/tmp/yaparena-wallet-phase-integrated-r5 \
  npm run verify:browser
```

[Raw output](output.log) and [result](result.json) establish:

- Full `npm run check`: **854 passed, zero failures or skips**;
  **95.31% lines, 91.19% branches, 95.35% functions**. All three coverage
  thresholds remain 90%.
- **235 focused account/security/ledger PostgreSQL cases on each fresh and
  upgraded database**, including 12 durable-wallet cases, 11 durable provider
  phase cases, four embedded-asset recovery cases, and real signed
  unknown-wallet signup rejection with retained wallet login preserved.
- **17 A4 cases and five receipt-backed treasury cases on each path**.
- Fresh/upgrade isolation, browser-role denial (including the new wallet table),
  owner/runtime separation, worker permissions, triggers and future defaults.
- Core account/A4, debate workspace, public/shared data, homepage, Live/replay,
  and the migrated strict-TypeScript retained-wallet browser verifier.

Exact disposable catalog snapshots and focused logs are in `database/`;
browser results and screenshots are in `browser/`. No hosted user was created
or deleted. The financial engine and terms remain unchanged by the wallet work.

Earlier failed attempts remain separate:

1. `r1-sandbox-failed.log`: local shared memory was denied before PostgreSQL
   startup. The same command was rerun with the required execution permission.
2. `r2-inventory-failed.log`: the new private wallet table was missing from the
   explicit expected inventory. Adding the table also added its browser-role
   SELECT/INSERT/DELETE denial checks; no assertion was relaxed.
3. `r3-owner-lock-failed.log`: a normal reset worker waited on a live owner retry
   whose test was awaiting that worker. The identified disposable test worker
   was stopped so the harness could fail and clean up. The selector now excludes
   a live owner claim before acquiring its account lock. Bounded regressions
   cover both the commit gap and a provider GET held under that lock.
4. `r4-format-failed.log`: all 235 fresh cases passed, but a previously saved
   evidence JSON needed formatting. Formatting changed no evidence values;
   the complete subsequent command passed.

These results do not establish genuine Privy authentication, actual wallet
creation/recovery, hosted acceptance, physical-device or screen-reader behavior,
live provider eligibility, or live financial release. Dedicated native/SDK
browser results, actual valueless testnet receipts and hosted release evidence
retain their own revision and environment boundaries.

After adding the independently reviewed read-only operator verifier and updating
the native fixture to drain the real reset worker, the final isolated quality
command also exited zero at code revision `8dad4dd`. Its separate
[result](final-quality/result.json) and [raw output](final-quality/output.log)
record 854/854 tests with zero skips and **95.36% lines / 91.21% branches /
95.35% functions**, plus fresh/upgrade isolation. The preceding complete browser
run retains its own coverage figures above; neither report is rewritten to
borrow the other's numbers. Application source, migrations and served assets
remained unchanged between these checks.
