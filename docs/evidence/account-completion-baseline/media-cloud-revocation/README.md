# Actual Cloud token revocation and public-viewer trial

[Combined postflight acceptance](postflight-acceptance.json) records the actual
hosted LiveKit Cloud test at revision `7a2482b`. The founder confirmed at least
five included participant-minutes and approved one disposable room, under two
minutes, with no microphone, camera, published tracks, egress or recording.
The trial used at most two clients and a conservative **1.5 participant-minute**
upper bound including session minimums and extra disconnect grace.

The actual installed browser SDK connected a newly issued speaker token and an
independent view-only viewer. A metadata update caused an actual server token
refresh; the SDK's typed `tokenRefreshed` engine event captured it only in memory.
`TokenVerifier` checked its signature, same fixture subject/room, unique metadata
and a newer `nbf`. That refreshed token successfully rejoined before revocation.

The compiled application `createMediaProvider.removeSpeaker` method performed
its actual provider clock check and explicit `revokeTokenTs` removal. The speaker
disconnected with `PARTICIPANT_REMOVED`. Both the original fresh token and genuine
server-refreshed token were then denied with **HTTP 401 / SDK NotAllowed**. The
independent viewer stayed connected, retained no-publish permission and
successfully rejoined using its unchanged original token. All clients published
zero tracks. No retained account or speaker identity was touched.

The [raw command report](acceptance.json) deliberately remains `passed: false` /
exit **1**: automatic room expiry was not observed during the helper's 40-second
cleanup observation window. Its four security assertions all passed. A separate
[read-only postflight](inspection.json) confirmed **zero rooms** at 05:44:44 UTC,
about **66 seconds** after fixture creation, still within the authorized
two-minute bound. No DeleteRoom call, extra participant or second trial was used.
The combined report preserves hashes of both original artifacts and does not
rewrite the raw command's exit status. Future automated cleanup observation
now accounts for Cloud's expiry scheduling granularity: after this trial the
helper's active cap was reduced to 45 seconds and cleanup may be observed for
60 seconds, with an absolute 115-second observation deadline. This adjustment
passed strict TypeScript/lint checks and did not trigger another Cloud trial.
The raw source hashes identify the code that actually ran.

Credentials and minted/refreshed JWTs stayed only in process/browser memory;
they were neither printed nor persisted. This is actual provider-signaling and
revocation evidence using disposable identities. It does not establish genuine
application-session logout, retained-account recovery, physical-device use,
screen-reader behavior, audio/video quality or financial eligibility.

The helper is strict TypeScript in the browser-automation inventory. Its
independent reviewer checked the installed SDK event and cost/cleanup bounds
before execution. The founder-provided quota fact is distinct from a verified
provider billing-plan inspection; no plan was changed.

Sources: [token lifecycle and explicit revocation](https://docs.livekit.io/frontends/reference/tokens-grants/),
[Cloud quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/),
and [metering/minimums](https://docs.livekit.io/deploy/admin/billing/).
