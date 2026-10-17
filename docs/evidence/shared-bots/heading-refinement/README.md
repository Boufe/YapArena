# Homepage heading and question titles

The public `/` page removes the visible `.ya-heading` block. The carousel and
idea grid keep their existing widths, gutters and component arrangements. The
normal content padding remains. An invisible semantic `h1` preserves the page's
accessible heading. The separately gated original reference preview is unchanged.

Homepage tile, ticker, trending and expansion titles use the first associated
published debate's question, falling back to the topic title only when no debate
exists. IDs, canonical links, follows and synthetic activity remain attached to
the same records; no database records were renamed.

The [desktop before](before-1440.png) and [after](after-1440.png), and
[mobile before](before-390.png) and [after](after-390.png), use read-only public
staging data rendered locally. [Measurements](evidence.json) confirm identical
grid/panel widths, no overflow, question titles throughout, and content moving
up 73.89px at 1440px and 55.52px at 390px. Captures freeze carousel/argument motion.

Node 24 build/check passed: 502 tests, no failures or skips, 94.50% line, 93.22%
branch and 95.78% function coverage. Fresh/upgrade PostgreSQL isolation passed.
The existing six-width reference and real-homepage browser suite passed all 16
groups, including interactions, no-JavaScript question links, absence of the public
heading block, unavailable states, CSP and accessibility. Reference geometry
remains unchanged. Hosted acceptance stays the user's manual test; the PR records
the exact staging deployment.
