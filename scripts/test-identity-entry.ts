// Starts the web service with the test identity entry mounted at
// /api/test-identity. Local development, CI and browser verifiers only:
//   npm run build && node scripts/test-identity-entry.ts
// It refuses production, Render, any sign-in provider setting and a
// non-loopback APP_ORIGIN before loading the application.
import express from "express";
import {
  createTestIdentityRouter,
  testIdentityRefusal,
} from "./test-identity.ts";

const refusal = testIdentityRefusal(process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const { createWebServer, runWebServer } = await import("../dist/web.js");
await runWebServer(
  createWebServer(process.env, {
    wrap(app, parts) {
      const outer = express();
      outer.disable("x-powered-by");
      outer.set("trust proxy", parts.config.trustProxy);
      outer.use(
        "/api/test-identity",
        createTestIdentityRouter({
          accounts: parts.auth0Accounts,
          environment: parts.config.environment,
          applicationOrigin:
            parts.config.applicationOrigin ?? "http://localhost:3000",
          sessionDurationMs: parts.config.sessionDurationMs,
          sessions: parts.sessions,
          operations: parts.accountSecurity.operations,
        }),
      );
      outer.use(app);
      return outer;
    },
  }),
);
