import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script = fileURLToPath(
  new URL("../scripts/verify-auth-redis.ts", import.meta.url),
);
function options(arguments_, extraEnvironment = {}) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      ...extraEnvironment,
    },
  });
}

describe("Redis verifier disposable engine gates", () => {
  it("preserves the Redis default and selects only the exact Valkey release", () => {
    const defaults = options(["--options-only", "--disposable"]);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.deepEqual(JSON.parse(defaults.stdout), {
      disposable: true,
      engine: "redis-7.4",
      image: "redis:7.4-alpine",
      binary: "redis-server",
    });
    const selected = options([
      "--options-only",
      "--disposable",
      "--disposable-engine=valkey-8.1.10",
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout), {
      disposable: true,
      engine: "valkey-8.1.10",
      image: "valkey/valkey:8.1.10-alpine",
      binary: "valkey-server",
    });
  });

  it("rejects arbitrary images, unowned targets and conflicting flags offline", () => {
    for (const [arguments_, expected] of [
      [
        ["--options-only", "--disposable-engine=valkey-8.1.10"],
        /requires --disposable/,
      ],
      [
        ["--options-only", "--disposable", "--disposable-engine=valkey-latest"],
        /engine must be redis-7.4 or valkey-8.1.10/,
      ],
      [
        [
          "--options-only",
          "--disposable",
          "--disposable-engine=attacker/image",
        ],
        /engine must be redis-7.4 or valkey-8.1.10/,
      ],
      [
        ["--options-only", "--disposable", "--disposable-engine="],
        /engine must be redis-7.4 or valkey-8.1.10/,
      ],
      [
        ["--options-only", "--disposable", "--disposable"],
        /duplicate Redis verifier options/,
      ],
      [
        [
          "--options-only",
          "--disposable",
          "--disposable-engine=redis-7.4",
          "--disposable-engine=valkey-8.1.10",
        ],
        /duplicate Redis verifier options/,
      ],
      [
        ["--options-only", "--http-worker"],
        /cannot run a worker or write evidence/,
      ],
      [
        ["--options-only", "--evidence=/unowned/evidence.json"],
        /cannot run a worker or write evidence/,
      ],
      [["--options-only", "--arbitrary-option"], /unsupported Redis verifier/],
    ]) {
      const result = options(arguments_);
      assert.notEqual(result.status, 0, JSON.stringify(arguments_));
      assert.match(result.stderr, expected);
      assert.equal(result.stdout, "");
    }
    const unowned = options(["--options-only", "--disposable"], {
      REDIS_TEST_URL: "redis://127.0.0.1:56379",
    });
    assert.notEqual(unowned.status, 0);
    assert.match(unowned.stderr, /must not use an existing Redis target/);
    assert.equal(unowned.stdout, "");
  });
});
