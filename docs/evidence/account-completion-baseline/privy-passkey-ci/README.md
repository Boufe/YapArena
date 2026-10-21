# Required CI acceptance for the Privy-only release

[Run 39483112893](https://github.com/Boufe/YapArena/actions/runs/39483112893)
completed successfully on 2026-10-20 for PR #42 head
`d6e2d355da255e03c257802c890c036c4d572a62`. All five required checks passed:
`quality / check`, `container`, `integration`, `monitoring` and `deployment`.
[Run metadata](run.json) and [job/step results](jobs.json) are allowlisted actual
API responses. No staging mutation is implied by the deployment configuration
check.

The independent reviewer downloaded and inspected the completed quality and
integration logs. [Exact hashes and extracted results](log-summaries.json)
record **798/798** quality tests, zero failures/skips, coverage **95.29% lines /
91.23% branches / 95.19% functions** against unchanged 90% thresholds. The local
R2 branch result was 91.24%; these are distinct environments and results.

Actual CI fresh/upgrade paths each pass **198/198** account/security/financial
cases, **17/17** A4 cases and **5/5** treasury cases on separate fixture databases.
Core browser/isolation, durable community/recovery, replay packaging/publication,
container/runtime identity separation, migration, backup/restore, smoke and
desktop/mobile browser steps all completed successfully.

GitHub checked out PR merge `1b515f3d40c7c320be2a16aadcb887bec7b57bbc`.
Its parents are base `fd60543` and head `d6e2d35`; its actual Git tree
`213981d61583b02fd28dc4dac12ad8355f72e99c` exactly matches the deployment
candidate's tree. This establishes the tested source boundary without confusing
the merge commit with the selected application commit.

Raw working logs remain mode 600 outside the repository and are available through
the job links. This report contains no raw environment, credentials or provider
responses. CI is isolated synthetic acceptance; genuine Privy, named staging,
actual chain/Cloud and physical/device results retain separate evidence. Live
money remains disabled. The matching
[staging release](../privy-passkey-release/README.md) subsequently passed. Final
review then found an additional provider-settings account-switch race; this CI
run does not establish acceptance of its follow-up correction. The task remains
incomplete pending that correction and outstanding external acceptance.
