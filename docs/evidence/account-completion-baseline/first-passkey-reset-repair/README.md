# Interrupted first-passkey reset repair

Executed on 2026-10-21 against the fixed staging app, using the repair committed
in `030b60e`. This is an owner-reviewed provider-session repair, not a successful
genuine passkey-login or device-acceptance trial.

The existing genuine account had one provider passkey whose exported COSE key
passed parsing, but no activated application key. Its unfinished first-key intent
expired. The recorded subsequent action was account-wide logout. The matching
worker freeze was confirmed in the actual organization Activity log, with no
independent or later freeze observed. An independently reproduced two-session
monitor bug is separate; it is not established as this account's failure cause.

The lead inspected the exact repair, and an independent reviewer checked its
authorization, one-use marker, transport and finalization boundaries. See
[independent review](../first-passkey-reset-review/README.md). The focused suite
passed **206/206 cases on both fresh and upgraded disposable databases**, with
zero skips; treasury checks passed five cases on each path. Exact logs and
sanitized role/catalog inventories are retained beside this document.

The owner command issued exactly one unfreeze after committing its durable review
marker. Its immediate confirmation reads did not yet observe propagation, so the
command stopped at `unfreeze_confirmation` without retrying the mutation. A later
GET observed explicitly null provider freeze state. The separate GET-only
finalizer then completed successfully. No second unfreeze was issued.

The read-only hosted postflight at **13:59:08.746 UTC** found one active mapping,
matching generations, the preserved old-token cutoff, one complete reset job,
zero manual jobs, and explicit provider-unfrozen state. There were still **zero
activated application passkeys**, and the accepted credential digest still
differed from the newly observed provider key. No credential snapshot was adopted,
account merged, new session created, security proof issued or financial balance
changed by this repair. Fresh provider login and native user verification remain
necessary to complete the first-key setup.

Public JSON files contain aggregate allowlisted facts only. Private operator
action/review files remain outside the repository; their SHA-256 digests are
recorded separately. No email, provider subject, passkey material, token, signature
or credential is included. The later durable normal-worker phase engine requires
its own combined acceptance and release; this repair does not establish that.
