# Manual argument scrolling

Hover still pauses the argument stream. Mouse-wheel and trackpad input now seek
the existing CSS animation in either direction, wrapping through its two seamless
copies. Leaving resumes at that position, without another timer or resetting the
stream. The keyboard-focusable viewport also supports arrows, Page Up/Down and
Home/End. Focus and explicit pause retain their previous behavior. Reduced motion
still reveals the full list without automatic movement. Ctrl-wheel zoom is not
intercepted. No layout, source data or chart behavior changed.

The [browser results](evidence.json) passed all 17 groups, including wheel
displacement in both directions, line-based wheel input, no page scrolling,
continuous resume, keyboard exploration and seamless wrap without extra copies.
The [paused panel capture](manual-argument-scroll.png) shows its manually inspected
position. Existing six-width reference geometry is unchanged; there were no
captured errors or axe A/AA violations. Trials use the original reference dataset
and local public/auth fixtures, not hosted accounts or media sessions.

Node 24 build/check passed with disposable PostgreSQL identities: 502 tests,
no failures or skips; 94.50% line, 93.22% branch and 95.78% function coverage.
Fresh/upgrade SQL isolation and `git diff --check` passed. The PR records CI and
the exact staging deployment; hosted manual acceptance remains with the user.
