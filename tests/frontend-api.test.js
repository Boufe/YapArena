import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";

import {
  ApiError,
  api,
  apiError,
  apiErrorStatus,
  apiFetch,
  sameOriginUrl,
} from "../public/lib/api.js";

let calls;
let reply;
beforeEach(() => {
  globalThis.location = new URL("https://yaparena.test/topics");
  calls = [];
  reply = () => Response.json({ ok: true });
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return reply(init);
  };
});

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers });

it("sends same-origin credentials, a JSON body and the expected account", async () => {
  const result = await api("/api/me/profile", {
    method: "PATCH",
    json: { displayName: "Ada" },
    headers: { "Idempotency-Key": "key-1" },
    expectedAccount: "account-1",
    cache: "no-store",
  });
  assert.deepEqual(result, { ok: true });
  const [{ path, init }] = calls;
  assert.equal(path, "/api/me/profile");
  assert.equal(init.method, "PATCH");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.cache, "no-store");
  assert.equal(init.body, '{"displayName":"Ada"}');
  assert.equal(init.signal, undefined);
  assert.equal(init.headers.get("Content-Type"), "application/json");
  assert.equal(init.headers.get("Idempotency-Key"), "key-1");
  assert.equal(init.headers.get("X-YapArena-Expected-Account"), "account-1");
});

it("sends no body or JSON type without json, and returns undefined for 204", async () => {
  reply = () => new Response(null, { status: 204 });
  assert.equal(
    await api("/api/me/follows/topics/a", { method: "DELETE" }),
    undefined,
  );
  const [{ init }] = calls;
  assert.equal("body" in init, false);
  assert.equal(init.headers.has("Content-Type"), false);
  assert.equal(init.headers.has("X-YapArena-Expected-Account"), false);
  // A caller's own body passes through unchanged.
  await apiFetch("/api/upload", { method: "POST", body: "raw" });
  assert.equal(calls[1].init.body, "raw");
});

it("refuses another origin before sending anything", async () => {
  await assert.rejects(api("https://elsewhere.test/api/auth/me"), {
    message: "Requests must stay on YapArena.",
  });
  assert.throws(() => sameOriginUrl("//elsewhere.test/x"));
  assert.equal(
    sameOriginUrl("/api/x?y=1").href,
    "https://yaparena.test/api/x?y=1",
  );
  assert.equal(calls.length, 0);
});

it("reports failures as ApiError with the server's message, code and retry time", async () => {
  reply = () =>
    json(
      { error: "Slow down.", code: "RATE_LIMITED", retryAfterSeconds: 9 },
      429,
    );
  const limited = await api("/api/x").catch((error) => error);
  assert.ok(limited instanceof ApiError);
  assert.equal(limited.message, "Slow down.");
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(limited.retryAfterSeconds, 9);
  assert.equal(apiErrorStatus(limited), 429);

  reply = () => json({}, 503, { "Retry-After": "12" });
  const unavailable = await api("/api/x").catch((error) => error);
  assert.equal(unavailable.message, "Request failed (503).");
  assert.equal(unavailable.code, undefined);
  assert.equal(unavailable.retryAfterSeconds, 12);

  reply = () =>
    new Response("<html>", {
      status: 404,
      headers: { "Content-Type": "text/html", "Retry-After": "soon" },
    });
  const missing = await api("/api/x", {
    errorMessage: (status) => `custom ${status}`,
  }).catch((error) => error);
  assert.equal(missing.message, "custom 404");
  assert.equal(missing.retryAfterSeconds, undefined);

  const malformed = await apiError(
    new Response("{", {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.equal(malformed.message, "Request failed (500).");
  assert.equal(apiErrorStatus(new Error("network")), undefined);
  assert.equal(apiErrorStatus("text"), undefined);
});

it("passes a caller signal or a timeout through, and combines both", async () => {
  const caller = new AbortController();
  await apiFetch("/api/a", { signal: caller.signal });
  assert.equal(calls[0].init.signal, caller.signal);

  await apiFetch("/api/b", { timeout: 1000 });
  assert.ok(calls[1].init.signal instanceof AbortSignal);
  assert.equal(calls[1].init.signal.aborted, false);

  // Both: the caller's abort reaches the request with its reason.
  let seen;
  reply = (init) =>
    new Promise((_resolve, reject) => {
      seen = init.signal;
      // Like fetch, reject at once for a signal that is already aborted.
      if (init.signal.aborted) reject(init.signal.reason);
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const pending = apiFetch("/api/c", { signal: caller.signal, timeout: 60000 });
  caller.abort(new Error("left the page"));
  await assert.rejects(pending, { message: "left the page" });
  assert.equal(seen.aborted, true);

  // Both: the timeout aborts with a TimeoutError.
  const timed = apiFetch("/api/d", {
    signal: new AbortController().signal,
    timeout: 5,
  });
  await assert.rejects(timed, { name: "TimeoutError" });

  // An already aborted caller signal aborts at once.
  const aborted = new AbortController();
  aborted.abort(new Error("already"));
  await assert.rejects(
    apiFetch("/api/e", { signal: aborted.signal, timeout: 60000 }),
    { message: "already" },
  );
});
