import type { Pool } from "pg";
import {
  ProviderCredentialChangedError,
  type IdentityVerifier,
} from "./privy.ts";
import { recordProviderCredentials } from "./provider-methods.ts";
import { passkeyActivationPending } from "./provider-passkeys.ts";
import {
  lockAccount,
  revokeAccountSessions,
  type ProviderCheckScheduler,
} from "./sessions.ts";

export type ProviderRecheckOutcome =
  | "skipped" // not due, not mapped, already running, paused or closed
  | "unchanged"
  | "recorded" // sign-in methods changed; recorded with a notice
  | "deferred" // inconclusive; due again after the retry delay
  | "revoked" // deleted, frozen or guest Privy user; sessions ended
  | "unavailable" // Privy did not answer; re-checks pause briefly
  | "error";

type Mapping = {
  subject: string;
  credentialsDigest: string;
  authGeneration: string;
  // Fingerprint of the app's latest own provider reset (freeze/unfreeze).
  providerControl: string | null;
  providerResetActive: boolean;
};
const mappingColumns = `p.subject,p.credentials_digest AS "credentialsDigest",
  u.auth_generation::text AS "authGeneration",
  (SELECT jsonb_build_array(j.generation::text,j.state,j.attempts,j.control_phase,
    j.control_id,j.control_lease_id,j.control_reads,j.freeze_acknowledged_at,j.unfreeze_acknowledged_at)::text
    FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject
    ORDER BY j.generation DESC LIMIT 1) AS "providerControl",
  EXISTS(SELECT 1 FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject
    AND j.generation=u.auth_generation AND (j.state IN ('pending','running')
      OR (j.state='manual' AND j.failure_reason='uncertain_provider_outcome'))) AS "providerResetActive"`;

// Decision 0008: requests never wait on Privy. A request whose last Privy read
// is older than `staleAfterMs` schedules this re-check. The claim below lets one
// process per account read Privy once per interval, with no lock held during
// the call; results are written only if the mapping did not change meanwhile.
// A deleted, frozen or guest Privy user loses every session. A method change
// is recorded with an audit event and an in-app notice. An inconclusive check
// hands its claim back so the account is due again after `retryAfterMs`.
export function createProviderRecheck(
  database: Pool,
  inspector: Pick<IdentityVerifier, "inspect">,
  options: {
    staleAfterMs?: number;
    maxConcurrent?: number;
    pauseAfterUnavailableMs?: number;
    retryAfterMs?: number;
    now?: () => number;
    observe?: (outcome: ProviderRecheckOutcome, error?: unknown) => void;
  } = {},
): ProviderCheckScheduler & {
  run(userId: string): Promise<ProviderRecheckOutcome>;
  drain(): Promise<void>;
  close(): Promise<void>;
} {
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const pauseMs = options.pauseAfterUnavailableMs ?? 60_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<ProviderRecheckOutcome>>();
  let pausedUntil = 0;
  let closed = false;

  async function check(userId: string): Promise<ProviderRecheckOutcome> {
    if (now() < pausedUntil) return "skipped";
    const claim = (
      await database.query<Mapping & { claimedAt: string }>(
        `UPDATE provider_identities p SET checked_at=clock_timestamp()
        FROM users u
        WHERE p.provider='privy' AND p.user_id=$1 AND u.id=p.user_id
          AND u.account_status='active'
          AND (p.checked_at IS NULL OR p.checked_at <= clock_timestamp()
            - make_interval(secs => $2::double precision / 1000))
        RETURNING ${mappingColumns},p.checked_at::text AS "claimedAt"`,
        [userId, staleAfterMs],
      )
    ).rows[0];
    if (!claim) return "skipped";
    let outcome: ProviderRecheckOutcome;
    try {
      outcome = await inspect(userId, claim);
    } catch (error) {
      await release(userId, claim.claimedAt).catch(() => {});
      throw error;
    }
    if (outcome === "deferred" || outcome === "unavailable")
      await release(userId, claim.claimedAt);
    return outcome;
  }

  // Makes the account due again after the retry delay, unless another writer
  // (a sign-in or a later check) has refreshed it since this claim.
  async function release(userId: string, claimedAt: string) {
    await database.query(
      `UPDATE provider_identities SET checked_at=checked_at
        - make_interval(secs => GREATEST($3::double precision - $4::double precision, 0) / 1000)
      WHERE provider='privy' AND user_id=$1 AND checked_at=$2::timestamptz`,
      [userId, claimedAt, staleAfterMs, retryAfterMs],
    );
  }

  async function inspect(
    userId: string,
    claim: Mapping,
  ): Promise<ProviderRecheckOutcome> {
    // The app's own sign-out reset freezes the Privy user for a moment; that
    // freeze is not a provider-side change.
    if (claim.providerResetActive) return "deferred";
    let state;
    try {
      state = await inspector.inspect(claim.subject);
    } catch (error) {
      if (error instanceof ProviderCredentialChangedError)
        return settle(userId, claim, null);
      // Outage or rate limit: back off for every account in this process.
      pausedUntil = now() + pauseMs;
      return "unavailable";
    }
    if (state.credentialsDigest !== claim.credentialsDigest)
      return settle(userId, claim, state);
    // Older mappings may predate the stored snapshot.
    if (state.credentials)
      await database.query(
        `UPDATE provider_identities SET credentials_snapshot=$3::jsonb
        WHERE provider='privy' AND user_id=$1 AND subject=$2
          AND credentials_digest=$4 AND credentials_snapshot IS NULL`,
        [
          userId,
          claim.subject,
          JSON.stringify(state.credentials),
          claim.credentialsDigest,
        ],
      );
    return "unchanged";
  }

  async function settle(
    userId: string,
    claim: Mapping,
    state: Awaited<ReturnType<typeof inspector.inspect>> | null,
  ): Promise<ProviderRecheckOutcome> {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const account = await lockAccount(client, userId);
      const current = account
        ? (
            await client.query<Mapping>(
              `SELECT ${mappingColumns} FROM provider_identities p JOIN users u ON u.id=p.user_id
              WHERE p.provider='privy' AND p.user_id=$1`,
              [userId],
            )
          ).rows[0]
        : undefined;
      // Compare-and-set: sign-in, sign-out, passkey activation or the app's
      // own provider reset may have changed the account during the read.
      if (
        !current ||
        current.subject !== claim.subject ||
        current.credentialsDigest !== claim.credentialsDigest ||
        current.authGeneration !== claim.authGeneration ||
        current.providerControl !== claim.providerControl ||
        current.providerResetActive
      ) {
        await client.query("ROLLBACK");
        return "deferred";
      }
      if (!state) {
        await revokeAccountSessions(client, userId, {
          action: "sessions.incident",
          reason: "provider_change",
        });
        await client.query("COMMIT");
        return "revoked";
      }
      if (
        await passkeyActivationPending(client, {
          userId,
          authGeneration: current.authGeneration,
          subject: current.subject,
          beforeDigest: current.credentialsDigest,
          current: state,
        })
      ) {
        await client.query("ROLLBACK");
        return "deferred";
      }
      const recorded = await recordProviderCredentials(client, {
        userId,
        subject: current.subject,
        previousDigest: current.credentialsDigest,
        identity: state,
        source: "recheck",
      });
      await client.query("COMMIT");
      return recorded ? "recorded" : "deferred";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function run(userId: string) {
    const running = inFlight.get(userId);
    if (running) return running;
    if (closed || inFlight.size >= maxConcurrent)
      return Promise.resolve<ProviderRecheckOutcome>("skipped");
    const work = check(userId).finally(() => inFlight.delete(userId));
    inFlight.set(userId, work);
    return work;
  }

  return {
    staleAfterMs,
    run,
    schedule(userId) {
      void run(userId).then(
        (outcome) => options.observe?.(outcome),
        (error: unknown) => options.observe?.("error", error),
      );
    },
    async drain() {
      await Promise.allSettled([...inFlight.values()]);
    },
    // Shutdown: start no new checks, then wait for the running ones.
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
