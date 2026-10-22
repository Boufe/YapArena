# Same Privy passkey: local protocol and PostgreSQL acceptance

The founder requested one Privy passkey for login and sensitive actions. This
supersedes new enrollment of a separate YapArena key. The bridge uses the trusted
provider credential ID/public key and a fresh application challenge, without a
second registration ceremony or an access-token freshness shortcut.

The actual final isolated owner/runtime PostgreSQL verifier exited **0**:
**179/179 tests for fresh installation and 179/179 for upgrade, no failures or
skips**, plus **5/5 Base treasury tests in each path**. See
[the complete output](postgres-output.txt) and
[the tested source/runtime hashes](postgres-results.json). The recorded revision
includes explicitly hashed uncommitted source changes; a commit name alone does
not identify this test boundary.

Sixteen new bridge groups cover first setup for email/Google accounts, unchanged
activation of an existing provider key, financial/prior-key bootstrap denial,
immutable mode and selected credential, exact DID/SID/exported-key/credential
delta, challenge/origin/RP/user-presence/user-verification, replay and cross-account
attempts, concurrent one-use completion, provider IO outside a single-connection
pool, expired/consumed intents, and retained approval for later setup. They also
exercise the actual session monitor's temporary denial during an exact pending
addition, incident revocation from another cookie or a changed old key, missing
key evidence without false revocation, self-removal denial, and rejection of
changed exported keys for a sensitive proof. A newly accepted Privy key cannot
use independent application-key login or authorize legacy new-DID replacement.

Provider responses are synthetic fixtures. Assertions use real generated P-256
keys and signatures, verified by the installed WebAuthn library against the real
application repositories and PostgreSQL roles. These are **not actual Privy
enrollment, token verification, exported-key availability, hosted acceptance,
native browser or physical-device evidence**. The browser/SDK and genuine
provider checks remain separate gates.

Four preceding nonzero runs were investigated before this result. The first
found a challenge-encoding bug: authentication options were given an encoded
string instead of decoded challenge bytes. The second found fixture type and
microsecond-clock errors and an inconsistent invalid-assertion status. The third
found an existing reset fixture's read count had not yet been updated for a new
unfreeze-confirmation GET. The fourth found a stale key-list projection assertion
and a reset fixture compiled during its owner's edit window. Each was corrected
without weakening nonce, expiry, signature, authorization or privacy checks.
The private original logs remain at
`/private/tmp/yaparena-privy-key-isolation-{initial,second,third,fourth}.log`.

The initial sandbox process also failed at PostgreSQL shared-memory setup before
creating a database. The authorized reruns used the same loopback-only disposable
harness outside that sandbox restriction. No staging database, retained account,
provider identity, live transaction or paid service was changed.
