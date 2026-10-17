# Slow scrolling ticker

The public ticker displays every homepage idea in a seamless right-to-left strip.
All internal separators are removed, including mobile row borders. The navy,
mint/coral values and existing selection action remain. The populated strip moves
at about 24px/second; loop duration adjusts to its measured width. Hover, focus,
the existing pause control, hidden tabs and leaving the viewport stop motion.
Reduced motion exposes one native horizontally scrollable copy. Empty/single-item
feeds stay static. The original gated reference preview remains unchanged.

Original buttons provide keyboard access; visual repeat spans are hidden from
assistive technology and remain clickable. Focus reveals an offscreen entry.
The ticker retains its progress through resizing and data replacement, deferring
replacement while hovered/focused. It uses one CSS transform animation, the
existing observer/lifecycle cleanup and no additional requests or timers.

[Desktop](ticker-1440.png) and [mobile](ticker-390.png) captures use a local render
of the read-only public staging feed, frozen partway through the strip. The
[320px test capture](ticker-320.png) uses local public-record fixtures.
[Browser results](evidence.json) passed all 18 groups: direction/speed, equal
repeat widths (within Chrome subpixel precision), hover/resume, keyboard reveal,
clicks on visual repeats, borders/overflow at 1440/390/320px, explicit pause,
offscreen suspension and reduced motion, plus all prior homepage checks.
The six-width original reference comparison remains unchanged. No captured errors
or axe A/AA violations occurred in the suite's audited homepage states.

Node 24 build/check passed: 502 tests, zero failures/skips, 94.51% line, 93.11%
branch and 95.79% function coverage. Fresh/upgrade SQL isolation and
`git diff --check` passed. No schema, data, dependency or media changes were made.
The PR records CI and exact staging deployment. Hosted manual acceptance remains
with the user.
