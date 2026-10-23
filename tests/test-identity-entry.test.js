import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, mock } from "node:test";
import express from "express";
import { SignInError } from "../dist/platform/auth/auth0-accounts.js";
import request from "../scripts/test-http-request.ts";
import {
  createTestIdentityRouter,
  testIdentityRefusal,
  testSubject,
} from "../scripts/test-identity.ts";

const run = promisify(execFile);
const entry = new URL("../scripts/test-identity-entry.ts", import.meta.url)
  .pathname;

// The entry must stop before it loads the application or connects anywhere.
async function start(environment) {
  try {
    await run(process.execPath, [entry], {
      env: { PATH: process.env.PATH, ...environment },
      timeout: 10_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.code, stderr: error.stderr };
  }
}

describe("test identity entry", () => {
  it("refuses to start with NODE_ENV=production", async () => {
    const result = await start({ NODE_ENV: "production" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refuses NODE_ENV=production/);
  });

  it("refuses Render, provider settings and a non-loopback origin", async () => {
    for (const [environment, message] of [
      [{ RENDER: "true" }, /refuses to run on Render/],
      [{ AUTH0_CLIENT_SECRET: "secret" }, /refuses AUTH0_CLIENT_SECRET/],
      [
        { APP_ORIGIN: "https://yaparena-staging-web.onrender.com" },
        /loopback APP_ORIGIN/,
      ],
    ]) {
      const result = await start({ NODE_ENV: "test", ...environment });
      assert.equal(result.code, 1);
      assert.match(result.stderr, message);
    }
    for (const key of [
      "AUTH0_ISSUER_BASE_URL",
      "AUTH0_CLIENT_ID",
      "PRODUCTION_SERVICE",
      "PRIVY_APP_ID",
      "PRIVY_APP_SECRET",
      "PRIVY_VERIFICATION_KEY",
    ])
      assert.match(testIdentityRefusal({ [key]: "x" }), new RegExp(key));
    assert.match(testIdentityRefusal({ APP_ORIGIN: "::" }), /loopback/);
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:4000",
      "http://[::1]:3000",
      undefined,
    ])
      assert.equal(
        testIdentityRefusal({ NODE_ENV: "test", APP_ORIGIN: origin }),
        null,
      );
  });

  it("signs in through the shared sign-in function from a form, including the email-code link step", async () => {
    const results = [
      {
        kind: "link_required",
        pendingLinkId: "link-1",
        email: "p@example.test",
      },
      {
        kind: "session",
        user: { id: "7", email: null, createdAt: new Date(0) },
        created: false,
        linked: ["google"],
      },
    ];
    const accounts = { signIn: mock.fn(async () => results.shift()) };
    const app = express().use(
      "/api/test-identity",
      createTestIdentityRouter({
        accounts,
        environment: "test",
        now: () => 1_000_000,
      }),
    );
    const form = await request(app).get("/api/test-identity?return=%2Flive");
    assert.match(form.text, /name="return" value="\/live"/);
    const google = await request(app)
      .post("/api/test-identity/sign-in")
      .type("form")
      .send({ email: "P@example.test", method: "google", return: "/live" });
    assert.equal(google.status, 202);
    assert.match(google.text, /name="pendingLinkId" value="link-1"/);
    assert.equal(google.headers["set-cookie"], undefined);
    const linked = await request(app)
      .post("/api/test-identity/sign-in")
      .type("form")
      .send({
        email: "p@example.test",
        method: "email",
        pendingLinkId: "link-1",
        return: "//evil.example",
      });
    assert.equal(linked.status, 303);
    assert.equal(linked.headers.location, "/");
    assert.match(linked.headers["set-cookie"][0], /^session=.*HttpOnly/);
    const [[first, firstContext], [second, secondContext]] =
      accounts.signIn.mock.calls.map((call) => call.arguments);
    assert.deepEqual(first, {
      subject: testSubject("google", "p@example.test"),
      email: "p@example.test",
      method: "google",
      authTime: 1000,
    });
    assert.deepEqual(firstContext, { purpose: "sign_in" });
    assert.equal(second.method, "email");
    assert.deepEqual(secondContext, {
      purpose: "link",
      pendingLinkId: "link-1",
    });
  });

  it("reports refusals without a session", async () => {
    const accounts = {
      signIn: async () => {
        throw new SignInError("account_unavailable", 403, "refused for test");
      },
    };
    const app = express().use(
      "/api/test-identity",
      createTestIdentityRouter({ accounts, environment: "test" }),
    );
    const json = await request(app)
      .post("/api/test-identity/sign-in")
      .send({ email: "p@example.test" });
    assert.equal(json.status, 403);
    assert.deepEqual(json.body, {
      error: "refused for test",
      code: "account_unavailable",
    });
    const form = await request(app)
      .post("/api/test-identity/sign-in")
      .type("form")
      .send({ email: "p@example.test" });
    assert.equal(form.status, 403);
    assert.match(form.text, /refused for test/);
    assert.equal(form.headers["set-cookie"], undefined);
  });
});
