# Privy passkey and first-key restart cookie coordination

Actual local Chromium run passed all seven check groups. [results.json](results.json) records the tested revision, browser version and exact helper source/asset hashes. The matrix exercises 14 session-issuing routes, including both ordinary Privy passkey completion and `/security/provider/passkeys/bootstrap/:id/complete`, across two tabs.

Launch HEAD was `ac59dc0674e367d5afca3dea0992f52a7b926d41` with the new helper routes in the shared working tree. The saved hashes identify those tested bytes; this is not a claim that the launch commit alone contains the changes.

Command: `SESSION_COORDINATION_ARTIFACT_DIR=docs/evidence/account-completion-baseline/single-privy-passkey-bootstrap-cookie-browser node scripts/verify-session-coordination-browser.ts`.

This verifies actual HTTP cookie headers, Fetch aborts and Web Locks: delayed headers/bodies, account-sensitive sign-out races, queue/network timeouts and the unsupported-browser failure. Server identities and cookie values are synthetic. No provider, PostgreSQL, hosted, physical-device or other-browser acceptance is inferred. Arbitrary API clients do not participate in these browser locks. The later focus-only account-security bundle change does not change this tested coordination helper.

The previous 13-route run remains separately recorded in `../single-privy-passkey-cookie-browser/`.
