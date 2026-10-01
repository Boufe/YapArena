# Community operations

This runbook covers Work Package 5 community behavior in a local or test environment. Follow
[decision 0005](decisions/0005-community-moderation-distribution.md) for roles, reason codes,
content states, retention, and appeal rules. This package does not authorize sponsor or financial
features. The [media readiness gate](media-trial-report.md#work-package-5-readiness-gate) remains
open; no production rollout is approved by these checks.

## Rollout and access

Apply `1785924000000_add_community_moderation.js` after the earlier migrations and before
serving the new app. The migration adds community tables and indexes without rewriting earlier
records. It enables row-level security on the new tables. Keep Supabase's Data API disabled as
documented in [Render staging](render-staging.md); do not grant `anon` or `authenticated`
direct table access. The app uses its server-held PostgreSQL connection and checks authorization
on each request. The existing global API limit and production origin check also apply.

Assign `moderator` through the reviewed account-role procedure. Keep at least two moderators so
an appeal can be decided by someone other than the first reviewer. An `operator` role is for
debate media actions; it grants no case-review permission. Remove a moderator role through the
same procedure when access ends. Audit identity-role changes using `identity_audit_events`.

On rollback, redeploy the previous app image while retaining the additive community tables.
Review any cases and appeals created after the rollout before restoring an older image, because
it will not provide their review UI. Do not drop the migration as a rollback step. The old
discovery code may display legacy sponsor data; keep sponsor records empty while sponsor
identification is deferred.

## Participant and moderator journeys

1. Open a published event page. Guests can read visible chat, copy the canonical event link,
   open its QR code, and load `/overlay/<event-slug>` for a basic broadcast title card. The
   overlay contains no likes, chat counts, score, sponsor, hidden tally, or result.
2. A signed-in participant with a published profile can post plain-text chat while the event
   is live and chat is open. Any participant can like a published event once. The page labels
   these as visible interest, not official support. A guest or restricted account sees a clear
   sign-in or restriction error for writes. Chat becomes read-only when the event leaves `live`.
3. A participant reports a chat message or event with a reason and context. The report is
   private and appears in `/account/moderation`. Repeat reports for the same target return a
   conflict; more than five reports in 24 hours return HTTP 429. More than ten actual like-state
   changes in an hour also return HTTP 429; repeating the current like state is idempotent.
4. A moderator opens `/moderation`, reviews the target and private report context, and records
   a reason and note. The available actions are dismiss, remove chat, restrict a chat author
   for seven days, or pause event chat. Chat removal hides the message publicly while the
   original remains in private evidence and the audit trail records the transition. A pause
   affects chat only, never the event clock or video. Reporters and affected chat authors
   receive an account notification. Select the Actioned filter and use the active pause case
   to resume chat with another note. A moderator participating in the event cannot resume it.
5. An affected chat author visits `/account/moderation` and may appeal a removal or account
   restriction once within 30 days. A different moderator reviews the open appeal. Overturning
   a removal restores that case's message; overturning a restriction revokes that case's
   restriction. Upholding it leaves the action in place. The appellant receives an account
   notification. A repeated or late appeal is rejected.

Case and appeal decisions are serialized by database row locks. Account writes use a per-account
transaction lock, so parallel chat, like, and report requests cannot bypass account limits.
The moderator API has no event-result or future-settlement method.

## Failure handling and retention

- HTTP 401 means sign in. HTTP 403 means the role, profile, self-review, or active restriction
  disallows the action. HTTP 404 hides a nonpublic event or missing target. HTTP 409 means the
  state changed or a duplicate request already exists. HTTP 429 means the account limit is
  reached; wait for the stated window. On HTTP 5xx or network failure, refresh state before
  retrying a decision. A retry never applies a case action twice.
- Triage urgent threats or privacy reports from the open queue first. Preserve the case ID,
  UTC times, reason, reviewer, and redacted request logs for an incident. Do not paste chat
  content or personal details into public issues or screenshots. If chat itself is unsafe,
  pause chat through an event report; the moderator cannot pause the media clock.
- The hourly maintenance job prunes resolved cases and associated appeals/audit after 365
  days, then old chat, likes, and like-change records after 365 days. Open cases or appeals hold their targets until
  review completes. The job logs failures and retries at the next interval. Before a longer
  legal hold is approved, export only a redacted case summary through the approved private
  process; there is no public export endpoint.

## Verification

Run `npm run check` and the PostgreSQL integration exercise in the CI integration job. Locally,
after starting PostgreSQL and applying migrations, run `node scripts/verify-community.js` with
the local `DATABASE_URL` set. The exercise creates and removes synthetic users and a synthetic
event. It checks concurrent posts and likes, report limits, removal, preserved private evidence,
restriction, pause/resume, appeal independence, and no change to event status or rule snapshot.

For a local browser trial, start the app and run:

```sh
BROWSER_DATABASE_PORT=55433 node --env-file=.env scripts/verify-community-browser.js
```

Set `BROWSER_BASE_URL`, `BROWSER_DATABASE_PORT`, `BROWSER_CHROME_PATH`, and
`BROWSER_ARTIFACT_DIR` if your local ports or Chrome path differ. The script refuses a nonlocal
database, registers synthetic test accounts, grants temporary moderator roles, exercises chat,
likes, reports, removal, appeal, and restoration, scans the new UI with axe-core, checks mobile
overflow, and removes its fixture. It saves screenshots to `/private/tmp` by default. It tests
responsive layout at a phone-sized viewport; it does not stand in for physical-device media,
touch, screen-reader, caption, or replay testing.

The [local browser trial record](community-trial-report.md) contains the observed results and
screenshots. Repeat the community journey with staging test accounts on desktop and mobile
devices before promotion. Verify keyboard focus, screen-reader announcements, touch targets,
chat reconnect behavior, moderation queue latency, QR scanning, Open Graph previews on the
target sharing apps, and overlay legibility in the broadcast compositor. Record any failures
and the deployed commit. Complete the separate measured media trial before calling the full
package production ready.
