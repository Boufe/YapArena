# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest released major version.

This narrow support window keeps remediation expectations explicit; generated products should widen
it only when maintainers can test and release every supported line.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature under **Security → Advisories → Report a
vulnerability**. Do not include exploit details, credentials, personal data, or production URLs in a
public issue.

Include affected versions, reproduction conditions, impact, and any suggested mitigation. A
maintainer should acknowledge the report within three business days. Response and disclosure timing
depends on severity and whether downstream users need time to update.

Generated projects must replace this contact and response policy with one their maintainers can
actually operate.

## Current security work and evidence

The [implementation status](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence)
links the merged authentication, logging and database work. Use the current
[session revocation](docs/security/account-session-revocation.md),
[wallet authorization](docs/security/wallet-authorization.md) and
[database isolation](docs/security/database-isolation.md) contracts when operating this service.
Dated handoffs preserve original findings and test results; a merged fix does not close the
remaining hosted API isolation, historical-log exposure, credential-rotation or provider-grant
incident checks. Keep incident evidence private under the reporting procedure above.
