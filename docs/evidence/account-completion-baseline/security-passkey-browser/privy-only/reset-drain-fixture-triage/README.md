# Local reset-drain fixture corrections, 2026-10-21

These preserved attempts used isolated loopback PostgreSQL, real application
repositories, frozen generated assets, intercepted synthetic provider responses
and Chrome virtual credentials. They did not touch hosted accounts or Privy
identities. Each process exited 1 and cleaned its disposable cluster.

- [Initial output](before.log) and [screen](before.png): after real bridge
  activation queued normal provider revocation, the minimal harness had no
  worker drain. Its catch-all middleware incorrectly mapped the expected
  provider-unavailable exception to 500. The corrected fixture preserves the
  monitor, maps this supported exception to 503, runs the actual durable reset
  repository with explicit synthetic controls and asserts job/generation
  completion before refreshing through authenticated requests.
- [Second output](wrong-completion-status.log) and [screen](wrong-completion-status.png):
  the new verifier barrier expected 204. The actual route returns 200 with
  `keyId`; correcting that exact assertion changed no application behavior.
- [Third output](legacy-before.log) and [screen](legacy-before.png): the same
  drain was also required after fixture-only legacy enrollments/removal, which
  intentionally rotate the session and enqueue provider revocation. Those
  rotations now use the same real worker step before the next approval UI.

The final [terminal output](../output.txt) exited 0 with all 18 groups and no
page/backend errors. Native assertions, exact-key binding, replay, cross-account,
last-key, SQL rollback, cookie rotation, cancellation and focus checks remain.
No security condition or coverage threshold was removed. These corrections do
not establish genuine provider enrollment, propagation latency or device
acceptance. Previous top-level evidence is retained in Git history; its complete
pre-overwrite directory was also archived privately before these runs.
