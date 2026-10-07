import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

export const renditions = Object.freeze([
  { name: "240", width: 426, height: 240, bitrate: 300, audio: 48 },
  { name: "480", width: 854, height: 480, bitrate: 1000, audio: 64 },
  { name: "720", width: 1280, height: 720, bitrate: 2400, audio: 96 },
]);
export class ReplayFailure extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, retryable = true) {
    super(`replay processing failed: ${code}`);
    this.name = "ReplayFailure";
    this.code = code;
    this.retryable = retryable;
  }
}
export function checkReplaySignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new ReplayFailure("cancelled");
}
export function validateReviewedCaptions(value: string) {
  if (
    !value.startsWith("WEBVTT\n") ||
    Buffer.byteLength(value) > 200_000 ||
    /<[a-z!/]/i.test(value)
  )
    throw new ReplayFailure("invalid_captions", false);
  return value;
}
export function validRecordingKey(key: string) {
  return /^debates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-zA-Z0-9-]+\.mp4$/.test(
    key,
  );
}
export type ProcessOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: typeof spawn;
};
// Never invoke a shell or include raw encoder stderr, private media metadata or
// storage credentials in public errors. Wait for process close after killing it.
export async function run(
  command: string,
  args: string[],
  {
    signal,
    timeoutMs = 30 * 60 * 1000,
    maxOutputBytes = 1_000_000,
    spawnProcess = spawn,
  }: ProcessOptions = {},
): Promise<string> {
  checkReplaySignal(signal);
  return new Promise((done, reject) => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let failure: ReplayFailure | undefined;
    let stdout = "";
    let outputBytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (code: string) => {
      failure ||= new ReplayFailure(code);
      child.kill("SIGTERM");
      killTimer ||= setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    const aborted = () => kill("cancelled");
    const timeout = setTimeout(() => kill("process_timeout"), timeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) kill("process_output_limit");
      else stdout += chunk.toString("utf8");
    });
    child.once("error", () => {
      failure ||= new ReplayFailure("process_unavailable", false);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", aborted);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ReplayFailure("encoder_failed"));
      else done(stdout);
    });
  });
}

export type ReplayFile = {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
};
export type ReplayManifest = {
  version: 1;
  durationSeconds: number;
  sourceSha256: string;
  captionsSha256: string | null;
  bytes: number;
  files: ReplayFile[];
};
export async function fileDigest(path: string, signal?: AbortSignal) {
  checkReplaySignal(signal);
  const digest = createHash("sha256");
  const stream = createReadStream(path, signal ? { signal } : undefined);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}
export const replayFileName =
  /^(?:master\.m3u8|captions\.vtt|(?:240|480|720)\/(?:index\.m3u8|segment\d{5}\.ts))$/;
export async function inspectReplayPackage(
  directory: string,
  durationSeconds: number,
  sourceSha256: string,
  captions: string | null,
  {
    signal,
    maxFiles = 11_000,
    maxOutputBytes = 4 * 1024 ** 3,
  }: { signal?: AbortSignal; maxFiles?: number; maxOutputBytes?: number } = {},
): Promise<ReplayManifest> {
  const paths: string[] = captions
    ? ["captions.vtt", "master.m3u8"]
    : ["master.m3u8"];
  let firstDurations: number[] | undefined;
  for (const rendition of renditions) {
    checkReplaySignal(signal);
    const folder = resolve(directory, rendition.name);
    const names = await readdir(folder);
    if (paths.length + names.length > maxFiles)
      throw new ReplayFailure("file_limit", false);
    for (const name of names) {
      const path = `${rendition.name}/${name}`;
      if (!replayFileName.test(path))
        throw new ReplayFailure("invalid_output_path", false);
      paths.push(path);
    }
    const playlistPath = resolve(folder, "index.m3u8");
    const playlistInfo = await lstat(playlistPath);
    if (!playlistInfo.isFile())
      throw new ReplayFailure("invalid_output_file", false);
    if (playlistInfo.size > 1_000_000)
      throw new ReplayFailure("playlist_limit", false);
    const playlist = await readFile(playlistPath, "utf8");
    if (
      !playlist.startsWith("#EXTM3U\n") ||
      !playlist.includes("#EXT-X-ENDLIST") ||
      !playlist.includes("#EXT-X-INDEPENDENT-SEGMENTS")
    )
      throw new ReplayFailure("incomplete_playlist", false);
    const uris = playlist
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) =>
      Number(m[1]),
    );
    if (
      !uris.length ||
      uris.length !== durations.length ||
      new Set(uris).size !== uris.length ||
      uris.some(
        (uri) => !/^segment\d{5}\.ts$/.test(uri) || !names.includes(uri),
      ) ||
      durations.some(
        (duration) =>
          !Number.isFinite(duration) || duration <= 0 || duration > 2.25,
      ) ||
      Math.abs(durations.reduce((sum, d) => sum + d, 0) - durationSeconds) >
        0.5 ||
      (firstDurations &&
        (durations.length !== firstDurations.length ||
          durations.some((d, i) => Math.abs(d - firstDurations![i]!) > 0.05)))
    )
      throw new ReplayFailure("unaligned_playlist", false);
    firstDurations = durations;
  }
  const files: ReplayFile[] = [];
  let bytes = 0;
  for (const path of paths.sort()) {
    checkReplaySignal(signal);
    const fullPath = resolve(directory, path);
    const info = await lstat(fullPath);
    if (
      !info.isFile() ||
      !info.size ||
      (path.endsWith(".ts") && info.size > 4_000_000)
    )
      throw new ReplayFailure("invalid_output_file", false);
    bytes += info.size;
    if (bytes > maxOutputBytes) throw new ReplayFailure("output_limit", false);
    files.push({
      path,
      bytes: info.size,
      sha256: await fileDigest(fullPath, signal),
      contentType: path.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : path.endsWith(".vtt")
          ? "text/vtt"
          : "video/mp2t",
    });
  }
  return {
    version: 1,
    durationSeconds,
    sourceSha256,
    captionsSha256: captions
      ? createHash("sha256").update(captions).digest("hex")
      : null,
    bytes,
    files,
  };
}

export async function buildReplayPackage(
  input: string,
  directory: string,
  reviewedCaptions: string | null = null,
  {
    signal,
    maxInputBytes = 2 * 1024 ** 3,
    maxDurationSeconds = 7200,
    maxOutputBytes = 4 * 1024 ** 3,
    maxFiles = 11_000,
    runProcess = run,
  }: {
    signal?: AbortSignal;
    maxInputBytes?: number;
    maxDurationSeconds?: number;
    maxOutputBytes?: number;
    maxFiles?: number;
    runProcess?: typeof run;
  } = {},
) {
  checkReplaySignal(signal);
  const captions =
    reviewedCaptions === null
      ? null
      : validateReviewedCaptions(reviewedCaptions);
  const source = await lstat(input);
  if (!source.isFile() || !source.size || source.size > maxInputBytes)
    throw new ReplayFailure("source_limit", false);
  const probe = JSON.parse(
    await runProcess(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        resolve(input),
      ],
      { signal },
    ),
  ) as {
    format?: { duration?: string; format_name?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      channels?: number;
    }[];
  };
  const duration = Number(probe.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > maxDurationSeconds ||
    !probe.format?.format_name?.split(",").includes("mp4") ||
    !probe.streams?.some((s) => s.codec_type === "video") ||
    !probe.streams.some((s) => s.codec_type === "audio") ||
    probe.streams.some(
      (s) =>
        s.codec_type === "video" &&
        (!s.width || !s.height || s.width > 3840 || s.height > 2160),
    ) ||
    probe.streams.some(
      (s) => s.codec_type === "audio" && (!s.channels || s.channels > 8),
    )
  )
    throw new ReplayFailure("invalid_source", false);
  const sourceSha256 = await fileDigest(input, signal);
  await mkdir(directory, { mode: 0o700 });
  // Fixed bitrate/duration limits bound expected output. Reserve headroom and
  // reject a full worker volume before creating thousands of segments.
  const expectedBytes = Math.ceil(
    ((duration *
      renditions.reduce((sum, r) => sum + r.bitrate * 1.1 + r.audio, 0) *
      1000) /
      8) *
      1.2,
  );
  if (expectedBytes > maxOutputBytes)
    throw new ReplayFailure("output_limit", false);
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < expectedBytes + 64 * 1024 ** 2)
    throw new ReplayFailure("disk_capacity");
  for (const rendition of renditions) {
    checkReplaySignal(signal);
    const folder = resolve(directory, rendition.name);
    await mkdir(folder, { mode: 0o700 });
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-protocol_whitelist",
        "file",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-threads",
        "2",
        "-i",
        resolve(input),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-t",
        String(maxDurationSeconds),
        "-vf",
        `scale=${rendition.width}:${rendition.height}:force_original_aspect_ratio=decrease,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-filter_threads",
        "1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        "2",
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
      ],
      { signal },
    );
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
  await writeFile(resolve(directory, "master.m3u8"), master, {
    flag: "wx",
    mode: 0o600,
  });
  if (captions !== null)
    await writeFile(resolve(directory, "captions.vtt"), captions, {
      flag: "wx",
      mode: 0o600,
    });
  return inspectReplayPackage(directory, duration, sourceSha256, captions, {
    signal,
    maxFiles,
    maxOutputBytes,
  });
}
