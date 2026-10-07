# 0004 — Hostless live debate and replay prototype

**Status:** Prototype implementation; media architecture and product timings are not approved for launch.

The subsequent [playback reliability checkpoint](../media-playback-operations.md) adds
connection preparation, application recovery and an optional authenticated HLS replay
path. Its [acceptance scope](../media-playback-requirements.md) remains proposed and
[release evidence](../media-playback-trial.md) explicitly records unverified gates.

The subsequent [replay automation decision](../replay-automation.md) replaces the prototype's
manual packaging/publication prerequisite with an automatic verified pipeline when enabled.
Optional captions never block automatic conversion or publication; no transcription service
is introduced by this change.

## Product boundary

The product PRD requires two speakers, equal initial speaking time, a bounded extension mechanism,
an overall maximum duration, public viewing, and replay. It does not settle minutes, engagement
triggers, extension allocation, or the maximum. `prototype-media-1` uses one-minute turns and a
ten-minute maximum solely to exercise the clock and recovery paths. Extensions are disabled. These
values are not founder-approved event economics. Older `preview-1` event snapshots remain unchanged
and cannot start a timed media session. No media state implies a winner, financial cutoff, or open
market.

## Prototype architecture

- The app signs short-lived, room-scoped LiveKit tokens. Only the two reserved participant accounts
  can request speaker tokens; anonymous viewers get subscribe-only tokens only while an event is
  live. The server grants microphone publishing to the active side and camera publishing to both.
- Speaker readiness requires a recent browser camera and microphone check. The browser joins the
  room before recording readiness; the operator can start only when both speakers are connected.
  Checks are user-reported device evidence, not a guarantee of media quality.
- PostgreSQL stores the active side, turn deadline, accumulated active duration, revision, incident,
  egress ID, recording state, and object key. A one-second server worker advances turns, and clients
  poll state with a server timestamp. Reloads and reconnects restore the same server-owned clock.
- An operator can pause or resume with an explicit incident. A LiveKit speaker departure webhook
  pauses the debate. An unexpectedly ended recording pauses it too. The live status remains live
  while paused; the incident is visible on the event page. Resume uses a state revision to reject
  stale operator actions.
- Starting live begins room-composite recording to a private S3-compatible bucket. End transitions
  set a durable stop request, which the worker claims and retries after failure. A signed LiveKit
  webhook marks a recording ready only when Egress reports a nonempty file matching the planned
  object key. Publishing replay additionally HEAD-checks that object. Playback gets a one-hour
  signed URL. Operator-reviewed plain WebVTT captions are served separately.

The browser includes camera permission preflight, connect and reconnect status, a server clock,
keyboard buttons, replay controls, and an operator panel. The operator panel is visible only after
the authenticated roles endpoint reports `operator`; server routes enforce that role independently.
The browser stops its preview tracks after connecting. Speaker audio opens only on the active turn.

## Local setup

With `.env` configured, run from the repository root:

```sh
docker compose -f compose.yaml -f compose.media.yaml up --detach --wait db redis-media livekit object-store egress
docker compose -f compose.yaml -f compose.media.yaml run --rm --build app \
  node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
docker compose -f compose.yaml -f compose.media.yaml up --detach --build --wait app
```

The override contains local-only media and storage keys. The browser connects to
`ws://localhost:7880`; the app uses the internal HTTP endpoint. A real deployment must provide
its own HTTPS/WSS LiveKit endpoint, private storage, distinct secrets, TURN/network configuration,
Egress capacity, webhook delivery, and access controls. The local Egress worker recommends at least
four CPUs and four GB of memory for room-composite recording. The current two-CPU Docker VM reports
insufficient capacity; a local Egress start probe timed out. Recording has not been proven end to end
on this machine.

Speaker flow: create a new event under `prototype-media-1`, open its debate page as each speaker,
allow camera and microphone, and join. The page records readiness. An operator opens the same page,
enters a reason, and selects **Start** when both speakers are ready and connected, regardless of
the scheduled time. **Pause**, **Resume**, and **End** control incidents. Once Egress has finished and object
storage confirms the file, the operator selects **Publish replay** and can upload reviewed WebVTT.
Previously seeded demo replay listings intentionally have no video.

## Release evidence still required

This prototype does not select the production media architecture. Before that decision, run a
two-speaker trial and record join/publish latency, audience playback latency, audio/video sync,
recording completeness, reconnection after device/network switches, webhook loss, worker restart,
accessibility on keyboard/mobile/reduced-motion, and load at an agreed audience concurrency.
Choose budgets and expected audience size first, then retain trial results and incident traces.
Caption generation and transcript review are manual here; automated caption quality and moderation
need separate validation. The API and database tests verify lifecycle gates, but a full live video
and recording trial remains outstanding.

LiveKit [self-hosting](https://docs.livekit.io/transport/self-hosting/deployment/),
[Egress requirements](https://docs.livekit.io/transport/self-hosting/egress/), and
[webhook configuration](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/)
inform this prototype's local setup and deployment gate.
