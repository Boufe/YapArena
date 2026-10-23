// Browser verifiers sign in through the local test identity entry
// (scripts/test-identity-entry.ts), which calls the same post-callback sign-in
// function as the Auth0 callback. The context's request client shares the
// browser's cookie jar, so the session cookie it receives signs in the pages.
import type { BrowserContext } from "playwright-core";

export async function signInForTest(
  context: BrowserContext,
  base: string,
  email: string,
  method: "email" | "google" = "email",
) {
  const response = await context.request.post(
    `${base}/api/test-identity/sign-in`,
    { data: { email, method } },
  );
  if (!response.ok())
    throw new Error(`test sign-in failed with HTTP ${response.status()}`);
  const body: { user: { id: string }; created: boolean } =
    await response.json();
  return body;
}

// The entry the verifiers start instead of dist/server.js. It refuses
// production, Render, provider settings and non-loopback origins.
export const testIdentityEntry = "scripts/test-identity-entry.ts";
