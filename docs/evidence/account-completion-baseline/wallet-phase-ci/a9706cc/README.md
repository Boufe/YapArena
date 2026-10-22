# Failed a970 CI: independent inspection

Actual final result: **FAIL, four jobs passed and integration failed**, run
[39673300122](https://github.com/Boufe/YapArena/actions/runs/39673300122), attempt 1.
This failure is preserved. It is not acceptance of either a970 or the later
wallet parking/fixture corrections.

The reviewer downloaded all five completed job logs to mode-600 files in an
owned mode-700 private directory. Their checksums, job URLs and allowlisted
aggregate results are in [result.json](result.json) and
[sanitized-output.txt](sanitized-output.txt). Raw log/ZIP bytes were not copied
into source or rendered; only synthetic browser evidence was extracted.

Each job's actual checkout log identifies merge commit
`345ebcb02b83034511fa2d8a826bbf1aa3927d85`. The GitHub commit API verified its
parents are main `fd60543b5f6d8f0b65fe1f93807252064d9317f2` and branch
`a9706ccb55ae342c4f11366145b1896d17656931`. Its tree
`ba22cb58e56f07dd8824b057195c2c394d8b7412` exactly matches the branch tree,
independently checked locally and through the API. This conclusion does not rely
only on the workflow's `head_sha` metadata.

The quality job passed 854/854 tests, zero skips, and coverage
95.31%/91.19%/95.35%. It passed 235 account/security/ledger cases on each fresh
and upgrade database and five treasury cases on each separately isolated Base
ledger. The runner image was Ubuntu 24.04, using Node 24.22.0 and the committed
Docker isolation configuration. The configured isolation image is
`postgres:18.4-bookworm`; that image name is a source/configuration observation,
not an independently captured database-version query.

Integration passed replay packaging/publication checks, the fresh 235-case suite,
fresh 17-case A4 suite and all four A4 execution/no-trade repetitions. It then
failed in the strict retained-wallet child, whose only original diagnostic was
phase `retained-wallet proof negatives`. The pre-final
[mobile screenshot](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/wallet-phase-ci/a9706cc/before-final-mobile.png) exists; the verifier takes it after
wrong-account, wrong-chain, cancelled-signature, expired-proof and service-outage
assertions. The failure therefore occurred at the final successful mobile
removal or its immediate assertions. The original catch discarded the error and
line and did not capture a failure screenshot, so its exact historical assertion
cannot be recovered. A deterministic refresh-barrier reproduction and stronger
sanitized diagnostics are separate follow-up evidence, not an invented original
stack trace.

Core upgrade/browser completion, durable community, later public discovery,
backup/restore and smoke checks were not reached in integration. The deployment
job validates Compose; it is not a hosted deployment. Container production and
encoder builds/scans passed their configured HIGH/CRITICAL, ignore-unfixed
policy; this does not claim that every possible vulnerability category is zero.
Monitoring validation passed. All evidence remains runner-local/synthetic,
without genuine hosted provider or physical-device acceptance.
