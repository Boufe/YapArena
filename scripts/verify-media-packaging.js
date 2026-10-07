import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { packageReplay, renditions, run } from "./package-replay.js";

const directory = await mkdtemp(resolve(tmpdir(), "yaparena-hls-trial-"));
try {
  const input = resolve(directory, "synthetic.mp4");
  const captions = resolve(directory, "reviewed.vtt");
  await writeFile(
    captions,
    "WEBVTT\n\n00:00:00.000 --> 00:00:06.000\nSynthetic audio tone\n",
  );
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
  const output = resolve(directory, "hls");
  const files = await packageReplay(input, output, captions);
  const results = [];
  for (const rendition of renditions) {
    const playlist = resolve(output, rendition.name, "index.m3u8");
    const streams = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", playlist],
        { encoding: "utf8" },
      ),
    ).streams;
    assert.equal(
      streams.find((s) => s.codec_type === "video").width,
      rendition.width,
    );
    assert.equal(
      streams.find((s) => s.codec_type === "video").height,
      rendition.height,
    );
    assert.equal(
      streams.find((s) => s.codec_type === "audio").codec_name,
      "aac",
    );
    const text = await readFile(playlist, "utf8");
    const durations = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((match) =>
      Number(match[1]),
    );
    assert.equal(durations.length, 3);
    for (const duration of durations) assert.ok(Math.abs(duration - 2) < 0.05);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      playlist,
      "-f",
      "null",
      "-",
    ]);
    results.push({
      rendition: rendition.name,
      width: rendition.width,
      height: rendition.height,
      segments: durations.length,
      durations,
    });
  }
  const master = await readFile(resolve(output, "master.m3u8"), "utf8");
  assert.equal((master.match(/EXT-X-STREAM-INF/g) || []).length, 3);
  assert.ok(files.includes("captions.vtt"));
  console.log(
    JSON.stringify(
      {
        result: "passed",
        ffmpeg: execFileSync("ffmpeg", ["-version"], {
          encoding: "utf8",
        }).split("\n")[0],
        files: files.length,
        renditions: results,
        generatedFolders: await readdir(output),
        scope:
          "local synthetic encoding and decoding; no storage upload or browser playback",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
