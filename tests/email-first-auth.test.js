import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  createPrivyVerifier,
  createPrivyOperatorInspector,
  createPrivySessionControl,
  ProviderCredentialChangedError,
  ProviderUnavailableError,
} from "../dist/platform/auth/privy.js";
import { loadProviderConfig } from "../dist/platform/auth/provider-config.js";
import { createSharedAbuseLimiter } from "../dist/platform/shared-abuse.js";
import { createApp } from "../dist/app.js";
import { createAuthRouter } from "../dist/platform/auth/router.js";
import { createLogger } from "../dist/platform/logger.js";
import { ProviderAccountError } from "../dist/platform/auth/provider-accounts.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";
import {
  formatYapCoins,
  createAccountWallet,
  grantProgress,
} from "../dist/features/account-wallet/repository.js";
import {
  captureAuthReturn,
  completeAuthReturn,
  parseAuthReturnIntent,
  readAuthReturn,
  rememberAuthReturn,
  safeAuthReturn,
} from "../frontend/auth-return.ts";
import { createEmailAuthSecurity } from "../dist/platform/auth/browser-security.js";

it("admits lazy authentication while preserving media CSP and frame isolation", async () => {
  const app = express()
    .use(
      createEmailAuthSecurity("production", {
        connect: [
          "wss://live.example",
          "https://live.example",
          "https://replay.example",
        ],
        playback: ["https://replay.example"],
      }),
    )
    .get("/live", (_req, res) => res.send("public fixture"));
  const response = await request(app).get("/live");
  const policy = response.headers["content-security-policy"];
  assert.match(
    policy,
    /connect-src[^;]*https:\/\/auth\.privy\.io[^;]*wss:\/\/live\.example/,
  );
  assert.match(policy, /media-src 'self' blob: https:\/\/replay\.example/);
  assert.match(policy, /worker-src 'self' blob:/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /walletconnect|unsafe-eval/);
});

const appId = "synthetic-app";
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const claims = {
  iss: "privy.io",
  aud: appId,
  sub: "did:privy:synthetic",
  sid: "provider-session",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
};
function jwt(overrides = {}) {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
    "base64url",
  );
  const p = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString(
    "base64url",
  );
  const signature = createSign("SHA256")
    .update(`${h}.${p}`)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${h}.${p}.${signature}`;
}
function verifier(
  user = {
    id: claims.sub,
    is_guest: false,
    linked_accounts: [{ type: "email", address: "verified@example.test" }],
  },
  settings = {
    email_auth: true,
    merge_accounts_by_email: false,
    google_oauth: true,
    passkey_auth: true,
  },
) {
  return createPrivyVerifier({
    appId,
    appSecret: "synthetic",
    verificationKey: publicKey.export({ type: "spki", format: "pem" }),
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith(`/v1/apps/${appId}`) ? settings : user,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
  });
}
describe("verified provider evidence", () => {
  it("sends explicit empty JSON for the installed SDK's freeze/unfreeze transport and keeps provider reads bodyless", async () => {
    const calls = [];
    const control = createPrivySessionControl({
      appId,
      appSecret: "synthetic",
      fetch: async (url, init) => {
        const outbound = new Request(url, init);
        calls.push({
          method: outbound.method,
          path: new URL(outbound.url).pathname,
          contentType: outbound.headers.get("content-type"),
          body: await outbound.text(),
          hasSignal: init.signal instanceof AbortSignal,
        });
        return new Response(
          JSON.stringify(
            outbound.method === "GET"
              ? { id: claims.sub, frozen_at: 12345 }
              : { success: true },
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const options = { signal: AbortSignal.timeout(10000) };
    assert.deepEqual(await control.state(claims.sub, options), {
      frozenAt: 12345,
    });
    await control.freeze(claims.sub, options);
    await control.unfreeze(claims.sub, options);
    const path = `/v1/users/${claims.sub}`;
    assert.deepEqual(calls, [
      { method: "GET", path, contentType: null, body: "", hasSignal: true },
      {
        method: "POST",
        path: `${path}/freeze`,
        contentType: "application/json",
        body: "{}",
        hasSignal: true,
      },
      {
        method: "DELETE",
        path: `${path}/freeze`,
        contentType: "application/json",
        body: "{}",
        hasSignal: true,
      },
    ]);
    const denied = createPrivySessionControl({
      appId,
      appSecret: "synthetic",
      fetch: async () =>
        new Response(JSON.stringify({ success: false }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    await assert.rejects(denied.freeze(claims.sub), /provider freeze failed/);
    await assert.rejects(
      denied.unfreeze(claims.sub),
      /provider unfreeze failed/,
    );
  });
  it("never treats absent, malformed or another identity's freeze state as confirmed unfrozen", async () => {
    for (const value of [
      { id: claims.sub },
      { id: "did:privy:another-identity", frozen_at: null },
      ...[
        undefined,
        "12345",
        false,
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((frozen_at) => ({ id: claims.sub, frozen_at })),
    ]) {
      const control = createPrivySessionControl({
        appId,
        appSecret: "synthetic",
        fetch: async () =>
          new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json" },
          }),
      });
      await assert.rejects(control.state(claims.sub), ProviderUnavailableError);
    }
    const knownUnfrozen = createPrivySessionControl({
      appId,
      appSecret: "synthetic",
      fetch: async () =>
        new Response(JSON.stringify({ id: claims.sub, frozen_at: null }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    assert.deepEqual(await knownUnfrozen.state(claims.sub), { frozenAt: null });
  });
  it("inspects current server-side credentials without accepting token refresh as reauthentication", async () => {
    const state = await verifier().inspect(claims.sub);
    assert.equal(state.subject, claims.sub);
    assert.equal(state.email, "verified@example.test");
    assert.equal(state.sessionId, undefined);
    assert.equal(state.issuedAt, undefined);
    for (const user of [
      {
        id: claims.sub,
        is_guest: false,
        frozen_at: 12345,
        linked_accounts: [{ type: "email", address: "verified@example.test" }],
      },
      {
        id: claims.sub,
        is_guest: false,
        linked_accounts: [{ type: "wallet", address: "unapproved" }],
      },
      { id: claims.sub, is_guest: false, linked_accounts: [] },
    ])
      await assert.rejects(
        verifier(user).inspect(claims.sub),
        ProviderCredentialChangedError,
      );
  });
  it("keeps verified Privy user wallets separate from sign-in credentials and their digest", async () => {
    const original = await verifier().inspect(claims.sub);
    assert.equal(original.hasEmbeddedWallets, false);
    const wallets = [
      {
        type: "wallet",
        chain_type: "ethereum",
        address: "0x1234567890123456789012345678901234567890",
        wallet_client_type: "privy",
        connector_type: "embedded",
        user_can_sign: true,
      },
      {
        type: "wallet",
        chain_type: "solana",
        address: "11111111111111111111111111111111",
        wallet_client_type: "privy",
        connector_type: "embedded",
        user_can_sign: true,
      },
    ];
    for (const selected of [[wallets[0]], [wallets[1]], wallets]) {
      const state = await verifier({
        id: claims.sub,
        is_guest: false,
        linked_accounts: [
          { type: "email", address: "verified@example.test" },
          ...selected,
        ],
      }).inspect(claims.sub);
      assert.equal(state.hasEmbeddedWallets, true);
      assert.deepEqual({ ...state, hasEmbeddedWallets: false }, original);
    }
    for (const changed of [
      { ...wallets[0], wallet_client_type: "metamask" },
      { ...wallets[0], wallet_client_type: undefined },
      { ...wallets[0], connector_type: "injected" },
      { ...wallets[0], connector_type: undefined },
      { ...wallets[0], user_can_sign: false },
      { ...wallets[0], user_can_sign: undefined },
      { ...wallets[0], address: "unverified-wallet" },
      { ...wallets[1], address: "0Oinvalid-solana-address" },
      { ...wallets[1], chain_type: "bitcoin-segwit" },
    ])
      await assert.rejects(
        verifier({
          id: claims.sub,
          is_guest: false,
          linked_accounts: [
            { type: "email", address: "verified@example.test" },
            changed,
          ],
        }).inspect(claims.sub),
        ProviderCredentialChangedError,
      );
    await assert.rejects(
      verifier({
        id: claims.sub,
        is_guest: false,
        linked_accounts: wallets,
      }).inspect(claims.sub),
      ProviderCredentialChangedError,
    );
  });
  it("allows only a read-only operator inspector to inspect a frozen identity without making it authentication evidence", async () => {
    const user = {
      id: claims.sub,
      frozen_at: 12345,
      is_guest: false,
      linked_accounts: [{ type: "email", address: "verified@example.test" }],
    };
    const calls = [];
    const inspect = createPrivyOperatorInspector({
      appId,
      appSecret: "synthetic",
      fetch: async (url, init) => {
        const outbound = new Request(url, init);
        calls.push(outbound.method);
        return new Response(JSON.stringify(user), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.deepEqual(Object.keys(inspect), ["inspect"]);
    assert.deepEqual(
      await inspect.inspect(claims.sub),
      await verifier({ ...user, frozen_at: null }).inspect(claims.sub),
    );
    assert.deepEqual(calls, ["GET"]);
    await assert.rejects(
      verifier(user).inspect(claims.sub),
      ProviderCredentialChangedError,
    );
    user.is_guest = true;
    await assert.rejects(
      inspect.inspect(claims.sub),
      ProviderCredentialChangedError,
    );
    user.is_guest = false;
    user.id = "did:privy:other-identity";
    await assert.rejects(
      inspect.inspect(claims.sub),
      ProviderCredentialChangedError,
    );
  });
  it("refuses unsafe email merging and reflects configured login methods", async () => {
    assert.deepEqual(await verifier().configuration(), {
      google: true,
      passkeys: true,
    });
    await assert.rejects(
      verifier(undefined, {
        email_auth: true,
        merge_accounts_by_email: true,
      }).verify(jwt()),
    );
    await assert.rejects(
      verifier(undefined, {
        email_auth: false,
        merge_accounts_by_email: false,
      }).configuration(),
    );
  });
  it("refuses any Privy sign-in method other than email codes, Google and passkeys", async () => {
    for (const unsupported of [
      { sms_auth: true },
      { wallet_auth: true },
      { apple_oauth: true },
      { guest_auth: true },
      { custom_jwt_auth: true },
      { custom_oauth_providers: [{ enabled: true, provider: "custom:x" }] },
    ])
      await assert.rejects(
        verifier(undefined, {
          email_auth: true,
          merge_accounts_by_email: false,
          google_oauth: true,
          passkey_auth: true,
          ...unsupported,
        }).configuration(),
        ProviderUnavailableError,
      );
    assert.deepEqual(
      await verifier(undefined, {
        email_auth: true,
        merge_accounts_by_email: false,
        google_oauth: false,
        passkey_auth: true,
        sms_auth: false,
        twitter_oauth_on_mobile_enabled: true,
        custom_oauth_providers: [{ enabled: false, provider: "custom:x" }],
      }).configuration(),
      { google: false, passkeys: true },
    );
  });
  it("serves GET /api/auth/provider from a five-minute cache and backs off after failures", async () => {
    function providerApp() {
      const state = { clock: 0, reads: 0, failing: false };
      const app = express();
      app.use(
        "/api/auth",
        createAuthRouter({
          users: {},
          sessions: {},
          environment: "test",
          now: () => state.clock,
          provider: {
            appId,
            accounts: {},
            verifier: {
              async configuration() {
                state.reads++;
                if (state.failing)
                  throw new ProviderUnavailableError("synthetic");
                return { google: true, passkeys: state.reads % 2 === 1 };
              },
            },
          },
        }),
      );
      const methods = async () => {
        const response = await request(app).get("/api/auth/provider");
        return [response.status, response.body.passkeys];
      };
      return { state, methods };
    }
    const cached = providerApp();
    assert.deepEqual(
      await Promise.all([cached.methods(), cached.methods(), cached.methods()]),
      [
        [200, true],
        [200, true],
        [200, true],
      ],
    );
    assert.equal(cached.state.reads, 1);
    cached.state.clock = 5 * 60_000 - 1;
    assert.deepEqual(await cached.methods(), [200, true]);
    assert.equal(cached.state.reads, 1);
    // A failed refresh serves the last good answer and waits 15 seconds.
    cached.state.clock = 5 * 60_000;
    cached.state.failing = true;
    assert.deepEqual(await cached.methods(), [200, true]);
    cached.state.failing = false;
    cached.state.clock = 5 * 60_000 + 14_999;
    assert.deepEqual(await cached.methods(), [200, true]);
    assert.equal(cached.state.reads, 2);
    cached.state.clock = 5 * 60_000 + 15_000;
    assert.deepEqual(await cached.methods(), [200, true]);
    assert.equal(cached.state.reads, 3);
    // Without a good answer yet, a failure is a 503 and is not retried at once.
    const cold = providerApp();
    cold.state.failing = true;
    assert.deepEqual(await cold.methods(), [503, undefined]);
    cold.state.failing = false;
    cold.state.clock = 14_999;
    assert.deepEqual(await cold.methods(), [503, undefined]);
    assert.equal(cold.state.reads, 1);
    cold.state.clock = 15_000;
    assert.equal((await cold.methods())[0], 200);
    assert.equal(cold.state.reads, 2);
  });
  it("verifies a real ES256 signature and obtains ownership data only from the provider", async () => {
    assert.deepEqual(await verifier().verify(jwt()), {
      subject: claims.sub,
      sessionId: claims.sid,
      email: "verified@example.test",
      methods: ["email"],
      credentials: [{ type: "email", id: "verified@example.test" }],
      hasEmbeddedWallets: false,
      issuedAt: claims.iat,
      credentialsDigest: createHash("sha256")
        .update(
          JSON.stringify([JSON.stringify(["email", "verified@example.test"])]),
        )
        .digest("hex"),
    });
    assert.equal(
      (
        await verifier({
          id: claims.sub,
          is_guest: false,
          linked_accounts: [
            { type: "google_oauth", subject: "synthetic-google" },
          ],
        }).verify(jwt())
      ).email,
      null,
    );
  });
  it("keeps same-contact Google and newly verified email identities distinct", async () => {
    const address = "same@example.test";
    const google = await verifier({
      id: claims.sub,
      is_guest: false,
      linked_accounts: [
        { type: "google_oauth", subject: "synthetic-google", email: address },
      ],
    }).verify(jwt());
    const replacementSubject = "did:privy:replacement-email";
    const email = await verifier({
      id: replacementSubject,
      is_guest: false,
      linked_accounts: [{ type: "email", address }],
    }).verify(jwt({ sub: replacementSubject }));
    assert.equal(google.email, null);
    assert.deepEqual(google.methods, ["google_oauth"]);
    assert.deepEqual(google.credentials, [
      { type: "google_oauth", id: "synthetic-google" },
    ]);
    assert.equal(email.email, address);
    assert.deepEqual(email.methods, ["email"]);
    assert.notEqual(email.subject, google.subject);
    assert.notEqual(email.credentialsDigest, google.credentialsDigest);
  });
  it("rejects wrong audience/issuer, expired, malformed and altered tokens", async () => {
    for (const token of [
      jwt({ aud: "other-app" }),
      jwt({ iss: "attacker" }),
      jwt({ exp: 1 }),
      jwt({ sid: undefined }),
      "invalid",
      jwt().slice(0, -8) + "invalid!",
    ])
      await assert.rejects(verifier().verify(token));
    await assert.rejects(
      verifier({
        id: "another-account",
        is_guest: false,
        linked_accounts: [],
      }).verify(jwt()),
    );
    await assert.rejects(
      verifier({ id: claims.sub, is_guest: true, linked_accounts: [] }).verify(
        jwt(),
      ),
    );
  });
});

describe("configuration and exact platform-currency presentation", () => {
  const env = {
    PRIVY_APP_ID: appId,
    PRIVY_APP_SECRET: "synthetic",
    PRIVY_VERIFICATION_KEY: "public-key",
    REDIS_SECURITY_URL: "rediss://localhost",
    REDIS_NAMESPACE: "test-auth",
    REDIS_KEY_SECRET: "a".repeat(32),
    NODE_ENV: "production",
  };
  it("requires complete server-only, namespaced TLS configuration", () => {
    assert.equal(loadProviderConfig({}), undefined);
    assert.equal(loadProviderConfig(env).appId, appId);
    for (const input of [
      { PRIVY_APP_SECRET: "missing-app" },
      { ...env, REDIS_NAMESPACE: "" },
      { ...env, REDIS_NAMESPACE: "has:colon" },
      { ...env, REDIS_KEY_SECRET: "short" },
      { ...env, REDIS_SECURITY_URL: "redis://localhost" },
      { ...env, REDIS_SECURITY_URL: "https://localhost" },
    ])
      assert.throws(() => loadProviderConfig(input));
    assert.ok(
      loadProviderConfig({
        ...env,
        NODE_ENV: "test",
        REDIS_SECURITY_URL: "redis://localhost",
      }),
    );
  });
  it("preserves exact atomic USDC arithmetic at 100 YC per USDC, including large values", async () => {
    assert.equal(formatYapCoins("1000000"), "100");
    assert.equal(formatYapCoins("1"), "0.0001");
    assert.equal(formatYapCoins("-1"), "-0.0001");
    assert.equal(formatYapCoins("-10001"), "-1.0001");
    assert.equal(formatYapCoins("10001"), "1.0001");
    assert.equal(
      formatYapCoins("1000000000000000000000000000000"),
      "100000000000000000000000000",
    );
    const empty = createAccountWallet({ query: async () => ({ rows: [] }) });
    assert.deepEqual(await empty.balances("1"), {
      available: "0",
      reserved: "0",
      pending: "0",
      promotional: "0",
      withdrawable: "0",
      grants: [],
    });
    const funded = createAccountWallet({
      query: async (sql) => ({
        rows: sql.includes("coin_grant_lots")
          ? []
          : [
              { kind: "available", amount: "1000000" },
              { kind: "backing", amount: "-1000000" },
            ],
      }),
    });
    assert.equal((await funded.balances("1")).available, "100");
  });
  it("shows exact independent grant progress, losses and permanent qualification", () => {
    const base = {
      id: "welcome",
      kind: "welcome",
      target: "25000000",
      net: "10000000",
      peak: "10000000",
    };
    assert.deepEqual(grantProgress(base), {
      id: "welcome",
      label: "Welcome grant",
      target: "2500",
      netProfit: "1000",
      remaining: "1500",
      qualified: false,
      percent: 40,
    });
    const daily = grantProgress({
      ...base,
      id: "daily",
      kind: "daily",
      target: "5000000",
      net: "0",
      peak: "0",
    });
    assert.equal(daily.remaining, "500");
    assert.equal(daily.percent, 0);
    const qualified = grantProgress({
      ...base,
      net: "10000000",
      peak: "25000000",
    });
    assert.equal(qualified.qualified, true);
    assert.equal(qualified.percent, 100);
    assert.equal(qualified.remaining, "0");
    const loss = grantProgress({ ...base, net: "-10000", peak: "0" });
    assert.equal(loss.netProfit, "-1");
    assert.equal(loss.remaining, "2501");
    assert.equal(loss.percent, 0);
    assert.equal(
      grantProgress({ ...base, net: "30000000", peak: "30000000" }).percent,
      100,
    );
    assert.equal(
      grantProgress({ ...base, net: "30000000", peak: "0" }).percent,
      100,
    );
    assert.throws(() => grantProgress({ ...base, target: "0" }));
  });
  it("returns to the exact local debate fragment and rejects redirect escape paths", () => {
    const origin = "https://arena.example";
    assert.equal(
      safeAuthReturn("/debates/test?round=1#commit", origin),
      "/debates/test?round=1#commit",
    );
    assert.equal(
      safeAuthReturn(
        "/debates/test?round=1&%70rivy_oauth_code=synthetic-secret&privy_oauth_state=synthetic-state#commit",
        origin,
      ),
      "/debates/test?round=1#commit",
    );
    for (const path of [
      null,
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/account?next=/account",
      "/\n/evil.example",
    ])
      assert.equal(safeAuthReturn(path, origin), null);
  });
  it("keeps only expiring local confirmation intent and public action locators", () => {
    const origin = "https://arena.example",
      now = 1000000,
      intent = {
        version: 1,
        next: "/debates/test?round=4#commit",
        expiresAt: now + 15 * 60 * 1000,
        phase: "oauth",
        action: { kind: "follow", type: "topics", slug: "test-topic" },
      },
      parse = (value) =>
        parseAuthReturnIntent(JSON.stringify(value), origin, now);
    assert.deepEqual(parse(intent), intent);
    assert.deepEqual(
      parse({
        ...intent,
        next: "/debates/test?round=4&privy_oauth_code=synthetic-private#commit",
      }),
      intent,
    );
    for (const patch of [
      { version: 2 },
      { expiresAt: now },
      { expiresAt: now + 15 * 60 * 1000 + 1 },
      { expiresAt: Infinity },
      { phase: "submit" },
      { next: "//elsewhere.example" },
      { next: "/account?next=/debates/test" },
      { action: { kind: "submit", selector: "form" } },
      { action: { kind: "follow", type: "wallets", slug: "test-topic" } },
      { action: { kind: "follow", type: "topics", slug: "../private" } },
      { action: { kind: "page", amount: "5000000" } },
      { credentials: "must-not-be-stored" },
    ])
      assert.equal(parse({ ...intent, ...patch }), null);
    for (const value of [null, "{", "[]", "x".repeat(4097)])
      assert.equal(parseAuthReturnIntent(value, origin, now), null);
    assert.equal(
      parseAuthReturnIntent(JSON.stringify(intent), origin, intent.expiresAt),
      null,
    );
  });
  it("offers same-page completion to the controller without navigation or another action", () => {
    const stored = new Map(),
      navigation = [],
      historyUpdates = [],
      events = new EventTarget(),
      completion = [],
      fixtures = {
        location: {
          origin: "https://arena.example",
          pathname: "/debates/test",
          search: "?round=4&privy_oauth_code=synthetic-callback",
          hash: "#commit",
          assign: (value) => navigation.push(value),
        },
        history: {
          state: { dialog: "retained" },
          replaceState: (...args) => historyUpdates.push(args),
        },
        window: events,
        sessionStorage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => stored.set(key, value),
          removeItem: (key) => stored.delete(key),
        },
      },
      descriptors = new Map(
        Object.keys(fixtures).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(globalThis, key),
        ]),
      );
    try {
      for (const [key, value] of Object.entries(fixtures))
        Object.defineProperty(globalThis, key, { value, configurable: true });
      const listener = (event) => {
        completion.push(event.detail);
        event.preventDefault();
      };
      events.addEventListener("yap:auth-complete", listener);
      captureAuthReturn("/debates/test?round=4#commit", {
        kind: "community-chat",
      });
      rememberAuthReturn("/debates/test?round=4#commit");
      assert.equal(readAuthReturn().phase, "oauth");
      assert.equal(completeAuthReturn("/debates/test?round=4#commit"), true);
      assert.deepEqual(navigation, []);
      assert.deepEqual(historyUpdates, [
        [{ dialog: "retained" }, "", "/debates/test?round=4#commit"],
      ]);
      assert.deepEqual(completion, [
        { returnTo: "/debates/test?round=4#commit" },
      ]);
      assert.deepEqual(readAuthReturn().action, { kind: "community-chat" });
      assert.equal(readAuthReturn().phase, "confirmed");
      assert.deepEqual(
        Object.keys(JSON.parse(stored.get("yaparena-auth-return"))).sort(),
        ["action", "expiresAt", "next", "phase", "version"],
      );
      events.removeEventListener("yap:auth-complete", listener);
      fixtures.location.pathname = "/account";
      fixtures.location.search = "";
      fixtures.location.hash = "";
      assert.equal(completeAuthReturn("/debates/test?round=4#commit"), true);
      assert.deepEqual(navigation, ["/debates/test?round=4#commit"]);
      assert.equal(readAuthReturn().phase, "confirmed");
      assert.equal(completeAuthReturn("//elsewhere.example"), false);
      assert.deepEqual(navigation, ["/debates/test?round=4#commit"]);
      assert.equal(readAuthReturn(), null);
    } finally {
      for (const [key, descriptor] of descriptors)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
  });
});

describe("shared abuse middleware", () => {
  it("shares a budget between instances, hashes keys and fails closed during outages", async () => {
    const keys = [];
    let count = 0,
      fail = false;
    const options = {
      store: {
        async increment(key) {
          keys.push(key);
          if (fail) throw Error("secret");
          return { count: ++count, ttl: 1200 };
        },
      },
      namespace: "isolated-test",
      secret: "x".repeat(32),
      scope: "auth",
      limit: 2,
      windowMs: 2000,
    };
    const a = express(),
      b = express();
    for (const app of [a, b]) {
      app.use(createSharedAbuseLimiter(options));
      app.get("/", (_r, s) => s.sendStatus(204));
    }
    assert.equal((await request(a).get("/")).status, 204);
    assert.equal((await request(b).get("/")).status, 204);
    const throttled = await request(a).get("/");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers["retry-after"], "2");
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^isolated-test:security:limit:auth:[a-f0-9]{64}$/);
    fail = true;
    assert.equal((await request(b).get("/")).status, 503);
    assert.throws(() =>
      createSharedAbuseLimiter({ ...options, namespace: "unsafe:shared" }),
    );
    const account = express();
    account.use(createSharedAbuseLimiter({ ...options, account: true }));
    assert.equal((await request(account).get("/")).status, 401);
  });
});

describe("provider exchange API", () => {
  function setup({
    fail,
    active = false,
    configured = true,
    sharedAuthLimiter,
    providerDetails = null,
  } = {}) {
    const provider = {
      appId,
      accounts: {
        exchange: async () => {
          if (fail) throw fail;
          return {
            user: { id: "11", email: null, createdAt: new Date(0) },
            created: true,
          };
        },
        details: async (accountId) => {
          assert.equal(accountId, "11");
          return providerDetails;
        },
      },
      verifier: verifier(),
    };
    return createApp({
      messages: {},
      users: {},
      sessions: {
        findUserByTokenHash: async () => (active ? { id: "11" } : null),
        deleteByTokenHash: async () => {},
        revokeSession: async () => ({ current: true }),
      },
      logger: createLogger({ enabled: false }),
      environment: "production",
      applicationOrigin: "https://arena.example",
      authProvider: configured ? provider : undefined,
      authRateLimit: 100,
      sharedAuthLimiter,
    });
  }
  const exchange = (app) =>
    request(app)
      .post("/api/auth/privy/exchange")
      .set("Origin", "https://arena.example")
      .set("Authorization", `Bearer ${jwt()}`);
  it("pairs the provider mapping with its authenticated account in one response", async () => {
    const providerDetails = { subject: claims.sub, methods: ["email"] };
    const response = await request(setup({ active: true, providerDetails }))
      .get("/api/auth/methods?accountId=attacker-controlled")
      .set("Cookie", "__Host-session=synthetic");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      accountId: "11",
      provider: providerDetails,
      legacyPassword: false,
    });
  });
  it("keeps logout and session reads usable when shared abuse protection is unavailable", async () => {
    const app = setup({
      active: true,
      sharedAuthLimiter: (_request, response) => response.sendStatus(503),
    });
    assert.equal(
      (
        await request(app)
          .get("/api/auth/me")
          .set("Cookie", "__Host-session=synthetic")
      ).status,
      200,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/auth/logout")
          .set("Origin", "https://arena.example")
          .set("Cookie", "__Host-session=synthetic")
      ).status,
      204,
    );
    assert.equal((await exchange(app)).status, 503);
  });
  it("publishes a host-only secure session after provisioning and retires new unverified registration", async () => {
    const app = setup();
    const r = await exchange(app);
    assert.equal(r.status, 201);
    assert.match(
      r.headers["set-cookie"][0],
      /__Host-session=.*HttpOnly; Secure; SameSite=Strict/,
    );
    assert.equal(r.body.user.authGeneration, undefined);
    assert.equal(
      (await request(app).post("/api/auth/register").send({})).status,
      410,
    );
    assert.equal(
      (await request(app).get("/api/auth/provider")).body.appId,
      appId,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/auth/methods")
          .set("Cookie", "__Host-session=x")
      ).status,
      401,
    );
  });
  it("rejects login CSRF, missing/bad tokens, account switching and unavailable provider", async () => {
    assert.equal(
      (await request(setup()).post("/api/auth/privy/exchange")).status,
      403,
    );
    assert.equal(
      (
        await request(setup())
          .post("/api/auth/privy/exchange")
          .set("Origin", "https://arena.example")
      ).status,
      401,
    );
    assert.equal(
      (
        await request(setup())
          .post("/api/auth/privy/exchange")
          .set("Origin", "https://arena.example")
          .set("Authorization", "Bearer invalid")
      ).status,
      401,
    );
    assert.equal(
      (
        await exchange(setup({ active: true })).set(
          "Cookie",
          "__Host-session=x",
        )
      ).status,
      409,
    );
    assert.equal((await exchange(setup({ configured: false }))).status, 503);
    for (const fail of [
      new ProviderAccountError("blocked", 403),
      new SessionUnavailableError(),
      new Error("private provider data"),
    ]) {
      const r = await exchange(setup({ fail }));
      assert.equal(
        r.status,
        fail instanceof ProviderAccountError
          ? 403
          : fail instanceof SessionUnavailableError
            ? 401
            : 500,
      );
      assert.ok(!JSON.stringify(r.body).includes("private provider data"));
      assert.equal(r.headers["set-cookie"], undefined);
    }
  });
  it("distinguishes credential reconciliation from reset, retired-identity and revoked-session refusals without issuing cookies or private reset metadata", async () => {
    for (const [code, status] of [
      ["provider_credentials_changed", 403],
      ["provider_identity_retired", 403],
      ["provider_reset_pending", 503],
      ["provider_reset_review_required", 403],
      ["provider_access_review_required", 403],
      ["provider_session_revoked", 401],
      ["provider_signin_paused", 503],
    ]) {
      const response = await exchange(
        setup({ fail: new ProviderAccountError("safe refusal", status, code) }),
      );
      assert.equal(response.status, status);
      assert.deepEqual(response.body, { error: "safe refusal", code });
      assert.equal(response.headers["set-cookie"], undefined);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(
        response.headers["retry-after"],
        code === "provider_reset_pending" ? "5" : undefined,
      );
      assert.equal(
        Object.keys(response.body).some((key) =>
          /subject|account|generation|frozen|attempt|digest|job/i.test(key),
        ),
        false,
      );
    }
  });
  it("allows only bounded aggregate telemetry fields", async () => {
    for (const event of [
      "code_resent",
      "recovery_started",
      "recovery_completed",
      "recovery_failed",
      "recovery_cancelled",
    ])
      assert.equal(
        (
          await request(setup())
            .post("/api/auth/journey")
            .send({ event, seconds: 1.25 })
        ).status,
        204,
      );
    for (const body of [
      { event: "code", code: "secret" },
      { event: "code_sent", email: "private@example.test" },
      { event: "code_sent", seconds: 601 },
      { event: "recovery_failed", error: "private provider response" },
      { event: "recovery_completed", signature: "private proof" },
    ])
      assert.equal(
        (await request(setup()).post("/api/auth/journey").send(body)).status,
        400,
      );
  });
});
