import helmet from "helmet";

// The lazy sign-in dialog is available on public pages. Retain media origins
// while admitting only the provider/CAPTCHA origins that authentication needs.
export function createEmailAuthSecurity(
  environment: string,
  media?: { connect: string[]; playback: string[] },
) {
  const hcaptcha = ["https://hcaptcha.com", "https://*.hcaptcha.com"];
  return helmet.contentSecurityPolicy({
    directives: {
      "connect-src": [
        "'self'",
        "https://auth.privy.io",
        ...hcaptcha,
        ...(media?.connect ?? []),
      ],
      "frame-src": [
        "'self'",
        "https://auth.privy.io",
        "https://challenges.cloudflare.com",
        ...hcaptcha,
      ],
      "script-src": [
        "'self'",
        "https://challenges.cloudflare.com",
        ...hcaptcha,
      ],
      "style-src": ["'self'", "'unsafe-inline'", ...hcaptcha],
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
