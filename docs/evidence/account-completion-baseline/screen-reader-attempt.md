# Native screen-reader attempt — incomplete

On 2026-10-20 the browser verifier attempted macOS VoiceOver against the public
staging login journey. This was separate from the completed automated Axe,
keyboard, zoom and browser accessibility-tree checks.

The verifier enabled VoiceOver through System Settings. Subsequent access to
the VoiceOver application was rejected by automatic approval review:
“Computer Use was not approved to use VoiceOver.” No spoken output or caption
output was inspected, so this is **not screen-reader acceptance**.

A subsequent System Settings accessibility-tree read reported the toggle off.
That read did not establish the actual operating state: the user reported that
VoiceOver remained active. The verifier immediately stopped all native browser
and system interaction and notified the lead. The lead's subsequent attempt to
open System Settings was also rejected by automatic approval review. After
explaining the temporary-test intent, the lead stopped changing the setting;
the final operating state was not established. The verifier must not treat a toggle's reported
value as proof that a running screen reader has stopped.

No physical-device, VoiceOver, NVDA or TalkBack pass is claimed. A human
screen-reader trial or separately approved access to the screen-reader app
remains necessary. No credentials, codes, private keys or provider identities
were entered during this attempt.
