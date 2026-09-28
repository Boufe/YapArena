import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

describe("project initializer", () => {
  it("renames identity files and refuses an ambiguous rerun", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "service-template-"));
    await cp(resolve(import.meta.dirname, ".."), temporaryRoot, {
      recursive: true,
      filter: (source) =>
        !["node_modules", ".git", ".template-initialized"].includes(
          basename(source),
        ),
    });
    const { initializeProject } =
      await import("../scripts/initialize-project.js");
    const argumentsList = [
      "--name",
      "Forecast Lab",
      "--slug",
      "forecast-lab",
      "--owner",
      "example-org",
      "--database",
      "forecast_lab",
      "--description",
      "A forecasting service.",
    ];

    await initializeProject(argumentsList, temporaryRoot);

    const packageJson = JSON.parse(
      await readFile(join(temporaryRoot, "package.json")),
    );
    const compose = await readFile(join(temporaryRoot, "compose.yaml"), "utf8");
    const environment = await readFile(
      join(temporaryRoot, ".env.example"),
      "utf8",
    );
    assert.equal(packageJson.name, "forecast-lab");
    assert.equal(packageJson.description, "A forecasting service.");
    assert.match(compose, /COMPOSE_PROJECT_NAME:-forecast-lab/);
    assert.match(environment, /POSTGRES_DB=forecast_lab/);
    assert.match(
      await readFile(join(temporaryRoot, ".github/CODEOWNERS"), "utf8"),
      /\* @example-org/,
    );
    assert.match(
      await readFile(
        join(temporaryRoot, ".github/ISSUE_TEMPLATE/config.yml"),
        "utf8",
      ),
      /github\.com\/example-org\/forecast-lab\/security\/advisories\/new/,
    );
    for (const path of [
      "src/platform/metrics.ts",
      "monitoring/prometheus.yml",
      "monitoring/prometheus/rules/yaparena.yml",
    ]) {
      assert.doesNotMatch(
        await readFile(join(temporaryRoot, path), "utf8"),
        /yaparena/iu,
      );
    }
    await assert.rejects(
      initializeProject(argumentsList, temporaryRoot),
      /already been initialized/,
    );
  });

  it("rejects unsafe identifiers", async () => {
    const { initializeProject } =
      await import("../scripts/initialize-project.js");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "service-template-invalid-"),
    );
    await assert.rejects(
      initializeProject(
        [
          "--name",
          "Bad Project",
          "--slug",
          "../bad",
          "--owner",
          "owner",
          "--database",
          "database",
          "--description",
          "Bad project description",
        ],
        temporaryRoot,
      ),
      /slug is invalid/,
    );
  });

  it("runs through the CLI from a symlinked temporary path", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "service-template-cli-"),
    );
    await cp(resolve(import.meta.dirname, ".."), temporaryRoot, {
      recursive: true,
      filter: (source) =>
        !["node_modules", ".git", ".template-initialized"].includes(
          basename(source),
        ),
    });

    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        join(temporaryRoot, "scripts/initialize-project.js"),
        "--name",
        "Forecast Lab",
        "--slug",
        "forecast-lab",
        "--owner",
        "example-org",
        "--database",
        "forecast_lab",
        "--description",
        "A forecasting service.",
      ],
      { cwd: temporaryRoot },
    );

    assert.match(stdout, /Initialized Forecast Lab/);
    const packageJson = JSON.parse(
      await readFile(join(temporaryRoot, "package.json")),
    );
    assert.equal(packageJson.name, "forecast-lab");
  });
});
