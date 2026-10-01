# Enterprise adoption checklist

The current backend supplies professional application and delivery foundations. It does not make
YAP Arena production-ready by itself. Record owners and evidence for every applicable item. The
[product PRD](product-prd.md) defines the intended product, and the
[release evidence checklist](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds)
defines additional gates before accepting real funds.

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

## YAP Arena financial-product gates

The planned first paid release includes both the real-money debate-event market and continuing
ideas market. Reversible prototypes and simulations can proceed while specifications are settled;
they do not authorize real-fund activation. The event market needs approved paired-collateral,
fee-reserve, refund, and hidden-tally designs. The ongoing market needs a defined instrument,
holder rights, issuance, liquidity, and exit rules. Both markets must pass the companion evidence
checklist together before paid access.

- [ ] Obtain written, structure-specific specialist review for the intended Québec, Canadian, and
      US jurisdictions; implement the required permissions and eligibility controls before accepting
      funds. Wallet-first preference does not decide whether identity checks are required.
- [ ] Approve the financial specifications, demonstrate full backing and independent reconciliation,
      and verify that event collateral, refundable fees, ongoing-market assets, sponsor funds, and
      operating revenue remain distinguishable.
- [ ] Test the hidden-tally promise against actual chain, order, quote, API, analytics, and staff-access
      surfaces before advertising it as verified.
- [ ] Complete the security, privacy, operational, user-comprehension, sponsor, and combined-release
      evidence listed in the companion checklist.

Use exact units, an append-only double-entry ledger, idempotency, transactional invariants,
immutable audit records, and reconciliation for money movements. Never implement money as a mutable
`users.balance` field.
