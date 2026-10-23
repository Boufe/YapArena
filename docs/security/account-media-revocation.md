# Account-bound speaker grants and revocation

This extends application-session containment to assigned speakers. Public
discovery and anonymous watching remain available. Since the 2026-10-22 founder
decision, **Sign out** deletes only this device's session, which retires the
speaker grants bound to it; other devices keep theirs. The other-session and
all-session APIs were removed; the Active sessions list ends one chosen session.

## Provider capability verified from official documentation

LiveKit Cloud supports invalidating cached tokens when removing a participant;
self-hosted removal does not provide that guarantee. Token expiry does not end an
existing connection, and LiveKit can refresh a connected participant's token.
See [the token reference](https://docs.livekit.io/frontends/reference/tokens-grants/).

The [RoomService reference](https://docs.livekit.io/reference/other/roomservice-api/)
supports an explicit `revoke_token_ts`, bounded within 60 seconds of provider
time, including removal of an already-left identity. Default buffer descriptions
do not establish a sufficiently recent cutoff for this application. The provider
adapter must supply an explicit cutoff and retain the fence on failures. A clock
assumption remains until the hosted trial checks both provider clock alignment
and replay of a freshly refreshed token. Installed `livekit-server-sdk` 2.19.1
exposes the supported `revokeTokenTs` option.

These provider capabilities are documentation findings. Local callback fixtures
and SQL tests are not evidence that the hosted Cloud project revoked a token.

## PostgreSQL contract

`media_account_grants` records the account, original session and generation,
debate, opaque UUID identity, issuance/expiry times and permanent retirement
state. It stores no JWT. A single active or retiring slot exists per account and
debate, preserving one publishing device. A retired identity is never reused.

Speaker issuance takes the account and current session locks, rechecks an active
assigned seat, participant role, publication/phase and recent camera/microphone
check, then signs locally. A final session check precedes commit. The token is
returned only after commit. Same-session refresh reuses its active identity.
JWT signing is local; no provider network request belongs inside this transaction.

Changing devices retires the previous slot and persists a revocation job first.
The replacement receives no publishing token until old-token revocation succeeds.
A pending response occurs **after** that retirement commits. New identities are
UUIDs, so delayed removal jobs and Cloud cutoffs cannot remove a replacement's
identity. Automatic recovery must not silently replace a different active SID;
only an explicit manual Join carries takeover intent. Retirement records the
intended replacement SID for five minutes. During removal and after its
completion, only that SID may automatically claim the freed slot; the displaced
SID cannot win a retry race. An expired intent requires another manual Join.
The old identity retains its displacement record, so a later departure does not
silently restore the old device. Replacement intent must reference a current
session belonging to the same account.

Signed departure callbacks use `withSpeakerDeparture` to check relevance and
pause media in the same database transaction. Its account lock fences replacement
issuance while remaining compatible with event-history foreign-key checks. A
delayed departure from an old UUID or mapped legacy account identity is ignored
when that account has a newer valid active grant. Unknown legacy identities
retain the existing conservative pause behavior. Provider turn synchronization
runs after the database transaction and reads the current media state.

Deferred database triggers inspect the final transaction state after account
generation/status changes or session deletion/update. They retire invalid SIDs,
including suspension and credential changes. The deferral let the since-removed
logout-others action keep its surviving SID valid; deleting one session row
retires only grants bound to that session.
A background scan also detects naturally expired rows without depending on an
hourly deletion job. Grant generation records issuance history; the actual
current session and account are checked in PostgreSQL for authority.

`media_account_revocations` holds durable jobs with claim tokens and leases.
Workers lock account, grant and job in that order, commit the claim, then call
the provider outside database locks. A matching claim token is required to
acknowledge completion. Failures keep the publishing slot retired and retry with
bounded exponential delay (2, 4, 8 seconds up to 60). A provider call has a bounded
deadline. Metrics expose only bounded results and latency, without account,
session, room, token, URL or error-object contents.

The local application fence commits independently of provider availability.
Logout/revocation cannot wait indefinitely for LiveKit. A provider outage can
delay external disconnection; the durable pending job must stay visible and
retry after recovery. A self-hosted removal is never acknowledged as complete
token revocation, and new protected speaker grants fail closed on unsupported
deployments. Anonymous viewer grants are unaffected.

## Integration and rollout acceptance

Use `createMediaAccountRevocation` with the runtime pool, a verified Cloud
capability, local speaker-token signer, exact-identity removal callback, and
privacy-safe observation hook. Route speaker issuance through
`issueSpeakerGrant`; check `isCurrentGrant` for signed participant-joined
webhooks before restoring publishing permissions. Use `withSpeakerDeparture`
with a same-client database pause callback for signed departure webhooks; do not
separate its relevance check from the pause. Run `flush` in the existing
background worker loop and expose pending/retry failures operationally.

Pre-deployment identities such as `speaker-<account>` are not in the new grant
table. Verify that no legacy publishers remain connected before declaring
rollout acceptance, or explicitly contain those known identities. Waiting for
the original 15-minute JWT lifetime is insufficient because a connected client
may have received refresh tokens. Do not delete retained accounts or issue an
automatic account reset to address this gap.

Required hosted evidence must identify the revision/project and include:

- An actually assigned speaker receives camera-only initial permission, with
  microphone permission still controlled by the existing turn mechanism.
- Single-device Sign out, suspension, credential changes and explicit
  per-session revocation disconnect the intended speakers across instances.
- A SID on another device survives this device's Sign out, while a removed SID
  cannot obtain a replacement speaker grant.
- Old initial and freshly refreshed tokens cannot rejoin after Cloud removal;
  already-left identities are also revoked without an endless error loop.
- Device replacement waits for old revocation. An offline old tab cannot
  automatically take the slot back, and delayed jobs or departure callbacks do
  not kick, pause or mute a new identity.
- Provider failure leaves a durable retry, while application logout still
  succeeds. Retrying after recovery completes containment.
- An anonymous viewer stays connected throughout, and new anonymous watching
  still works.

The PostgreSQL suite uses explicitly disposable loopback databases and injected
provider callbacks; it opens no provider room. Automated browser fake-device,
actual hosted Cloud and physical-device checks remain distinct acceptance gates.
