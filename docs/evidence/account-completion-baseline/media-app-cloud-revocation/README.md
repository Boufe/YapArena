# Application logout through LiveKit Cloud

On 2026-10-20 the founder approved one additional disposable room within the
previously confirmed five included participant-minutes. The independently
[reviewed helper](../media-app-cloud-review.md) ran successfully:

```sh
LC_ALL=C LANG=C MEDIA_CLOUD_INCLUDED_QUOTA_CONFIRMED=5-minutes MEDIA_CLOUD_APP_TRIAL_APPROVED=true node scripts/verify-media-cloud-revocation.ts --execute-app
```

The command exited zero. The [actual result](acceptance.json) records
`4b880918934f8be0060f260392ea29f0601a01e9` with the uncommitted helper extension;
its exact helper, compiled application and SDK hashes define the tested source.
No application source was changed during this trial.

Two genuine local application cookies authenticated against a new disposable
PostgreSQL cluster. Normal HTTP Sign out rejected both cookies and queued the
tracked speaking grant in the same transaction. A separate runtime database
pool processed that durable job through the actual Cloud provider. Cloud
disconnected the speaker and rejected both its original token and a genuine
server-refreshed token with HTTP 401. Both tokens had connected successfully
before logout. The independent public viewer stayed connected and reconnected
with its original view-only token.

The room expired automatically. The Cloud portion lasted 51.406 seconds with
at most two simultaneous clients. Conservative rounded usage, including
disconnect grace, was 90,000 participant-milliseconds for this trial and
90,000 for the preceding trial: three minutes total, below the five confirmed
included minutes. No microphone, camera, track publishing, recording, egress,
room-deletion API or paid plan change was used.

This combines actual application HTTP authorization, PostgreSQL transactions,
cross-pool processing and hosted Cloud signaling. The identities and assigned
speaker/device-check records were isolated local fixtures. It is not a genuine
hosted Privy login, hosted database, physical-device, screen-reader or audiovisual
quality test. No retained account or hosted application identity was changed.

The earlier `--verify-app` preparation command also exited zero, with two
rejected cookies and one completed durable job, but simulated the provider
removal and made zero external calls. That preparation alone is not Cloud
acceptance. The original [provider-only trial](../media-cloud-revocation/README.md)
retains its separate failed initial cleanup deadline and successful postflight;
this later success does not rewrite that history.
