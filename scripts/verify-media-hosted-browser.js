/* global document, window */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { RoomServiceClient, EgressClient } from "livekit-server-sdk";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

// Separately authorized staging operator process; never run with fixture/owner
// credentials in the web service. Only this unique synthetic room is mutated.
// Successful ended fixtures remain for the subsequent package/replay trial.
export async function verifyHostedMediaBrowser({
  owner,
  environment,
  base,
  artifactDirectory,
  executablePath,
  sourceCommit,
}) {
  assert.equal(base, "https://yaparena-staging-web.onrender.com");
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(artifactDirectory && executablePath);
  const evidence = resolve(artifactDirectory);
  await mkdir(evidence, { mode: 0o700, recursive: true });
  const save = async (name, value) =>
    writeFile(
      resolve(evidence, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  const vars = environment;
  const rooms = new RoomServiceClient(
    vars.LIVEKIT_URL,
    vars.LIVEKIT_API_KEY,
    vars.LIVEKIT_API_SECRET,
  );
  const storage = new S3Client({
    endpoint: vars.MEDIA_S3_ENDPOINT,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: vars.MEDIA_S3_ACCESS_KEY,
      secretAccessKey: vars.MEDIA_S3_SECRET_KEY,
    },
  });
  const egress = new EgressClient(
    vars.LIVEKIT_URL,
    vars.LIVEKIT_API_KEY,
    vars.LIVEKIT_API_SECRET,
  );
  assert.equal(
    (await rooms.listRooms()).length,
    0,
    "trial requires no existing media rooms",
  );
  assert.equal((await egress.listEgress({ active: true })).length, 0);
  assert.equal(
    (await owner.query("SELECT current_user AS role")).rows[0].role,
    "yaparena_owner",
  );
  const room = randomUUID(),
    tag = "media-browser-" + randomUUID().slice(0, 8),
    users = [],
    tokens = [];
  let topic,
    browser,
    recording,
    speakerPage,
    phase = "fixture";
  const apiStatuses = [];
  const record = {
    at: new Date().toISOString(),
    sourceCommit,
    browser:
      "Chrome desktop headless; actual LiveKit transport with synthetic capture",
    physicalDevices: false,
    independentNetworks: false,
    measurements: {},
  };
  const saveCleanupManifest = () =>
    save("media-cleanup", { room, tag, topic, users });
  async function until(fn, ms = 30000) {
    const start = performance.now();
    while (!(await fn())) {
      assert.ok(
        performance.now() - start < ms,
        "media trial deadline: " + phase,
      );
      await delay(200);
    }
  }
  async function state() {
    return (
      await owner.query(
        "SELECT state,active_side,revision,recording_status,recording_key,egress_id FROM debate_media WHERE debate_id=$1",
        [room],
      )
    ).rows[0];
  }
  async function action(
    page,
    name,
    body = { reason: "Synthetic controlled browser trial" },
  ) {
    const result = await page.evaluate(
      async ({ id, name, body }) => {
        const r = await fetch("/api/media/events/" + id + "/" + name, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, data: await r.json() };
      },
      { id: room, name, body },
    );
    assert.equal(result.status, 200, "authorized media action " + name);
    return result.data;
  }
  async function cleanup() {
    recording = await state();
    if (recording?.egress_id) {
      try {
        const current = await egress.listEgress({
          egressId: recording.egress_id,
        });
        if (current.some((v) => [0, 1, 2].includes(v.status)))
          await egress.stopEgress(recording.egress_id);
      } catch {
        // A racing provider completion can make Stop redundant; verify terminal
        // status below before deleting any fixture or recording object.
      }
    }
    try {
      await rooms.deleteRoom("debate-" + room);
    } catch {
      assert.equal(
        (await rooms.listRooms(["debate-" + room])).length,
        0,
        "failed room deletion must not leave a live synthetic room",
      );
    }
    if (recording?.egress_id)
      await until(async () => {
        const current = await egress.listEgress({
          egressId: recording.egress_id,
        });
        return current.every((v) => ![0, 1, 2].includes(v.status));
      }, 60000);
    const prefix = "debates/" + room + "/";
    const objects = await storage.send(
      new ListObjectsV2Command({
        Bucket: vars.MEDIA_S3_BUCKET,
        Prefix: prefix,
        MaxKeys: 100,
      }),
    );
    assert.ok(!objects.IsTruncated, "synthetic cleanup must remain bounded");
    for (const object of objects.Contents ?? []) {
      assert.ok(object.Key.startsWith(prefix));
      await storage.send(
        new DeleteObjectCommand({
          Bucket: vars.MEDIA_S3_BUCKET,
          Key: object.Key,
        }),
      );
    }
    await owner.query("DELETE FROM debates WHERE id=$1 AND slug=$2", [
      room,
      tag,
    ]);
    await owner.query("DELETE FROM community_room_events WHERE room_id=$1", [
      room,
    ]);
    await owner.query("DELETE FROM community_rooms WHERE room_id=$1", [room]);
    if (topic)
      await owner.query("DELETE FROM topics WHERE id=$1 AND slug=$2", [
        topic,
        tag,
      ]);
    for (const id of users) {
      await owner.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await owner.query("DELETE FROM account_notifications WHERE user_id=$1", [
        id,
      ]);
      await owner.query("DELETE FROM public_profiles WHERE user_id=$1", [id]);
      await owner.query("DELETE FROM account_roles WHERE user_id=$1", [id]);
      await owner.query("DELETE FROM identity_audit_events WHERE user_id=$1", [
        id,
      ]);
      await owner.query("DELETE FROM users WHERE id=$1 AND email LIKE $2", [
        id,
        tag + "-%@example.test",
      ]);
    }
  }
  try {
    topic = (
      await owner.query(
        "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Synthetic two-speaker media','Temporary synthetic trial','A','B','published') RETURNING id",
        [tag],
      )
    ).rows[0].id;
    await saveCleanupManifest();
    await owner.query(
      "INSERT INTO debates(id,slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot,scheduled_at) SELECT $1,$2,$3,'Synthetic two-speaker media trial','scheduled','published',version,rules,clock_timestamp()+INTERVAL '1 minute' FROM event_rule_versions WHERE version='prototype-media-1'",
      [room, tag, topic],
    );
    for (const side of ["A", "B"]) {
      const id = (
        await owner.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'unused-synthetic') RETURNING id",
          [tag + "-" + side + "@example.test"],
        )
      ).rows[0].id;
      users.push(id);
      await saveCleanupManifest();
      await owner.query(
        "INSERT INTO account_roles(user_id,role) VALUES($1,'participant') ON CONFLICT DO NOTHING",
        [id],
      );
      if (side === "A")
        await owner.query(
          "INSERT INTO account_roles(user_id,role) VALUES($1,'operator') ON CONFLICT DO NOTHING",
          [id],
        );
      await owner.query(
        "INSERT INTO event_participants(debate_id,user_id,side) VALUES($1,$2,$3)",
        [room, id, side],
      );
      const token = randomBytes(32).toString("hex");
      tokens.push(token);
      await owner.query(
        "INSERT INTO sessions(user_id,token_hash,expires_at,auth_generation) SELECT id,$2,clock_timestamp()+INTERVAL '1 hour',auth_generation FROM users WHERE id=$1",
        [id, createHash("sha256").update(token).digest("hex")],
      );
    }
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    });
    const pages = [],
      contexts = [];
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({
        permissions: ["camera", "microphone"],
      });
      contexts.push(context);
      await context.addCookies([
        {
          name: "__Host-session",
          value: tokens[i],
          url: base,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(base + "/debates/" + tag);
      const asset = await page
        .locator('script[src*="media.bundle.js"]')
        .getAttribute("src");
      assert.equal(
        new URL(asset, base).searchParams.get("v"),
        sourceCommit.slice(0, 12),
        "browser must exercise the recorded deployment",
      );
      if (i === 0) {
        speakerPage = page;
        page.on("response", (r) => {
          const path = new URL(r.url()).pathname;
          if (path.startsWith("/api/media/") && r.status() >= 400) {
            apiStatuses.push({
              endpoint: path.split("/").at(-1),
              status: r.status(),
            });
            if (apiStatuses.length > 20) apiStatuses.shift();
          }
        });
      }
      await page.locator("[data-media-speaker]").waitFor({ state: "visible" });
      const start = performance.now();
      await page.locator("[data-media-speaker]").click();
      await page
        .locator("[data-media-status]")
        .getByText("Connected as speaker", { exact: false })
        .waitFor({ timeout: 45000 });
      record.measurements["speaker" + (i + 1) + "JoinMs"] = Math.round(
        performance.now() - start,
      );
    }
    phase = "start-recording";
    await action(pages[0], "start");
    recording = await state();
    assert.equal(recording.state, "running");
    assert.equal(recording.recording_status, "recording");
    const viewContext = await browser.newContext();
    const viewer = await viewContext.newPage();
    await viewer.goto(base + "/debates/" + tag);
    await viewer.locator("[data-media-viewer]").waitFor({ state: "visible" });
    const start = performance.now();
    await viewer.locator("[data-media-viewer]").click();
    await viewer.waitForFunction(
      () =>
        [...document.querySelectorAll("[data-media-videos] video")].filter(
          (v) => v.videoWidth > 0 && v.currentTime > 0,
        ).length === 2,
      {},
      { timeout: 45000 },
    );
    record.measurements.viewerTwoRenderedVideosMs = Math.round(
      performance.now() - start,
    );
    const sound = viewer.locator("[data-media-sound]");
    record.soundActivationControlRequired = await sound.isVisible();
    if (record.soundActivationControlRequired) await sound.click();
    record.soundActivationControlHiddenAfterGesture =
      !(await sound.isVisible());
    phase = "deliberate-mute";
    await pages[0].locator("[data-media-mute]").click();
    await pages[0].locator('[data-media-mute][aria-pressed="true"]').waitFor();
    await until(async () => {
      const people = await rooms.listParticipants("debate-" + room);
      const a = people.find((p) => p.identity === "speaker-" + users[0]);
      return a && !a.tracks.some((t) => t.type === 0 && !t.muted);
    });
    record.deliberateMuteActualPublishedTrackCheck = "PASS";
    phase = "speaker-refresh-connection";
    const rejoin = performance.now();
    await pages[0].reload();
    await pages[0]
      .locator("[data-media-mute]")
      .waitFor({ state: "visible", timeout: 45000 });
    phase = "speaker-refresh-muted-intent";
    await pages[0].locator('[data-media-mute][aria-pressed="true"]').waitFor();
    record.measurements.deliberatelyMutedRefreshJoinMs = Math.round(
      performance.now() - rejoin,
    );
    const refreshedState = await state();
    record.pauseObservedAfterSpeakerRefresh = refreshedState.state === "paused";
    if (refreshedState.state === "paused")
      await action(pages[0], "resume", { revision: refreshedState.revision });
    else assert.equal(refreshedState.state, "running");
    await until(async () => {
      const a = (await rooms.listParticipants("debate-" + room)).find(
        (p) => p.identity === "speaker-" + users[0],
      );
      return a && !a.tracks.some((t) => t.type === 0 && !t.muted);
    });
    record.mutePreservedThroughRefresh = "PASS";
    phase = "turn-change";
    await until(async () => (await state()).active_side === "B", 90000);
    await until(async () => {
      const b = (await rooms.listParticipants("debate-" + room)).find(
        (p) => p.identity === "speaker-" + users[1],
      );
      return b?.tracks.some((t) => t.type === 0 && !t.muted);
    });
    record.secondSpeakerAuthorizedAudio = "PASS";
    phase = "end";
    await action(pages[0], "end");
    await viewer.locator("[data-media-leave]").waitFor({ state: "hidden" });
    record.endStopsViewer = "PASS";
    phase = "recording-completion";
    await until(async () => {
      recording = await state();
      return ["ready", "failed"].includes(recording.recording_status);
    }, 90000);
    assert.equal(
      recording.recording_status,
      "ready",
      "actual provider webhook verifies recording",
    );
    record.providerRecordingWebhook = "PASS";
    record.result = "PASS";
    record.finishedAt = new Date().toISOString();
    const privateFixture = {
      room,
      tag,
      topic,
      users,
      recordingKey: recording.recording_key,
      egressId: recording.egress_id,
      operatorToken: tokens[0],
      sourceCommit: record.sourceCommit,
    };
    await writeFile(
      evidence + "/media-fixture.json",
      JSON.stringify(privateFixture, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    record.browserVersion = browser.version();
    await save("media-browser", record);
    // Keep only this ended synthetic fixture for explicit package/replay validation.
    return record;
  } catch (error) {
    record.result = "FAIL";
    record.phase = phase;
    record.errorName = error.name;
    record.apiStatuses = apiStatuses;
    if (speakerPage)
      record.browserState = await speakerPage.evaluate(() => ({
        status: document.querySelector("[data-media-status]")?.textContent,
        muteHidden: document.querySelector("[data-media-mute]")?.hidden,
        muted: document
          .querySelector("[data-media-mute]")
          ?.getAttribute("aria-pressed"),
        joinHidden: document.querySelector("[data-media-speaker]")?.hidden,
        diagnostics: window.yapMediaDiagnostics
          ?.export()
          .records.filter(
            (v) => !["active_viewing_sample", "webrtc_stats"].includes(v.event),
          )
          .slice(-15)
          .map(({ event, reason, status, name }) => ({
            event,
            reason,
            status,
            name,
          })),
        rememberedSpeaker: Object.keys(sessionStorage)
          .filter(
            (k) => k.startsWith("media-speaker:") && !k.includes(":devices"),
          )
          .map((k) => ({
            kind: k.endsWith(":muted") ? "mute" : "joined",
            value: sessionStorage.getItem(k),
          })),
      }));
    record.finishedAt = new Date().toISOString();
    await save("media-browser-failed", record);
    try {
      await cleanup();
      record.cleanup = "PASS";
    } catch (cleanupError) {
      record.cleanup = "FAIL";
      record.cleanupErrorName = cleanupError.name;
      // The private manifest preserves exact synthetic IDs for operator repair.
    }
    await save("media-browser-failed", record);
    return record;
  } finally {
    if (browser) await browser.close();
    storage.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let owner;
  try {
    const [artifactDirectory, sourceCommit] = process.argv.slice(2);
    assert.ok(
      process.env.DATABASE_OWNER_URL &&
        process.env.DATABASE_CA_FILE &&
        process.env.BROWSER_EXECUTABLE_PATH,
      "separate owner connection, TLS CA and browser path required",
    );
    const url = new URL(process.env.DATABASE_OWNER_URL);
    owner = new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: {
        rejectUnauthorized: true,
        ca: await readFile(process.env.DATABASE_CA_FILE, "utf8"),
      },
      options: "-c search_path=pg_catalog,yaparena,pg_temp",
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
    });
    await owner.connect();
    const result = await verifyHostedMediaBrowser({
      owner,
      environment: process.env,
      base: "https://yaparena-staging-web.onrender.com",
      artifactDirectory,
      executablePath: process.env.BROWSER_EXECUTABLE_PATH,
      sourceCommit,
    });
    console.log(JSON.stringify(result));
    if (result.result !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "FAIL",
        phase: "operator-preflight",
        errorName: error.name,
        code: error.code,
      }),
    );
    process.exitCode = 1;
  } finally {
    if (owner) await owner.end();
  }
}
