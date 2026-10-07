import { randomUUID } from "node:crypto";
import {
  AccessToken,
  EgressClient,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import { EncodedFileOutput, S3Upload } from "@livekit/protocol";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { createReplayAccess, replayPrefix } from "./replay.ts";

export interface MediaProviderConfig {
  livekitUrl: string;
  livekitPublicUrl: string;
  livekitKey: string;
  livekitSecret: string;
  s3Endpoint?: string;
  s3PublicEndpoint?: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  replayEdgeUrl?: string;
  replaySigningSecret?: string;
}

export function createMediaProvider(config: MediaProviderConfig) {
  const rooms = new RoomServiceClient(
    config.livekitUrl,
    config.livekitKey,
    config.livekitSecret,
  );
  const egress = new EgressClient(
    config.livekitUrl,
    config.livekitKey,
    config.livekitSecret,
  );
  const receiver = new WebhookReceiver(config.livekitKey, config.livekitSecret);
  const storage = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: Boolean(config.s3Endpoint),
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  });
  const playbackStorage = config.s3PublicEndpoint
    ? new S3Client({
        endpoint: config.s3PublicEndpoint,
        region: config.s3Region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.s3AccessKey,
          secretAccessKey: config.s3SecretKey,
        },
      })
    : storage;
  const roomName = (id: string) => `debate-${id}`;
  return Object.freeze({
    publicUrl: config.livekitPublicUrl,
    adaptiveReplay: Boolean(config.replayEdgeUrl),
    playbackOrigin: config.replayEdgeUrl
      ? new URL(config.replayEdgeUrl).origin
      : config.s3PublicEndpoint
        ? new URL(config.s3PublicEndpoint).origin
        : "https:",
    async token(
      id: string,
      identity: string,
      canPublish: boolean,
      side?: "A" | "B",
    ) {
      const token = new AccessToken(config.livekitKey, config.livekitSecret, {
        identity: canPublish ? `speaker-${identity}` : `viewer-${randomUUID()}`,
        ttl: 15 * 60,
        metadata: side ? JSON.stringify({ side }) : undefined,
      });
      token.addGrant({
        roomJoin: true,
        room: roomName(id),
        canPublish,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: canPublish ? [1] : [],
      });
      return token.toJwt();
    },
    async connectedSpeakers(id: string) {
      const people = await rooms.listParticipants(roomName(id));
      return people.filter((person) => person.identity.startsWith("speaker-"))
        .length;
    },
    async setTurn(id: string, side: "A" | "B" | null) {
      const people = await rooms.listParticipants(roomName(id));
      for (const person of people) {
        if (!person.identity.startsWith("speaker-")) continue;
        let speakerSide: string | undefined;
        try {
          speakerSide = JSON.parse(person.metadata || "{}").side;
        } catch {
          /* malformed metadata has no turn */
        }
        await rooms.updateParticipant(roomName(id), person.identity, {
          permission: {
            canPublish: true,
            canSubscribe: true,
            canPublishData: false,
            canPublishSources: speakerSide === side ? [1, 2] : [1],
          },
        });
      }
    },
    async beginRecording(id: string) {
      const key = `debates/${id}/${randomUUID()}.mp4`;
      const output = new EncodedFileOutput({
        filepath: key,
        output: {
          case: "s3",
          value: new S3Upload({
            bucket: config.s3Bucket,
            region: config.s3Region,
            endpoint: config.s3Endpoint ?? "",
            forcePathStyle: Boolean(config.s3Endpoint),
            accessKey: config.s3AccessKey,
            secret: config.s3SecretKey,
          }),
        },
      });
      const result = await egress.startRoomCompositeEgress(
        roomName(id),
        output,
        { layout: "grid" },
      );
      return { egressId: result.egressId, key };
    },
    async stopRecording(egressId: string) {
      await egress.stopEgress(egressId);
    },
    async webhook(body: string, authorization?: string) {
      return receiver.receive(body, authorization);
    },
    async replayAccess(key: string) {
      if (!config.replayEdgeUrl || !config.replaySigningSecret)
        return {
          url: await this.replayUrl(key),
          type: "mp4",
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      await storage.send(
        new HeadObjectCommand({
          Bucket: config.s3Bucket,
          Key: `${replayPrefix(key)}ready.json`,
        }),
      );
      return createReplayAccess(
        key,
        config.replayEdgeUrl,
        config.replaySigningSecret,
      );
    },
    async publishCaptions(key: string, captions: string) {
      if (config.replayEdgeUrl)
        await storage.send(
          new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: `${replayPrefix(key)}captions.vtt`,
            Body: captions,
            ContentType: "text/vtt",
            CacheControl: "no-store",
          }),
        );
    },
    async replayUrl(key: string) {
      await storage.send(
        new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }),
      );
      return getSignedUrl(
        playbackStorage,
        new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }),
        { expiresIn: 3600 },
      );
    },
  });
}
