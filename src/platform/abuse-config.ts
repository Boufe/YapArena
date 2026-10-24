// Shared Redis abuse controls for sign-in limits, the signup pause and rate
// limits. They load on their own, independent of the sign-in provider settings.
export type AbuseControlConfig = Readonly<{
  redisUrl: string;
  namespace: string;
  keySecret: string;
}>;

export function loadAbuseControlConfig(
  env: NodeJS.ProcessEnv,
): AbuseControlConfig | undefined {
  const url = env.REDIS_SECURITY_URL;
  const namespace = env.REDIS_NAMESPACE;
  const keySecret = env.REDIS_KEY_SECRET;
  if (!url && !namespace && !keySecret) return undefined;
  if (!url || !namespace || !keySecret)
    throw new Error(
      "Redis abuse controls require REDIS_SECURITY_URL, REDIS_NAMESPACE and REDIS_KEY_SECRET",
    );
  let redisUrl: URL;
  try {
    redisUrl = new URL(url);
  } catch {
    throw new Error("REDIS_SECURITY_URL must be an absolute URL");
  }
  if (
    !["redis:", "rediss:"].includes(redisUrl.protocol) ||
    (env.NODE_ENV === "production" && redisUrl.protocol !== "rediss:")
  )
    throw new Error("production Redis requires TLS");
  if (!/^[a-z0-9_-]{1,48}$/.test(namespace) || keySecret.length < 32)
    throw new Error("invalid Redis namespace or key secret");
  return Object.freeze({ redisUrl: url, namespace, keySecret });
}
