# One Privy credential: installed SDK, native browser and real PostgreSQL

The actual maintained verifier exited **0 with all 18 groups passing and no
page/backend errors**. See [terminal output](output.txt),
[the acceptance boundary](acceptance.json) and
[source, generated-asset and executed-runtime hashes](results.json).
The latest run completed at **2026-10-21 15:02:36.654 UTC**, with checkout
`43cc9a0` and the exact saved source/asset/dist hashes. The application assets stayed frozen throughout; only the operational verifier was corrected. All recorded hashes still matched in [the post-run comparison](source-verification.json).

The desktop journey uses the installed Privy SDK's dedicated linking hook to
register exactly one Chrome virtual credential. The intercepted synthetic
provider verifies the actual registration response and exposes the derived COSE
public key. The real YapArena authentication router provisions the account; the
real bridge verifies a fresh native assertion from the same credential and
atomically activates it in the runtime-role PostgreSQL database. Mobile instead
starts with one prelinked native fixture credential and finishes its activation
without registering another key. Both journeys then use that same credential for
an amount/asset/destination-bound proof, reject replay and cross-account
completion, rotate the local cookie, reject self-authorized removal and create
no extra user or payment.

The existing 14 native legacy-key/recovery groups remain. Their legacy keys are
prepared through explicitly labelled fixture-only native ceremonies and real
backend authorization; the removed separate-key enrollment UI is not claimed.
Current generated controls still exercise retained-key removal, cancellation and
focus. Funded synthetic-account recovery preserves identity/profile/source
balances and permanently fences the old DID. Real SQL rejects wrong, expired,
revoked or unconsumed proofs. Old-subject jobs and callback replays remain denied.

Matching [desktop before](provider-desktop-before.png) /
[after](provider-desktop-after.png) and
[mobile before](provider-mobile-before.png) /
[after](provider-mobile-after.png) images were visually inspected. They are
explicit minimal SDK-island fixtures, not complete production-account layout
parity evidence. Because this page intentionally omits `account.ts`, it supplies
the controller's comparison hint only after an actual successful
cookie-authenticated `/me` response. The backend independently derives ownership
from its original session and never trusts that browser hint.

Three earlier nonzero attempts are preserved as named screenshots and private
logs. They found fixture assumptions: an old account-controller success message,
the omitted minimal-page session comparison hint, and an obsolete expectation of
an extra Privy modal. The actual SDK link response was corrected to its installed
contract: a raw user, rather than a session envelope. No application authorization
check was relaxed. The final run does not leave a misleading `failure.png`.

These fixtures intercept provider OTP, user and token responses; they do not
verify real Privy tokens or enroll a real provider identity. Actual selected-app
public-key export, RP compatibility and genuine returning login remain separate
acceptance gates. Virtual CTAP2 is not physical-device or screen-reader evidence.
Public app metadata is the only real provider read. No hosted database, live
fund, external transaction or native OS setting was changed.

An earlier 18-group run revealed a stale initial load-error notice after
authentication. The final rebuilt run verifies its correction, the Settings
status “Ready for sign-in and account approvals”, and absence of the empty or
provider-only legacy key section. Explicit fixture-created legacy keys still
expose their retained management controls. Current desktop/mobile after images
were visually inspected and show the readable single-key status without the
stale notice. Earlier results remain in commit `ac59dc0`.

The executed asset/dist hashes govern runtime scope; source hashes were observed
when this report was written. This native verifier does not exercise the new
expired-first-setup restart endpoint. Its ten real-PG cases, and the own-reset
monitor failure cases, passed separately in the complete R2 gate (198 account
cases on each fresh/upgrade path). None of these results is genuine provider,
hosted, physical-device or screen-reader acceptance.

The current run adds a faithful fixture worker boundary after credential
rotation. The minimal page does not start the web service's provider drain, so
the real durable revocation repository now runs as an explicit fixture step
with synthetic freeze/unfreeze responses. The verifier asserts the completed
job and synchronized generation, then refreshes through actual authenticated
requests before retaining every ready-state, proof, replay and cancellation
assertion. Expected provider-unavailable responses map to 503 as in production.
No authentication monitor, phase fence or application code was relaxed.

Three nonzero attempts are preserved in
[the labelled fixture triage](reset-drain-fixture-triage/README.md): missing
normal reset draining, a verifier barrier expecting 204 where the real route
returns 200, and the same missing drain after legacy fixture rotations. These
are local harness failures, not evidence of another genuine Privy failure.
