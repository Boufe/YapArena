import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  findViolations,
  maximumBytes,
} from "../scripts/check-repository-files.ts";

const script = fileURLToPath(
  new URL("../scripts/check-repository-files.ts", import.meta.url),
);

describe("repository file policy", () => {
  it("rejects new media under docs/ and large files outside public/", () => {
    const violations = findViolations(
      [
        { path: "docs/evidence/new.PNG", size: 10 },
        { path: "docs/trial/recording.webm", size: 10 },
        { path: "docs/trial/frame.raw", size: 10 },
        { path: "fixtures/dump.json", size: maximumBytes + 1 },
        { path: "public/hero.webp", size: maximumBytes + 1 },
        { path: "docs/decision.md", size: 10 },
        { path: "fixtures/small.json", size: maximumBytes },
        { path: "docs/evidence/old.png", size: maximumBytes * 3 },
      ],
      new Set(["docs/evidence/old.png"]),
    );
    assert.deepEqual(violations, [
      "docs/evidence/new.PNG: image, video or .raw file under docs/",
      "docs/trial/recording.webm: image, video or .raw file under docs/",
      "docs/trial/frame.raw: image, video or .raw file under docs/",
      `fixtures/dump.json: ${maximumBytes + 1} bytes exceeds 1 MiB`,
    ]);
  });

  it("fails the command for a tracked screenshot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "yaparena-files-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      mkdirSync(path.join(root, "docs"));
      writeFileSync(path.join(root, "docs", "screenshot.png"), "x");
      writeFileSync(path.join(root, "docs", "notes.md"), "x");
      execFileSync("git", ["add", "."], { cwd: root });

      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /docs\/screenshot\.png: image/);
      assert.doesNotMatch(result.stderr, /notes\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
