import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express from "express";
import { chromium, type Page } from "playwright-core";
import type {} from "../frontend/lib/session.js";

// Actual Chromium Fetch/Web Locks and HTTP cookie behavior, synthetic server
// fixtures only. No provider, application identity, database or funds are used.
// Sign-in is a full-page navigation through Auth0 (Decision 0009); the
// fixture's /fixture/sign-in stands in for that navigation's new cookie.
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const directory = resolve(
  process.env.SESSION_COORDINATION_ARTIFACT_DIR ??
    "/tmp/yaparena-session-coordination-browser",
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
const cookieOf = (header: string | undefined) =>
  header?.match(/(?:^|;\s*)coordination_fixture=([^;]+)/)?.[1];
app.post("/fixture/sign-in", (r, s) => {
  const { label, account } = r.body as { label: string; account: string };
  sessions.set(label, { account, active: true });
  s.cookie("coordination_fixture", label, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  s.sendStatus(204);
});
app.get("/api/auth/me", (r, s) => {
  const current = sessions.get(cookieOf(r.headers.cookie) ?? "");
  return current?.active
    ? s.json({ account: current.account })
    : s.sendStatus(401);
});
app.use("/api/auth", async (r, s) => {
  const body: unknown = r.body;
  const cookie = cookieOf(r.headers.cookie);
  const current = cookie ? sessions.get(cookie) : undefined;
  if (
    !body ||
    typeof body !== "object" ||
    !("label" in body) ||
    typeof body.label !== "string"
  )
    return s.sendStatus(400);
  const label = body.label;
  entered.add(label);
  arrivals.get(label)?.release();
  await gates.get(label)?.promise;
  revocationCookies.set(label, cookie);
  if (!current?.active) return s.sendStatus(401);
  const expected = r.get("X-YapArena-Expected-Account");
  if (expected && expected !== current.account) return s.sendStatus(409);
  // Sign-out ends only the session that sent the request.
  current.active = false;
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
      if (!window.yapSession) throw new Error("session helper missing");
      Reflect.set(window, label, "pending");
      void window.yapSession
        .fetch(path, {
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
async function status(page: Page, label: string) {
  return page.evaluate((label) => Reflect.get(window, `${label}Status`), label);
}
async function signIn(page: Page, label: string, account = "synthetic-a") {
  await page.evaluate(
    async ({ label, account }) => {
      await fetch("/fixture/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, account }),
      });
    },
    { label, account },
  );
}
function hold(label: string, body = false) {
  const gate = deferred(),
    arrived = deferred();
  (body ? bodyGates : gates).set(label, gate);
  arrivals.set(label, arrived);
  return { ...gate, arrived: arrived.promise };
}
async function waitingForLock(page: Page) {
  await page.waitForFunction(async () =>
    (await navigator.locks.query()).pending?.some(
      (lock) => lock.name === "yaparena-application-session",
    ),
  );
}
try {
  const context = await browser.newContext();
  const a = await context.newPage(),
    b = await context.newPage();
  await Promise.all([a.goto(base), b.goto(base)]);
  for (const page of [a, b])
    await page.waitForFunction(
      () => typeof window.yapSession?.fetch === "function",
    );

  const revocations = [
    ["POST", "/api/auth/logout"],
    ["DELETE", "/api/auth/sessions/7"],
  ] as const;
  for (const [index, [method, path]] of revocations.entries()) {
    await signIn(a, `serial-${index}`);
    const first = `held-${index}`,
      second = `queued-${index}`,
      gate = hold(first);
    await start(a, path, first, method);
    await gate.arrived;
    await start(b, path, second, method);
    await waitingForLock(b);
    assert.equal(entered.has(second), false, path);
    gate.release();
    assert.equal(await result(a, first), "complete");
    assert.equal(await result(b, second), "complete");
    assert.equal(await status(a, first), 200);
    // The queued request ran after the first ended the shared session.
    assert.equal(await status(b, second), 401);
  }
  checks.push(
    "Sign-out and session removal serialize across two browser tabs; the queued request runs only after the first finished.",
  );

  await signIn(a, "held-body");
  const body = hold("held-body", true);
  await start(a, "/api/auth/logout", "held-body");
  await body.arrived;
  await start(b, "/api/auth/logout", "after-body");
  await waitingForLock(b);
  assert.equal(entered.has("after-body"), false);
  assert.equal(
    await b.evaluate(
      async () => (await window.yapSession!.fetch("/api/auth/me")).status,
    ),
    401,
    "reads pass without the lock",
  );
  body.release();
  assert.equal(await result(a, "held-body"), "complete");
  assert.equal(await result(b, "after-body"), "complete");
  checks.push(
    "A delayed response body retains the session lock; reads pass without it.",
  );

  await signIn(a, "account-a");
  await a.evaluate(() => window.yapSession!.remember("synthetic-a"));
  // Another tab completes a sign-in to a different account.
  await signIn(b, "account-b", "synthetic-b");
  await start(a, "/api/auth/logout", "stale-a-logout");
  assert.equal(await result(a, "stale-a-logout"), "complete");
  assert.equal(await status(a, "stale-a-logout"), 409);
  assert.equal(revocationCookies.get("stale-a-logout"), "account-b");
  assert.equal(sessions.get("account-b")?.active, true);
  checks.push(
    "A page's sign-out carries the account it verified; after another tab signs in to a different account it is refused with 409 and the new session stays.",
  );

  const timeout = hold("network-timeout");
  await signIn(a, "timeout-session");
  await start(a, "/api/auth/logout", "network-timeout");
  await timeout.arrived;
  assert.match(
    String(await result(a, "network-timeout")),
    /Sign-out could not be confirmed/,
  );
  timeout.release();
  checks.push(
    "The ten-second sign-out timeout reports an unconfirmed sign-out instead of waiting indefinitely.",
  );

  await b.evaluate(() => {
    window.yapSession!.remember("synthetic-a");
    window.dispatchEvent(
      new CustomEvent("yap:provider-logout", { detail: false }),
    );
  });
  assert.equal(await b.evaluate(() => window.yapSession!.account()), null);
  checks.push("Signing out forgets the verified account.");

  const unsupported = await context.newPage();
  await unsupported.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "locks", {
      configurable: true,
      get: () => undefined,
    }),
  );
  await unsupported.goto(base);
  await start(unsupported, "/api/auth/logout", "unsupported");
  assert.match(
    String(await result(unsupported, "unsupported")),
    /browser cannot safely coordinate/,
  );
  assert.equal(entered.has("unsupported"), false);
  checks.push(
    "A browser without Web Locks receives a clear failure and never submits an uncoordinated sign-out.",
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
