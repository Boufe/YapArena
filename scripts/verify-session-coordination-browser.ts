import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express from "express";
import { chromium, type Page } from "playwright-core";
import type {} from "../frontend/auth-events.js";

// Actual Chromium Fetch/Web Locks and HTTP cookie behavior, synthetic server
// fixtures only. No provider, application identity, database or funds are used.
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const directory = resolve(
  "docs/evidence/account-completion-baseline/session-coordination-browser",
);
const asset = await readFile("public/session-coordination.js");
const app = express();
app.use(express.json());
app.get("/", (_r, s) =>
  s.send(
    '<!doctype html><html lang="en"><head><title>Local session coordination fixture</title><script defer src="/session-coordination.js"></script></head><body><h1>Local synthetic HTTP fixture</h1></body></html>',
  ),
);
app.get("/session-coordination.js", (_r, s) => s.type("js").send(asset));
const gates = new Map<string, ReturnType<typeof deferred>>();
const bodyGates = new Map<string, ReturnType<typeof deferred>>();
const arrivals = new Map<string, ReturnType<typeof deferred>>();
const entered = new Set<string>();
const sessions = new Map<string, { account: string; active: boolean }>();
const revocationCookies = new Map<string, string | undefined>();
app.use("/api/auth", async (r, s) => {
  const body: unknown = r.body;
  const cookie = r.headers.cookie?.match(
    /(?:^|;\s*)coordination_fixture=([^;]+)/,
  )?.[1];
  const current = cookie ? sessions.get(cookie) : undefined;
  if (r.method === "GET")
    return current?.active
      ? s.json({ account: current.account })
      : s.sendStatus(401);
  if (
    !body ||
    typeof body !== "object" ||
    !("label" in body) ||
    typeof body.label !== "string"
  )
    return s.sendStatus(400);
  const label = body.label;
  const revocation =
    r.path.startsWith("/logout") || r.path.startsWith("/sessions/");
  if (!revocation) {
    // Model the DB commit preceding delayed HTTP headers. A credential rotation
    // invalidates the old cookie before its replacement reaches the browser.
    if (label.startsWith("rotation-") && current) current.active = false;
    sessions.set(label, {
      account: label.startsWith("account-b-") ? "synthetic-b" : "synthetic-a",
      active: true,
    });
  }
  entered.add(label);
  arrivals.get(label)?.release();
  await gates.get(label)?.promise;
  if (revocation) {
    revocationCookies.set(label, cookie);
    if (!current?.active) return s.sendStatus(401);
    const expected = r.get("X-YapArena-Expected-Account");
    if (expected && expected !== current.account) return s.sendStatus(409);
    for (const [id, session] of sessions)
      if (
        session.account === current.account &&
        (r.path !== "/logout-other-sessions" || id !== cookie)
      )
        session.active = false;
    return s.status(200).json({ label });
  }
  s.cookie("coordination_fixture", label, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  const bodyGate = bodyGates.get(label);
  if (bodyGate) {
    s.type("json").write('{"label":');
    await bodyGate.promise;
    s.end(`${JSON.stringify(label)}}`);
  } else s.json({ label });
});
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const checks: string[] = [];
async function start(page: Page, path: string, label: string, method = "POST") {
  await page.evaluate(
    ({ path, label, method }) => {
      if (!window.yapSessionFetch) throw new Error("session helper missing");
      Reflect.set(window, label, "pending");
      void window
        .yapSessionFetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        })
        .then(async (response) => {
          await response.text();
          Reflect.set(window, `${label}Status`, response.status);
          Reflect.set(window, label, "complete");
        })
        .catch((error: unknown) => {
          Reflect.set(
            window,
            label,
            error instanceof Error ? error.message : "failed",
          );
        });
    },
    { path, label, method },
  );
}
async function result(page: Page, label: string) {
  await page.waitForFunction(
    (label) => Reflect.get(window, label) !== "pending",
    label,
    { timeout: 35000 },
  );
  const value: unknown = await page.evaluate(
    (label) => Reflect.get(window, label),
    label,
  );
  assert.equal(typeof value, "string");
  return value;
}
function hold(label: string, body = false) {
  const gate = deferred(),
    arrived = deferred();
  (body ? bodyGates : gates).set(label, gate);
  arrivals.set(label, arrived);
  return { ...gate, arrived: arrived.promise };
}
try {
  const context = await browser.newContext();
  const a = await context.newPage(),
    b = await context.newPage();
  await Promise.all([a.goto(base), b.goto(base)]);
  for (const page of [a, b])
    await page.waitForFunction(
      () => typeof window.yapSessionFetch === "function",
    );
  const id = "00000000-0000-4000-8000-000000000001";
  const routes = [
    ["POST", "/api/auth/register"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/privy/exchange"],
    ["POST", "/api/auth/wallet/login/verify"],
    ["POST", `/api/auth/wallet/operations/${id}/complete`],
    ["POST", `/api/auth/security/access/login/${id}/complete`],
    ["POST", `/api/auth/security/access/reconciliation/${id}/complete`],
    ["POST", `/api/auth/security/passkeys/enrollment/${id}/complete`],
    ["DELETE", `/api/auth/security/passkeys/${id}`],
    ["POST", `/api/auth/security/wallet/operations/${id}/complete`],
    ["POST", `/api/auth/security/provider/link/${id}/complete`],
  ] as const;
  for (const [index, [method, path]] of routes.entries()) {
    const first = `held-${index}`,
      second = `replacement-${index}`,
      gate = hold(first);
    await start(a, "/api/auth/login", first);
    await gate.arrived;
    await start(b, path, second, method);
    await b.waitForFunction(async () =>
      (await navigator.locks.query()).pending?.some(
        (lock) => lock.name === "yaparena-application-session",
      ),
    );
    assert.equal(entered.has(second), false, path);
    gate.release();
    assert.equal(await result(a, first), "complete");
    assert.equal(await result(b, second), "complete");
    const cookie = (await context.cookies(base)).find(
      (cookie) => cookie.name === "coordination_fixture",
    );
    assert.ok(cookie);
    assert.equal(cookie.value, second);
    assert.equal(cookie.httpOnly, true);
  }
  checks.push(
    "Every application session-issuing route serializes actual HTTP cookie headers across two browser tabs.",
  );

  const body = hold("held-body", true);
  await start(a, "/api/auth/login", "held-body");
  await body.arrived;
  await start(b, "/api/auth/register", "after-body");
  await b.waitForFunction(async () =>
    (await navigator.locks.query()).pending?.some(
      (lock) => lock.name === "yaparena-application-session",
    ),
  );
  assert.equal(entered.has("after-body"), false);
  assert.equal(
    await b.evaluate(
      async () => (await window.yapSessionFetch!("/api/auth/me")).status,
    ),
    200,
  );
  await start(b, "/api/auth/logout", "after-body-logout");
  assert.equal(entered.has("after-body-logout"), false);
  body.release();
  assert.equal(await result(a, "held-body"), "complete");
  assert.equal(await result(b, "after-body"), "complete");
  assert.equal(await result(b, "after-body-logout"), "complete");
  assert.equal(revocationCookies.get("after-body-logout"), "after-body");
  checks.push(
    "A delayed response body retains the session lock; reads remain unlocked and sign-out waits for the final replacement cookie.",
  );

  const revocations = [
    ["POST", "/api/auth/logout"],
    ["POST", "/api/auth/logout-all"],
    ["POST", "/api/auth/logout-other-sessions"],
    ["DELETE", "/api/auth/sessions/7"],
  ] as const;
  for (const [index, [method, path]] of revocations.entries()) {
    await start(a, "/api/auth/login", `before-rotation-${index}`);
    assert.equal(await result(a, `before-rotation-${index}`), "complete");
    await b.evaluate(() => window.yapRememberSessionAccount!("synthetic-a"));
    const label = `rotation-${index}`,
      gate = hold(label);
    await start(
      a,
      "/api/auth/security/passkeys/enrollment/" + id + "/complete",
      label,
    );
    await gate.arrived;
    await start(b, path, `rotation-logout-${index}`, method);
    await b.waitForFunction(async () =>
      (await navigator.locks.query()).pending?.some(
        (lock) => lock.name === "yaparena-application-session",
      ),
    );
    assert.equal(entered.has(`rotation-logout-${index}`), false);
    gate.release();
    assert.equal(await result(a, label), "complete");
    assert.equal(await result(b, `rotation-logout-${index}`), "complete");
    assert.equal(
      await b.evaluate(
        (label) => Reflect.get(window, label + "Status"),
        `rotation-logout-${index}`,
      ),
      200,
    );
    assert.equal(revocationCookies.get(`rotation-logout-${index}`), label);
    assert.equal(sessions.get(label)?.active, path.endsWith("other-sessions"));
  }
  checks.push(
    "All four revocation controls wait for a committed credential rotation's delayed headers and revoke using the replacement cookie; sign-out-other-sessions preserves only that current session.",
  );

  await start(a, "/api/auth/login", "before-cross-account");
  assert.equal(await result(a, "before-cross-account"), "complete");
  await a.evaluate(() => window.yapRememberSessionAccount!("synthetic-a"));
  const cross = hold("rotation-cross-account");
  await start(a, "/api/auth/login", "rotation-cross-account");
  await cross.arrived;
  await start(b, "/api/auth/login", "account-b-replacement");
  await b.waitForFunction(
    async () => (await navigator.locks.query()).pending?.length === 1,
  );
  await start(a, "/api/auth/logout", "old-a-logout");
  await a.waitForFunction(
    async () => (await navigator.locks.query()).pending?.length === 2,
  );
  cross.release();
  assert.equal(await result(a, "rotation-cross-account"), "complete");
  assert.equal(await result(b, "account-b-replacement"), "complete");
  assert.equal(await result(a, "old-a-logout"), "complete");
  assert.equal(
    await a.evaluate(() => Reflect.get(window, "old-a-logoutStatus")),
    409,
  );
  assert.equal(sessions.get("account-b-replacement")?.active, true);
  assert.equal(
    await b.evaluate(
      async () => (await (await fetch("/api/auth/me")).json()).account,
    ),
    "synthetic-b",
  );
  checks.push(
    "A different account's login queued before old-account logout keeps its cookie and active session; the captured account comparison rejects the stale logout with409.",
  );

  const queued = hold("queue-holder");
  await start(a, "/api/auth/login", "queue-holder");
  await queued.arrived;
  await start(b, "/api/auth/register", "queue-timeout");
  assert.match(
    String(await result(b, "queue-timeout")),
    /Another sign-in is still finishing/,
  );
  assert.equal(entered.has("queue-timeout"), false);
  queued.release();
  assert.equal(await result(a, "queue-holder"), "complete");
  checks.push(
    "The ten-second lock-wait timeout cancels a queued mutation before any HTTP submission.",
  );

  const timeout = hold("network-timeout");
  await start(a, "/api/auth/login", "network-timeout");
  await timeout.arrived;
  assert.match(
    String(await result(a, "network-timeout")),
    /Account request timed out/,
  );
  await start(b, "/api/auth/register", "after-timeout");
  assert.equal(await result(b, "after-timeout"), "complete");
  timeout.release();
  // A read round trip follows the attempted late server response. Cookies are
  // inspected by Chromium itself, never inferred from a mocked fetch result.
  await b.evaluate(() => fetch("/api/auth/me"));
  const cookie = (await context.cookies(base)).find(
    (cookie) => cookie.name === "coordination_fixture",
  );
  assert.equal(cookie?.value, "after-timeout");
  checks.push(
    "The actual thirty-second Fetch timeout aborts old headers; a later server response cannot overwrite the replacement HttpOnly cookie.",
  );

  const unsupported = await context.newPage();
  await unsupported.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => undefined,
    }),
  );
  await unsupported.goto(base);
  await start(unsupported, "/api/auth/login", "unsupported");
  assert.match(
    String(await result(unsupported, "unsupported")),
    /browser cannot safely coordinate/,
  );
  assert.equal(entered.has("unsupported"), false);
  checks.push(
    "A browser without Web Locks receives a clear failure and never submits a weaker session mutation.",
  );
  await context.close();
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "results.json"),
    JSON.stringify(
      {
        result: "PASS",
        at: new Date().toISOString(),
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        browser: browser.version(),
        assetSha256: createHash("sha256").update(asset).digest("hex"),
        sourceSha256: createHash("sha256")
          .update(await readFile("frontend/session-coordination.ts"))
          .digest("hex"),
        checks,
        limitations: [
          "Local synthetic HTTP server and Chromium only; no provider or database acceptance.",
          "Coordination applies to supported application browser flows; arbitrary API clients do not participate in browser locks.",
          "No physical-device or other-browser acceptance is inferred.",
        ],
        documentation: [
          "https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API",
          "https://w3c.github.io/web-locks/",
          "https://fetch.spec.whatwg.org/",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      checks: checks.length,
      evidence: directory,
    }),
  );
} finally {
  for (const gate of [...gates.values(), ...bodyGates.values()]) gate.release();
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
