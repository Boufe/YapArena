import type { Pool } from "pg";
import { createA4Repository } from "./features/a4/repository.ts";
import { createCoinDebateSandbox } from "./features/account-wallet/debate-sandbox.ts";
import { createIdentityRepository } from "./features/identity/repository.ts";
import { createMatchingRepository } from "./features/matching/repository.ts";
import { createMediaRepository } from "./features/media/repository.ts";
import { createMediaProvider } from "./features/media/provider.ts";
import { createMediaOperations } from "./features/media/operations.ts";
import { createMediaAccountRevocation } from "./features/media/account-revocation.ts";
import { createReplayJobs } from "./features/media/replay-jobs.ts";
import { createCommunityRepository } from "./features/community/repository.ts";
import { createMeasurementRepository } from "./features/measurement/repository.ts";
import { createSessionRepository } from "./platform/auth/sessions.ts";
import { createWalletRepository } from "./platform/auth/wallets.ts";
import { createUserRepository } from "./platform/auth/users.ts";
import type { loadProviderConfig } from "./platform/auth/provider-config.ts";
import {
  createPrivyVerifier,
  createPrivySessionControl,
} from "./platform/auth/privy.ts";
import { createProviderRevocation } from "./platform/auth/provider-revocation.ts";
import { createProviderAccounts } from "./platform/auth/provider-accounts.ts";
import { createEmbeddedWalletProvisioning } from "./platform/auth/embedded-wallet-provisioning.ts";
import { createPrivyEmbeddedWalletProvider } from "./platform/auth/embedded-wallet-provider.ts";
import { createProviderRecheck } from "./platform/auth/provider-recheck.ts";
import {
  AccountOperationError,
  createAccountOperationRepository,
} from "./platform/auth/account-operations.ts";
import { createSecurityPasskeyRepository } from "./platform/auth/security-passkeys.ts";
import { createProviderPasskeys } from "./platform/auth/provider-passkeys.ts";
import { createProviderPasskeyBootstrap } from "./platform/auth/provider-passkey-bootstrap.ts";
import { createProviderWalletOperations } from "./platform/auth/provider-wallet-operations.ts";
import { createLegacyProviderLink } from "./platform/auth/legacy-provider-link.ts";
import { createProviderIdentityRecovery } from "./platform/auth/provider-identity-recovery.ts";
import {
  createAccountAccessRepository,
  deleteExpiredAccessChallenges,
} from "./platform/auth/account-access.ts";
import {
  createRedisAbuseStore,
  createSharedAccountAttemptLimiter,
} from "./platform/shared-abuse.ts";
import type { loadConfig } from "./platform/config.ts";
import type { createLogger } from "./platform/logger.ts";
import type { createMetrics } from "./platform/metrics.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { createRuntime } from "./platform/runtime.ts";

type ServiceOptions = {
  config: ReturnType<typeof loadConfig>;
  providerConfig: ReturnType<typeof loadProviderConfig>;
  database: Pool;
  logger: ReturnType<typeof createLogger>;
  metrics: ReturnType<typeof createMetrics>;
};

// Builds the repositories, providers and background jobs shared by the web
// server and the background worker, so both processes run identical jobs.
export function createServices({
  config,
  providerConfig,
  database,
  logger,
  metrics,
}: ServiceOptions) {
  const identity = createIdentityRepository(database);
  const matching = createMatchingRepository(database);
  const community = createCommunityRepository(database);
  const measurement = createMeasurementRepository(database);
  const a4 = createA4Repository(database, config.a4Mode, config.a4Funding);
  const media = config.media
    ? createMediaRepository(database, {
        enabled: config.replayPackaging.enabled,
        allowedRooms: config.media.replayEdgeRooms,
      })
    : undefined;
  const replayJobs = config.replayPackaging.enabled
    ? createReplayJobs(database)
    : undefined;
  const baseMediaProvider = config.media
    ? createMediaProvider(
        config.media,
        replayJobs
          ? (key) => replayJobs.ready(key.split("/")[1]!, key)
          : undefined,
      )
    : undefined;
  const mediaOperations =
    media && baseMediaProvider
      ? createMediaOperations({
          database,
          media,
          provider: baseMediaProvider,
          logger,
          count: (kind) => metrics.mediaControl.inc({ kind }),
        })
      : undefined;
  const mediaProvider = mediaOperations?.provider;
  const mediaAccountRevocation = mediaProvider
    ? createMediaAccountRevocation(database, {
        supportsTokenRevocation: mediaProvider.supportsTokenRevocation,
        mintSpeakerToken: (debateId, suffix, side) =>
          mediaProvider.token(debateId, suffix, true, side),
        removeSpeaker: (debateId, identity) =>
          mediaProvider.removeSpeaker(debateId, identity),
        timeoutMs: 6000,
        observe: ({ result, seconds }) => {
          metrics.mediaControl.inc({ kind: `speaker_revocation_${result}` });
          metrics.authLatency.observe({ phase: "speaker_revocation" }, seconds);
        },
      })
    : undefined;
  const users = createUserRepository(database);
  const wallets = createWalletRepository(database, {
    allowNewAccounts: !providerConfig,
  });
  const abuseStore = providerConfig
    ? createRedisAbuseStore({
        url: providerConfig.redisUrl,
        observe: (outcome, seconds) => {
          metrics.redisOutcome.inc({ outcome });
          metrics.redisLatency.observe(seconds);
        },
      })
    : undefined;
  const embeddedWallet = providerConfig
    ? createEmbeddedWalletProvisioning(
        database,
        createPrivyEmbeddedWalletProvider({
          appId: providerConfig.appId,
          appSecret: providerConfig.appSecret,
        }),
      )
    : undefined;
  const authProvider = providerConfig
    ? {
        appId: providerConfig.appId,
        clientId: providerConfig.clientId,
        verifier: createPrivyVerifier(providerConfig),
        accounts: createProviderAccounts(database),
        embeddedWallet: embeddedWallet
          ? {
              repository: embeddedWallet,
              authorizeAttempt: (userId: string) =>
                authorizeAccountAttempt(userId, "embedded.wallet.retry"),
            }
          : undefined,
      }
    : undefined;
  // Requests never call Privy; a stale Privy read schedules this re-check.
  // Only web requests trigger it; the worker never serves a session lookup.
  const providerRecheck = authProvider
    ? createProviderRecheck(database, authProvider.verifier, {
        observe: (outcome, error) => {
          metrics.authJourney.inc({ event: `provider_recheck_${outcome}` });
          if (error) logger.error({ error }, "provider re-check failed");
        },
      })
    : undefined;
  const sessions = createSessionRepository(database, {
    providerCheck: providerRecheck,
  });
  const providerRevocation = providerConfig
    ? createProviderRevocation(
        database,
        createPrivySessionControl(providerConfig),
      )
    : undefined;
  const accountAttempt =
    providerConfig && abuseStore
      ? createSharedAccountAttemptLimiter({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          limit: 20,
          windowMs: 15 * 60_000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined;
  async function authorizeAccountAttempt(
    userId: string,
    purpose:
      | "security.login"
      | "provider.credentials.reconcile"
      | "provider.passkey.link"
      | "provider.passkey.restart"
      | "embedded.wallet.retry",
  ) {
    if (!accountAttempt)
      throw new AccountOperationError(
        503,
        "sign-in protection is temporarily unavailable",
      );
    const outcome = await accountAttempt(userId, purpose);
    if (outcome !== "allowed")
      throw new AccountOperationError(
        outcome === "throttled" ? 429 : 503,
        outcome === "throttled"
          ? "too many attempts; try again shortly"
          : "sign-in protection is temporarily unavailable",
      );
  }
  const accountSecurity = {
    operations: createAccountOperationRepository(
      database,
      authProvider?.verifier,
    ),
    passkeys: createSecurityPasskeyRepository(database),
    providerPasskeys: authProvider
      ? createProviderPasskeys(database, authProvider.verifier)
      : undefined,
    providerPasskeyBootstrap: authProvider
      ? createProviderPasskeyBootstrap(database, authProvider.verifier, {
          authorizeAttempt: authorizeAccountAttempt,
        })
      : undefined,
    authorizeProviderPasskeyAttempt: (userId: string) =>
      authorizeAccountAttempt(userId, "provider.passkey.link"),
    walletOperations: createProviderWalletOperations(
      database,
      authProvider?.verifier,
    ),
    legacyProviderLink: authProvider
      ? createLegacyProviderLink(database, authProvider.verifier)
      : undefined,
    providerIdentityRecovery: authProvider
      ? createProviderIdentityRecovery(database, authProvider.verifier)
      : undefined,
    access: authProvider
      ? createAccountAccessRepository(database, authProvider.verifier, {
          authorizeAttempt: authorizeAccountAttempt,
        })
      : undefined,
  };
  const coinDebates = config.coinSandboxEnabled
    ? createCoinDebateSandbox(database, "simulation")
    : undefined;

  return Object.freeze({
    identity,
    matching,
    community,
    measurement,
    a4,
    media,
    mediaProvider,
    mediaAccountRevocation,
    users,
    wallets,
    abuseStore,
    authProvider,
    sessions,
    providerRecheck,
    providerRevocation,
    accountSecurity,
    coinDebates,
    // Everything createRuntime needs except the web-only app and community
    // streams, and the per-process background-jobs switch.
    background: {
      a4,
      coinDebates,
      database,
      sessions,
      accountSecurityCleanup: async () => {
        await Promise.all([
          accountSecurity.operations.deleteExpired(),
          accountSecurity.passkeys.deleteExpiredChallenges(),
          deleteExpiredAccessChallenges(database),
        ]);
      },
      mediaAccountRevocation,
      identity,
      matching,
      community,
      measurement,
      media,
      mediaProvider,
      mediaOperations,
      wallets,
      providerRevocation,
      embeddedWallet,
      metrics,
      logger,
      config,
      verifyDatabase: () =>
        verifyDatabaseState(
          database,
          new URL("../migrations", import.meta.url),
        ),
    },
    close() {
      abuseStore?.close();
    },
  });
}

// The dedicated worker runs every background job regardless of
// RUN_BACKGROUND_JOBS; it never listens for HTTP or starts community streams.
export function createBackgroundWorker({
  config,
  providerConfig,
  database,
  logger,
  metrics,
  ...runtimeOptions
}: ServiceOptions &
  Partial<
    Pick<
      Parameters<typeof createRuntime>[0],
      "verifyDatabase" | "setIntervalFn" | "clearIntervalFn"
    >
  >) {
  const services = createServices({
    config,
    providerConfig,
    database,
    logger,
    metrics,
  });
  const runtime = createRuntime({ ...services.background, ...runtimeOptions });
  return Object.freeze({
    start: runtime.start,
    async stop() {
      await runtime.stop();
      services.close();
    },
  });
}
