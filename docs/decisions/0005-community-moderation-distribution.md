# Decision 0005 — Community, moderation, and distribution

Status: development policy for Work Package 5. Product and privacy review remain required before
production rollout. No financial or sponsor behavior is authorized by this decision.

## Boundaries and roles

- A signed-in `participant` may post event chat, like an event once, report public chat or an
  event, and appeal an action affecting their own chat or account. Guests may read visible chat
  and share published event links. Profiles are not required to read, like, or report, but a
  published profile is required to post chat so public authors have an accountable identity.
- A `moderator` may read the private case queue and evidence, dismiss a report, remove a chat
  message, restrict the subject account's community writes for seven days, or pause an event's
  chat. Moderator actions require a reason code and an explanatory note. An appeal must be
  decided by a different moderator. A moderator cannot moderate their own content or case.
- An `operator` controls the debate media lifecycle under decision 0004. Moderator actions
  change only community records. They cannot start, end, void, finalize, or decide a debate,
  publish a winner, or change any future market settlement input.

Roles are assigned through the existing reviewed account-role procedure; there is no public
role-grant endpoint. All permissions are checked by the API for each request. UI visibility is
only a convenience. The case queue contains private reports and is never in public APIs.

## Content, reasons, and transitions

Chat is available only for published, non-demo events while `live`; after the debate it is
read-only. Moderators can pause chat for an event without pausing its video or clock. Chat text
is plain text, 1–500 characters, with no links rendered as HTML. A post is `visible` or
`removed`. Removal hides it from public reads immediately but preserves its original text and
author in the private case evidence until retention expires. A restored post returns to
`visible`; no user edit or self-delete flow is provided in this package.

Reports target a chat message or event. The reporter chooses one of `harassment`, `hate`,
`threat`, `spam`, `privacy`, or `other`, and adds 10–500 characters of context. One account can
report the same target once. Cases start `open` and end `dismissed` or `actioned`. The moderator
records one of the same reason codes and an action-specific note of 10–500 characters.
`remove_chat` applies to chat reports; `restrict_account` applies to a chat author;
`pause_chat` applies to event reports. `dismiss` changes no public state. An actioned case
cannot be acted on again.

The affected chat author or restricted account can appeal once within 30 days of action.
Appeals start `open` and end `upheld` or `overturned`. An overturn restores only the content or
restriction applied by that case, so it cannot undo a later independent action. The appeal
reviewer must be a different moderator from the initial reviewer and cannot be the appellant.
Event chat pauses are operational and may be resumed by a moderator with a case note; they do
not create an individual appeal right. Case and appeal decisions append immutable audit events.

## Abuse, retention, and release

Server-side account locks serialize community writes, including concurrent requests. Chat is
limited to one post per 10 seconds and 30 per hour per account. Reports are limited to five per
24 hours. Likes use idempotent add/remove operations, a unique account/event key, and at most
ten actual like-state changes per hour per account; repeat requests that change no state do not
consume the allowance. A
restricted account cannot post, like, or report until the restriction expires or is overturned.
Global API and origin protections also apply; they do not replace account limits.

Visible chat, likes, resolved cases, appeals, and their audit events are retained for 365 days.
Open cases and appeals are held until resolved; the hourly cleanup then purges eligible older
records. Operators must export a redacted case summary before expiry if a longer legal hold is
approved. Do not put private case text, signed replay URLs, or account identifiers in public
share metadata or overlays.

Event links, QR codes, Open Graph metadata, and overlays use only the published proposition,
topic, speaker display names, schedule, and event status. They expose no chat count, likes,
reports, score, hidden tally, winner, sponsor, or financial field. Visible engagement is not
official event support. QR generation is server-side from the canonical event URL only, never
from a caller-supplied URL.

Before production use, finish the measured desktop/mobile trial in the media report, test
moderation operations with real browsers, review privacy retention with counsel, and set an
accessibility target. Staging may use test accounts and non-sensitive test content while these
gates remain open.
