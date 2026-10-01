# Community local trial — 2026-10-01

The Work Package 5 implementation was exercised against local PostgreSQL and the local Docker
app. Synthetic accounts and event records were removed after the browser run. The test event
had no media provider, so this record verifies media-independent community behavior only.

- PostgreSQL integration: concurrent posts allowed one message under the ten-second account
  limit; repeated likes stayed at one per account; duplicate and sixth reports were blocked;
  chat removal hid the public message while private evidence retained its text; independent
  appeal review restored it; restriction and event chat pause blocked only the intended
  community writes. The event remained `live` with its original rules snapshot.
- Headless Chrome desktop: registered and published profiles, posted chat, received a rate-limit
  message, liked an event, reported chat and the event, reviewed the case as a moderator,
  removed the message, submitted an appeal, and restored the message through a different
  moderator. The QR SVG and overlay routes loaded from the canonical event URL.
- Phone-sized Chrome viewport (390 × 844): the event page had no horizontal overflow and the
  community controls stacked into one column. axe-core WCAG 2/2.1 A and AA checks found no
  violations in the community section at desktop or phone width, or in the moderator main
  content. This is an automated scan, not a physical-device or screen-reader review.

Visual evidence: [desktop event](evidence/community-desktop.png),
[phone-sized event](evidence/community-mobile.png), and
[moderation queue](evidence/community-moderation.png). Screenshots contain only synthetic text.

Still open: staging use on desktop and physical mobile browsers, keyboard and screen-reader
review, QR scanning with a phone, link previews in sharing apps, overlay compositor checks,
moderation volume/latency, the privacy retention review, and the separate measured media trial
in [the media report](media-trial-report.md#work-package-5-readiness-gate). No production
readiness claim follows from this local trial.

## Live chat follow-up — 2026-10-01

The watch page now places chat beside video on desktop and directly below it at phone width.
In a local two-viewer browser run, a sent message appeared in the other desktop session and
the phone viewport without either page refreshing. The sender saw an inline rate-limit error
and retained the unsent draft. After one viewer went offline, messages arrived in order on
reconnect without duplicate IDs. A 55-message backlog was drained across two sync pages;
the reader could stay scrolled up and use **Jump to latest**. Moderator removal, appeal
restoration, chat pause, and resume were reflected in both open viewers. The watch and chat
area and the community section passed axe-core WCAG 2/2.1 A/AA checks at both sizes, with no
horizontal overflow at 390 × 844.

The first run found that the general API limit was consumed by live polling and that the
chat form remained visually displayed during a pause because of a CSS rule. Both were fixed
before the successful repeat. The screenshots above now show the updated watch/chat layout.
This remains a local Chrome trial; physical mobile, screen-reader, and staging multi-viewer
checks are still open.
