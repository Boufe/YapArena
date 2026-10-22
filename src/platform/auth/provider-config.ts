export function loadProviderConfig(env: NodeJS.ProcessEnv) {
  const appId = env.PRIVY_APP_ID;
  if (!appId) {
    if (env.PRIVY_APP_SECRET || env.PRIVY_VERIFICATION_KEY)
      throw new Error("Privy configuration requires PRIVY_APP_ID");
    return undefined;
  }
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(appId) ||
    !env.PRIVY_APP_SECRET ||
    !env.REDIS_SECURITY_URL ||
    !env.REDIS_NAMESPACE ||
    !env.REDIS_KEY_SECRET
  )
    throw new Error(
      "Privy requires server secret and namespaced Redis abuse controls",
    );
  const redisUrl = new URL(env.REDIS_SECURITY_URL);
  if (
    !["redis:", "rediss:"].includes(redisUrl.protocol) ||
    (env.NODE_ENV === "production" && redisUrl.protocol !== "rediss:")
  )
    throw new Error("production Redis requires TLS");
  if (
    !/^[a-z0-9_-]{1,48}$/.test(env.REDIS_NAMESPACE) ||
    env.REDIS_KEY_SECRET.length < 32
  )
    throw new Error("invalid Redis namespace or key secret");
  return {
    appId,
    appSecret: env.PRIVY_APP_SECRET,
    verificationKey: env.PRIVY_VERIFICATION_KEY,
    clientId: env.PRIVY_CLIENT_ID,
    redisUrl: env.REDIS_SECURITY_URL,
    namespace: env.REDIS_NAMESPACE,
    keySecret: env.REDIS_KEY_SECRET,
  };
}
