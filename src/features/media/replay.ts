import { createHmac } from "node:crypto";

export const replayAccessSeconds = 300;

export function replayPrefix(recordingKey: string) {
  if (!/^debates\/[0-9a-f-]{36}\/[a-zA-Z0-9-]+\.mp4$/.test(recordingKey))
    throw new Error("invalid recording key");
  return `${recordingKey.slice(0, -4)}/hls/`;
}

export function createReplayAccess(
  recordingKey: string,
  edgeUrl: string,
  secret: string,
  now = Date.now(),
) {
  const prefix = replayPrefix(recordingKey);
  const expiresAt = Math.floor(now / 1000) + replayAccessSeconds;
  const payload = Buffer.from(
    JSON.stringify({ prefix, exp: expiresAt }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const url = new URL(`/${prefix}master.m3u8`, edgeUrl);
  url.searchParams.set("access", `${payload}.${signature}`);
  const captions = new URL("captions.vtt", url);
  captions.search = url.search;
  return {
    url: url.href,
    captionsUrl: captions.href,
    type: "hls" as const,
    expiresIn: replayAccessSeconds,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
