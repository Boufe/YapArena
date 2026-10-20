import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import {
  chromium,
  type Browser,
  type BrowserServer,
  type Page,
} from "playwright-core";
import { format } from "prettier";
import { createMediaProvider } from "../dist/features/media/provider.js";

type ClientSdk = typeof import("livekit-client");
type BrowserRoom = import("livekit-client").Room;
declare global {
  interface Window {
    LivekitClient?: ClientSdk;
    yapCloudTrial?: {
      room: BrowserRoom;
      refreshedTokens: string[];
      disconnectReason: number | null;
    };
  }
}

// Explicit operator-only trial. No .env, database, retained identities, media
// capture, publish calls, egress, recording or DeleteRoom API is used. Tokens and
// API credentials remain in process/browser memory and never enter evidence.
const mode = process.argv[2] ?? "--inspect";
assert.ok(["--inspect", "--execute"].includes(mode));
assert.ok(process.argv.length <= 3);
const service = "srv-datv1kjncjis73a500cg";
const controlOrigin = "https://yaparena-staging-e100x84o.livekit.cloud";
const publicOrigin = "wss://yaparena-staging-e100x84o.livekit.cloud";
const artifactDirectory = resolve(
  "docs/evidence/account-completion-baseline/media-cloud-revocation",
);
await mkdir(artifactDirectory, { recursive: true });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function configuration() {
  const config = await readFile("/Users/felixboucher/.render/cli.yaml", "utf8");
  const match = config.match(/^\s*key:\s*(.+)$/m);
  assert.ok(match?.[1]);
  const encoded = match[1].trim();
  const key: unknown = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  assert.ok(typeof key === "string" && key.length > 20);
  const response = await fetch(
    `https://api.render.com/v1/services/${service}/env-vars?limit=100`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(response.status, 200);
  const rows: unknown = await response.json();
  assert.ok(Array.isArray(rows) && rows.length < 100);
  const vars = new Map<string, string>();
  for (const row of rows) {
    assert.ok(object(row) && object(row.envVar));
    const entry = row.envVar;
    assert.ok(typeof entry.key === "string" && typeof entry.value === "string");
    vars.set(entry.key, entry.value);
  }
  const value = (name: string) => {
    const found = vars.get(name);
    assert.ok(found);
    return found;
  };
  const control = new URL(value("LIVEKIT_URL"));
  const browser = new URL(value("LIVEKIT_PUBLIC_URL"));
  assert.equal(control.origin, controlOrigin);
  assert.equal(browser.origin, publicOrigin);
  assert.equal(
    control.username + control.password + browser.username + browser.password,
    "",
  );
  return {
    livekitUrl: controlOrigin,
    livekitPublicUrl: publicOrigin,
    livekitKey: value("LIVEKIT_API_KEY"),
    livekitSecret: value("LIVEKIT_API_SECRET"),
  };
}
async function digest(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function report(name: string, value: unknown) {
  const path = resolve(artifactDirectory, `${name}.json`);
  await writeFile(
    `${path}.next`,
    await format(JSON.stringify(value), { parser: "json" }),
  );
  await rename(`${path}.next`, path);
}
type Interval = {
  label: string;
  startedAt: number;
  stoppedAt: number | null;
};
let browser: Browser | undefined;
let browserServer: BrowserServer | undefined;
let rooms: RoomServiceClient | undefined;
let fixtureRoom: string | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let phase = "read named staging configuration";
let executionStartedAt: number | undefined;
let roomExpired = false;
const intervals: Interval[] = [];
const pages = new Map<Page, Interval>();
const checks: string[] = [];
let result: Record<string, unknown> | undefined;
let maximumConcurrentClients = 0;
async function bounded<T>(pending: Promise<T>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("trial step deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
async function disconnect(page: Page) {
  try {
    if (!page.isClosed())
      await bounded(
        page.evaluate(async () => {
          await window.yapCloudTrial?.room.disconnect();
        }),
        2000,
      );
  } catch {
    // Only the subprocess started by this helper is killed; never the user's
    // native browser. This bounds provider connection time if the SDK hangs.
    browserServer?.process().kill("SIGKILL");
    process.exitCode = 1;
  } finally {
    const interval = pages.get(page);
    if (interval && interval.stoppedAt === null)
      interval.stoppedAt = Date.now();
    if (!page.isClosed()) await bounded(page.close(), 2000);
  }
}
async function connect(label: string, token: string) {
  assert.ok(browser && executionStartedAt);
  assert.ok(Date.now() - executionStartedAt < 45_000);
  assert.ok([...pages.values()].filter((i) => i.stoppedAt === null).length < 2);
  const page = await browser.newPage();
  const interval = { label, startedAt: Date.now(), stoppedAt: null };
  pages.set(page, interval);
  intervals.push(interval);
  maximumConcurrentClients = Math.max(
    maximumConcurrentClients,
    [...pages.values()].filter((i) => i.stoppedAt === null).length,
  );
  await page.addScriptTag({
    path: resolve("node_modules/livekit-client/dist/livekit-client.umd.js"),
  });
  const response = await page.evaluate(
    async ({ token, url }) => {
      const sdk = window.LivekitClient;
      if (!sdk) throw new Error("installed SDK unavailable");
      sdk.setLogLevel(sdk.LogLevel.silent);
      const room = new sdk.Room({
        reconnectPolicy: { nextRetryDelayInMs: () => null },
      });
      const state: NonNullable<Window["yapCloudTrial"]> = {
        room,
        refreshedTokens: [],
        disconnectReason: null,
      };
      window.yapCloudTrial = state;
      // This is the real typed installed SDK engine event. RTCEngine's actual
      // SignalClient.onTokenRefresh handler emits it upon a server token update.
      room.engine.on("tokenRefreshed", (refreshed: string) => {
        state.refreshedTokens.push(refreshed);
      });
      room.on(sdk.RoomEvent.Disconnected, (reason) => {
        state.disconnectReason = reason ?? null;
      });
      try {
        await room.connect(url, token, {
          autoSubscribe: false,
          maxRetries: 0,
          websocketTimeout: 5000,
          peerConnectionTimeout: 5000,
        });
        return {
          connected: true,
          denied: false,
          status: null,
          canPublish: room.localParticipant.permissions?.canPublish ?? false,
          canSubscribe:
            room.localParticipant.permissions?.canSubscribe ?? false,
          publishedTracks: room.localParticipant.trackPublications.size,
        };
      } catch (error) {
        await room.disconnect();
        return {
          connected: false,
          denied:
            error instanceof sdk.ConnectionError &&
            error.reason === sdk.ConnectionErrorReason.NotAllowed &&
            (error.status === 401 || error.status === 403),
          status:
            error instanceof sdk.ConnectionError
              ? (error.status ?? null)
              : null,
          canPublish: false,
          canSubscribe: false,
          publishedTracks: 0,
        };
      }
    },
    { token, url: publicOrigin },
  );
  if (!response.connected) await disconnect(page);
  return { page, response };
}

try {
  const config = await configuration();
  rooms = new RoomServiceClient(
    config.livekitUrl,
    config.livekitKey,
    config.livekitSecret,
    { requestTimeout: 3 },
  );
  const before = await rooms.listRooms();
  if (mode === "--inspect") {
    await report("inspection", {
      at: new Date().toISOString(),
      controlOrigin,
      publicOrigin,
      existingRoomCount: before.length,
      mutation: false,
      executionRequires: "explicit included-quota confirmation and --execute",
    });
    console.log(
      JSON.stringify({ mode, existingRooms: before.length, mutation: false }),
    );
  } else {
    assert.equal(process.env.MEDIA_CLOUD_INCLUDED_QUOTA_CONFIRMED, "5-minutes");
    assert.equal(
      before.length,
      0,
      "do not run beside existing media participants",
    );
    phase = "bounded disposable room trial";
    const id = randomUUID(),
      speaker = randomUUID();
    fixtureRoom = `debate-${id}`;
    browserServer = await chromium.launchServer({
      executablePath:
        process.env.BROWSER_CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    browser = await chromium.connect(browserServer.wsEndpoint());
    executionStartedAt = Date.now();
    deadline = setTimeout(() => {
      browserServer?.process().kill("SIGKILL");
      process.exitCode = 1;
    }, 45_000);
    await rooms.createRoom({
      name: fixtureRoom,
      emptyTimeout: 30,
      departureTimeout: 10,
      maxParticipants: 3,
      metadata: "YapArena disposable no-media revocation acceptance",
    });
    const provider = createMediaProvider({
      ...config,
      // Storage methods are never called. This inert configuration avoids
      // loading unrelated storage secrets or contacting the storage provider.
      s3Region: "auto",
      s3Bucket: "unused-no-recording",
      s3AccessKey: "unused-no-recording",
      s3SecretKey: "unused-no-recording",
    });
    assert.equal(provider.supportsTokenRevocation, true);
    const verifier = new TokenVerifier(config.livekitKey, config.livekitSecret);
    const original = await provider.token(id, speaker, true, "A");
    const viewerToken = await provider.token(id, randomUUID(), false);
    const originalClaims = await verifier.verify(original, 0);
    const viewerClaims = await verifier.verify(viewerToken, 0);
    assert.equal(originalClaims.sub, `speaker-${speaker}`);
    assert.equal(typeof originalClaims.nbf, "number");
    const originalNbf = originalClaims.nbf;
    assert.ok(typeof originalNbf === "number");
    assert.equal(viewerClaims.video?.canPublish, false);
    const initial = await connect("original speaker baseline", original);
    assert.ok(initial.response.connected && initial.response.canPublish);
    assert.equal(initial.response.publishedTracks, 0);
    const viewer = await connect("public viewer baseline", viewerToken);
    assert.ok(
      viewer.response.connected &&
        !viewer.response.canPublish &&
        viewer.response.canSubscribe,
    );
    assert.equal(viewer.response.publishedTracks, 0);
    checks.push(
      "original fresh speaker and independent view-only viewer connect without publishing tracks",
    );

    phase = "capture and verify actual server-refreshed token";
    await delay(1100);
    const marker = JSON.stringify({ revocationTrial: id });
    await rooms.updateParticipant(fixtureRoom, `speaker-${speaker}`, {
      metadata: marker,
    });
    let refreshed: string | undefined;
    let refreshedNbf: number | undefined;
    const refreshDeadline = Date.now() + 8000;
    while (!refreshed && Date.now() < refreshDeadline) {
      const received = await initial.page.evaluate(
        () => window.yapCloudTrial?.refreshedTokens ?? [],
      );
      for (const candidate of received) {
        if (candidate === original) continue;
        const claims = await verifier.verify(candidate, 0);
        if (
          claims.sub === originalClaims.sub &&
          claims.video?.room === fixtureRoom &&
          claims.metadata === marker &&
          typeof claims.nbf === "number" &&
          claims.nbf > originalNbf
        ) {
          refreshed = candidate;
          refreshedNbf = claims.nbf;
          break;
        }
      }
      if (!refreshed) await delay(100);
    }
    assert.ok(refreshed && refreshedNbf);
    await disconnect(initial.page);
    const refreshedBaseline = await connect(
      "server-refreshed speaker baseline",
      refreshed,
    );
    assert.ok(
      refreshedBaseline.response.connected &&
        refreshedBaseline.response.canPublish,
    );
    assert.equal(refreshedBaseline.response.publishedTracks, 0);
    checks.push(
      "real SignalClient token-refresh event produced a signature-verified newer nbf token accepted before cutoff",
    );

    phase = "invoke actual strict provider revocation path";
    const cutoffStartedAt = Date.now();
    await provider.removeSpeaker(id, `speaker-${speaker}`);
    const cutoffCompletedAt = Date.now();
    await refreshedBaseline.page.waitForFunction(
      () => window.yapCloudTrial?.disconnectReason != null,
      undefined,
      { timeout: 5000 },
    );
    const reason = await refreshedBaseline.page.evaluate(
      () => window.yapCloudTrial?.disconnectReason,
    );
    // The actual SDK enum is used rather than assuming a numeric wire value.
    assert.equal(
      await refreshedBaseline.page.evaluate(
        (value) =>
          value === window.LivekitClient?.DisconnectReason.PARTICIPANT_REMOVED,
        reason,
      ),
      true,
    );
    await disconnect(refreshedBaseline.page);
    const originalReplay = await connect("original token replay", original);
    assert.ok(
      !originalReplay.response.connected && originalReplay.response.denied,
    );
    const refreshedReplay = await connect(
      "server-refreshed token replay",
      refreshed,
    );
    assert.ok(
      !refreshedReplay.response.connected && refreshedReplay.response.denied,
    );
    checks.push(
      "actual integrated explicit-cutoff removal disconnects the fixture and rejects both original and server-refreshed tokens as unauthorized",
    );

    phase = "verify view-only public access remains available";
    assert.equal(
      await viewer.page.evaluate(
        () =>
          window.yapCloudTrial?.room.state ===
          window.LivekitClient?.ConnectionState.Connected,
      ),
      true,
    );
    const remaining = await rooms.listParticipants(fixtureRoom);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.identity, viewerClaims.sub);
    assert.equal(remaining[0]?.permission?.canPublish, false);
    assert.equal(remaining[0]?.tracks.length, 0);
    await disconnect(viewer.page);
    const viewerAgain = await connect("public viewer reconnect", viewerToken);
    assert.ok(
      viewerAgain.response.connected &&
        !viewerAgain.response.canPublish &&
        viewerAgain.response.canSubscribe,
    );
    await disconnect(viewerAgain.page);
    checks.push(
      "independent public view-only client stays connected, retains no-publish permission and reconnects with its original token",
    );
    assert.ok(Date.now() - executionStartedAt < 45_000);
    result = {
      originalNbf: originalClaims.nbf,
      serverRefreshedNbf: refreshedNbf,
      explicitCutoffUnixSeconds: {
        minimum: Math.floor(cutoffStartedAt / 1000) + 30,
        maximum: Math.floor(cutoffCompletedAt / 1000) + 30,
        source: "actual compiled createMediaProvider.removeSpeaker path",
      },
      originalReplay: originalReplay.response,
      refreshedReplay: refreshedReplay.response,
      viewerReconnect: viewerAgain.response,
    };
  }
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      category: error instanceof Error ? error.name : "unclassified",
      details: "Tokens, credentials and provider response bodies omitted",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const page of pages.keys()) {
    try {
      await disconnect(page);
    } catch {
      const interval = pages.get(page);
      if (interval && interval.stoppedAt === null)
        interval.stoppedAt = Date.now();
    }
  }
  try {
    if (browser) await bounded(browser.close(), 2000);
    if (browserServer) await bounded(browserServer.close(), 2000);
  } catch {
    browserServer?.process().kill("SIGKILL");
    process.exitCode = 1;
  }
  if (deadline) clearTimeout(deadline);
  if (rooms && fixtureRoom) {
    // Cloud expiry is scheduled, rather than an exact departure-time alarm.
    // Reserve most of the two-minute total budget for observing that cleanup.
    const expiresBy = Math.min(
      Date.now() + 60_000,
      (executionStartedAt ?? Date.now()) + 115_000,
    );
    while (Date.now() < expiresBy) {
      try {
        if ((await rooms.listRooms([fixtureRoom])).length === 0) {
          roomExpired = true;
          break;
        }
      } catch {
        process.exitCode = 1;
      }
      await delay(1000);
    }
  }
  if (executionStartedAt) {
    const intervalBounds = intervals.map((interval) => ({
      label: interval.label,
      startedAt: new Date(interval.startedAt).toISOString(),
      stoppedAt: new Date(interval.stoppedAt ?? Date.now()).toISOString(),
      roundedUpperBoundMs: Math.max(
        10_000,
        (interval.stoppedAt ?? Date.now()) - interval.startedAt,
      ),
    }));
    // Conservatively include two 15-second unexpected-disconnect grace periods
    // beyond the timed intervals, even when all explicit disconnects succeeded.
    const participantUsageUpperBoundMs = intervalBounds.reduce(
      (total, interval) => total + interval.roundedUpperBoundMs,
      30_000,
    );
    const cloudTrialElapsedMs = Date.now() - executionStartedAt;
    const passed = Boolean(
      result &&
      roomExpired &&
      participantUsageUpperBoundMs < 300_000 &&
      cloudTrialElapsedMs < 120_000 &&
      process.exitCode !== 1,
    );
    if (!passed) process.exitCode = 1;
    await report("acceptance", {
      at: new Date().toISOString(),
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      scope:
        "Actual hosted LiveKit Cloud signaling/revocation with disposable identities, real installed SDK and actual application provider path; no application account, microphone, camera, media publishing, recording or egress. Not genuine application logout, physical-device or media-quality acceptance.",
      passed,
      controlOrigin,
      publicOrigin,
      fixtureRoom,
      maximumConcurrentClients,
      cloudTrialElapsedMs,
      participantUsageUpperBoundMs,
      confirmedIncludedQuotaMinutes: 5,
      roomExpired,
      intervals: intervalBounds,
      checks,
      result: result ?? null,
      sourceHashes: Object.fromEntries(
        await Promise.all(
          [
            "scripts/verify-media-cloud-revocation.ts",
            "dist/features/media/provider.js",
            "node_modules/livekit-client/dist/livekit-client.umd.js",
            "node_modules/livekit-client/src/room/RTCEngine.ts",
          ].map(async (path) => [path, await digest(path)]),
        ),
      ),
      limitations: [
        "Quota availability was confirmed by the founder; provider billing plan was not changed or inferred.",
        "Disposable provider identities are not retained YapArena accounts; full app-session/provider-outbox acceptance is separate.",
        "No recordings, physical devices, screen reader or audiovisual quality tested.",
      ],
    });
    console.log(
      JSON.stringify({
        passed,
        roomExpired,
        participantUsageUpperBoundMs,
        evidence:
          "docs/evidence/account-completion-baseline/media-cloud-revocation/acceptance.json",
      }),
    );
  }
}
