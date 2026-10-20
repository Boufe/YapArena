# Privy passkey completion cookie coordination

Actual local Chromium run passed all seven check groups at revision `390958ab2b49bce13153af681942882ca4e5ee10`, with the saved source and generated asset hashes in [results.json](results.json). The frozen helper includes `/security/provider/passkeys/:id/complete` among the 13 session-issuing routes exercised across two tabs. The maintained verifier gained an optional artifact directory so this evidence does not replace the earlier trial.

The recorded revision is launch HEAD; the additional helper route was in the shared working tree. The saved hashes identify its exact tested bytes.

Command: `SESSION_COORDINATION_ARTIFACT_DIR=docs/evidence/account-completion-baseline/single-privy-passkey-cookie-browser node scripts/verify-session-coordination-browser.ts`.

This tests actual HTTP cookie headers, Fetch aborts and Web Locks, including held headers/bodies, both account-sensitive sign-out races, queue/network timeouts and the unsupported-browser failure. The server identities and cookie values are synthetic. It establishes no provider, PostgreSQL, hosted, physical-device or other-browser acceptance; arbitrary API clients do not participate in these browser locks.
