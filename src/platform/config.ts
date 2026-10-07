const environments = new Set(["development", "test", "production"]);
const logLevels = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

function parseInteger(
  value: string,
  name: string,
  { minimum, maximum }: { minimum: number; maximum: number },
) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function parseTrustProxy(value: string | undefined): number | false {
  if (value === undefined || value === "false") return false;
  return parseInteger(value, "TRUST_PROXY", { minimum: 1, maximum: 10 });
}

function parseSiweRpcUrls(
  value: string | undefined,
  environment: string,
): Readonly<Record<string, string>> {
  if (!value) return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SIWE_RPC_URLS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SIWE_RPC_URLS must be a JSON object");
  }
  const urls: Record<string, string> = {};
  for (const [chainId, value] of Object.entries(parsed)) {
    if (
      !/^[1-9]\d*$/.test(chainId) ||
      !Number.isSafeInteger(Number(chainId)) ||
      typeof value !== "string"
    ) {
      throw new Error("SIWE_RPC_URLS has an invalid chain or URL");
    }
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" &&
        (environment === "production" || url.protocol !== "http:")
      )
        throw new Error();
      if (url.username || url.password) throw new Error();
    } catch {
      throw new Error("SIWE_RPC_URLS has an invalid chain or URL");
    }
    urls[chainId] = value;
  }
  return Object.freeze(urls);
}

function parseMedia(environment: NodeJS.ProcessEnv, nodeEnvironment: string) {
  const names = [
    "LIVEKIT_URL",
    "LIVEKIT_PUBLIC_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "MEDIA_S3_REGION",
    "MEDIA_S3_BUCKET",
    "MEDIA_S3_ACCESS_KEY",
    "MEDIA_S3_SECRET_KEY",
  ] as const;
  if (
    Boolean(environment.MEDIA_REPLAY_EDGE_URL) !==
    Boolean(environment.MEDIA_REPLAY_SIGNING_SECRET)
  )
    throw new Error(
      "replay edge URL and signing secret must be configured together",
    );
  if (environment.MEDIA_REPLAY_EDGE_URL) {
    const edge = new URL(environment.MEDIA_REPLAY_EDGE_URL);
    if (
      edge.protocol !== "https:" ||
      edge.origin !== environment.MEDIA_REPLAY_EDGE_URL ||
      edge.username ||
      edge.password ||
      environment.MEDIA_REPLAY_SIGNING_SECRET!.length < 32
    )
      throw new Error(
        "replay edge requires an HTTPS origin and a secret of at least 32 characters",
      );
  }
  let replayEdgeRooms: readonly string[] | undefined;
  if (environment.MEDIA_REPLAY_EDGE_ROOMS) {
    const rooms = environment.MEDIA_REPLAY_EDGE_ROOMS.split(",");
    if (
      !environment.MEDIA_REPLAY_EDGE_URL ||
      rooms.length > 100 ||
      rooms.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            id,
          ),
      )
    )
      throw new Error(
        "replay edge rooms require a configured edge and at most 100 lower-case UUIDs",
      );
    replayEdgeRooms = Object.freeze([...new Set(rooms)]);
  }
  const set = names.filter((name) => Boolean(environment[name]));
  if (set.length === 0) {
    if (environment.MEDIA_REPLAY_EDGE_URL)
      throw new Error("replay edge requires media configuration");
    return undefined;
  }
  if (set.length !== names.length)
    throw new Error(`media configuration requires ${names.join(", ")}`);
  const livekitUrl = new URL(environment.LIVEKIT_URL!);
  const livekitPublicUrl = new URL(environment.LIVEKIT_PUBLIC_URL!);
  if (!(
    ["http:", "https:"].includes(livekitUrl.protocol) &&
    ["ws:", "wss:"].includes(livekitPublicUrl.protocol)
  ))
    throw new Error("invalid LiveKit URLs");
  if (
    nodeEnvironment === "production" &&
    (livekitUrl.protocol !== "https:" || livekitPublicUrl.protocol !== "wss:")
  )
    throw new Error("production media requires HTTPS and WSS");
  let s3Region = environment.MEDIA_S3_REGION!;
  if (environment.MEDIA_S3_ENDPOINT) {
    if (!environment.MEDIA_S3_PUBLIC_ENDPOINT)
      throw new Error(
        "custom media S3 endpoint requires a public playback endpoint",
      );
    const endpoint = new URL(environment.MEDIA_S3_ENDPOINT);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      (nodeEnvironment === "production" && endpoint.protocol !== "https:")
    )
      throw new Error("invalid media S3 endpoint");
    if (endpoint.hostname.endsWith(".r2.cloudflarestorage.com"))
      s3Region = "auto";
  }
  if (environment.MEDIA_S3_PUBLIC_ENDPOINT) {
    const endpoint = new URL(environment.MEDIA_S3_PUBLIC_ENDPOINT);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      (nodeEnvironment === "production" && endpoint.protocol !== "https:")
    )
      throw new Error("invalid public media S3 endpoint");
  }
  return Object.freeze({
    livekitUrl: environment.LIVEKIT_URL!,
    livekitPublicUrl: environment.LIVEKIT_PUBLIC_URL!,
    livekitKey: environment.LIVEKIT_API_KEY!,
    livekitSecret: environment.LIVEKIT_API_SECRET!,
    s3Endpoint: environment.MEDIA_S3_ENDPOINT,
    s3PublicEndpoint: environment.MEDIA_S3_PUBLIC_ENDPOINT,
    s3Region,
    s3Bucket: environment.MEDIA_S3_BUCKET!,
    s3AccessKey: environment.MEDIA_S3_ACCESS_KEY!,
    s3SecretKey: environment.MEDIA_S3_SECRET_KEY!,
    replayEdgeUrl: environment.MEDIA_REPLAY_EDGE_URL,
    replaySigningSecret: environment.MEDIA_REPLAY_SIGNING_SECRET,
    replayEdgeRooms,
  });
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const host = environment.HOST ?? "0.0.0.0";
  const rawPort = environment.PORT ?? "3000";
  const port = parseInteger(rawPort, "PORT", { minimum: 1, maximum: 65535 });
  const databaseUrl = environment.DATABASE_URL;
  const logLevel = environment.LOG_LEVEL ?? "info";
  const applicationOrigin = environment.APP_ORIGIN;
  const trustProxy = parseTrustProxy(environment.TRUST_PROXY);
  const requestBodyLimit = environment.REQUEST_BODY_LIMIT ?? "10kb";
  const apiRateLimit = parseInteger(
    environment.API_RATE_LIMIT ?? "300",
    "API_RATE_LIMIT",
    {
      minimum: 1,
      maximum: 100_000,
    },
  );
  const authRateLimit = parseInteger(
    environment.AUTH_RATE_LIMIT ?? "10",
    "AUTH_RATE_LIMIT",
    {
      minimum: 1,
      maximum: 10_000,
    },
  );
  const rateLimitWindowMs = parseInteger(
    environment.RATE_LIMIT_WINDOW_MS ?? "900000",
    "RATE_LIMIT_WINDOW_MS",
    { minimum: 1_000, maximum: 86_400_000 },
  );
  const sessionDurationMs = parseInteger(
    environment.SESSION_DURATION_MS ?? "604800000",
    "SESSION_DURATION_MS",
    { minimum: 60_000, maximum: 31_536_000_000 },
  );
  const siweRpcUrls = parseSiweRpcUrls(
    environment.SIWE_RPC_URLS,
    nodeEnvironment,
  );
  const media = parseMedia(environment, nodeEnvironment);
  const packagingEnabled =
    environment.MEDIA_REPLAY_PACKAGING_ENABLED ?? "false";
  if (!["true", "false"].includes(packagingEnabled))
    throw new Error("MEDIA_REPLAY_PACKAGING_ENABLED must be true or false");
  if (packagingEnabled === "true" && !media?.replayEdgeUrl)
    throw new Error(
      "automatic replay packaging requires configured media and private replay edge",
    );
  const replayPackaging = Object.freeze({
    enabled: packagingEnabled === "true",
    concurrency: parseInteger(
      environment.MEDIA_REPLAY_CONCURRENCY ?? "1",
      "MEDIA_REPLAY_CONCURRENCY",
      { minimum: 1, maximum: 2 },
    ),
    pollMs: 5000,
    leaseMs: 60000,
    heartbeatMs: 15000,
    maxJobMs:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_JOB_SECONDS ?? "1800",
        "MEDIA_REPLAY_MAX_JOB_SECONDS",
        { minimum: 60, maximum: 7200 },
      ) * 1000,
    maxInputBytes:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_INPUT_MIB ?? "2048",
        "MEDIA_REPLAY_MAX_INPUT_MIB",
        { minimum: 1, maximum: 2048 },
      ) *
      1024 ** 2,
    maxOutputBytes:
      parseInteger(
        environment.MEDIA_REPLAY_MAX_OUTPUT_MIB ?? "4096",
        "MEDIA_REPLAY_MAX_OUTPUT_MIB",
        { minimum: 1, maximum: 4096 },
      ) *
      1024 ** 2,
    maxDurationSeconds: 7200,
    maxFiles: 11000,
  });
  const backgroundJobs = environment.RUN_BACKGROUND_JOBS ?? "true";
  const streamEnabled = environment.COMMUNITY_STREAM_ENABLED ?? "false";
  if (!["true", "false"].includes(streamEnabled))
    throw new Error("COMMUNITY_STREAM_ENABLED must be true or false");
  const communityStream = Object.freeze({
    enabled: streamEnabled === "true",
    maxStreams: parseInteger(
      environment.COMMUNITY_MAX_STREAMS ?? "500",
      "COMMUNITY_MAX_STREAMS",
      { minimum: 1, maximum: 10000 },
    ),
    maxRooms: parseInteger(
      environment.COMMUNITY_MAX_ROOMS ?? "50",
      "COMMUNITY_MAX_ROOMS",
      { minimum: 1, maximum: 1000 },
    ),
    maxConcurrentReads: 4,
    reconcileMs: 5000,
    heartbeatMs: 15000,
    bufferBytes: 65536,
  });

  if (!environments.has(nodeEnvironment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  if (backgroundJobs !== "true" && backgroundJobs !== "false") {
    throw new Error("RUN_BACKGROUND_JOBS must be true or false");
  }

  if (host.trim() === "") {
    throw new Error("HOST must not be empty");
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  if (communityStream.enabled && new URL(databaseUrl).port === "6543")
    throw new Error(
      "community LISTEN requires a direct or session-pooler connection",
    );
  if (
    environment.DATABASE_MIGRATION_URL ||
    environment.DATABASE_ADMIN_URL ||
    environment.DATABASE_OWNER_PASSWORD ||
    environment.DATABASE_RUNTIME_PASSWORD ||
    environment.DATABASE_FIXTURE_URL ||
    environment.DATABASE_INSPECTION_URL
  ) {
    throw new Error(
      "runtime must not receive database provisioning or migration secrets",
    );
  }

  if (!logLevels.has(logLevel)) {
    throw new Error("LOG_LEVEL is invalid");
  }

  if (nodeEnvironment === "production") {
    try {
      const origin = new URL(applicationOrigin ?? "");
      if (origin.origin !== applicationOrigin || origin.protocol !== "https:")
        throw new Error();
    } catch {
      throw new Error("APP_ORIGIN must be an HTTPS origin in production");
    }
  }

  if (!/^\d+(?:\.\d+)?(?:kb|mb)$/iu.test(requestBodyLimit)) {
    throw new Error("REQUEST_BODY_LIMIT must use kb or mb units");
  }

  return Object.freeze({
    environment: nodeEnvironment,
    host,
    port,
    databaseUrl,
    logLevel,
    applicationOrigin,
    trustProxy,
    requestBodyLimit,
    apiRateLimit,
    authRateLimit,
    rateLimitWindowMs,
    sessionDurationMs,
    siweRpcUrls,
    media,
    replayPackaging,
    backgroundJobs: backgroundJobs === "true",
    communityStream,
  });
}
