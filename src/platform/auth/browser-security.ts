import helmet from "helmet";

// Only the account island needs provider/CAPTCHA execution. WalletConnect and
// arbitrary RPC origins are not enabled by email authentication.
export function createEmailAuthSecurity(environment: string) {
  const hcaptcha = ["https://hcaptcha.com", "https://*.hcaptcha.com"];
  return helmet.contentSecurityPolicy({
    directives: {
      "connect-src": ["'self'", "https://auth.privy.io", ...hcaptcha],
      "frame-src": [
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
      "upgrade-insecure-requests": environment === "production" ? [] : null,
    },
  });
}
