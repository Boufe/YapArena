# PostgreSQL 18 authentication fixture compatibility

The actual PR CI run rejected two recovery-test assertions because PostgreSQL
18.4 reports `23001` (`restrict_violation`) when the permanent retired-identity
foreign key denies deletion. The locally tested PostgreSQL 17 release reports
`23503` (`foreign_key_violation`). The database denied the prohibited deletion
in both cases. PostgreSQL's [error-code reference](https://www.postgresql.org/docs/18/errcodes-appendix.html)
documents both conditions and separate class-23 constraint-name fields.

The corrected test accepts only those two codes, requires the exact
`provider_identity_recoveries_provider_old_subject_fkey`, and verifies that the
scrubbed retired mapping and immutable recovery history remain unchanged. It
never weakens the foreign key, migration, authorization or acceptance threshold.
The lead reviewed the exact fixture diff.

The first actual Docker rerun passed the new tombstone checks and both separate
Base suites, but failed three existing wallet/SIWE fixture cases: an instant
synthetic signer reached validation before the host reached the database-issued
time. Five synchronous clock samples established the Docker VM at least 3–11 ms
ahead even after the host command returned. That [failed run](first-clock-failure.txt)
is retained. Existing unrelated containers were left untouched; no shared VM
clock was changed.

The central test-only `waitForSiweIssuedAt` helper parses the actual message with
viem and waits until its issued-at boundary is reached, with a one-second bound
and an explicit setup failure for larger drift. Only positive fixture ceremonies
use it. Wrong-origin/wrong-signer assertions then run at a valid time; negative
expiry assertions, signed bytes and application checks remain unchanged.

The subsequent **actual PostgreSQL 18.4 Docker run passed**: 151/151 tests in
each fresh/upgraded simulation database and 5/5 in each separate fresh/upgraded
Base treasury database, zero failures or skips. The [complete output](focused-postgres.txt)
and [structured results/source hashes](results.json) identify the command,
version, public immutable Docker image digest, test-only changes and exact source/dist boundary.
The image identity was independently read with `postgres --version` and
`docker image inspect` after the completed suite. The application source
was frozen from the passing `63eada6` integrated gate; the fixture changes were
uncommitted during this run and are identified by their hashes. This is focused
local compatibility acceptance. It is not a new full browser/coverage result,
remote CI success, hosted authentication or live financial acceptance.
