# Integrated local release acceptance

On 2026-10-20, the complete repository browser release gate exited **0** at
`63eada6b47ef94017fd9bcda52e1f890f67f860c`. Application, migration, browser and
verification sources remained fixed for this run.

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host \
  BROWSER_ARTIFACT_DIR=/private/tmp/yaparena-account-final-integrated \
  npm run verify:browser
```

[Raw output](output.log), [terminal result](result.json) and
[revision/source hashes](source-hashes.json) preserve the actual run.

- Full runtime-backed `npm run check`: **739/739**, no failures or skips;
  coverage **94.94% lines, 91.69% branches, 95.16% functions** against the
  unchanged 90% thresholds.
- Account/security/financial PostgreSQL suites: **151/151** on each fresh and
  upgraded disposable database.
- A4 PostgreSQL suites: **17/17** on each database; receipt-backed treasury
  suites: **5/5** on each physically separate disposable Base Sepolia ledger.
  These treasury cases use deterministic receipt fixtures, not new chain calls.
- Fresh/upgrade database isolation, browser-role denial, runtime/worker
  privileges, triggers and future-object defaults passed.
- Account/A4, arena, shared discovery, homepage and Live/replay preview browser
  gates passed. The terminal output explicitly reports `Browser release gate PASS`.

The environment used local PostgreSQL 17 with disposable owner/runtime roles.
Browser identities, public records and media transports in this gate are fixtures.
It does not establish hosted Privy, physical-device, screen-reader, chain-provider
or live-money acceptance.

The subsequent login loading/error padding correction has its own
[70-group browser run and matching before/after screenshots](../auth-return-browser/README.md).
Only CSS changed among served assets. A later test-only PostgreSQL 18 constraint
assertion correction and bounded fixture clock wait passed a separate
[PostgreSQL 18.4 run](../pg18-auth-compatibility/README.md). Final remote CI is
recorded separately; this report does not relabel later changes as part of this run.
The earlier [726-test gate](../combined-release-gate/README.md) remains historical.
