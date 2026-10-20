# Required CI acceptance for the staging revision

GitHub Actions run [39459326972](https://github.com/Boufe/YapArena/actions/runs/39459326972)
completed successfully on 2026-10-20 for PR head
`93952425100d15bde110a0b1b38b04e35d653b9b`.

All five required checks passed: `quality / check`, `container`, `integration`,
`monitoring` and `deployment`. The [run metadata](run.json) and
[job/step results](jobs.json) are allowlisted actual API responses, independently
read before the staging services were stopped.

The lead and independent reviewer read the completed quality/integration logs.
[Exact log hashes and extracted summaries](log-summaries.json) record:

- **739/739** quality tests, zero failures/skips, **94.94% line / 91.69% branch /
  95.16% function** coverage; thresholds remain 90%.
- **151/151** account/security/financial and **17/17** A4 cases on each fresh
  and upgrade path; **5/5** treasury cases on each separate Base fixture database.
- Core browser release, database isolation, durable community delivery/recovery,
  replay publication/failure recovery, container provisioning/migration,
  backup/restore, public discovery, smoke and desktop/mobile browser checks.

These are isolated CI environments and synthetic browser/media fixtures.
The `deployment` check validates configuration; it does not deploy staging.
Real chain, LiveKit Cloud, hosted Privy, staging rollout and physical-device
acceptance have separate reports. Raw CI logs remain available through the job
links; private working copies are not application configuration.

The earlier run at `63eada6` failed two PostgreSQL 18 error-code assertions
while the database correctly denied deleting retired identities. That failure
remains historical; the [reviewed compatibility correction](../pg18-auth-compatibility/README.md)
preserves the exact constraint/state checks and passed in this new run.
