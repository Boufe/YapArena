#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const identityFiles = [
  ".env.example",
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "README.md",
  "compose.yaml",
  "compose.production.yaml",
  "docs/operations.md",
  "monitoring/prometheus.yml",
  "monitoring/grafana/dashboards/yaparena-overview.json",
  "monitoring/prometheus/rules/yaparena.yml",
  "src/platform/metrics.ts",
  "tests/app.test.js",
  "tests/metrics.test.js",
];
const metricIdentityFiles = new Set([
  "monitoring/prometheus.yml",
  "monitoring/grafana/dashboards/yaparena-overview.json",
  "monitoring/prometheus/rules/yaparena.yml",
  "src/platform/metrics.ts",
  "tests/app.test.js",
  "tests/metrics.test.js",
]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("arguments must use --name value pairs");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function requireMatch(value, name, expression) {
  if (!value || !expression.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function validate(values) {
  return {
    name: requireMatch(
      values.name,
      "name",
      /^[\p{L}\p{N}][\p{L}\p{N} .'-]{1,79}$/u,
    ),
    slug: requireMatch(values.slug, "slug", /^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    owner: requireMatch(
      values.owner,
      "owner",
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u,
    ),
    database: requireMatch(
      values.database,
      "database",
      /^[a-z][a-z0-9_]{0,62}$/u,
    ),
    description: requireMatch(values.description, "description", /^.{3,160}$/u),
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initializeProject(
  argv = process.argv.slice(2),
  projectRoot = root,
) {
  const marker = resolve(projectRoot, ".template-initialized");
  if (await exists(marker)) {
    throw new Error("this repository has already been initialized");
  }

  const project = validate(parseArguments(argv));
  const metricIdentifier = project.slug.replaceAll("-", "_");

  for (const relativePath of identityFiles) {
    const path = resolve(projectRoot, relativePath);
    let contents = await readFile(path, "utf8");
    if (relativePath === ".github/ISSUE_TEMPLATE/config.yml") {
      contents = contents.replace(
        /github\.com\/Boufe\/YapArena/gu,
        `github.com/${project.owner}/${project.slug}`,
      );
    }
    const replacements = [
      [/OWNER\/REPOSITORY/gu, `${project.owner}/${project.slug}`],
      [/YapArena/gu, project.name],
      [
        /yaparena/gu,
        metricIdentityFiles.has(relativePath) ? metricIdentifier : project.slug,
      ],
    ];
    for (const [pattern, replacement] of replacements) {
      contents = contents.replace(pattern, replacement);
    }
    if (relativePath === ".github/CODEOWNERS") {
      contents = contents.replace(/@Boufe\b/gu, `@${project.owner}`);
    }
    await writeFile(path, contents);
  }

  const composePath = resolve(projectRoot, "compose.yaml");
  const compose = (await readFile(composePath, "utf8"))
    .replaceAll(
      `\${POSTGRES_DB:-${project.slug}}`,
      `\${POSTGRES_DB:-${project.database}}`,
    )
    .replaceAll(
      `\${POSTGRES_USER:-${project.slug}}`,
      `\${POSTGRES_USER:-${project.database}}`,
    );
  await writeFile(composePath, compose);

  for (const file of ["package.json", "package-lock.json"]) {
    const path = resolve(projectRoot, file);
    const contents = JSON.parse(await readFile(path, "utf8"));
    contents.name = project.slug;
    if (file === "package.json") contents.description = project.description;
    if (contents.packages?.[""]) {
      contents.packages[""].name = project.slug;
      contents.packages[""].description = project.description;
    }
    await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
  }

  const environmentPath = resolve(projectRoot, ".env.example");
  const environment = (await readFile(environmentPath, "utf8"))
    .replace(/^POSTGRES_DB=.*$/mu, `POSTGRES_DB=${project.database}`)
    .replace(/^POSTGRES_USER=.*$/mu, `POSTGRES_USER=${project.database}`)
    .replace(
      /^DATABASE_URL=.*$/mu,
      `DATABASE_URL=postgresql://${project.database}:local-development-only@127.0.0.1:5433/${project.database}`,
    );
  await writeFile(environmentPath, environment);
  await writeFile(marker, `${JSON.stringify(project, null, 2)}\n`);

  return project;
}

function isCommandLineEntry() {
  if (!process.argv[1]) return false;
  return (
    realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
  );
}

if (isCommandLineEntry()) {
  initializeProject()
    .then((project) => {
      process.stdout.write(`Initialized ${project.name} (${project.slug}).\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
