import assert from "node:assert/strict";
import { beforeEach, it } from "node:test";

import { createSessionStore, sessionStore } from "../public/lib/session.js";

// A minimal page: window events, one fake BroadcastChannel registry shared
// by every "tab", a scripted fetch and Web Locks.
let channels;
let requests;
let replies;
let locks;
class FakeChannel {
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.posted = [];
    channels.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  postMessage(message) {
    this.posted.push(message);
    // Like BroadcastChannel, never deliver to the sender.
    for (const channel of channels)
      if (channel !== this && channel.name === this.name)
        for (const listener of channel.listeners) listener({ data: message });
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
function page() {
  const target = new EventTarget();
  target.BroadcastChannel = FakeChannel;
  globalThis.window = target;
  return target;
}
const me = (id) => Response.json({ user: { id, email: `${id}@example.test` } });

beforeEach(() => {
  channels = [];
  requests = [];
  replies = [];
  locks = [];
  globalThis.location = new URL("https://yaparena.test/account");
  globalThis.BroadcastChannel = FakeChannel;
  globalThis.isSecureContext = true;
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: async (name, options, work) => {
        locks.push({ name, mode: options.mode });
        return work();
      },
    },
  });
  globalThis.fetch = (path, init) => {
    requests.push({ path, init });
    const reply = replies.shift();
    return typeof reply === "function" ? reply() : Promise.resolve(reply);
  };
  page();
});

it("merges every /api/auth/me read on a page into one request", async () => {
  const store = createSessionStore();
  const gate = deferred();
  replies.push(() => gate.promise);
  const header = store.me();
  const account = store.me();
  const fresh = store.me({ fresh: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/auth/me");
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.equal(store.state().status, "checking");
  gate.resolve(me("account-1"));
  const users = await Promise.all([header, account, fresh]);
  assert.deepEqual(
    users.map((user) => user.id),
    ["account-1", "account-1", "account-1"],
  );
  assert.equal(store.account(), "account-1");
  assert.equal(store.state().status, "signed-in");
  // Later reads for the same account reuse the result; fresh asks again.
  assert.equal((await store.me()).id, "account-1");
  assert.equal(requests.length, 1);
  replies.push(me("account-1"));
  await store.me({ fresh: true });
  assert.equal(requests.length, 2);
});

it("reads again after an account change and ignores the earlier answer", async () => {
  const store = createSessionStore();
  const stale = deferred();
  replies.push(() => stale.promise, me("account-2"));
  const before = store.me();
  globalThis.window.dispatchEvent(new Event("yap:account-changed"));
  const [header, account] = [store.me(), store.me()];
  assert.equal(requests.length, 2);
  assert.equal((await header).id, "account-2");
  assert.equal((await account).id, "account-2");
  stale.resolve(me("account-1"));
  assert.equal((await before).id, "account-1");
  assert.equal(store.account(), "account-2");

  // A page restored from the back/forward cache reads again too.
  replies.push(me("account-3"));
  const restored = new Event("pageshow");
  restored.persisted = true;
  globalThis.window.dispatchEvent(restored);
  assert.equal((await store.me()).id, "account-3");
  const shown = new Event("pageshow");
  shown.persisted = false;
  globalThis.window.dispatchEvent(shown);
  assert.equal((await store.me()).id, "account-3");
  assert.equal(requests.length, 3);
});

it("reports signed-out, forbidden and unavailable sessions", async () => {
  const store = createSessionStore();
  replies.push(me("account-1"));
  await store.me();
  globalThis.window.dispatchEvent(new Event("yap:account-changed"));
  replies.push(new Response(null, { status: 401 }));
  assert.equal(await store.me(), null);
  assert.equal(store.account(), null);
  assert.equal(store.state().status, "signed-out");

  replies.push(me("account-1"));
  await store.me({ fresh: true });
  replies.push(Response.json({ error: "account restricted" }, { status: 403 }));
  await assert.rejects(store.me({ fresh: true }), {
    status: 403,
    message: "account restricted",
  });
  assert.equal(store.account(), null);
  assert.equal(store.state().status, "signed-out");

  replies.push(new Response("busy", { status: 429 }));
  await assert.rejects(store.me({ fresh: true }), {
    message: "Too many attempts. Wait a moment, then try again.",
  });
  replies.push(new Response("down", { status: 502 }));
  await assert.rejects(store.me({ fresh: true }), {
    message: "Request failed. Please try again.",
  });
  replies.push(() => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(store.me(), TypeError);
  assert.equal(store.state().status, "unavailable");
  // A failure is not reused: the next read asks again.
  replies.push(me("account-1"));
  assert.equal((await store.me()).id, "account-1");

  // An answer for an earlier account generation never changes the state.
  const late = deferred();
  replies.push(() => late.promise);
  const earlier = store.me({ fresh: true });
  globalThis.window.dispatchEvent(new Event("yap:account-changed"));
  late.resolve(new Response(null, { status: 500 }));
  await assert.rejects(earlier);
  assert.equal(store.state().status, "checking");
});

it("notifies subscribers and refreshes them after an account change", async () => {
  const store = createSessionStore();
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.status));
  replies.push(me("account-1"));
  await store.me();
  replies.push(me("account-2"));
  globalThis.window.dispatchEvent(new Event("yap:account-changed"));
  assert.equal(requests.length, 2);
  assert.equal((await store.me()).id, "account-2");
  assert.equal(requests.length, 2);
  globalThis.window.dispatchEvent(
    new CustomEvent("yap:provider-logout", { detail: false }),
  );
  assert.equal(store.account(), null);
  // The store starts in "checking", so the first read announces only its result.
  assert.deepEqual(seen, ["signed-in", "checking", "signed-in", "signed-out"]);
  unsubscribe();
  globalThis.window.dispatchEvent(new Event("yap:account-changed"));
  assert.equal(requests.length, 2);
  assert.equal(seen.length, 4);
});

it("owns the page's only account channel and shares one store per page", async () => {
  const first = sessionStore();
  assert.equal(sessionStore(), first);
  assert.equal(globalThis.window.yapSession, first);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "yaparena-account");

  // Another tab's change reaches this page as yap:account-changed.
  const tab = globalThis.window;
  let changes = 0;
  tab.addEventListener("yap:account-changed", () => changes++);
  page();
  const other = sessionStore();
  assert.notEqual(other, first);
  assert.equal(channels.length, 2);
  const events = [];
  globalThis.window.addEventListener("yap:provider-logout", (event) =>
    events.push(["logout", event.detail]),
  );
  globalThis.window.addEventListener("yap:account-changed", () =>
    events.push(["changed"]),
  );
  other.signedOut(true);
  assert.deepEqual(events, [["logout", true], ["changed"]]);
  assert.deepEqual(channels[1].posted, ["changed"]);
  assert.equal(changes, 1);

  // Without BroadcastChannel the store still works on its own page.
  const plain = new EventTarget();
  globalThis.window = plain;
  createSessionStore().signedOut(false);
  assert.equal(channels.length, 2);
});

it("revokes under the origin-wide lock with the verified account", async () => {
  const store = createSessionStore();
  replies.push(me("account-1"));
  await store.me();
  replies.push(Response.json({ redirectTo: "https://login.example.test/" }));
  const response = await store.fetch("/api/auth/logout", { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(locks, [
    { name: "yaparena-application-session", mode: "exclusive" },
  ]);
  const { path, init } = requests[1];
  assert.equal(path, "/api/auth/logout");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.get("X-YapArena-Expected-Account"), "account-1");

  // A caller abort stops the queued request.
  const caller = new AbortController();
  caller.abort(new Error("cancelled"));
  replies.push(() => Promise.reject(new Error("cancelled")));
  await assert.rejects(
    store.fetch("/api/auth/sessions/4", {
      method: "DELETE",
      signal: caller.signal,
    }),
    { message: "cancelled" },
  );

  globalThis.isSecureContext = false;
  await assert.rejects(store.fetch("/api/auth/logout", { method: "POST" }), {
    message: /cannot safely coordinate account changes/,
  });
});

it("gives up on a queued or unanswered revocation with a clear message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createSessionStore();
  const waitForAbort = (signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  // Another tab holds the lock for longer than the queue allows.
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: { request: (_name, options) => waitForAbort(options.signal) },
  });
  const queued = store.fetch("/api/auth/logout", { method: "POST" });
  t.mock.timers.tick(35000);
  await assert.rejects(queued, {
    message:
      "Another account change is still finishing. Sign-out is unconfirmed; wait and try again.",
  });
  // The lock is free but the server never answers.
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: { request: (_name, _options, work) => work() },
  });
  globalThis.fetch = (_path, init) => waitForAbort(init.signal);
  const unanswered = store.fetch("/api/auth/logout", { method: "POST" });
  await Promise.resolve();
  t.mock.timers.tick(10000);
  await assert.rejects(unanswered, {
    message:
      "Sign-out could not be confirmed. Refresh your account and try again.",
  });
});

it("passes other account requests through without the lock", async () => {
  const store = createSessionStore();
  store.remember("account-9");
  assert.equal(store.account(), "account-9");
  replies.push(new Response(null, { status: 401 }), Response.json({}));
  const read = await store.fetch("/api/auth/me");
  assert.equal(read.status, 401);
  await store.fetch("/api/auth/sessions/0", { method: "DELETE" });
  await store.fetch("/api/auth/logout");
  assert.equal(locks.length, 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].init, {});
  await assert.rejects(store.fetch("https://elsewhere.test/api/auth/logout"), {
    message: "Requests must stay on YapArena.",
  });
  store.remember(null);
  assert.equal(store.account(), null);
});
