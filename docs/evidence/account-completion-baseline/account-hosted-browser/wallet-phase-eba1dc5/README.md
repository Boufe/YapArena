# Hosted guest acceptance at eba1dc5

Actual named staging web trial, 2026-10-21 22:09 UTC. The lead separately
confirmed terminal Render LIVE at exact
`eba1dc5cfe6680a9a41e98482b64d3c725163a1b`; the replay worker remains at
`fd60543`. See the [control-plane report](../../embedded-wallet-release/render-account-inspect.json).

The maintained guest browser verifier passed **seven groups**, including all
**14 served asset matches**, health/readiness, actual public provider metadata,
private API denial, real SDK initialization, desktop/mobile layout and dialog
focus, and one guarded retired-registration request through Redis. See
[the actual result](acceptance.json). No email code, OAuth or passkey ceremony,
account creation, financial action or media connection was performed.

The [wallet endpoint supplement](embedded-wallet-anonymous.json) made one GET
without credentials: 401, private/no-store, Vary Cookie, no Set-Cookie and only
the exact anonymous error. It exposed no wallet state. Its deployment gate is
the paired actual Render LIVE evidence, not an asserted server revision header.

The six images use the same guest journeys and desktop/mobile viewports as the prior
[d6e2d35 trial](../d6e2d35/acceptance.json). The lead visually compared both
desktop account images and the new mobile account image: shared theme, layout
and single passkey sign-in entry are preserved. This guest comparison does not
establish signed-in wallet, genuine recovery, physical-device, screen-reader
or full WCAG conformance. Signed-in wallet fixtures retain their separate
[synthetic browser evidence](../../embedded-wallet-browser/README.md).

Actual provider wallet inspection remains separately recorded as
[PENDING credential verification](../../embedded-wallet-release/provider-wallet/README.md),
with no ownership or creation acceptance implied by these guest results.
