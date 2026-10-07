import assert from "node:assert/strict";
import { it } from "node:test";
import { createReplayLibraryLoader } from "../public/media-replay-library.js";

it("coalesces lazy player loading and permits retry after a failed script", async () => {
  let library;
  const scripts = [];
  const loader = createReplayLibraryLoader({
    document: {
      createElement() {
        return {
          remove() {
            this.removed = true;
          },
        };
      },
      head: {
        append(script) {
          scripts.push(script);
        },
      },
    },
    source: "/assets/replay.bundle.js",
    getLibrary: () => library,
  });
  const first = loader();
  assert.equal(loader(), first);
  assert.equal(scripts[0].src, "/assets/replay.bundle.js");
  scripts[0].onerror();
  await assert.rejects(first, /could not load/);
  assert.equal(scripts[0].removed, true);
  const second = loader();
  scripts[1].onload();
  await assert.rejects(second, /could not load/);
  const third = loader();
  library = { isSupported: () => true };
  scripts[2].onload();
  assert.equal(await third, library);
  assert.equal(await loader(), library);
  assert.equal(scripts.length, 3);
});
