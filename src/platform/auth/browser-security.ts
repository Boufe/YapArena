import helmet from "helmet";

// Auth0 sign-in is a full-page redirect (Decision 0009), so pages load no
// provider scripts, frames or connections. Retain media origins only.
export function createEmailAuthSecurity(
  environment: string,
  media?: { connect: string[]; playback: string[] },
) {
  return helmet.contentSecurityPolicy({
    directives: {
      "connect-src": ["'self'", ...(media?.connect ?? [])],
      "frame-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "frame-ancestors": ["'none'"],
      ...(media
        ? {
            "worker-src": ["'self'", "blob:"],
            "media-src": ["'self'", "blob:", ...media.playback],
          }
        : {}),
      "upgrade-insecure-requests": environment === "production" ? [] : null,
    },
  });
}
