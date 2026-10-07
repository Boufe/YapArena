import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const renditions = [
  { name: "240", width: 426, height: 240, bitrate: 300, audio: 48 },
  { name: "480", width: 854, height: 480, bitrate: 1000, audio: 64 },
  { name: "720", width: 1280, height: 720, bitrate: 2400, audio: 96 },
];
export function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (data) => {
      errorText = (errorText + data).slice(-4000);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} failed (${code}): ${errorText}`)),
    );
  });
}
export async function packageReplay(input, directory, captionFile) {
  const captions = await readFile(captionFile, "utf8");
  if (
    !captions.startsWith("WEBVTT\n") ||
    captions.length > 200_000 ||
    /<[a-z!/]/i.test(captions)
  )
    throw new Error("reviewed plain WebVTT captions required");
  await mkdir(directory); // immutable output; never overwrite a published package
  for (const rendition of renditions) {
    const folder = resolve(directory, rendition.name);
    await mkdir(folder);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      resolve(input),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-vf",
      `scale=${rendition.width}:${rendition.height}:force_original_aspect_ratio=decrease,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-b:v",
      `${rendition.bitrate}k`,
      "-maxrate",
      `${Math.round(rendition.bitrate * 1.1)}k`,
      "-bufsize",
      `${rendition.bitrate * 2}k`,
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-b:a",
      `${rendition.audio}k`,
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      `${folder}/segment%05d.ts`,
      `${folder}/index.m3u8`,
    ]);
  }
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    ...renditions.flatMap((r) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round((r.bitrate * 1.1 + r.audio) * 1000)},RESOLUTION=${r.width}x${r.height},CODECS="avc1.42c01f,mp4a.40.2"`,
      `${r.name}/index.m3u8`,
    ]),
    "",
  ].join("\n");
  await writeFile(resolve(directory, "master.m3u8"), master);
  await writeFile(resolve(directory, "captions.vtt"), captions);
  const files = [];
  for (const rendition of renditions)
    for (const name of await readdir(resolve(directory, rendition.name)))
      files.push(`${rendition.name}/${name}`);
  files.push("captions.vtt", "master.m3u8");
  // Sanity check every playlist URI references a nonempty generated object.
  for (const rendition of renditions) {
    const playlist = await readFile(
      resolve(directory, rendition.name, "index.m3u8"),
      "utf8",
    );
    if (!playlist.includes("#EXT-X-ENDLIST"))
      throw new Error("incomplete VOD playlist");
    for (const uri of playlist
      .split("\n")
      .filter((line) => line && !line.startsWith("#")))
      if (!(await stat(resolve(directory, rendition.name, uri))).size)
        throw new Error("empty segment");
  }
  return files;
}

export async function uploadReplay(
  directory,
  files,
  recordingKey,
  environment = process.env,
) {
  if (!/^debates\/[0-9a-f-]{36}\/[a-zA-Z0-9-]+\.mp4$/.test(recordingKey))
    throw new Error("invalid recording key");
  for (const name of [
    "MEDIA_S3_REGION",
    "MEDIA_S3_BUCKET",
    "MEDIA_S3_ACCESS_KEY",
    "MEDIA_S3_SECRET_KEY",
  ])
    if (!environment[name]) throw new Error(`${name} required`);
  const storage = new S3Client({
    endpoint: environment.MEDIA_S3_ENDPOINT,
    region: environment.MEDIA_S3_ENDPOINT?.includes(".r2.cloudflarestorage.com")
      ? "auto"
      : environment.MEDIA_S3_REGION,
    forcePathStyle: Boolean(environment.MEDIA_S3_ENDPOINT),
    credentials: {
      accessKeyId: environment.MEDIA_S3_ACCESS_KEY,
      secretAccessKey: environment.MEDIA_S3_SECRET_KEY,
    },
  });
  const prefix = `${recordingKey.slice(0, -4)}/hls/`;
  for (const file of files)
    await storage.send(
      new PutObjectCommand({
        Bucket: environment.MEDIA_S3_BUCKET,
        Key: `${prefix}${file}`,
        Body: createReadStream(resolve(directory, file)),
        ContentType: file.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : file.endsWith(".vtt")
            ? "text/vtt"
            : "video/mp2t",
        IfNoneMatch: "*",
      }),
    );
  // Marker last: readers never receive access to an incompletely uploaded package.
  await storage.send(
    new PutObjectCommand({
      Bucket: environment.MEDIA_S3_BUCKET,
      Key: `${prefix}ready.json`,
      Body: JSON.stringify({
        version: 1,
        renditions: renditions.map((r) => r.name),
        reviewedCaptions: true,
      }),
      ContentType: "application/json",
      IfNoneMatch: "*",
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, directory, captions, recordingKey] = process.argv.slice(2);
  if (!input || !directory || !captions)
    throw new Error(
      "Usage: node scripts/package-replay.js INPUT.mp4 NEW_OUTPUT_DIR REVIEWED.vtt [RECORDING_KEY_TO_UPLOAD]",
    );
  const files = await packageReplay(input, resolve(directory), captions);
  if (recordingKey) await uploadReplay(resolve(directory), files, recordingKey);
  console.log(
    JSON.stringify({
      packaged: files.length,
      uploaded: Boolean(recordingKey),
      renditions: renditions.map((r) => r.name),
    }),
  );
}
