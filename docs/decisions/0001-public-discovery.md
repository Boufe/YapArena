# 0001 — Public discovery delivery

Status: implemented for work package 1; performance and accessibility targets still need product approval.

## Decision

Serve the initial public pages as HTML from the existing Express service, alongside a read-only
`/api/public` JSON contract. Use a small CSS system and progressive enhancement for the offline
message. Keep the page shell useful without JavaScript. This avoids a second runtime and makes
public content and canonical links available on the first response.

Only records marked `published` are returned. Debate read models select named public fields and
do not join to future market data. Public HTML and JSON use `Cache-Control: no-store` so a hidden
record stops being served as soon as the origin applies a moderation change. Static assets can
be cached. Introduce shared caching only with a tested invalidation path for publication changes.

## Verification and follow-up

The repository quality gate covers routes, filters, pagination, escaping, and public field
selection. CI migrates PostgreSQL, seeds demo records, and checks the served page and API.
Representative-data query plans, p95/p99 latency budgets, browser accessibility review, mobile
layout review, and visual QA remain release checks before public availability. The initial demo
data is only for development and never authorizes real event or financial behavior.
