import { Router, type Request } from "express";
import { A4Error, purchaseLimit } from "./engine.ts";
import {
  type createA4Repository,
  type Actor,
  type RunConfig,
} from "./repository.ts";
import { SessionUnavailableError } from "../../platform/auth/sessions.ts";
import { hashSessionToken } from "../../platform/auth/session-tokens.ts";
import { rateLimit } from "express-rate-limit";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new A4Error("resource not found", 404);
  return value;
}
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new A4Error("invalid request fields", 400);
  return value as Record<string, unknown>;
}
function page(value: unknown, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^\d{1,5}$/.test(value) ||
    Number(value) > max
  )
    throw new A4Error("invalid pagination", 400);
  return Number(value);
}
export function createA4Router(
  a4: ReturnType<typeof createA4Repository>,
  environment: string,
) {
  const router = Router();
  const actor = (r: Request): Actor => ({
    userId: r.user!.id,
    tokenHash: hashSessionToken(
      r.cookies[environment === "production" ? "__Host-session" : "session"],
    ),
  });
  const key = (r: Request) => {
    const value = r.get("Idempotency-Key");
    if (!value) throw new A4Error("Idempotency-Key required", 400);
    return value;
  };
  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store").set("Vary", "Cookie");
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      keyGenerator: (r) => r.user!.id,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  router.use((r, _s, next) => {
    if (r.method !== "GET" && r.method !== "HEAD")
      return writeLimit(r, _s, next);
    next();
  });
  const writeLimit = rateLimit({
    windowMs: 60000,
    limit: 30,
    keyGenerator: (r) => r.user!.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  router.get("/wallet", async (r, s) => s.json(await a4.wallet(actor(r))));
  router.get("/debates/:id/workspace", async (r, s) => {
    const current = actor(r),
      debateId = id(r.params.id);
    const runId = r.query.runId === undefined ? undefined : id(r.query.runId);
    const runs = await a4.list(current, debateId);
    const run = runId ? await a4.view(current, runId, 0, 1) : null;
    if (run && (run.debateId !== debateId || run.mode === "observer"))
      throw new A4Error("run not found", 404);
    const wallet = run ?? (await a4.wallet(current));
    const timeline = await a4.timeline(
      current,
      debateId,
      run?.mode === "mixed" ? "sandbox" : "human",
    );
    return s.json({ accountId: current.userId, run, wallet, runs, timeline });
  });
  router.get("/debates/:id/timeline", async (r, s) => {
    const scope = r.query.scope ?? "human";
    if (scope !== "human" && scope !== "sandbox")
      throw new A4Error("invalid timeline scope", 400);
    return s.json(await a4.timeline(actor(r), id(r.params.id), scope));
  });
  router.get("/history", async (r, s) =>
    s.json(await a4.history(actor(r), page(r.query.offset, 10000, 0))),
  );
  router.get("/runs", async (r, s) =>
    s.json(
      await a4.list(
        actor(r),
        r.query.debateId === undefined ? undefined : id(r.query.debateId),
        page(r.query.offset, 10000, 0),
      ),
    ),
  );
  router.post("/runs", async (r, s) => {
    const b = body(r.body, ["debateId", "mode", "config", "seed", "speed"]);
    const config =
      b.config === undefined
        ? undefined
        : (body(b.config, [
            "argumentLabel",
            "epsilon",
            "feeBps",
            "population",
            "preset",
            "quantity",
            "periods",
            "delayed",
            "roundSeconds",
          ]) as Partial<RunConfig>);
    return s.status(201).json(
      await a4.create(actor(r), key(r), {
        debateId: id(b.debateId),
        mode: b.mode as "human" | "mixed" | "observer",
        config,
        seed: b.seed as string | undefined,
        speed: b.speed as number | undefined,
      }),
    );
  });
  router.get("/runs/:id", async (r, s) =>
    s.json(
      await a4.view(
        actor(r),
        id(r.params.id),
        page(r.query.offset, 10000, 0),
        Math.max(1, page(r.query.limit, 100, 50)),
      ),
    ),
  );
  router.post("/refill", async (r, s) => {
    const b = body(r.body, ["runId"]);
    return s.json(
      await a4.refill(
        actor(r),
        key(r),
        b.runId === undefined ? undefined : id(b.runId),
      ),
    );
  });
  router.post("/rounds/:id/submit", async (r, s) => {
    const b = body(r.body, [
      "side",
      "ceiling",
      "quantity",
      "rule",
      "accountId",
    ]);
    if (typeof b.side !== "string" || !["YES", "NO"].includes(b.side))
      throw new A4Error("position required", 400);
    if (b.accountId !== r.user!.id)
      throw new A4Error("account changed; review again");
    const side = b.side as "YES" | "NO";
    const limit = purchaseLimit(side, b.ceiling as string);
    // Input precision divides 10^6, so conversion is exact in this decimal representation.
    const micro = (BigInt(limit.n) * 1000000n) / BigInt(limit.d);
    const text = `${micro / 1000000n}.${String(micro % 1000000n).padStart(6, "0")}`;
    return s.status(201).json(
      await a4.submit(actor(r), key(r), id(r.params.id), {
        side,
        limit: text,
        quantity: b.quantity as number,
        rule: b.rule as string,
      }),
    );
  });
  router.post("/runs/:id/control", async (r, s) => {
    const b = body(r.body, ["action", "speed"]);
    if (
      typeof b.action !== "string" ||
      !["run", "pause", "step", "archive", "speed"].includes(b.action)
    )
      throw new A4Error("invalid control", 400);
    return s.json(
      await a4.control(
        actor(r),
        key(r),
        id(r.params.id),
        b.action as "run" | "pause" | "step" | "archive" | "speed",
        b.speed as number | undefined,
      ),
    );
  });
  router.use(
    (
      error: unknown,
      _request: Request,
      response: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      if (error instanceof A4Error)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "sign in again" });
      return next(error);
    },
  );
  return router;
}
