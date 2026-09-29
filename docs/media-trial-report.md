# Live debate and replay validation — 2026-09-29

## Setup and evidence

- Reviewed [media decision](decisions/0004-live-debate-replay.md), [staging runbook](render-staging.md), media API/repository/provider, browser client, worker, and media tests.
- Staging: `https://yaparena-staging-web.onrender.com` (`feature/render-staging`, Render service `yaparena-staging-web`). The stack uses Supabase Postgres, LiveKit Cloud, and private R2 storage. Do not use real user data.
- Local: Docker app, PostgreSQL, LiveKit, Redis, object store, and Egress containers were running. `http://localhost:53000/ready` returned 200. The local Egress capacity and full recording path remain unproven.
- Staging `/ready` returned HTTP 200; `/` returned HTTP 401 without the staging secret, as expected. Render logs showed a signed LiveKit webhook request returning 204 on 2026-09-29 at 18:15:46 UTC. This proves webhook reachability, not a completed debate or recording.
- `npm run check` passed: lint, format, typecheck, build, and the Node test suite with coverage thresholds (97.12% lines, 90.38% branches, 98.66% functions).

## Results and fixes

| Check                                                                                                                                                                                                    | Result                       | Evidence or remaining observation                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speaker token, device check, viewer grant, turn clock, pause/resume, recording/replay/caption gates                                                                                                      | Automated pass               | `tests/media-router.test.js`, `tests/media-repository.test.js`; these use fakes and do not prove browser media or cloud Egress.                                                                                                              |
| Early Egress completion                                                                                                                                                                                  | Defect fixed, automated pass | A nonempty partial file previously became `ready` while the debate was still running. It now becomes `failed`, and the paused debate cannot resume without a recording.                                                                      |
| Speaker disconnect                                                                                                                                                                                       | Defect fixed, automated pass | The signed webhook now revokes the speaker turn after pausing; previously only the database clock paused.                                                                                                                                    |
| Resume when LiveKit permission update fails                                                                                                                                                              | Defect fixed, automated pass | The route now pauses again and returns 503 instead of leaving a running clock with stale speaker permissions.                                                                                                                                |
| Two-speaker staging join, camera/mic publishing, audience playback, turn changes, reload/clock recovery, device/network reconnect, completed Egress file, replay video, caption quality, mobile playback | **Not run**                  | Requires staging access, three signed-in test accounts including an operator, two camera/mic devices on separate networks, an audience device, and human audio/video observation. The available browser connection could not be established. |

The fixes are local and **not deployed to staging**. The current staging service must not be treated as evidence for them.

## Staging trial procedure

1. Deploy the reviewed media fixes to the staging branch, confirm `/ready` is 200, and record the deployed commit SHA and UTC time. Retrieve `STAGING_ACCESS_SECRET` from Render's secret field; enter it in the browser's Basic Auth prompt with username `staging`. Do not put it in this report or chat.
2. Prepare separate speaker A, speaker B, and operator test accounts. Publish profiles for both speakers. The operator account needs the `operator` role in `account_roles`; there is no public role-grant endpoint. If no test operator exists, a database administrator can grant it in the Supabase SQL Editor with `INSERT INTO account_roles (user_id, role) SELECT id, 'operator' FROM users WHERE email = '<test-operator-email>' ON CONFLICT DO NOTHING;`. Use only a designated test account, then sign in as it and verify `/api/me/roles` reports `operator`.
3. At `/match`, create and publish a test topic. Speaker A creates a direct challenge for side A; speaker B accepts side B. Record the event ID and URL. The UI requires scheduling at least one hour ahead; return when the event is within 15 minutes of its start to run the trial. Confirm it uses `prototype-media-1`; older `preview-1` examples cannot start media.
4. On separate camera/mic devices and networks, each speaker opens the event page and selects **Check camera and join as speaker**. An anonymous viewer selects **Join as viewer**. Record device/browser/network, UTC join time, first local/remote video time, first audible speech time, and any permission or console error. Check that only the active speaker's microphone is audible.
5. The operator enters a reason and selects **Start**. Observe at least two one-minute turn changes on all three screens. Reload one speaker page and the viewer page; verify that the server clock, current side, and playback recover without restarting the debate. Record clock differences and recovery times.
6. Switch one speaker's camera/microphone, then interrupt and restore that speaker's network. Record whether the operator sees a pause and incident, whether speech stops, how the speaker rejoins, and whether **Resume** restores the correct turn. Repeat on a mobile browser; inspect video layout, controls, focus, captions, and audio routing. These are human-observed checks.
7. The operator selects **End**. Record the time until recording status becomes `ready`, the LiveKit Egress ID/status, R2 object size, and any webhook or worker errors. Select **Publish replay**, play the full video as a fresh viewer, and check picture, both speakers' audio, sync, and ending. Publish reviewed WebVTT with the operator control and verify visible, synchronized captions on desktop and mobile.
8. Save the event ID, deployed SHA, UTC timestamps, device/browser versions, request IDs or redacted logs, R2 object size, and screenshots or short clips of failures. Never save tokens, passwords, signed replay URLs, or private media in Git. Enter measured results below.

| Measure                                                  | Result  |
| -------------------------------------------------------- | ------- |
| Deployed SHA / event ID / trial UTC time                 | Pending |
| A, B, viewer join and first media times                  | Pending |
| Turn/clock differences and reload recovery               | Pending |
| Device and network reconnect outcomes                    | Pending |
| Egress completion, file size, replay start/full playback | Pending |
| Caption and mobile observations                          | Pending |

## Recommendation

**Do not build Work Package 5 on this media design yet.** Automated behavior and staging health are encouraging, but the required two-speaker cloud recording and replay trial has not occurred. Complete the procedure above, choose measurable latency/reliability budgets and expected audience size, then decide whether the current LiveKit/worker/storage design meets them. Test webhook loss, worker restart, accessibility, and audience load before selecting it for production.
