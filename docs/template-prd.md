# Production Service Template PRD

This document records the reusable backend template and its original acceptance criteria. It is
not YAP Arena's product specification. The [YAP Arena product PRD](product-prd.md) governs product
behavior and first-release scope; its [companion outlines](product-specification-outlines.md)
track unresolved financial designs and evidence required before accepting real funds. References
below to a play-money template example do not define or stage YAP Arena's planned paid release.

## Status

- Owner: repository maintainers
- Product: reusable Node.js/PostgreSQL production-service template
- Reference implementation: YapArena
- Source requirements: enterprise-readiness, golden-path automation, and prediction-market foundation
- Delivery rule: every in-repository acceptance criterion must be implemented and verified before this
  transformation is considered complete

Checked acceptance criteria describe repository evidence, not hosted-product certification. External
adoption gates remain the responsibility of each generated service because its provider, risk, and
legal context determine how those controls are implemented.

This is the product-requirements record for the template rather than a setup guide. Start with
[Getting started from the template](getting-started.md) to create a project, and use the
[glossary](glossary.md) for unfamiliar Git, container, database, CI, and release terms.

## Problem

YapArena proves a professional production workflow, but it still contains product-specific identity,
an example message domain, and deployment assumptions. Starting another service from it would require
manual renaming and rediscovery of security, CI, release, monitoring, and operations decisions.

The repository should become a repeatable golden path: a developer creates a repository from the
template, runs one initializer, implements domain behavior, and inherits tested production defaults.

## Goals

1. Preserve a working reference API while making the platform mechanics reusable.
2. Make project identity and local infrastructure configurable without global search-and-replace.
3. Provide a deterministic initializer and an end-to-end getting-started path.
4. Strengthen reusable application security and lifecycle behavior.
5. Keep CI, container publishing, monitoring, and deployment provider-neutral.
6. Document the difference between repository readiness and full enterprise readiness.
7. Make the generic foundation suitable for ordinary SaaS products and a play-money
   prediction-market example; YAP Arena's product scope is defined separately.

## Non-goals and external adoption gates

This repository cannot by itself deliver or certify:

- managed hosting, DNS, TLS termination, load balancing, multi-region availability, or autoscaling;
- managed secrets, key rotation, managed PostgreSQL replicas, or provider backup guarantees;
- centralized log storage, paging delivery, distributed tracing backends, or production SLO evidence;
- legal authorization for gambling, derivatives, custody, payments, KYC, sanctions, or tax workflows;
- penetration-test results, compliance certification, staffing processes, or incident exercises;
- product-specific authorization, retention, threat models, capacity targets, or recovery objectives.

Each generated product must resolve these gates according to its risk, jurisdiction, and operating
environment. Documentation must never imply that using the template alone makes a product
enterprise-grade or legally suitable for real-money markets.

## Users and primary workflow

The primary user is a developer or small team starting a Node.js/PostgreSQL service:

1. Create a repository from this GitHub template.
2. Run the project initializer with a name, description, owner, database name, and local ports.
3. Install dependencies and start PostgreSQL.
4. Run migrations and the quality gate.
5. Replace or extend the isolated example feature.
6. Open a pull request and let CI validate code, containers, monitoring, and deployment configuration.
7. Tag a reviewed main commit and publish an immutable multi-platform image.
8. Apply migrations separately and deploy the exact image digest.

## Functional requirements

### FR1 — Configurable identity

- Compose project, local image, database, monitoring display names, CI image names, and documentation
  must derive from documented placeholders or initializer inputs.
- Release publishing must continue deriving its GHCR path from `GITHUB_REPOSITORY`.
- No generated project should require editing package lockfile integrity data by hand.

### FR2 — Deterministic initializer

- A dependency-free script must support non-interactive flags and an interactive/default path.
- It must validate project slug, npm package name, database identifier, GitHub owner, and port values.
- It must update all declared identity locations, be safe to run once, and refuse ambiguous reruns.
- It must provide an explicit, tested initialization path and document safe example-feature removal
  before or after migrations have been applied.
- Automated tests must exercise initialization in a temporary copy and verify no template tokens remain.

### FR3 — Platform and example boundaries

- Reusable concerns must live under an explicit platform boundary.
- The message domain must live under an explicit example-feature boundary.
- Application composition must inject repositories and policies so product domains can be replaced.
- Existing API behavior and database migration history must remain valid for the reference app.

### FR4 — Security defaults

- Authentication endpoints and the general API must have separately configurable rate limits.
- Cookie-authenticated unsafe requests must enforce a documented CSRF origin policy in production.
- Trusted-proxy behavior must be explicit and disabled by default.
- Request size, session duration, rate limits, and allowed application origin must be validated config.
- Session storage must support expired-session cleanup, with a bounded scheduled maintenance loop.
- Security behavior must have automated tests and fail closed on invalid production configuration.

### FR5 — Lifecycle and database safety

- Startup must verify database connectivity and migration currency before accepting traffic.
- Shutdown must stop accepting traffic, stop maintenance work, close the database pool, and have a
  bounded forced-exit path.
- Startup and graceful shutdown orchestration must be testable without importing a process-owning
  module.
- Migrations remain a separate release step; application startup must never mutate schema.

### FR6 — Golden-path automation

- CI must validate formatting, lint, coverage, container build/security, monitoring, deployment config,
  and initializer behavior.
- Workflow actions and container tools must be pinned or versioned with an explicit update policy.
- Release must publish AMD64/ARM64 images with provenance, SBOM, semantic-version tag, commit tag,
  and immutable digest summary.
- The reusable workflow boundary and extension points must be documented.

### FR7 — Governance and onboarding

- Include getting-started, contribution, security-reporting, pull-request, issue, ownership, and license
  assets suitable for a template.
- Document recommended GitHub branch protection, environments, permissions, and secret setup.
- Document how to replace the example feature and where product-specific decisions belong.
- Document enterprise gaps, adoption checklist, and prediction-market-specific cautions.

### FR8 — Provider-neutral operations

- The base release must target an OCI registry and the deployment contract must consume a digest.
- Single-host Compose remains a reference deployment, clearly labeled as such.
- Provider integrations must be optional extensions, not requirements of the base template.
- Secrets must not be committed or emitted by bootstrap and operational tooling.

## Quality requirements

- Node.js 24 and locked npm dependencies.
- Existing coverage thresholds remain at least 90%; changed application code receives direct tests.
- Production containers run as a non-root user with a read-only filesystem and dropped capabilities.
- Logs remain structured and redact credentials.
- Metrics use bounded-cardinality labels.
- Documentation commands are copyable and use placeholders where secrets are required.

## Prediction-market suitability

The generic template may host a play-money prediction-market MVP after adding product-specific markets,
outcomes, positions, pricing, resolution, audit, and real-time behavior. Real-money use is explicitly
outside the template's assurances. Any monetary implementation must use an append-only double-entry
ledger, exact numeric representation, idempotency keys, strict transactions, reconciliation, and
jurisdiction-specific legal review; it must never rely on a mutable `users.balance` field.

For YAP Arena, the [product PRD](product-prd.md) specifies a combined first paid release with two
real-money crypto markets. This template's example does not replace that decision or satisfy its
release gates.

## Acceptance criteria

- [x] Identity is configurable and a tested initializer produces a renamed working project.
- [x] Platform and example-feature boundaries are explicit and existing behavior passes tests.
- [x] Global/auth rate limits, CSRF origin enforcement, trusted proxy, and config validation are tested.
- [x] Session cleanup and testable startup/shutdown lifecycle are implemented.
- [x] Startup rejects an unavailable or migration-stale database without applying migrations.
- [x] CI/release/deployment/monitoring assets are generic and validated.
- [x] Governance and template onboarding files are complete and internally consistent.
- [x] Enterprise and prediction-market adoption boundaries are documented without overclaiming.
- [x] `npm run check`, initializer integration tests, Compose validation, container build, and smoke
      tests pass.
- [x] A final repository search finds no unintended hardcoded personal owner, deployment digest,
      credential, or machine-specific path.

## Completion evidence

The implementation PR must link test output and note any external adoption gates. After merge,
maintainers must configure the GitHub settings in [Getting started](getting-started.md#8-configure-github),
enable **Template repository** if this repository will be used as a template, and verify one real
release run before claiming that publishing works end to end.

Implemented evidence:

- Root and freshly initialized `forecast-lab` copies each pass 67 tests and the configured coverage
  thresholds; the root application reports 99%+ line coverage and 100% application function coverage.
- Both development and production Compose contracts render successfully before and after initialization.
- The production image builds, starts against the real migration history, becomes healthy, and reports
  zero fixable HIGH or CRITICAL vulnerabilities with the CI-pinned Trivy scanner.
- `actionlint` validates all workflows, including the reusable quality workflow and Node.js 24 Docker
  release actions.
- The generated project test proves npm/package, Compose, database, metric namespace, monitoring, and
  repository-owner identity changes remain internally consistent.
