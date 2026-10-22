import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { IdentityVerifier, ProviderSessionControl } from "./privy.ts";
import { ProviderResetRetryError } from "./provider-revocation.ts";
import { firstProviderPasskeyBootstrapAllowed } from "./provider-passkey-policy.ts";
import { inspectProviderPasskeyAddition } from "./provider-passkeys.ts";
import {
  providerCredentialsDigest,
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";

export type FirstPasskeyResetRepairInput = {
  userId: string;
  requestId: string;
  activityReview: {
    evidenceDigest: string;
    noIndependentFreeze: true;
    frozenAt: number;
    expectedGeneration: string;
    expectedAttempts: number;
  };
};
type Snapshot = {
  userId: string;
  generation: string;
  mappedGeneration: string;
  status: string;
  subject: string;
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
  email: string | null;
  methods: string[];
  attempts: number;
  state: string;
  failureReason: string | null;
  confirmedFrozenAt: string | null;
  available: boolean;
  freezeInWindow: boolean;
  leaseUntil: string;
};
type Original = {
  id: string;
  before: ProviderCredential[];
  candidateDigest: string | null;
  credentialId: string | null;
  publicKey: Buffer | null;
  publicKeyDigest: string | null;
};
type Binding = {
  requestId: string;
  generation: string;
  attempts: number;
  frozenAt: number;
  evidenceDigest: string;
  ownerReviewed: true;
  noIndependentFreeze: true;
  providerSubjectDigest: string;
  beforeDigest: string;
  currentDigest: string;
  publicKeyDigest: string;
  credentialIdDigest: string;
  originalIntentId: string;
};
type Event = { eventType: string; metadata: Binding };
const requestedEvent = "provider.passkey.reset_repair_requested";
const completedEvent = "provider.passkey.reset_repair_completed";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new ProviderResetRetryError("snapshot");
function same(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}
function status(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
  )
    return error.status;
  return undefined;
}

// Owner-only reset completion for an unfinished FIRST key. This never adopts
// the candidate key/digest, issues a cookie, or supplies user authorization.
// A fresh provider login and the separate native-UV bootstrap remain mandatory.
export function createFirstPasskeyResetRepair(
  database: Pool,
  inspector: Pick<IdentityVerifier, "inspect">,
  provider: Pick<ProviderSessionControl, "state" | "unfreeze">,
  { origin }: { origin: string },
) {
  async function validate(input: FirstPasskeyResetRepairInput) {
    if (
      (
        await database.query<{ owner: boolean }>(
          "SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AS owner",
        )
      ).rows[0]?.owner !== true
    )
      throw new ProviderResetRetryError("owner");
    const review = input.activityReview;
    if (
      !/^[1-9][0-9]{0,18}$/.test(input.userId) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.requestId) ||
      !review ||
      review.noIndependentFreeze !== true ||
      !/^[0-9a-f]{64}$/.test(review.evidenceDigest) ||
      !/^[1-9][0-9]{0,18}$/.test(review.expectedGeneration) ||
      !Number.isSafeInteger(review.expectedAttempts) ||
      review.expectedAttempts < 1 ||
      !Number.isSafeInteger(review.frozenAt) ||
      review.frozenAt < 1
    )
      throw new ProviderResetRetryError("input");
    new URL(origin);
  }
  async function read(
    source: Pick<Pool | PoolClient, "query">,
    input: FirstPasskeyResetRepairInput,
  ) {
    return (
      await source.query<Snapshot>(
        `SELECT u.id::text AS "userId",u.auth_generation::text AS generation,u.account_status AS status,
      p.subject,p.auth_generation::text AS "mappedGeneration",p.credentials_digest AS "credentialsDigest",p.credentials_snapshot AS "credentialsSnapshot",p.email,p.methods,
      j.attempts,j.state,j.failure_reason AS "failureReason",j.confirmed_frozen_at::text AS "confirmedFrozenAt",j.lease_until::text AS "leaseUntil",j.lease_until<clock_timestamp() AS available,
      EXISTS(SELECT 1 FROM identity_audit_events a WHERE a.user_id=u.id AND a.event_type IN ('sessions.logout_all','sessions.logout_others','sessions.incident')
        AND a.metadata->>'authGeneration'=u.auth_generation::text AND to_timestamp($2::double precision)>=date_trunc('second',a.occurred_at)
        AND to_timestamp($2::double precision)>=date_trunc('second',j.lease_until-interval '30 seconds')
        AND to_timestamp($2::double precision)<j.lease_until) AS "freezeInWindow"
      FROM users u JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy'
      JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation AND j.subject=p.subject WHERE u.id=$1`,
        [input.userId, input.activityReview.frozenAt],
      )
    ).rows[0];
  }
  async function history(
    source: Pick<Pool | PoolClient, "query">,
    input: FirstPasskeyResetRepairInput,
  ) {
    return (
      await source.query<Event>(
        `SELECT a.event_type AS "eventType",a.metadata FROM identity_audit_events a
      WHERE a.user_id=$1 AND a.metadata->>'requestId'=$2 AND a.event_type IN ($3,$4) ORDER BY a.id`,
        [input.userId, input.requestId, requestedEvent, completedEvent],
      )
    ).rows;
  }
  async function eligible(
    source: Pick<Pool | PoolClient, "query">,
    current: Snapshot | undefined,
    identity: Awaited<ReturnType<IdentityVerifier["inspect"]>>,
    input: FirstPasskeyResetRepairInput,
  ): Promise<Binding> {
    const review = input.activityReview;
    if (
      !current ||
      current.userId !== input.userId ||
      current.status !== "active" ||
      current.generation !== review.expectedGeneration ||
      current.attempts !== review.expectedAttempts ||
      !current.available ||
      !current.freezeInWindow ||
      identity.subject !== current.subject ||
      !(await firstProviderPasskeyBootstrapAllowed(source, input.userId))
    )
      throw unavailable();
    if (
      (
        await source.query(
          "SELECT 1 FROM provider_revocation_jobs WHERE user_id=$1 AND subject=$2 AND generation<$3 AND state<>'complete' LIMIT 1",
          [input.userId, current.subject, current.generation],
        )
      ).rowCount
    )
      throw unavailable();
    const before = verifiedStoredCredentials(current);
    if (!before?.length || before.some((entry) => entry.type === "passkey"))
      throw unavailable();
    const addition = inspectProviderPasskeyAddition(before, identity);
    if (!addition) throw unavailable();
    const site = new URL(origin);
    const originals = (
      await source.query<Original>(
        `SELECT id,before_credentials AS before,candidate_digest AS "candidateDigest",candidate_credential_id AS "credentialId",
      candidate_public_key AS "publicKey",candidate_key_digest AS "publicKeyDigest" FROM provider_passkey_intents
      WHERE user_id=$1 AND provider_subject=$2 AND before_digest=$3 AND intent_mode='addition' AND consumed_at IS NULL AND origin=$4 AND rp_id=$5 ORDER BY created_at DESC,id`,
        [
          input.userId,
          current.subject,
          current.credentialsDigest,
          site.origin,
          site.hostname,
        ],
      )
    ).rows;
    const original = originals.find(
      (row) =>
        providerCredentialsDigest(row.before) === current.credentialsDigest &&
        (row.candidateDigest === null ||
          (row.candidateDigest === identity.credentialsDigest &&
            row.credentialId === addition.credentialId &&
            row.publicKeyDigest === addition.publicKeyDigest &&
            row.publicKey?.equals(addition.publicKey))),
    );
    if (!original) throw unavailable();
    return {
      requestId: input.requestId,
      generation: current.generation,
      attempts: current.attempts,
      frozenAt: review.frozenAt,
      evidenceDigest: review.evidenceDigest,
      ownerReviewed: true,
      noIndependentFreeze: true,
      providerSubjectDigest: sha(current.subject),
      beforeDigest: current.credentialsDigest,
      currentDigest: identity.credentialsDigest,
      publicKeyDigest: addition.publicKeyDigest,
      credentialIdDigest: sha(addition.credentialId),
      originalIntentId: original.id,
    };
  }
  async function locked<T>(
    input: FirstPasskeyResetRepairInput,
    expected: Snapshot,
    action: (client: PoolClient, current: Snapshot) => Promise<T>,
  ) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`privy:${expected.subject}`],
      );
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        input.userId,
      ]);
      await client.query(
        "SELECT subject FROM provider_identities WHERE user_id=$1 AND provider='privy' FOR UPDATE",
        [input.userId],
      );
      await client.query(
        "SELECT generation FROM provider_revocation_jobs WHERE user_id=$1 AND generation=$2 FOR UPDATE",
        [input.userId, expected.generation],
      );
      const current = await read(client, input);
      if (!current || !same(current, expected)) throw unavailable();
      const result = await action(client, current);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function complete(
    client: PoolClient,
    input: FirstPasskeyResetRepairInput,
    current: Snapshot,
    binding: Binding,
  ) {
    if (
      current.state !== "manual" ||
      current.failureReason !== "uncertain_provider_outcome" ||
      current.confirmedFrozenAt !== String(binding.frozenAt) ||
      current.generation === current.mappedGeneration
    )
      throw unavailable();
    await client.query(
      "UPDATE provider_identities SET auth_generation=$2,minimum_issued_at=GREATEST(minimum_issued_at,$3) WHERE user_id=$1 AND subject=$4 AND credentials_digest=$5",
      [
        input.userId,
        current.generation,
        binding.frozenAt + 1,
        current.subject,
        binding.beforeDigest,
      ],
    );
    await client.query(
      "UPDATE provider_revocation_jobs SET state='complete',failure_reason=NULL WHERE user_id=$1 AND generation=$2 AND subject=$3",
      [input.userId, current.generation, current.subject],
    );
    await client.query(
      "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,$2,$1::bigint::text,$3::jsonb)",
      [input.userId, completedEvent, JSON.stringify(binding)],
    );
    return { state: "complete" as const };
  }
  async function inspect(input: FirstPasskeyResetRepairInput) {
    const initial = await read(database, input);
    if (!initial) throw unavailable();
    const identity = await inspector.inspect(initial.subject);
    return {
      initial,
      identity,
      binding: await eligible(database, initial, identity, input),
    };
  }
  function completed(current: Snapshot, events: Event[], binding: Binding) {
    return (
      current.state === "complete" &&
      current.generation === current.mappedGeneration &&
      current.confirmedFrozenAt === String(binding.frozenAt) &&
      events.length === 2 &&
      events[0]?.eventType === requestedEvent &&
      events[1]?.eventType === completedEvent &&
      events.every((event) => same(event.metadata, binding))
    );
  }
  async function perform(
    input: FirstPasskeyResetRepairInput,
    finalize: boolean,
  ) {
    let stage: ConstructorParameters<typeof ProviderResetRetryError>[0] =
      "owner";
    try {
      await validate(input);
      stage = "provider_inspection";
      const { initial, identity, binding } = await inspect(input),
        events = await history(database, input);
      if (completed(initial, events, binding))
        return { state: "complete" as const };
      if (
        initial.state !== "manual" ||
        initial.failureReason !== "uncertain_provider_outcome" ||
        initial.generation === initial.mappedGeneration
      )
        throw unavailable();
      const signal = AbortSignal.timeout(20_000);
      stage = "provider_state";
      const state = await provider.state(initial.subject, { signal });
      if (finalize) {
        if (
          state.frozenAt !== null ||
          initial.confirmedFrozenAt !== String(binding.frozenAt) ||
          events.length !== 1 ||
          events[0]?.eventType !== requestedEvent ||
          !same(events[0].metadata, binding)
        )
          throw unavailable();
        stage = "commit";
        return await locked(input, initial, async (client, current) => {
          if (
            !same(await eligible(client, current, identity, input), binding) ||
            !same(await history(client, input), events)
          )
            throw unavailable();
          return complete(client, input, current, binding);
        });
      }
      if (
        state.frozenAt !== binding.frozenAt ||
        initial.confirmedFrozenAt !== null ||
        events.length
      )
        throw unavailable();
      // Commit the one-use mutation marker before any unfreeze. A failed or
      // uncertain attempt can only be finalized with GETs, never repeated.
      stage = "activity_review";
      await locked(input, initial, async (client, current) => {
        if (
          !same(await eligible(client, current, identity, input), binding) ||
          (await history(client, input)).length
        )
          throw unavailable();
        await client.query(
          "UPDATE provider_revocation_jobs SET confirmed_frozen_at=$3 WHERE user_id=$1 AND generation=$2",
          [input.userId, current.generation, binding.frozenAt],
        );
        await client.query(
          "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,$2,$1::bigint::text,$3::jsonb)",
          [input.userId, requestedEvent, JSON.stringify(binding)],
        );
      });
      stage = "provider_inspection";
      const admitted = await inspect(input);
      if (!same(admitted.binding, binding)) throw unavailable();
      return await locked(input, admitted.initial, async (client, current) => {
        const saved = await history(client, input);
        if (
          !same(
            await eligible(client, current, admitted.identity, input),
            binding,
          ) ||
          saved.length !== 1 ||
          saved[0]?.eventType !== requestedEvent ||
          !same(saved[0].metadata, binding) ||
          current.confirmedFrozenAt !== String(binding.frozenAt)
        )
          throw unavailable();
        stage = "provider_state";
        if (
          (await provider.state(current.subject, { signal })).frozenAt !==
          binding.frozenAt
        )
          throw unavailable();
        stage = "unfreeze";
        await provider.unfreeze(current.subject, { signal });
        stage = "unfreeze_confirmation";
        for (let attempt = 0; attempt < 6; attempt++) {
          const observed = await provider.state(current.subject, { signal });
          if (observed.frozenAt === null) {
            stage = "commit";
            return complete(client, input, current, binding);
          }
          if (observed.frozenAt !== binding.frozenAt) throw unavailable();
          if (attempt < 5) await delay(1500, undefined, { signal });
        }
        throw new ProviderResetRetryError(stage);
      });
    } catch (error) {
      if (error instanceof ProviderResetRetryError) throw error;
      throw new ProviderResetRetryError(stage, status(error));
    }
  }
  return Object.freeze({
    repair: (input: FirstPasskeyResetRepairInput) => perform(input, false),
    finalize: (input: FirstPasskeyResetRepairInput) => perform(input, true),
  });
}
