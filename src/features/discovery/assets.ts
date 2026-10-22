import { randomUUID } from "node:crypto";

// Deploys on Render pin the revision to the commit. Elsewhere each process
// picks a random revision, so a restart never reuses a cached asset URL.
export const assetRevision = /^[0-9a-f]{40}$/i.test(
  process.env.RENDER_GIT_COMMIT ?? "",
)
  ? process.env.RENDER_GIT_COMMIT!.slice(0, 12)
  : randomUUID().replaceAll("-", "").slice(0, 12);
export const asset = (name: string) => `/assets/${name}?v=${assetRevision}`;
