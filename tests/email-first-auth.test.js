import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { describe, it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  createPrivyVerifier,
  ProviderCredentialChangedError,
} from "../dist/platform/auth/privy.js";
import { loadProviderConfig } from "../dist/platform/auth/provider-config.js";
import { createSharedAbuseLimiter } from "../dist/platform/shared-abuse.js";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { ProviderAccountError } from "../dist/platform/auth/provider-accounts.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";
import {
  formatYapCoins,
  createAccountWallet,
  grantProgress,
} from "../dist/features/account-wallet/repository.js";
import { safeAuthReturn } from "../frontend/auth-return.ts";
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
  it("verifies a real ES256 signature and obtains ownership data only from the provider", async () => {
    assert.deepEqual(await verifier().verify(jwt()), {
      subject: claims.sub,
      sessionId: claims.sid,
      email: "verified@example.test",
      methods: ["email"],
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
        details: async () => null,
      },
      verifier: verifier(),
    };
    return createApp({
      messages: {},
      users: {},
      sessions: {
        findUserByTokenHash: async () => (active ? { id: "11" } : null),
        deleteByTokenHash: async () => {},
        revoke: async () => {},
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
    for (const path of ["logout-all", "logout-other-sessions"])
      assert.equal(
        (
          await request(app)
            .post(`/api/auth/${path}`)
            .set("Origin", "https://arena.example")
            .set("Cookie", "__Host-session=synthetic")
        ).status,
        204,
      );
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
  it("allows only bounded aggregate telemetry fields", async () => {
    assert.equal(
      (
        await request(setup())
          .post("/api/auth/journey")
          .send({ event: "code_resent" })
      ).status,
      204,
    );
    for (const body of [
      { event: "code", code: "secret" },
      { event: "code_sent", email: "private@example.test" },
      { event: "code_sent", seconds: 601 },
    ])
      assert.equal(
        (await request(setup()).post("/api/auth/journey").send(body)).status,
        400,
      );
  });
});
