// Auth0 sign-in settings (Decision 0009, points 1 and 11). They belong to the
// web service only: the background workers never load them.
export type Auth0Config = Readonly<{
  issuer: URL;
  clientId: string;
  clientSecret: string;
}>;

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadAuth0Config(
  env: NodeJS.ProcessEnv,
  { required = env.NODE_ENV === "production" }: { required?: boolean } = {},
): Auth0Config | undefined {
  const issuer = env.AUTH0_ISSUER_BASE_URL;
  const clientId = env.AUTH0_CLIENT_ID;
  const clientSecret = env.AUTH0_CLIENT_SECRET;
  const production = env.PRODUCTION_SERVICE;
  if (production !== undefined && production !== "true")
    throw new Error('PRODUCTION_SERVICE must be "true" or unset');
  if (production === "true" && env.NODE_ENV !== "production")
    throw new Error("PRODUCTION_SERVICE requires NODE_ENV=production");
  if (!issuer && !clientId && !clientSecret) {
    if (required)
      throw new Error(
        "production requires AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET",
      );
    return undefined;
  }
  if (!issuer || !clientId || !clientSecret)
    throw new Error(
      "Auth0 sign-in requires AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET",
    );
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("AUTH0_ISSUER_BASE_URL must be an absolute URL");
  }
  // A local OIDC issuer may use HTTP only outside production.
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      env.NODE_ENV !== "production" &&
      loopback.has(url.hostname)
    )
  )
    throw new Error("AUTH0_ISSUER_BASE_URL must use HTTPS");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("AUTH0_ISSUER_BASE_URL must be an origin");
  const hostname = url.hostname.toLowerCase();
  // Production uses its own custom domain (point 11); a tenant domain is
  // acceptable only for staging and development tenants.
  if (
    production === "true" &&
    (hostname === "auth0.com" || hostname.endsWith(".auth0.com"))
  )
    throw new Error(
      "the production service requires an Auth0 custom domain, not *.auth0.com",
    );
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId))
    throw new Error("invalid AUTH0_CLIENT_ID");
  if (clientSecret.length < 16) throw new Error("invalid AUTH0_CLIENT_SECRET");
  return Object.freeze({ issuer: url, clientId, clientSecret });
}
