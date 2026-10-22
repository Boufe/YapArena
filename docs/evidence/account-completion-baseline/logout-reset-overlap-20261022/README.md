# Provider reset overlapping logout — 2026-10-22

Source **92f11b449337ad12f2c2295d9b81fb72afb14634** corrects a locally
reproduced state transition. A first accepted passkey starts a provider-session
reset; its freeze is acknowledged while GET still returns stale null. A normal
authenticated logout advances the local generation before that reset finishes.
Previously the older job became permanently manual and the newer logout
inherited that fence. The correction drains the acknowledged cleanup, then
performs the current logout's own reset.

This archive establishes **local PostgreSQL/synthetic-provider acceptance** and
an independent source review. It does not assert a hosted repair, remote
freeze/unfreeze, returning login, wallet ownership or completion of the overall
authentication/financial task. The genuine diagnosis and any bounded operator
repair are separate records.

## Reproduction and preserved chronology

The [baseline RED log](red/baseline-failure.log) failed the intended new
regression: **240 of241 passed**, no skips, with the acknowledged predecessor
`manual` rather than expected `pending`. The author recorded exit1/session55830
against unmodified backend7e5c0a3. Both baseline backend hashes match that Git
revision and are retained in [summary.json](summary.json).

The actual RED test-file hash was not captured before later additions. The raw
log identifies the test, assertion and exact counts, but has no embedded source
manifest. The final248-case test hash is not relabeled as RED, and a later
reconstruction would not become contemporaneous evidence.

The [first candidate](history/first-candidate-failure.log) also failed: it reached
the later completion assertion but still left a job manual. It is preserved as
a failed correction, not acceptance. The
[next241-case run](history/normal-drain-241.log) passed fresh and upgrade after
that issue was corrected. The [247-case owner run](history/owner-rearm-247.log)
then passed both paths after reviewed rearm tests were added. Both are
intermediate results, not the final accepted revision.

The [final log](final/run.log) passed **248 of248 account/security/financial
cases on both fresh and upgrade databases, zero failures/skips**, plus five
separate treasury cases on each path. The final regression adds a competitor
between the committed unfreeze intent and its one provider call: the newer
logout stays pending, performs no provider I/O, and cannot steal the cleanup or
inherit a permanent manual state. The predecessor then drains and the current
reset completes once.

All runs used Node24 and PostgreSQL17.10 in the maintained disposable isolation
harness with `ACCOUNT_SECURITY_VERIFY=true`, `A4_QUALITY=false`. The exact
invocation and process exits are in the summary. These are focused suites; no
full coverage, full browser gate, CI, push or deployment is inferred here.

## Independent security review

The independently reviewed phase, revocation and test hashes are respectively
`a69efe83…`, `44fee9a8…` and `5b036b23…`. All match committed92f11b4 and the
root files at archival. The review found no remaining P0/P1/P2 issue in this
change, with these specific boundaries:

- Normal cleanup requires the same mapped DID and accepted credential digest,
  exact control nonce/attempt, a durable ACK, valid lease/deadline/read budget,
  and a complete chain of supported authenticated logout audit events with
  untouched successor jobs. Unknown intents, incidents, suspension, changed
  identity/digest and independently changed freeze timestamps remain fenced.
- Historical cleanup marks only its old job complete. It does not adopt a stale
  mapping generation, lower the provider-token cutoff, create a session or wake
  wallet creation. The current generation performs its own reset before access
  can become healthy. Existing local revocation and replay fences remain.
- Owner rearm requires dedicated `current_user` **and** `session_user`
  `yaparena_owner`, a stopped manual ACK pair with expired leases, and an
  untouched inherited logout. The owner supplies reviewed evidence; fresh
  server reads independently check current DID, digest, accepted COSE key and
  exact original freeze window. Provider reads hold no checked-out connection
  or ordering lock.
- Account, job and key locks plus the complete snapshot fingerprint protect
  rearm. One immutable request/terms/control-ID audit permits one fresh
  120-second/eight-read confirmation budget. Replay returns the exact receipt;
  altered terms or cross-account request reuse fail. Audit failure rolls both
  queued rows back. Rearm itself makes no provider mutation.

The owner path requires expired **leases**, not necessarily an expired
`control_deadline`. It is a deliberate one-time reviewed restart of stopped
confirmation, not an automatic extension of an exhausted retry loop. Freeze
timestamps are not provider operation IDs and cannot prove absence of a
simultaneous independent dashboard action. That operator evidence remains a
separate prerequisite.

The author ran the isolated tests; the independent reviewer read the actual
logs, final source and test cases and checked hashes. The independent reviewer
did not repeat a database run or perform any hosted/provider action.

## Evidence integrity and limits

[Final database logs](final/database/fresh-account-security.log),
[upgrade logs](final/database/upgrade-account-security.log), treasury logs and
fresh/upgrade catalog inventories retain the narrower assertions. The catalog
identifier is94625c7b. Catalogs contain schema/privilege metadata rather than
account rows and do not inspect hosted Data API/GraphQL/Realtime configuration.

[manifest.json](manifest.json) binds the archived bytes. Original `.json.raw`
catalogs and formatted JSON have equal parsed values. Copied logs contain no
database URL, JWT-shaped value, private-key block, DID, email or secret-assignment
marker in a bounded scan. That check is not a full current-secret/history audit.
No retained account or hosted datastore was changed by this archive.
