import { execFileSync, spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform, type Plugin } from "esbuild";

const repository = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(repository, "frontend");
const publicDirectory = path.join(repository, "public");
// These modules import shared src/ code (src/platform/html.ts) but keep their
// own /assets/<name>.js URL. Only src/ imports are inlined: sibling frontend
// imports such as ./arena-chart.js stay separate requests, exactly as the
// per-file transform emits them.
const inPlaceBundles = ["a4", "a4-inline"];
const keepSiblingImports: Plugin = {
  name: "keep-sibling-imports",
  setup(context) {
    context.onResolve({ filter: /^\.\/[^/]+\.js$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? files(name) : [name];
    }),
  );
  return nested.flat().sort();
}

async function checkSources(): Promise<string[]> {
  const sources = await files(frontend);
  const unsupportedSource = /\.(?:[cm]?js|jsx|tsx|[cm]ts)$/i;
  const unchecked = sources.filter((name) => unsupportedSource.test(name));
  // Source archives and Docker contexts omit .git. CI and local checkouts also
  // enforce that served JavaScript is never tracked as authored source.
  if (existsSync(path.join(repository, ".git"))) {
    const tracked = execFileSync(
      "git",
      ["ls-files", "-z", "--", "public", "frontend"],
      { cwd: repository, encoding: "utf8" },
    ).split("\0");
    unchecked.push(
      ...tracked.filter(
        (name) =>
          unsupportedSource.test(name) ||
          (name.startsWith("public/") && /\.[cm]?tsx?$/i.test(name)),
      ),
    );
  }
  if (unchecked.length) {
    throw new Error(
      `Handwritten frontend code must be strict TypeScript in frontend/; public JavaScript must remain untracked build output:\n${[...new Set(unchecked)].join("\n")}`,
    );
  }
  return sources.filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
  );
}

async function buildFrontend(): Promise<void> {
  const sources = await checkSources();
  await Promise.all(
    sources.map(async (source) => {
      const name = path.relative(frontend, source).replace(/\.ts$/, "");
      if (inPlaceBundles.includes(name)) return;
      // Omitting format preserves classic-script scope and existing ESM imports.
      // Type-only modules erase to nothing and need no browser asset.
      const output = await transform(await readFile(source, "utf8"), {
        loader: "ts",
        sourcefile: path.relative(repository, source),
      });
      if (!output.code.trim()) return;
      const destination = path.join(publicDirectory, `${name}.js`);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, output.code);
    }),
  );
  await Promise.all(
    (
      [
        ["media-entry", "media.bundle", "iife"],
        ["replay-entry", "replay.bundle", "iife"],
        ["hero-live", "hero-live.bundle", "esm"],
        ["homepage", "homepage.bundle", "iife"],
      ] as const
    ).map(([entry, output, format]) =>
      build({
        absWorkingDir: repository,
        entryPoints: [`frontend/${entry}.ts`],
        bundle: true,
        minify: true,
        format,
        outfile: `public/${output}.js`,
      }),
    ),
  );
  await Promise.all(
    inPlaceBundles.map((entry) =>
      build({
        absWorkingDir: repository,
        entryPoints: [`frontend/${entry}.ts`],
        bundle: true,
        format: "esm",
        outfile: `public/${entry}.js`,
        plugins: [keepSiblingImports],
      }),
    ),
  );
}

if (process.argv.includes("--check-sources")) {
  await checkSources();
} else {
  await buildFrontend();
  if (process.argv.includes("--watch") || process.argv.includes("--dev")) {
    let building = false;
    let requested = false;
    const rebuild = async () => {
      requested = true;
      if (building) return;
      building = true;
      while (requested) {
        requested = false;
        try {
          await buildFrontend();
        } catch (error) {
          console.error(error);
        }
      }
      building = false;
    };
    const watchers: FSWatcher[] = [
      watch(frontend, { recursive: true }, () => void rebuild()),
      watch(
        path.join(repository, "src/features/discovery"),
        { recursive: true },
        () => void rebuild(),
      ),
      watch(
        path.join(repository, "src/platform/html.ts"),
        () => void rebuild(),
      ),
    ];
    const server = process.argv.includes("--dev")
      ? spawn(
          process.execPath,
          ["--env-file-if-exists=.env.runtime", "--watch", "src/server.ts"],
          { cwd: repository, stdio: "inherit" },
        )
      : undefined;
    const close = () => {
      for (const watcher of watchers) watcher.close();
    };
    server?.on("exit", (code) => {
      close();
      process.exitCode = code ?? 1;
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        close();
        server?.kill(signal);
      });
    }
  }
}
