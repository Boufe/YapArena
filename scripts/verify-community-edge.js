/* global window */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// Read-only TLS/edge check. An eligible synthetic room must already exist under
// the separately authorized staging workflow; this script never creates data.
const base = new URL(
  process.env.BROWSER_BASE_URL ?? "https://yaparena-staging-web.onrender.com",
);
assert.equal(base.protocol, "https:");
const suppliedRoom = process.env.COMMUNITY_EDGE_ROOM_ID;
const room = suppliedRoom ?? "00000000-0000-4000-8000-000000000000";
assert.match(room, /^[0-9a-f-]{36}$/);
const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  const responses = [];
  session.on("Network.responseReceived", ({ response }) => {
    const url = new URL(response.url);
    if (url.origin === base.origin)
      responses.push({
        path: url.pathname,
        status: response.status,
        protocol: response.protocol,
        headers: response.headers,
      });
  });
  await page.goto(`${base.origin}/ready`, { timeout: 90000 });
  const timing = await page.evaluate(
    ({ room, enabled }) =>
      new Promise((resolve) => {
        if (!enabled) {
          window
            .fetch(`/api/community/events/${room}/stream`)
            .then((r) => resolve({ status: r.status, verifiedDelivery: false }))
            .catch(() => resolve({ verifiedDelivery: false }));
          return;
        }
        const started = performance.now();
        const stream = new window.EventSource(
          `/api/community/events/${room}/stream`,
        );
        let firstFrameMs;
        const timer = window.setTimeout(() => {
          stream.close();
          resolve({ verifiedDelivery: false, timeout: true });
        }, 30000);
        stream.addEventListener("community", () => {
          firstFrameMs ??= Math.round(performance.now() - started);
        });
        stream.addEventListener("heartbeat", () => {
          if (firstFrameMs === undefined) return;
          window.clearTimeout(timer);
          stream.close();
          resolve({
            firstFrameMs,
            firstHeartbeatMs: Math.round(performance.now() - started),
            verifiedDelivery: true,
          });
        });
        stream.onerror = () => {
          window.clearTimeout(timer);
          stream.close();
          resolve({ verifiedDelivery: false, connectionError: true });
        };
      }),
    { room, enabled: !!suppliedRoom },
  );
  const health = responses.find((r) => r.path === "/ready");
  const stream = responses.find((r) => r.path.endsWith("/stream"));
  const evidence = {
    trial: "browser-to-edge",
    at: new Date().toISOString(),
    origin: base.origin,
    healthStatus: health?.status,
    healthProtocol: health?.protocol,
    streamStatus: stream?.status ?? timing.status,
    streamProtocol: stream?.protocol,
    ...timing,
  };
  console.log(JSON.stringify(evidence));
  assert.equal(health?.status, 200);
  assert.equal(health?.protocol, "h2", "browser-to-edge must negotiate HTTP/2");
  if (suppliedRoom) {
    assert.equal(stream?.status, 200);
    assert.equal(stream?.protocol, "h2");
    assert.equal(timing.verifiedDelivery, true);
    assert.ok(timing.firstFrameMs <= 10000);
    assert.ok(timing.firstHeartbeatMs <= 25000);
    const headers = Object.fromEntries(
      Object.entries(stream.headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    assert.match(headers["content-type"], /text\/event-stream/);
    assert.match(headers["cache-control"], /no-store/);
  }
} finally {
  await browser.close();
}
