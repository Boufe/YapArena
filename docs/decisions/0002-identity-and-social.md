# Decision 0002 — Identity, profiles, and social graph

Status: implemented for the nonfinancial preview, 2026-09-29.

## Account and authorization model

- A server account owns at most one profile. A profile has one stable handle. A wallet is an
  authentication credential, not an account or a claim that one wallet equals one person.
- EVM wallet sign-in uses a five-minute, one-use Sign-In with Ethereum challenge tied to the
  configured application origin and chain. Signing the message creates a server session; it
  never authorizes a transaction. Wallet connection alone does not sign in. An existing email
  account can link a wallet after signing in; a wallet already linked to another account cannot
  be moved or used to merge profiles automatically.
- Each wallet link or unlink requires a fresh current-password proof or a purpose-specific
  signature from an existing linked wallet that will remain available. A five-minute, one-use
  operation binds this approval to the current account/session and exact target address/chain.
  Linking also requires separate proof of the proposed wallet. Session rotation, audit and an
  in-app notification commit with the mutation. See the
  [credential-change authorization design](../security/wallet-authorization.md). Changing or losing a
  wallet does not move a profile, follow history, or future debate rights. A wallet-only account
  cannot unlink its final sign-in method. There is no automatic recovery for a lost sole wallet;
  a future recovery method needs a separate security design.
- Externally owned accounts can sign in on any valid EVM chain ID. Contract wallet signatures
  require an operator-configured RPC endpoint for their chain. An unconfigured or unavailable
  endpoint fails closed. A wallet address on a different chain is a distinct credential.
- Anonymous browsing remains available. The `participant` role permits profile and follow
  writes. `moderator`, `operator`, and `sponsor` are separate roles and confer no unpublished
  discovery access by themselves. Roles are stored and audited; this package provides no public
  role-grant endpoint. Each future challenge or moderation action must check its own role and
  ownership rules before it ships.

## Profile and participation data

Profiles start as private drafts and are published by an explicit account action. Handles cannot
be edited once created, so shared links remain stable. Moderation can mark a profile hidden;
the owner cannot republish it. Follows target only published people or topics. The account page
shows the account's follows and a 90-day identity activity view. Audit entries include session,
profile, follow, role, and wallet-link changes; they do not store a wallet signature or session
token. A wallet address can be public on a blockchain, and linking it to a profile may expose
an association to anyone who knows both; the product should explain that before financial
participation is designed.

## Retention, export, and deletion policy for this preview

- Keep account, profile, linked-wallet, and follow records until an account deletion request is
  fulfilled. Expired SIWE challenges and wallet operations are purged after one day; identity audit entries are purged
  after 90 days by scheduled cleanup. A session expires after the configured duration (seven
  days by default) and expired sessions are purged by the existing cleanup task. Backups follow
  the operations runbook's retention and restore policy.
- A user's current nonfinancial account data comprises their account identifier and email if
  present, profile, wallet addresses and chain IDs, follows, and the remaining audit activity.
  The authenticated account APIs expose those records in pages. A single download/export
  endpoint is **not yet implemented**. Until one exists, an operator must fulfill an authenticated
  export request using a reviewed, owner-scoped database query and a secure delivery channel.
- Self-service account deletion is **not yet implemented**. An operator must verify account
  control, check for any applicable legal hold or future financial record obligation, then remove
  the account and associated profile, wallets, follows, sessions, and challenges. The audit table
  has no account foreign key so the operator must delete that user's audit rows explicitly.
  If the account has debate participation, the operator must first resolve any active event and
  review the event-history retention obligation; participation rows deliberately restrict a
  silent user deletion.
  Deletion from backups follows backup expiry. No request channel or service-level target is
  advertised in the preview until an operator support process exists.
- These preview rules need privacy and legal review before a paid launch. Future financial
  records, eligibility checks, and regulatory retention may require different treatment; this
  decision does not authorize their collection or deletion.

## Verification and limits

The route tests check ownership, role restrictions, malformed input, one-use challenges, session
binding, and wallet conflicts. A PostgreSQL integration check exercises migration-backed profile,
follow, audit, and wallet-link behavior. EOA signatures are tested with an actual signer. Contract
wallet verification still needs a representative live RPC test before those wallets are promised
in a deployed environment. Browser interaction, accessibility, and representative-load checks
remain release tasks.
