import assert from "node:assert/strict";
import { it } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import {
  EgressClient,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import { createMediaProvider } from "../dist/features/media/provider.js";
const id = "33333333-3333-4333-8333-333333333333";
const recording = `debates/${id}/recording.mp4`;
const config = {
  livekitUrl: "https://live.example",
  livekitPublicUrl: "wss://live.example",
  livekitKey: "synthetic-key",
  livekitSecret: "synthetic-live-secret-more-than-32-characters",
  s3Endpoint: "https://storage.example",
  s3PublicEndpoint: "https://storage.example",
  s3Region: "auto",
  s3Bucket: "synthetic",
  s3AccessKey: "synthetic-key",
  s3SecretKey: "synthetic-secret",
};
it("gates HLS access on package completion and delivers captions only to private storage", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  const provider = createMediaProvider({
    ...config,
    replayEdgeUrl: "https://edge.example",
    replaySigningSecret: "synthetic-replay-secret-32-characters",
  });
  const grant = await provider.replayAccess(recording);
  assert.equal(grant.type, "hls");
  assert.equal(grant.expiresIn, 300);
  assert.equal(provider.playbackOrigin, "https://edge.example");
  assert.match(commands[0].input.Key, /hls\/ready.json$/);
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.equal(commands[1].input.ContentType, "text/vtt");
  assert.match(commands[1].input.Key, /hls\/captions.vtt$/);
  t.mock.method(S3Client.prototype, "send", async () => {
    throw Error("not packaged");
  });
  await assert.rejects(provider.replayAccess(recording), /not packaged/);
});
it("preserves the explicit signed MP4 fallback and source recording behavior", async (t) => {
  const commands = [];
  t.mock.method(S3Client.prototype, "send", async (command) => {
    commands.push(command);
    return {};
  });
  t.mock.method(
    EgressClient.prototype,
    "startRoomCompositeEgress",
    async (room, output) => {
      assert.equal(room, `debate-${id}`);
      assert.match(output.filepath, /\.mp4$/);
      return { egressId: "synthetic-egress" };
    },
  );
  t.mock.method(EgressClient.prototype, "stopEgress", async (egress) =>
    assert.equal(egress, "synthetic-egress"),
  );
  const provider = createMediaProvider(config);
  const grant = await provider.replayAccess(recording);
  assert.equal(grant.type, "mp4");
  assert.equal(grant.expiresIn, 3600);
  assert.match(grant.url, /X-Amz-Signature=/);
  await provider.publishCaptions(recording, "WEBVTT\n");
  assert.equal(commands.length, 1);
  const started = await provider.beginRecording(id);
  assert.equal(started.egressId, "synthetic-egress");
  await provider.stopRecording(started.egressId);
  const defaultStorage = createMediaProvider({
    ...config,
    s3Endpoint: undefined,
    s3PublicEndpoint: undefined,
  });
  assert.equal(defaultStorage.playbackOrigin, "https:");
  await defaultStorage.replayUrl(recording);
});
it("issues subscribe-only viewer grants and permits microphone only to the current speaker", async (t) => {
  const updates = [];
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => [
    { identity: "speaker-1", metadata: '{"side":"A"}' },
    { identity: "speaker-2", metadata: '{"side":"B"}' },
    { identity: "speaker-3", metadata: "invalid" },
    { identity: "viewer-1" },
  ]);
  t.mock.method(
    RoomServiceClient.prototype,
    "updateParticipant",
    async (room, identity, update) => updates.push({ room, identity, update }),
  );
  const provider = createMediaProvider(config);
  const viewer = JSON.parse(
    Buffer.from(
      (await provider.token(id, "1", false)).split(".")[1],
      "base64url",
    ),
  );
  assert.equal(viewer.video.canPublish, false);
  assert.equal(viewer.video.canPublishData, false);
  assert.equal(viewer.video.room, `debate-${id}`);
  const speaker = JSON.parse(
    Buffer.from(
      (await provider.token(id, "1", true, "A")).split(".")[1],
      "base64url",
    ),
  );
  assert.deepEqual(speaker.video.canPublishSources, ["camera"]);
  assert.equal(await provider.connectedSpeakers(id), 3);
  await provider.setTurn(id, "A");
  assert.deepEqual(updates[0].update.permission.canPublishSources, [1, 2]);
  assert.deepEqual(updates[1].update.permission.canPublishSources, [1]);
  assert.deepEqual(updates[2].update.permission.canPublishSources, [1]);
  t.mock.method(WebhookReceiver.prototype, "receive", async () => ({
    event: "synthetic",
  }));
  assert.equal((await provider.webhook("{}", "synthetic")).event, "synthetic");
});
