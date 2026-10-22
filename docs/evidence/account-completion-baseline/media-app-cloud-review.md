# Independent review of the application-to-Cloud revocation trial

Source reviewed on 2026-10-20 before any additional Cloud room was authorized
or created. This is a source review and inspection of the actual local
`--verify-app` output, not hosted provider acceptance or permission to execute.

The reviewed helper SHA-256 is
`9f8bc454e2c74f426e7e8939cbe5f8320d9f07bb0aa8f55db6e23ee69356d0ef`.
Scope: `scripts/verify-media-cloud-revocation.ts --execute-app`, compiled media
provider/tracked-grant repository, actual authentication router and sessions.

Two execution issues were found and corrected before provider execution:

- A partial `pg_ctl start` failure could leave the startup flag false, allowing
  cleanup to remove a possibly live data directory. The flag now precedes
  startup; setup, database calls, server/pool shutdown and `pg_ctl stop` are
  bounded. An uncertain stop preserves the private directory.
- Local cleanup originally followed the absolute Cloud-expiry polling window,
  allowing its additional time to exceed the two-minute trial bound. It now
  runs before polling; application mode observes automatic expiry only until
  the absolute 110-second boundary, leaving RPC/reporting margin.

No remaining source blocker was found within this scope:

- No hosted database URL is accepted. A new private SCRAM PostgreSQL cluster
  uses distinct administrator/owner/runtime roles and two runtime pools.
  Credentials and tokens remain private or in memory. No retained or hosted
  application account is read or changed.
- Two actual local sessions pass the real `/me` router, then normal HTTP
  `/logout` must reject both cookies and transactionally queue tracked-speaker
  removal. The separate runtime pool must complete that durable job exactly
  once. Assigned participant/device-check rows are explicitly synthetic.
- Only the fixed staging Cloud project is used. The trial publishes no track,
  captures no microphone/camera, and requests no recording, egress, DeleteRoom,
  billing change or unrelated provider operation.
- Maximum concurrent clients remains two, active execution is capped at
  45 seconds, and browser/SDK disconnects are bounded. The original and actual
  server-refreshed tokens must be accepted before revocation and specifically
  rejected afterward. The independent view-only viewer must remain usable.
- The prior trial's conservative 90,000 participant-milliseconds are included
  separately in the final less-than-five-minute aggregate check. Current timed
  connections include conservative rounding and disconnect grace. The existing
  included quota is founder-confirmed; no new cost or plan is authorized.
- `--verify-app` branches before loading Render configuration or constructing a
  Cloud client. Its actual zero-exit output reports two rejected local cookies,
  a transactional pending job and completion by the second pool, with zero
  external calls. Simulated removal is clearly labelled and does not establish
  actual Cloud acceptance.

The concrete additional trial is suitable to request approval for one disposable
room within the remaining confirmed included minutes, with the bounds above.
That approval must precede `--execute-app`; environment flags are operator
assertions and do not themselves establish permission. A failed cleanup or
exceeded bound must remain a failed result, with a separate read-only postflight
where appropriate. This review does not establish a hosted YapArena/Privy logout,
physical device, audiovisual quality, screen-reader or live-money gate.

## Additional approved execution inspected

After the founder explicitly approved the additional disposable room, the
[actual application/Cloud report](media-app-cloud-revocation/acceptance.json)
recorded `passed: true` at 2026-10-20 15:58:50 UTC. Its helper hash matches the
reviewed source above. The local HTTP logout rejected two application cookies,
transactionally queued removal and completed it through the second runtime
pool. Cloud rejected both original and genuine server-refreshed tokens with
401; the independent view-only viewer reconnected without publish permission
or tracks. Automatic room expiry was observed.

Total Cloud trial and cleanup time was 51,406 milliseconds. Six conservatively
rounded connection intervals plus disconnect grace total 90,000 participant-
milliseconds; with the earlier trial's separate 90,000 bound, the combined
180,000 milliseconds remain below the confirmed five minutes. Maximum concurrent
clients stayed two. This closes the local application/outbox-to-actual-Cloud
boundary at the recorded hashes. It does not establish genuine hosted Privy
logout, named staging database/session acceptance or physical media quality.
