# Read-only embedded-wallet staging verification

`scripts/verify-embedded-wallet-staging.ts` verifies the fixed staging deployment,
database job and actual Privy wallet without creating, signing, funding, repairing
or deleting anything. It is checked in `tsconfig.database-tools.json`.

The verifier requires Node 24's explicit source-transform flag. It compares its
own file, package manifests and wallet source modules to the expected commit
before dynamically importing the verified TypeScript source. It does not rely
on a potentially stale compiled adapter.

Offline transport checks require no credentials or network:

```sh
node --experimental-transform-types scripts/verify-embedded-wallet-staging.ts self-test
```

The 20 checks exercise the actual SDK adapter with synthetic responses, reject
mutations before transport, and verify URL, response-size, redirect, provider
freeze-shape and output-privacy guards. This result is not provider acceptance.

For actual inspection, first deploy the exact reviewed commit. Set
`ACCOUNT_EMBEDDED_WALLET_EXPECTED_REVISION` to its full SHA and, if needed,
`ACCOUNT_STAGING_CA_PATH` to the reviewed certificate-authority file, then run:

```sh
node --experimental-transform-types scripts/verify-embedded-wallet-staging.ts inspect
```

Use the existing private owner configuration and Render CLI credential files.
Do not copy their values into chat, source, reports or a runtime process. The
script privately reads `PRIVY_APP_ID`, `PRIVY_APP_SECRET` and `DATABASE_URL` from
the named Render service; no credential is supplied as a command argument.

Inspection verifies the exact unsuspended Render service, origin, live revision
and paired runtime configuration. It uses verified TLS and the dedicated owner
role on session port 5432, with an explicit read-only transaction and safe search
path. There must be exactly one active mapped account; it refuses ambiguous
selection. Connections close before provider requests. Two provider inspections
and a second database snapshot must agree, and the deployed revision is checked
again. Provider requests are bounded, bodyless HTTPS GETs to an explicit path
allowlist, with redirects rejected and a 60-second overall deadline.

A passing wallet must match the ready job, current mapping/generation and
accepted credentials, its trusted user-linked address, and a user-only owner
quorum without other signers or policies. Original-DID mismatches and uncertain
ownership require review. The script cannot accept a pending passkey, finish
setup, retry creation or clear a security fence.

Artifacts use mode 0600 in the existing private operator directory. Output is
an explicit allowlist of booleans, counts, state, time, revision and hashes;
no email, account ID, DID, address, credential, provider response or raw error
is exported. Inspect the sanitized artifact before copying it into release
evidence.

| Exit | Result          | Meaning                                                                                             |
| ---- | --------------- | --------------------------------------------------------------------------------------------------- |
| 0    | PASS            | The genuine provider wallet matches a stable ready job and verified owner at the expected revision. |
| 2    | PENDING         | Provisioning, credential acceptance or stable observation is unfinished.                            |
| 2    | REVIEW_REQUIRED | Ownership or the immutable original identity needs review.                                          |
| 2    | UNAVAILABLE     | Safe provider evidence could not be obtained.                                                       |
| 1    | FAIL            | A target, revision, TLS, transport or consistency guard failed.                                     |

PASS does not establish signing, funding, withdrawal, device recovery, physical
accessibility or live financial approval. See the [wallet design](embedded-wallets.md)
and [completion matrix](email-first-completion.md) for those separate gates.
