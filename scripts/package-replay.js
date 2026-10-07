import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReplayPackage,
  renditions,
  run,
} from "../src/features/media/replay-packaging.ts";
import { createReplayStorage } from "../src/features/media/replay-storage.ts";

export { renditions, run };
// The automatic worker uses these same modules. This CLI remains useful for
// disposable trials; neither captions nor an operator publication step is needed.
export async function packageReplay(input, directory, captionFile) {
  const captions = captionFile ? await readFile(captionFile, "utf8") : null;
  const manifest = await buildReplayPackage(input, directory, captions);
  await writeFile(
    resolve(directory, ".replay-manifest.json"),
    JSON.stringify(manifest),
    { flag: "wx", mode: 0o600 },
  );
  return manifest.files.map((file) => file.path);
}
export async function uploadReplay(
  directory,
  files,
  recordingKey,
  environment = process.env,
) {
  for (const name of [
    "MEDIA_S3_REGION",
    "MEDIA_S3_BUCKET",
    "MEDIA_S3_ACCESS_KEY",
    "MEDIA_S3_SECRET_KEY",
  ])
    if (!environment[name]) throw new Error(`${name} required`);
  const manifest = JSON.parse(
    await readFile(resolve(directory, ".replay-manifest.json"), "utf8"),
  );
  if (
    JSON.stringify([...files].sort()) !==
    JSON.stringify(manifest.files.map((file) => file.path).sort())
  )
    throw new Error("package file inventory changed");
  const storage = createReplayStorage({
    region: environment.MEDIA_S3_REGION,
    bucket: environment.MEDIA_S3_BUCKET,
    endpoint: environment.MEDIA_S3_ENDPOINT,
    accessKey: environment.MEDIA_S3_ACCESS_KEY,
    secretKey: environment.MEDIA_S3_SECRET_KEY,
  });
  try {
    return await storage.upload(directory, manifest, recordingKey);
  } finally {
    storage.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, directory, captions, recordingKey] = process.argv.slice(2);
  if (!input || !directory)
    throw new Error(
      "Usage: node scripts/package-replay.js INPUT.mp4 NEW_OUTPUT_DIR [REVIEWED.vtt|-] [RECORDING_KEY_TO_UPLOAD]",
    );
  const files = await packageReplay(
    input,
    resolve(directory),
    captions === "-" ? undefined : captions,
  );
  if (recordingKey) await uploadReplay(resolve(directory), files, recordingKey);
  console.log(
    JSON.stringify({
      packaged: files.length,
      uploaded: Boolean(recordingKey),
      renditions: renditions.map((r) => r.name),
    }),
  );
}
