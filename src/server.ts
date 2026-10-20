import { createA4Repository } from "./features/a4/repository.ts";
import { createAccountWallet } from "./features/account-wallet/repository.ts";
import { createCoinSandboxRepository } from "./features/account-wallet/sandbox-repository.ts";
import { createCoinDebateSandbox } from "./features/account-wallet/debate-sandbox.ts";
import { createSandboxWebhookRouter } from "./features/account-wallet/sandbox-webhooks.ts";
import { createSandboxErrorReports } from "./features/account-wallet/sandbox-reports.ts";
import { createPublicBotRepository } from "./features/a4/public-bots.ts";
import { createApp } from "./app.ts";
import { createMessageRepository } from "./features/messages/repository.ts";
import { createDiscoveryRepository } from "./features/discovery/repository.ts";
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
import { loadProviderConfig } from "./platform/auth/provider-config.ts";
import {
  createPrivyVerifier,
  createPrivySessionControl,
} from "./platform/auth/privy.ts";
import { createProviderRevocation } from "./platform/auth/provider-revocation.ts";
import { createProviderAccounts } from "./platform/auth/provider-accounts.ts";
import { createProviderSessionMonitor } from "./platform/auth/provider-session-monitor.ts";
import { createAccountOperationRepository } from "./platform/auth/account-operations.ts";
import { AccountOperationError } from "./platform/auth/account-operations.ts";
import { createSecurityPasskeyRepository } from "./platform/auth/security-passkeys.ts";
import { createProviderPasskeys } from "./platform/auth/provider-passkeys.ts";
import { createProviderPasskeyBootstrap } from "./platform/auth/provider-passkey-bootstrap.ts";
import { createProviderWalletOperations } from "./platform/auth/provider-wallet-operations.ts";
import { createLegacyProviderLink } from "./platform/auth/legacy-provider-link.ts";
import { createProviderIdentityRecovery } from "./platform/auth/provider-identity-recovery.ts";
import { createAccountAccessRepository } from "./platform/auth/account-access.ts";
import {
  createRedisAbuseStore,
  createSharedAbuseLimiter,
  createSharedAccountAttemptLimiter,
} from "./platform/shared-abuse.ts";
import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { createRuntime } from "./platform/runtime.ts";
import { createMetrics } from "./platform/metrics.ts";
import { createCommunityStreams } from "./features/community/streams.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();
const database = createDatabase(config.databaseUrl, logger, (seconds) =>
  metrics.poolWait.observe(seconds),
);
const communityStreams = config.communityStream.enabled
  ? createCommunityStreams(
      database,
      config.databaseUrl,
      logger,
      metrics.community,
      config.communityStream,
    )
  : undefined;
const messages = createMessageRepository(database);
const discovery = createDiscoveryRepository(database);
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
const wallets = createWalletRepository(database);
const providerConfig = loadProviderConfig(process.env);
const abuseStore = providerConfig
  ? createRedisAbuseStore({
      url: providerConfig.redisUrl,
      observe: (outcome, seconds) => {
        metrics.redisOutcome.inc({ outcome });
        metrics.redisLatency.observe(seconds);
      },
    })
  : undefined;
const authProvider = providerConfig
  ? {
      appId: providerConfig.appId,
      clientId: providerConfig.clientId,
      verifier: createPrivyVerifier(providerConfig),
      accounts: createProviderAccounts(database),
    }
  : undefined;
const sessions = createSessionRepository(database, {
  verifyProviderSession: authProvider
    ? createProviderSessionMonitor(database, authProvider.verifier)
    : undefined,
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
    | "provider.passkey.restart",
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
const app = createApp({
  coinWebhook: config.coinSandboxWebhookSecret
    ? createSandboxWebhookRouter({
        database,
        rail: "simulation",
        secret: config.coinSandboxWebhookSecret,
      })
    : undefined,
  coinSandbox: coinDebates
    ? {
        sandbox: createCoinSandboxRepository(database, { rail: "simulation" }),
        debates: coinDebates,
        operations: accountSecurity.operations,
        reports: createSandboxErrorReports(database, "simulation"),
      }
    : undefined,
  messages,
  a4,
  publicBots: createPublicBotRepository(database),
  discovery,
  identity,
  matching,
  media,
  mediaProvider,
  mediaAccountRevocation,
  mediaAdmissionSecret: config.media?.livekitSecret,
  community,
  communityStreams,
  metrics,
  measurement,
  users,
  sessions,
  wallets,
  logger,
  environment: config.environment,
  homepageReferenceEnabled: config.homepageReferenceEnabled,
  applicationOrigin: config.applicationOrigin,
  trustProxy: config.trustProxy,
  requestBodyLimit: config.requestBodyLimit,
  apiRateLimit: config.apiRateLimit,
  authRateLimit: config.authRateLimit,
  rateLimitWindowMs: config.rateLimitWindowMs,
  sessionDurationMs: config.sessionDurationMs,
  siweRpcUrls: config.siweRpcUrls,
  authProvider,
  accountSecurity,
  synchronizeProvider: providerRevocation
    ? (userId) => providerRevocation.synchronize(userId)
    : undefined,
  accountWallet: createAccountWallet(database),
  sharedAccountLimiter:
    providerConfig && abuseStore
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          scope: "account",
          account: true,
          limit: 30,
          windowMs: 15 * 60 * 1000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
  sharedAuthLimiter:
    providerConfig && abuseStore
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          scope: "auth",
          limit: 120,
          windowMs: 15 * 60 * 1_000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
});

const runtime = createRuntime({
  a4,
  app,
  database,
  sessions,
  accountSecurityCleanup: async () => {
    await Promise.all([
      accountSecurity.operations.deleteExpired(),
      accountSecurity.passkeys.deleteExpiredChallenges(),
      accountSecurity.access?.deleteExpiredChallenges(),
    ]);
  },
  mediaAccountRevocation,
  coinDebates,
  identity,
  matching,
  community,
  communityStreams,
  measurement,
  media,
  mediaProvider,
  mediaOperations,
  wallets,
  logger,
  config,
  verifyDatabase: () =>
    verifyDatabaseState(database, new URL("../migrations", import.meta.url)),
  backgroundJobs: config.backgroundJobs,
});

await runtime.start();
let providerWork: Promise<void> | undefined;
const synchronizeProvider = () => {
  if (!providerRevocation || providerWork) return;
  providerWork = providerRevocation
    .synchronize()
    .catch(() => {
      metrics.authJourney.inc({ event: "provider_revocation_retry" });
    })
    .finally(() => {
      providerWork = undefined;
    });
};
const providerTimer = providerRevocation
  ? setInterval(synchronizeProvider, 30_000)
  : undefined;
providerTimer?.unref();
synchronizeProvider();

logger.info(
  {
    environment: config.environment,
    host: config.host,
    port: config.port,
  },
  "server started",
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "shutdown requested");
  const forcedExit = setTimeout(() => {
    logger.fatal("forced shutdown");
    process.exit(1);
  }, 10_000);
  forcedExit.unref();

  try {
    clearInterval(providerTimer);
    await providerWork;
    await runtime.stop();
    abuseStore?.close();
    clearTimeout(forcedExit);
  } catch (error) {
    logger.error({ error }, "server shutdown failed");
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
