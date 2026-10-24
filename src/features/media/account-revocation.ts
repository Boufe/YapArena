import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import {
  assertActiveSession,
  lockAccount,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
import { MediaConflictError } from "./repository.ts";

export class MediaRevocationPendingError extends MediaConflictError {}
export class MediaRevocationUnsupportedError extends MediaConflictError {}
export interface MediaGrantContext {
  userId: string;
  sessionTokenHash: string;
  debateId: string;
  // Intent only, never identity/authorization. Automatic reconnect must not
  // displace a different device; manual Join may request a two-phase move.
  allowReplacement?: boolean;
}
interface Grant {
  id: string;
  user_id: string;
  session_id: string;
  auth_generation: string;
  debate_id: string;
  identity: string;
  state: "active" | "revoking" | "revoked";
  intended_session_id: string | null;
}
interface SlotGrant extends Grant {
  intent_active: boolean;
  session_valid: boolean;
}
type Observation = {
  result: "complete" | "retry" | "unsupported";
  seconds: number;
};
const validSession = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.id=g.session_id AND u.id=g.user_id AND u.account_status='active'
    AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp())`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createMediaAccountRevocation(
  database: Pool,
  provider: {
    // True only for a verified Cloud deployment. Self-hosted removal does not
    // invalidate an old JWT, and must never be presented as complete revocation.
    supportsTokenRevocation: boolean;
    mintSpeakerToken: (
      debateId: string,
      identitySuffix: string,
      side: "A" | "B",
    ) => Promise<string>;
    removeSpeaker: (debateId: string, fullIdentity: string) => Promise<void>;
    observe?: (value: Observation) => void;
    timeoutMs?: number;
  },
) {
  const timeoutMs = provider.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new Error("invalid media revocation timeout");
  async function retire(
    client: PoolClient,
    grant: Grant,
    intendedSessionId?: string,
  ) {
    if (intendedSessionId)
      await client.query(
        `UPDATE media_account_grants SET state='revoking',intended_session_id=$2,
      intent_expires_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id=$1`,
        [grant.id, intendedSessionId],
      );
    else if (grant.state === "active")
      await client.query(
        "UPDATE media_account_grants SET state='revoking' WHERE id=$1",
        [grant.id],
      );
    await client.query(
      "INSERT INTO media_account_revocations(grant_id) VALUES($1) ON CONFLICT DO NOTHING",
      [grant.id],
    );
  }
  async function accountLock(client: PoolClient, userId: string) {
    // Includes suspended/deleted accounts: containment must remain possible.
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
  }
  async function invalidGrants(limit: number) {
    const candidates = (
      await database.query<Grant>(
        `SELECT g.* FROM media_account_grants g WHERE g.state='active' AND NOT ${validSession}
      ORDER BY g.user_id,g.id LIMIT $1`,
        [limit],
      )
    ).rows;
    for (const candidate of candidates)
      await withTransaction(database, async (client) => {
        await accountLock(client, candidate.user_id);
        const grant = (
          await client.query<Grant>(
            `SELECT g.* FROM media_account_grants g WHERE g.id=$1 AND g.state='active'
        AND NOT ${validSession} FOR UPDATE`,
            [candidate.id],
          )
        ).rows[0];
        if (grant) await retire(client, grant);
      });
  }
  async function process(grantId: string) {
    const candidate = (
      await database.query<Grant>(
        "SELECT * FROM media_account_grants WHERE id=$1",
        [grantId],
      )
    ).rows[0];
    if (!candidate) return null;
    const claim = await withTransaction(database, async (client) => {
      await accountLock(client, candidate.user_id);
      const grant = (
        await client.query<Grant>(
          "SELECT * FROM media_account_grants WHERE id=$1 FOR UPDATE",
          [grantId],
        )
      ).rows[0];
      const job = (
        await client.query<{
          state: string;
          attempts: number;
          available: boolean;
        }>(
          `SELECT state,attempts,
        available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AS available
        FROM media_account_revocations WHERE grant_id=$1 FOR UPDATE`,
          [grantId],
        )
      ).rows[0];
      if (
        !grant ||
        grant.state !== "revoking" ||
        !job ||
        job.state === "complete" ||
        !job.available
      )
        return null;
      const token = randomUUID();
      await client.query(
        `UPDATE media_account_revocations SET state='running',claim_token=$2,
        lease_until=clock_timestamp()+INTERVAL '15 seconds',attempts=attempts+1 WHERE grant_id=$1`,
        [grantId, token],
      );
      return { grant, token, attempts: job.attempts + 1 };
    });
    if (!claim) return null;
    const start = performance.now();
    let failure:
      | "provider_error"
      | "provider_timeout"
      | "unsupported_token_revocation"
      | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        provider.removeSpeaker(claim.grant.debate_id, claim.grant.identity),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            failure = "provider_timeout";
            reject(new Error("media revocation timeout"));
          }, timeoutMs);
        }),
      ]);
      if (!provider.supportsTokenRevocation)
        failure = "unsupported_token_revocation";
    } catch {
      failure ??= "provider_error";
    } finally {
      if (timer) clearTimeout(timer);
    }
    const outcome =
      failure === "unsupported_token_revocation"
        ? "unsupported"
        : failure
          ? "retry"
          : "complete";
    const acknowledged = await withTransaction(database, async (client) => {
      await accountLock(client, claim.grant.user_id);
      await client.query(
        "SELECT id FROM media_account_grants WHERE id=$1 FOR UPDATE",
        [grantId],
      );
      const current = (
        await client.query(
          "SELECT grant_id FROM media_account_revocations WHERE grant_id=$1 AND state='running' AND claim_token=$2 FOR UPDATE",
          [grantId, claim.token],
        )
      ).rows[0];
      if (!current) return false;
      if (!failure) {
        await client.query(
          "UPDATE media_account_grants SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1 AND state='revoking'",
          [grantId],
        );
        await client.query(
          "UPDATE media_account_revocations SET state='complete',claim_token=NULL,lease_until=NULL,last_error=NULL,completed_at=clock_timestamp() WHERE grant_id=$1",
          [grantId],
        );
      } else {
        const delay = Math.min(60, 2 ** Math.min(claim.attempts, 6));
        await client.query(
          `UPDATE media_account_revocations SET state='pending',claim_token=NULL,lease_until=NULL,last_error=$2,
          available_at=clock_timestamp()+($3::int*INTERVAL '1 second') WHERE grant_id=$1`,
          [grantId, failure, delay],
        );
      }
      return true;
    });
    if (!acknowledged) return null;
    provider.observe?.({
      result: outcome,
      seconds: (performance.now() - start) / 1000,
    });
    return outcome;
  }
  return Object.freeze({
    async issueSpeakerGrant(context: MediaGrantContext) {
      if (!provider.supportsTokenRevocation)
        throw new MediaRevocationUnsupportedError(
          "this media deployment cannot revoke cached speaker tokens",
        );
      if (!uuid.test(context.debateId))
        throw new MediaConflictError("speaker seat is unavailable");
      const issued = await withTransaction(database, async (client) => {
        const account = await lockAccount(client, context.userId);
        if (!account) throw new SessionUnavailableError("account unavailable");
        const session = await assertActiveSession(
          client,
          context.userId,
          context.sessionTokenHash,
        );
        const seat = (
          await client.query<{ side: "A" | "B" }>(
            `SELECT p.side FROM event_participants p JOIN debates d ON d.id=p.debate_id
          JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND p.user_id=$2 AND p.active AND d.publication_state='published'
          AND t.publication_state='published' AND d.status IN ('scheduled','ready','live')
          AND EXISTS(SELECT 1 FROM account_roles r WHERE r.user_id=p.user_id AND r.role='participant')
          AND EXISTS(SELECT 1 FROM media_device_checks c WHERE c.debate_id=d.id AND c.user_id=p.user_id
            AND c.camera_ok AND c.microphone_ok AND c.checked_at>clock_timestamp()-INTERVAL '30 minutes')`,
            [context.debateId, context.userId],
          )
        ).rows[0];
        if (!seat)
          throw new MediaConflictError(
            "an assigned speaker seat and camera/microphone check are required",
          );
        const previous = (
          await client.query<SlotGrant>(
            `SELECT g.*,COALESCE(intent_expires_at>clock_timestamp(),false) AS intent_active,${validSession} AS session_valid
            FROM media_account_grants g WHERE user_id=$1 AND debate_id=$2 AND state IN ('active','revoking') FOR UPDATE`,
            [context.userId, context.debateId],
          )
        ).rows[0];
        if (
          previous &&
          (previous.session_id !== session.id || previous.state === "revoking")
        ) {
          if (
            context.allowReplacement !== true &&
            (previous.state === "active" ||
              (previous.intended_session_id !== null
                ? previous.intended_session_id !== session.id ||
                  !previous.intent_active
                : previous.session_valid))
          )
            throw new MediaConflictError(
              "speaker access is active on another device; use Join to move it here",
            );
          await retire(
            client,
            previous,
            context.allowReplacement === true ||
              previous.intended_session_id === null
              ? session.id
              : undefined,
          );
          await assertActiveSession(
            client,
            context.userId,
            context.sessionTokenHash,
          );
          return null;
        }
        if (!previous && context.allowReplacement !== true) {
          const displaced = (
            await client.query<{ intended_session_id: string | null }>(
              `SELECT intended_session_id FROM media_account_grants
            WHERE user_id=$1 AND debate_id=$2 AND session_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
              [context.userId, context.debateId, session.id],
            )
          ).rows[0];
          const latest = (
            await client.query<SlotGrant>(
              `SELECT g.*,COALESCE(intent_expires_at>clock_timestamp(),false) AS intent_active,${validSession} AS session_valid
            FROM media_account_grants g WHERE user_id=$1 AND debate_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
              [context.userId, context.debateId],
            )
          ).rows[0];
          if (
            (displaced?.intended_session_id &&
              displaced.intended_session_id !== session.id) ||
            (latest?.intended_session_id &&
              (latest.intended_session_id !== session.id ||
                !latest.intent_active))
          )
            throw new MediaConflictError(
              "speaker access was moved to another device; use Join to move it here",
            );
        }
        const id = previous?.id ?? randomUUID();
        if (!previous)
          await client.query(
            `WITH timing AS MATERIALIZED (SELECT clock_timestamp() AS now)
            INSERT INTO media_account_grants(id,user_id,session_id,auth_generation,debate_id,identity,issued_at,expires_at)
            SELECT $1,$2,$3,$4,$5,$6,now,now+INTERVAL '15 minutes' FROM timing`,
            [
              id,
              context.userId,
              session.id,
              account.authGeneration,
              context.debateId,
              `speaker-${id}`,
            ],
          );
        // Local JWT signing only, while account/session locks order issuance
        // against logout. Publishing the JWT happens only after COMMIT.
        const token = await provider.mintSpeakerToken(
          context.debateId,
          id,
          seat.side,
        );
        await assertActiveSession(
          client,
          context.userId,
          context.sessionTokenHash,
        );
        if (previous)
          await client.query(
            `WITH timing AS MATERIALIZED (SELECT clock_timestamp() AS now)
            UPDATE media_account_grants SET issued_at=now,
          expires_at=now+INTERVAL '15 minutes' FROM timing WHERE id=$1`,
            [id],
          );
        await assertActiveSession(
          client,
          context.userId,
          context.sessionTokenHash,
        );
        return { token, side: seat.side };
      });
      if (!issued)
        throw new MediaRevocationPendingError(
          "moving speaker access; retry after the previous device is disconnected",
        );
      return issued;
    },
    async isCurrentGrant(debateId: string, identity: string) {
      return Boolean(
        (
          await database.query(
            `SELECT 1 FROM media_account_grants g WHERE g.debate_id=$1 AND g.identity=$2
        AND g.state='active' AND ${validSession}`,
            [debateId, identity],
          )
        ).rowCount,
      );
    },
    async withSpeakerDeparture(
      debateId: string,
      identity: string,
      pause: (client: PoolClient) => Promise<unknown>,
    ) {
      return withTransaction(database, async (client) => {
        const tracked = (
          await client.query<{ user_id: string }>(
            "SELECT user_id FROM media_account_grants WHERE debate_id=$1 AND identity=$2",
            [debateId, identity],
          )
        ).rows[0];
        const legacy = /^speaker-([1-9][0-9]{0,18})$/.exec(identity)?.[1];
        const userId =
          tracked?.user_id ??
          (legacy && BigInt(legacy) <= 9223372036854775807n ? legacy : null);
        if (userId) {
          // Conflicts with issuance's account lock while remaining compatible
          // with event_history's actor FK. No provider call belongs in pause.
          await client.query(
            "SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",
            [userId],
          );
          if (
            (
              await client.query(
                `SELECT 1 FROM media_account_grants g WHERE g.user_id=$1 AND g.debate_id=$2
            AND g.identity<>$3 AND g.state='active' AND ${validSession}`,
                [userId, debateId, identity],
              )
            ).rowCount
          )
            return false;
        }
        // Unknown legacy identities retain the existing conservative pause.
        // A mapped identity's relevance check and DB pause share this fence.
        await pause(client);
        return true;
      });
    },
    async flush(limit = 10) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("invalid media revocation batch limit");
      await invalidGrants(limit);
      const jobs = (
        await database.query<{ grant_id: string }>(
          `SELECT grant_id FROM media_account_revocations WHERE state<>'complete'
        AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY available_at,grant_id LIMIT $1`,
          [limit],
        )
      ).rows;
      const result = { complete: 0, retry: 0, unsupported: 0 };
      for (const job of jobs) {
        const outcome = await process(job.grant_id);
        if (outcome) result[outcome]++;
      }
      return result;
    },
  });
}
