import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
  AccountOperationError,
  accountOperationTermsDigest,
  type createAccountOperationRepository,
} from "./account-operations.ts";
import type { IdentityVerifier, ProviderIdentity } from "./privy.ts";
import {
  providerCredentialsDigest,
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";
import { assertActiveSession, insertSession, lockAccount } from "./sessions.ts";
import { createSessionToken } from "./session-tokens.ts";

type PreparedApproval = Awaited<
  ReturnType<ReturnType<typeof createAccountOperationRepository>["prepare"]>
>;
type ProviderState = Pick<
  ProviderIdentity,
  "subject" | "credentials" | "credentialsDigest" | "passkeys"
>;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function invalid(): never {
  throw new AccountOperationError(
    410,
    "Privy passkey activation changed or expired; start again.",
  );
}

// Privy's trusted GET-user public_key is a base64-encoded COSE_Key. Browser
// input is never an acceptable source for this value. Activation separately
// verifies the private key, origin, RP, signed flags and one-use challenge.
export function parseProviderPasskeyPublicKey(
  encoded: string | null | undefined,
) {
  try {
    if (
      !encoded ||
      encoded.length > 5_464 ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)
    )
      throw new Error("missing or invalid key");
    const normalized = encoded
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const publicKey = Buffer.from(encoded, "base64");
    if (
      publicKey.length < 16 ||
      publicKey.length > 4_096 ||
      publicKey.toString("base64url") !== normalized
    )
      throw new Error("invalid key encoding");
    const decoded = isoCBOR.decodeFirst<unknown>(publicKey);
    if (!(decoded instanceof Map)) throw new Error("COSE key required");
    const key = new Map<number, number | Uint8Array>();
    for (const [label, value] of decoded) {
      if (
        typeof label !== "number" ||
        !Number.isSafeInteger(label) ||
        !(typeof value === "number" || value instanceof Uint8Array)
      )
        throw new Error("invalid COSE value");
      key.set(label, value);
    }
    // decodeFirst deliberately ignores a following CBOR item. Re-encoding
    // length rejects trailing data, duplicate labels and non-minimal encodings.
    if (isoCBOR.encode(key).length !== publicKey.length)
      throw new Error("unexpected COSE data");
    const bytes = (label: number, length?: number) => {
      const value = key.get(label);
      return (
        value instanceof Uint8Array &&
        (length === undefined ? value.length > 0 : value.length === length)
      );
    };
    const type = key.get(1);
    const algorithm = key.get(3);
    const curve = key.get(-1);
    const ec =
      type === 2 &&
      key.size === 5 &&
      [...key.keys()].every((label) => [1, 3, -1, -2, -3].includes(label)) &&
      ((algorithm === -7 && curve === 1 && bytes(-2, 32) && bytes(-3, 32)) ||
        (algorithm === -35 && curve === 2 && bytes(-2, 48) && bytes(-3, 48)) ||
        (algorithm === -36 && curve === 3 && bytes(-2, 66) && bytes(-3, 66)));
    const ed =
      type === 1 &&
      key.size === 4 &&
      algorithm === -8 &&
      curve === 6 &&
      bytes(-2, 32);
    const modulus = key.get(-1);
    const rsa =
      type === 3 &&
      key.size === 4 &&
      typeof algorithm === "number" &&
      [-257, -258, -259, -37, -38, -39].includes(algorithm) &&
      modulus instanceof Uint8Array &&
      modulus.length >= 256 &&
      bytes(-2);
    if (!ec && !ed && !rsa) throw new Error("unsupported COSE key");
    return { publicKey, publicKeyDigest: digest(publicKey) };
  } catch {
    throw new AccountOperationError(
      503,
      "Privy has not supplied a supported public key for this passkey. Activation is unavailable.",
    );
  }
}

export function inspectProviderPasskeyAddition(
  before: ProviderCredential[],
  current: Pick<
    ProviderState,
    "credentials" | "credentialsDigest" | "passkeys"
  >,
) {
  const after = current.credentials;
  if (
    !after ||
    after.length !== before.length + 1 ||
    providerCredentialsDigest(after) !== current.credentialsDigest
  )
    return null;
  const serialized = (value: ProviderCredential) =>
    JSON.stringify([value.type, value.id]);
  const old = new Set(before.map(serialized));
  const next = new Set(after.map(serialized));
  if (old.size !== before.length || next.size !== after.length) return null;
  if ([...old].some((value) => !next.has(value))) return null;
  const additions = after.filter((value) => !old.has(serialized(value)));
  const added = additions[0];
  if (additions.length !== 1 || added?.type !== "passkey") return null;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(added.id)) return null;
  const evidence = current.passkeys?.filter(
    (value) => value.credentialId === added.id,
  );
  if (evidence?.length !== 1) return null;
  const parsed = parseProviderPasskeyPublicKey(evidence[0]!.publicKey);
  return { credentialId: added.id, ...parsed };
}

type Intent = {
  id: string;
  userId: string;
  sessionTokenHash: string;
  authGeneration: string;
  subject: string;
  origin: string;
  rpId: string;
  mode: "addition" | "existing";
  selectedCredentialId: string | null;
  beforeDigest: string;
  before: ProviderCredential[];
  expiresAt: Date;
  candidateDigest: string | null;
  credentialId: string | null;
  publicKey: Buffer | null;
  publicKeyDigest: string | null;
  sessionDigest: string | null;
  challenge: string | null;
};
const intentColumns = `id,user_id AS "userId",session_token_hash AS "sessionTokenHash",
  auth_generation AS "authGeneration",provider_subject AS subject,origin,rp_id AS "rpId",
  intent_mode AS mode,selected_credential_id AS "selectedCredentialId",
  before_digest AS "beforeDigest",before_credentials AS before,expires_at AS "expiresAt",
  candidate_digest AS "candidateDigest",candidate_credential_id AS "credentialId",
  candidate_public_key AS "publicKey",candidate_key_digest AS "publicKeyDigest",
  candidate_session_digest AS "sessionDigest",challenge`;

export async function pendingProviderPasskeyAddition(
  source: Pick<PoolClient, "query">,
  input: {
    userId: string;
    sessionTokenHash: string;
    authGeneration: string;
    subject: string;
    beforeDigest: string;
    current: ProviderState;
  },
) {
  if (input.current.subject !== input.subject) return false;
  const intents = await source.query<Intent>(
    `SELECT ${intentColumns} FROM provider_passkey_intents
     WHERE user_id=$1 AND session_token_hash=$2 AND auth_generation=$3
       AND provider_subject=$4 AND before_digest=$5
       AND intent_mode='addition'
       AND consumed_at IS NULL AND expires_at>clock_timestamp()
       AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.provider='privy'
         AND p.user_id=$1 AND p.subject=$4 AND p.auth_generation=$3 AND p.credentials_digest=$5)
       AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.user_id=$1 AND s.token_hash=$2 AND s.auth_generation=$3
           AND u.auth_generation=$3 AND u.account_status='active' AND s.expires_at>clock_timestamp())`,
    [
      input.userId,
      input.sessionTokenHash,
      input.authGeneration,
      input.subject,
      input.beforeDigest,
    ],
  );
  for (const intent of intents.rows) {
    if (providerCredentialsDigest(intent.before) !== input.beforeDigest)
      continue;
    const addition = inspectProviderPasskeyAddition(
      intent.before,
      input.current,
    );
    if (
      addition &&
      (intent.candidateDigest === null ||
        (intent.candidateDigest === input.current.credentialsDigest &&
          intent.credentialId === addition.credentialId &&
          intent.publicKeyDigest === addition.publicKeyDigest &&
          intent.publicKey?.equals(addition.publicKey)))
    )
      return true;
  }
  return false;
}

type Mapping = {
  subject: string;
  email: string | null;
  methods: string[];
  authGeneration: string;
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
};
const mappingColumns = `subject,email,methods,auth_generation AS "authGeneration",
  credentials_digest AS "credentialsDigest",credentials_snapshot AS "credentialsSnapshot"`;
const terms = (intent: Intent) => ({
  intentId: intent.id,
  subject: intent.subject,
  beforeDigest: intent.beforeDigest,
});

async function bootstrapAllowed(client: PoolClient, userId: string) {
  return (
    (
      await client.query<{ allowed: boolean }>(
        `SELECT u.password_hash IS NULL
       AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.user_id=u.id AND (p.methods ? 'email' OR p.methods ? 'google_oauth'))
       AND NOT EXISTS(SELECT 1 FROM wallet_identities w WHERE w.user_id=u.id)
       AND NOT EXISTS(SELECT 1 FROM account_security_keys k WHERE k.user_id=u.id)
       AND NOT EXISTS(SELECT 1 FROM coin_accounts a WHERE a.user_id=u.id AND
         (a.balance<>0 OR EXISTS(SELECT 1 FROM coin_postings p WHERE p.account_id=a.id)))
       AND NOT EXISTS(SELECT 1 FROM coin_grant_lots g WHERE g.user_id=u.id) AS allowed
       FROM users u WHERE u.id=$1`,
        [userId],
      )
    ).rows[0]?.allowed === true
  );
}

export function createProviderPasskeys(
  database: Pool,
  verifier: Pick<IdentityVerifier, "verify" | "inspect">,
) {
  async function readIntent(
    id: string,
    sessionTokenHash: string,
    origin: string,
  ) {
    const row = (
      await database.query<Intent>(
        `SELECT ${intentColumns} FROM provider_passkey_intents WHERE id=$1 AND session_token_hash=$2
       AND origin=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [id, sessionTokenHash, new URL(origin).origin],
      )
    ).rows[0];
    if (!row) invalid();
    return row;
  }
  async function lockIntent(client: PoolClient, snapshot: Intent) {
    const account = await lockAccount(client, snapshot.userId);
    if (!account || account.authGeneration !== snapshot.authGeneration)
      invalid();
    await assertActiveSession(
      client,
      snapshot.userId,
      snapshot.sessionTokenHash,
    );
    const row = (
      await client.query<Intent>(
        `SELECT ${intentColumns} FROM provider_passkey_intents WHERE id=$1 AND consumed_at IS NULL
       AND expires_at>clock_timestamp() FOR UPDATE`,
        [snapshot.id],
      )
    ).rows[0];
    if (
      !row ||
      row.sessionTokenHash !== snapshot.sessionTokenHash ||
      row.authGeneration !== snapshot.authGeneration ||
      row.beforeDigest !== snapshot.beforeDigest ||
      row.subject !== snapshot.subject ||
      row.origin !== snapshot.origin
    )
      invalid();
    const mapped = (
      await client.query<Mapping>(
        `SELECT ${mappingColumns} FROM provider_identities WHERE provider='privy' AND user_id=$1 AND subject=$2 FOR UPDATE`,
        [row.userId, row.subject],
      )
    ).rows[0];
    if (
      !mapped ||
      mapped.authGeneration !== row.authGeneration ||
      mapped.credentialsDigest !== row.beforeDigest ||
      providerCredentialsDigest(verifiedStoredCredentials(mapped) ?? []) !==
        row.beforeDigest
    )
      invalid();
    return row;
  }
  async function inspectCandidate(intent: Intent, token: string) {
    // verify includes the trusted, uncached GET. Never hold a connection during
    // provider IO; final local ownership/session/intent state is locked again.
    const identity = await verifier.verify(token);
    if (identity.subject !== intent.subject || !identity.sessionId) invalid();
    let addition;
    if (intent.mode === "existing") {
      if (
        identity.credentialsDigest !== intent.beforeDigest ||
        !identity.credentials ||
        providerCredentialsDigest(identity.credentials) !==
          intent.beforeDigest ||
        !intent.before.some(
          (credential) =>
            credential.type === "passkey" &&
            credential.id === intent.selectedCredentialId,
        )
      )
        invalid();
      const evidence = identity.passkeys?.filter(
        (key) => key.credentialId === intent.selectedCredentialId,
      );
      if (evidence?.length !== 1) invalid();
      addition = {
        credentialId: evidence[0]!.credentialId,
        ...parseProviderPasskeyPublicKey(evidence[0]!.publicKey),
      };
    } else {
      addition = inspectProviderPasskeyAddition(intent.before, identity);
    }
    if (!addition) invalid();
    return { identity, addition, sessionDigest: digest(identity.sessionId) };
  }
  return Object.freeze({
    async begin(input: {
      userId: string;
      sessionTokenHash: string;
      origin: string;
      credentialId?: string;
    }) {
      const mapping = (
        await database.query<Mapping>(
          `SELECT ${mappingColumns} FROM provider_identities WHERE provider='privy' AND user_id=$1`,
          [input.userId],
        )
      ).rows[0];
      if (!mapping) invalid();
      const before = verifiedStoredCredentials(mapping);
      const current = await verifier.inspect(mapping.subject);
      if (
        !before ||
        current.subject !== mapping.subject ||
        current.credentialsDigest !== mapping.credentialsDigest ||
        !current.credentials ||
        providerCredentialsDigest(current.credentials) !==
          mapping.credentialsDigest
      )
        invalid();
      const origin = new URL(input.origin).origin;
      const rpId = new URL(origin).hostname;
      const mode = input.credentialId ? "existing" : "addition";
      if (
        mode === "existing" &&
        !before.some(
          (credential) =>
            credential.type === "passkey" &&
            credential.id === input.credentialId,
        )
      )
        invalid();
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${mapping.subject}`],
        );
        const account = await lockAccount(client, input.userId);
        if (!account || account.authGeneration !== mapping.authGeneration)
          invalid();
        await assertActiveSession(client, input.userId, input.sessionTokenHash);
        const locked = (
          await client.query<Mapping>(
            `SELECT ${mappingColumns} FROM provider_identities WHERE provider='privy' AND user_id=$1 AND subject=$2 FOR UPDATE`,
            [input.userId, mapping.subject],
          )
        ).rows[0];
        if (
          !locked ||
          locked.authGeneration !== account.authGeneration ||
          locked.credentialsDigest !== mapping.credentialsDigest
        )
          invalid();
        if (
          input.credentialId &&
          (
            await client.query(
              "SELECT id FROM account_security_keys WHERE credential_id=$1",
              [input.credentialId],
            )
          ).rowCount
        )
          throw new AccountOperationError(
            409,
            "This Privy passkey was already activated or retired. Use its existing account control.",
          );
        const existing = (
          await client.query<Intent>(
            `SELECT ${intentColumns} FROM provider_passkey_intents WHERE user_id=$1 AND consumed_at IS NULL
           AND expires_at>clock_timestamp() FOR UPDATE`,
            [input.userId],
          )
        ).rows[0];
        let intent: Intent;
        if (existing) {
          if (
            existing.sessionTokenHash !== input.sessionTokenHash ||
            existing.authGeneration !== account.authGeneration ||
            existing.beforeDigest !== mapping.credentialsDigest ||
            existing.origin !== origin ||
            existing.subject !== mapping.subject ||
            existing.mode !== mode ||
            existing.selectedCredentialId !== (input.credentialId ?? null)
          )
            invalid();
          intent = existing;
        } else {
          intent = (
            await client.query<Intent>(
              `WITH issued AS(SELECT clock_timestamp() AS at)
             INSERT INTO provider_passkey_intents(id,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,
             before_digest,before_credentials,intent_mode,selected_credential_id,created_at,expires_at)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,at,at+interval '5 minutes' FROM issued
             RETURNING ${intentColumns}`,
              [
                randomUUID(),
                input.userId,
                input.sessionTokenHash,
                account.authGeneration,
                mapping.subject,
                origin,
                rpId,
                mapping.credentialsDigest,
                JSON.stringify(before),
                mode,
                input.credentialId ?? null,
              ],
            )
          ).rows[0]!;
        }
        const bootstrap =
          (mode === "existing" ||
            !before.some((credential) => credential.type === "passkey")) &&
          (await bootstrapAllowed(client, input.userId));
        await client.query("COMMIT");
        return {
          id: intent.id,
          expiresAt: intent.expiresAt,
          bootstrapAllowed: bootstrap,
          terms: terms(intent),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async activationOptions(input: {
      id: string;
      sessionTokenHash: string;
      origin: string;
      token: string;
    }) {
      const snapshot = await readIntent(
        input.id,
        input.sessionTokenHash,
        input.origin,
      );
      const candidate = await inspectCandidate(snapshot, input.token);
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${snapshot.subject}`],
        );
        let intent = await lockIntent(client, snapshot);
        if (intent.candidateDigest !== null) {
          if (
            intent.candidateDigest !== candidate.identity.credentialsDigest ||
            intent.credentialId !== candidate.addition.credentialId ||
            intent.publicKeyDigest !== candidate.addition.publicKeyDigest ||
            !intent.publicKey?.equals(candidate.addition.publicKey) ||
            intent.sessionDigest !== candidate.sessionDigest
          )
            invalid();
        } else {
          intent = (
            await client.query<Intent>(
              `UPDATE provider_passkey_intents SET candidate_digest=$2,candidate_credential_id=$3,candidate_public_key=$4,
             candidate_key_digest=$5,candidate_session_digest=$6,challenge=$7 WHERE id=$1 RETURNING ${intentColumns}`,
              [
                intent.id,
                candidate.identity.credentialsDigest,
                candidate.addition.credentialId,
                candidate.addition.publicKey,
                candidate.addition.publicKeyDigest,
                candidate.sessionDigest,
                randomBytes(32).toString("base64url"),
              ],
            )
          ).rows[0]!;
        }
        const authenticationOptions = await generateAuthenticationOptions({
          rpID: intent.rpId,
          challenge: Buffer.from(intent.challenge!, "base64url"),
          allowCredentials: [{ id: intent.credentialId! }],
          userVerification: "required",
          timeout: 300_000,
        });
        const bootstrap =
          (intent.mode === "existing" ||
            !intent.before.some(
              (credential) => credential.type === "passkey",
            )) &&
          (await bootstrapAllowed(client, intent.userId));
        await client.query("COMMIT");
        return {
          id: intent.id,
          userId: intent.userId,
          expiresAt: intent.expiresAt,
          bootstrapAllowed: bootstrap,
          terms: terms(intent),
          before: intent.before,
          after: candidate.identity.credentials!,
          authenticationOptions,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async complete(input: {
      id: string;
      sessionTokenHash: string;
      origin: string;
      token: string;
      authentication: AuthenticationResponseJSON;
      sessionDurationMs: number;
      approval?: PreparedApproval;
    }) {
      const snapshot = await readIntent(
        input.id,
        input.sessionTokenHash,
        input.origin,
      );
      if (
        !snapshot.challenge ||
        !snapshot.credentialId ||
        !snapshot.publicKey ||
        !snapshot.publicKeyDigest ||
        !snapshot.candidateDigest
      )
        invalid();
      if (input.approval) {
        input.approval.assertContext(snapshot.userId, input.sessionTokenHash);
        if (
          input.approval.purpose !== "provider.passkey.link" ||
          input.approval.termsDigest !==
            accountOperationTermsDigest(terms(snapshot))
        )
          throw new AccountOperationError(
            403,
            "approval does not authorize this passkey link",
          );
      }
      const candidate = await inspectCandidate(snapshot, input.token);
      if (
        candidate.identity.credentialsDigest !== snapshot.candidateDigest ||
        candidate.sessionDigest !== snapshot.sessionDigest ||
        candidate.addition.credentialId !== snapshot.credentialId ||
        candidate.addition.publicKeyDigest !== snapshot.publicKeyDigest ||
        !candidate.addition.publicKey.equals(snapshot.publicKey)
      )
        invalid();
      if (input.authentication.id !== snapshot.credentialId)
        throw new AccountOperationError(
          401,
          "Privy passkey activation assertion is invalid",
        );
      const verification = await verifyAuthenticationResponse({
        response: input.authentication,
        expectedChallenge: snapshot.challenge,
        expectedOrigin: snapshot.origin,
        expectedRPID: snapshot.rpId,
        credential: {
          id: snapshot.credentialId,
          publicKey: new Uint8Array(snapshot.publicKey),
          counter: 0,
        },
        requireUserVerification: true,
      }).catch(() => {
        throw new AccountOperationError(
          401,
          "Privy passkey activation assertion is invalid",
        );
      });
      if (
        !verification.verified ||
        !verification.authenticationInfo.userVerified
      )
        throw new AccountOperationError(
          401,
          "Privy passkey activation assertion is invalid",
        );
      if (
        !Number.isSafeInteger(input.sessionDurationMs) ||
        input.sessionDurationMs <= 0
      )
        invalid();
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${snapshot.subject}`],
        );
        const mutation = async () => {
          const intent = await lockIntent(client, snapshot);
          if (
            intent.candidateDigest !== snapshot.candidateDigest ||
            intent.credentialId !== snapshot.credentialId ||
            intent.publicKeyDigest !== snapshot.publicKeyDigest ||
            !intent.publicKey?.equals(snapshot.publicKey!) ||
            intent.sessionDigest !== snapshot.sessionDigest ||
            intent.challenge !== snapshot.challenge
          )
            invalid();
          if (
            !input.approval &&
            (!(await bootstrapAllowed(client, intent.userId)) ||
              (intent.mode === "addition" &&
                intent.before.some(
                  (credential) => credential.type === "passkey",
                )))
          )
            throw new AccountOperationError(
              403,
              "An existing trusted credential must approve this Privy passkey.",
            );
          await client.query(
            "INSERT INTO account_security_users(user_id,user_handle) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
            [intent.userId, randomBytes(32).toString("base64url")],
          );
          const keyId = randomUUID();
          const info = verification.authenticationInfo;
          await client.query(
            `INSERT INTO account_security_keys(id,user_id,credential_id,public_key,counter,device_type,backed_up,
            provenance,provider_subject,provider_public_key_digest,rp_id) VALUES($1,$2,$3,$4,$5,$6,$7,'privy',$8,$9,$10)`,
            [
              keyId,
              intent.userId,
              intent.credentialId,
              intent.publicKey,
              info.newCounter,
              info.credentialDeviceType,
              info.credentialBackedUp,
              intent.subject,
              intent.publicKeyDigest,
              intent.rpId,
            ],
          );
          await client.query(
            `UPDATE provider_identities SET email=$3,methods=$4::jsonb,credentials_digest=$5,credentials_snapshot=$6::jsonb
            WHERE provider='privy' AND subject=$1 AND user_id=$2`,
            [
              intent.subject,
              intent.userId,
              candidate.identity.email,
              JSON.stringify(candidate.identity.methods),
              candidate.identity.credentialsDigest,
              JSON.stringify(candidate.identity.credentials),
            ],
          );
          // Retain every old SID fence. This candidate SID is consumed as well;
          // it cannot recreate a revoked local session through ordinary exchange.
          await client.query(
            `INSERT INTO provider_session_exchanges(provider,subject,session_digest,user_id)
            VALUES('privy',$1,$2,$3) ON CONFLICT(provider,session_digest) DO NOTHING`,
            [intent.subject, intent.sessionDigest, intent.userId],
          );
          const sid = (
            await client.query<{ subject: string; userId: string | null }>(
              `SELECT subject,user_id AS "userId" FROM provider_session_exchanges WHERE provider='privy' AND session_digest=$1`,
              [intent.sessionDigest],
            )
          ).rows[0];
          if (
            !sid ||
            sid.subject !== intent.subject ||
            sid.userId !== intent.userId
          )
            invalid();
          const consumed = await client.query(
            `UPDATE provider_passkey_intents SET consumed_at=clock_timestamp()
            WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
            [intent.id],
          );
          if (!consumed.rowCount) invalid();
          const account = await lockAccount(client, intent.userId);
          if (!account) invalid();
          const token = createSessionToken();
          await insertSession(
            client,
            intent.userId,
            token.tokenHash,
            new Date(Date.now() + input.sessionDurationMs),
            account.authGeneration,
          );
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
            VALUES($1,'provider.passkey.activated',$2,$3::jsonb)`,
            [
              intent.userId,
              keyId,
              JSON.stringify({
                outcome: "success",
                scope: input.approval ? "retained-proof" : "before-funds",
              }),
            ],
          );
          await client.query(
            `INSERT INTO account_notifications(user_id,event_type,message)
            VALUES($1,'provider.passkey.activated','Your Privy passkey was activated for sensitive account actions. Other application sessions were signed out.')`,
            [intent.userId],
          );
          return { keyId, token: token.token };
        };
        const result = input.approval
          ? await input.approval.consume(client, mutation)
          : await mutation();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
