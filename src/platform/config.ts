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
  const set = names.filter((name) => Boolean(environment[name]));
  if (set.length === 0) return undefined;
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
  const backgroundJobs = environment.RUN_BACKGROUND_JOBS ?? "true";

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
    backgroundJobs: backgroundJobs === "true",
  });
}
