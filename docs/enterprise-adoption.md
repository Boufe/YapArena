# Enterprise adoption checklist

This template supplies professional application and delivery foundations. It does not make a generated
service enterprise-grade by itself. Record owners and evidence for every applicable item.

Terms used below: **RPO** is acceptable data loss, **RTO** is acceptable recovery time, **SLO** is a
measurable reliability target, and an **error budget** is the tolerated amount of SLO failure.
General repository, container, and release terminology is defined in the [glossary](glossary.md).

## Platform and reliability

- [ ] Managed runtime, DNS, TLS, load balancing, and availability design — remove single-host failure
      points and document how traffic survives faults.
- [ ] Managed PostgreSQL encryption, backups, restore tests, replicas, and documented RPO/RTO — prove
      how much data and downtime the product can tolerate.
- [ ] Central secret management and credential/key rotation — limit secret exposure and replace
      credentials without rebuilding source.
- [ ] Infrastructure as code and isolated development, staging, and production environments — make
      infrastructure reviewable and prevent test activity from affecting users.
- [ ] Capacity, load, resilience, and failure-injection tests against explicit targets — demonstrate
      behavior at expected load and during dependency failures.
- [ ] Deployment approvals, health gates, rollback, and—where justified—progressive delivery — stop
      unhealthy releases and constrain their blast radius.

## Security and operations

- [ ] Product authorization model, privileged-operation audit trail, and periodic access review —
      enforce who may do what and retain evidence for sensitive actions.
- [ ] Product threat model, abuse controls, security review, and penetration testing — identify likely
      attacks and validate defenses beyond automated scanning.
- [ ] Central logs, paging integration, traces, dashboards, SLOs, and error-budget ownership — detect,
      diagnose, and prioritize reliability problems using shared targets.
- [ ] Dependency and license policy plus image-signature/provenance verification during admission —
      reject unapproved code, licenses, and artifacts before runtime.
- [ ] Incident response plan, exercises, escalation contacts, and post-incident process — make response
      roles and learning repeatable under pressure.
- [ ] Privacy classification, retention/deletion policy, regulatory mapping, and user-data procedures —
      collect only justified data and handle it according to legal and product commitments.

## Prediction-market products

A play-money market can build on this service after adding market, outcome, pricing, position,
resolution, fraud, and real-time domains. Real-money functionality requires jurisdiction-specific legal
approval before implementation. It may implicate gambling, derivatives, payments, custody, KYC,
sanctions, taxation, and geographic restrictions.

Represent monetary value with exact units and an append-only double-entry ledger. Require idempotency,
transactional invariants, immutable audit records, and reconciliation. Never implement money as a
mutable `users.balance` field.
