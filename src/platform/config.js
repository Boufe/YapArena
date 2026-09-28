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

function parseInteger(value, name, { minimum, maximum }) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

function parseTrustProxy(value) {
  if (value === undefined || value === "false") return false;
  return parseInteger(value, "TRUST_PROXY", { minimum: 1, maximum: 10 });
}

export function loadConfig(environment = process.env) {
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

  if (!environments.has(nodeEnvironment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  if (host.trim() === "") {
    throw new Error("HOST must not be empty");
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (!logLevels.has(logLevel)) {
    throw new Error("LOG_LEVEL is invalid");
  }

  if (nodeEnvironment === "production") {
    try {
      const origin = new URL(applicationOrigin);
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
  });
}
