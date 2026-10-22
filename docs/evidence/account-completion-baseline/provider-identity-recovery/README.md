# Retained-key provider identity replacement review

The founder approved replacing a lost sole provider email or sole Google route
with a Privy-verified email identity when the original YapArena account retains
its application security passkey. This preserves the internal ID, profile,
keys and balances, permanently retires the old DID, and never merges an already
bound or retired new DID. The founder also approved using the email address
associated with the lost sole Google login, with the same verified-email and
retained-key requirements. That deliberate replacement is not an automatic
email-text merge.

This reviewer did not author the recovery module, migration, router or provider
worker changes. The review inspected those sources, the actual final focused
PostgreSQL output and a separate native browser execution. The
[source hashes](source-hashes.json) identify the exact backend/migration/test
boundary. HEAD was `4b880918934f8be0060f260392ea29f0601a01e9` with the listed
implementation changes not yet committed. Subsequent UI storage/focus changes
are excluded from that focused result. A later commit or full combined gate must
identify identical source hashes before applying these claims to its revision.

## Independent transition findings

No blocking source defect was found in the reviewed approved transitions:

- Candidate identity comes from server-verified provider evidence; browser
  email/account IDs or matching text never establish ownership. Both old and
  new credential snapshots, the exact new DID/SID and visible replacement terms
  are bound to the original account/session/generation and expiring operation.
- Only the retained application security passkey can authorize this purpose.
  Native user verification, origin/RP/challenge and key-counter checks remain
  server-enforced. Provider token issuance/refresh, timestamp fields and browser
  OTP flags are not used as fresh sensitive authorization.
- Provider reads occur before checking out a runtime connection. Sorted DID
  advisory locks precede account/session/proof/key locks, matching normal
  provisioning order. A potential lock inversion was raised during design
  review and prevented before the module was implemented.
- The narrow database definer checks the current account/session, exact proof
  and retained key. Runtime receives no general mapping-owner update privilege.
  The permanent old-DID tombstone cannot be rebound, even by owner UPDATE.
- Generation advancement happens while no provider mapping is attached. Old
  sessions are revoked and media retirement is queued; the new SID is consumed once, and a single
  replacement cookie points to the same account. History requires the exact
  consumed proof at commit and survives ordinary ephemeral-proof cleanup.
- Old provider jobs check the currently mapped subject before remote calls;
  mapping writes and inherited manual fences are subject-scoped. A retired
  job cannot target or fence the replacement identity. No old provider user is
  deleted, unfrozen, merged or otherwise changed by recovery.
- The Google dialog initially exposed the opaque OAuth subject. Review requested
  a plain description; the tested dialog says "your previous Google sign-in"
  while the exact subject remains internally bound. The new email, permanent
  retirement and no-payment effect remain visible.

There is no atomic lock over Privy's external state. The server inspects it and
then commits against fenced local snapshots; a subsequent external change fails
the next protected lookup. This limitation is not described as a provider-side
transaction or recovery of the original sole-method Privy account. The existing
provider freeze/unfreeze single-writer limitation also remains documented.

## Actual acceptance inspected

The lead ran the repository's guarded isolated PostgreSQL command:

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host ACCOUNT_SECURITY_VERIFY=true \
  A4_QUALITY=false node scripts/verify-database-isolation.ts
```

The [complete final output](focused-postgres.txt) records **151/151 on both fresh
and upgrade**, plus **5/5 on each separate Base treasury database**, with zero
failures or skips. Seven new recovery cases exercise sole email and Google
preservation, exact new email/digest/SID and account proof, bound/tombstoned and
unsupported multi-method identities, provisioning/concurrent recovery races,
counter rollback, one-connection-pool held inspection versus local revocation,
and real SQL privilege/consumed-proof boundaries. An initial expectation-only
fixture failure was corrected; this archive contains the final complete passing
run and does not reclassify the earlier diagnostic as passing.

The separate [native browser results](../security-passkey-browser/results.json)
pass **14 desktop/mobile groups** using the real account-security component,
Chrome virtual CTAP2 and runtime PostgreSQL. This includes actual rendered
permanent-retirement terms, native UV, unchanged funded source book/profile/key,
no additional user or cash journal, cross-account denial, old-cookie/old-DID/SID
and proof replay rejection. Independent runtime SQL attempts also reject missing,
wrong-purpose, expired and revoked-key proofs; an otherwise valid pending proof
cannot commit the definer mutation without consumption. Recovery dialog Axe
checks pass, and the desktop/mobile screenshots were visually inspected.
The extra adversarial job checks run the actual provider worker against an
old-DID job at the replacement account's current generation: it completes as
retired without a provider call. An old-subject manual job then cannot invalidate
the replacement identity's actual session monitor. The native run records
`5a7e957` plus exact source/compiled hashes; its root-owned session-coordinator
integration was still pending commit and needs final combined acceptance.

The provider verifier in those native tests is a labelled synthetic identity
fixture. It does not establish genuine Privy OTP delivery, Google authorization,
hosted user recovery or a real provider JWT ceremony. Native WebAuthn responses
and database/security mutations are real. Mobile is an emulated viewport; no
physical key/phone, screen-reader output or full WCAG acceptance is claimed.

The new UI storage/focus changes, final combined
release gate, staging backup/migrations/deploy and genuine hosted acceptance
remain separate requirements. No provider account, retained hosted identity,
live financial liability or live funds were changed by these tests.
