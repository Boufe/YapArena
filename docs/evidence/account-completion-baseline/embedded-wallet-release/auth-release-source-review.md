# Pre-release authentication and migration source review

Reviewer: `auth_security`, 2026-10-21. Reviewed checkout `a9706ccb55ae342c4f11366145b1896d17656931`.
This is a read-only source review, not an executed release or hosted acceptance.
The reviewer authored migration 15000 and its phase engine. Review of that
migration is an author recheck; the prior separate lead/Redis review provides
its independent source review. The release helpers and migration 14000 were
reviewed independently here.

No blocking issue was identified for the exact planned **43 → 45** staging
migration and fixed-target web deployment, subject to the operational gates
below. No provider, database or Render mutation, build, credential read or
service operation was performed during this review. A public Supabase changelog
was read; no Supabase auth, project setting or PostgreSQL version change is part
of the release.

| Reviewed path                                                  | SHA-256                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/release-account-staging.ts`                           | `76ed8a5fb44d189f6cbe84e0ad771f542c124ebd94f2ffcdba0c1693327497ba` |
| `scripts/release-account-render.ts`                            | `58d4fb8065d163dc0c81ac4923790bc2c62ef2cfcf4870b33302f7fdad54289b` |
| `scripts/verify-account-staging.ts`                            | `17523538c2d96068d46a62cd2f4221078769a02f398abc24cab5ea38785405f4` |
| `migrations/1792426014000_add-embedded-wallet-provisioning.js` | `ed48b610e77793bf4df1d49637f594660598d27dd98684f3dce890fd9f4db1b0` |
| `migrations/1792426015000_add-provider-control-phases.js`      | `07163766753d22498e9c9308817dbd9c6c6fb7928abb3ea7cd4ccded37e4c3ad` |

The database helper pins the existing project and owner/runtime roles, requires
direct/session-pooler port 5432 with verified TLS, and requires precisely the two
reviewed pending migrations. The owner/admin process remains separate from the
web and worker. Backup preparation encrypts the private application dump with
AES-GCM, restores it into a new loopback-only database, verifies table
fingerprints and sequence state, and rehearses the additive migrations as a
non-superuser owner. Hosted migration requires the same HEAD, every recorded
migration hash, backup ciphertext, applied/pending set and unchanged
pre-migration table/sequence snapshot. Neither mode resets or deletes accounts.
The backup is application-scoped, not a provider/global-role disaster recovery
backup; the local rehearsal intentionally omits original ACLs.

Migration 14000 adds the private RLS-protected wallet-provisioning table, a
security-invoker immutable-owner guard, runtime-scoped grants and pending jobs
only for active synchronized Privy mappings. It does not issue a provider call,
adopt a credential, change an existing account or move funds. Migration 15000
adds phase metadata and its due index. Existing jobs retain `legacy`; state,
attempts, leases, confirmed freeze and failure history remain unchanged. New
jobs default to `preflight`. Neither migration updates accepted provider
identity digests, account/session generations, SID issuance cutoffs or financial
configuration. Both require forward fixes rather than destructive down steps.

The Render helper targets only the two named staging services. Its mutation
modes require an explicit exact action flag; deployment additionally requires
exact HEAD and the general worker flag needed by the existing media drain.
The authentication drains themselves remain independent of that general flag.
Deploy acceptance is not evidence that the requested revision is live. The
`configure-sandbox` mode is not needed for this additive release; it is limited
to the deterministic simulation configuration and must not be described as
live financial enablement.

The lead must independently verify all five CI checks, stopped service and
callback writers, auto-deploy state, and the intended operation sequence before
executing. Writer-stop environment assertions and a point-in-time runtime
activity count are adjuncts, not proof or a persistent fence. Keep writers
stopped through migration; recheck preserved accounts, mapping/generation/
cutoff state, effective owner/runtime/browser privileges and zero live journals
before and after the release. Resume/deploy only the planned targets and verify
actual live revision, readiness and guest behavior separately. Genuine provider
passkey/recovery acceptance and physical-device/screen-reader testing remain
separate gates. This review does not authorize deleting another retained
account, changing plans, signing transactions or enabling live liabilities.
