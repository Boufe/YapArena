import QRCode from "qrcode";
import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import type { createIdentityRepository } from "../identity/repository.ts";
import type {
  createCommunityRepository,
  CaseAction,
  ReasonCode,
} from "./repository.ts";
import {
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityNotFoundError,
  CommunityRateError,
} from "./repository.ts";
import { createRequireRole } from "../identity/router.ts";
import { renderModeration, renderMyModeration, renderOverlay } from "./web.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = /^[1-9]\d{0,18}$/;
const slug = /^[a-z0-9][a-z0-9-]{2,99}$/;
const reasons = new Set<ReasonCode>([
  "harassment",
  "hate",
  "threat",
  "spam",
  "privacy",
  "other",
]);
const actions = new Set<CaseAction>([
  "dismiss",
  "remove_chat",
  "restrict_account",
  "pause_chat",
]);

function pathId(request: Request, key = "id") {
  const value = request.params[key];
  return typeof value === "string" && uuid.test(value) ? value : null;
}
function text(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= minimum && trimmed.length <= maximum
    ? trimmed
    : null;
}
function problem(response: Response, error: unknown) {
  if (error instanceof CommunityNotFoundError)
    return response.status(404).json({ error: error.message });
  if (error instanceof CommunityForbiddenError)
    return response.status(403).json({ error: error.message });
  if (error instanceof CommunityConflictError)
    return response.status(409).json({ error: error.message });
  if (error instanceof CommunityRateError)
    return response.status(429).json({ error: error.message });
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    error.code === "23505"
  )
    return response.status(409).json({ error: "request already exists" });
  throw error;
}
async function attempt(
  response: Response,
  work: () => Promise<unknown>,
  status = 200,
) {
  try {
    return response.status(status).json(await work());
  } catch (error) {
    return problem(response, error);
  }
}

export function createCommunityRouter({
  community,
  identity,
  requireAuth,
  applicationOrigin,
  recordProductAction,
}: {
  community: ReturnType<typeof createCommunityRepository>;
  identity: Pick<ReturnType<typeof createIdentityRepository>, "getRoles">;
  requireAuth: RequestHandler;
  applicationOrigin: string;
  recordProductAction?: ProductActionRecorder;
}) {
  const router = Router();
  const participant = createRequireRole(identity, ["participant"]);
  const moderator = createRequireRole(identity, ["moderator"]);
  const origin = applicationOrigin.replace(/\/$/, "");
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/debates/:slug/qr.svg", async (request, response) => {
    const key = request.params.slug;
    if (typeof key !== "string" || !slug.test(key))
      return response.status(404).end();
    const event = await community.publicEventBySlug(key);
    if (!event) return response.status(404).end();
    const canonical = `${origin}/debates/${event.slug}`;
    const svg = await QRCode.toString(canonical, {
      type: "svg",
      width: 256,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    return response.type("image/svg+xml").send(svg);
  });
  router.get("/overlay/:slug", async (request, response) => {
    const key = request.params.slug;
    const event =
      typeof key === "string" && slug.test(key)
        ? await community.publicEventBySlug(key)
        : null;
    return event
      ? response.type("html").send(renderOverlay(event))
      : response.status(404).type("html").send("<h1>Event not found</h1>");
  });
  router.get("/account/moderation", requireAuth, (_request, response) =>
    response.type("html").send(renderMyModeration()),
  );
  router.get("/moderation", requireAuth, moderator, (_request, response) =>
    response.type("html").send(renderModeration()),
  );

  router.get("/api/community/events/:id", async (request, response) => {
    const id = pathId(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    return attempt(response, () => community.summary(id));
  });
  router.get("/api/community/events/:id/chat", async (request, response) => {
    const id = pathId(request);
    if (!id) return response.status(404).json({ error: "event not found" });
    const before = request.query.before;
    if (
      before !== undefined &&
      (typeof before !== "string" || !integer.test(before))
    )
      return response.status(400).json({ error: "invalid chat cursor" });
    return attempt(response, () =>
      community.listChat(id, before as string | undefined),
    );
  });
  router.get(
    "/api/community/events/:id/chat/sync",
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const after = request.query.after ?? "0";
      const watch = request.query.watch ?? "";
      if (
        typeof after !== "string" ||
        (after !== "0" && !integer.test(after)) ||
        typeof watch !== "string" ||
        watch.length > 4000 ||
        (watch && !watch.split(",").every((value) => integer.test(value)))
      )
        return response.status(400).json({ error: "invalid chat cursor" });
      const watchedIds = watch ? [...new Set(watch.split(","))] : [];
      if (watchedIds.length > 200)
        return response
          .status(400)
          .json({ error: "too many watched messages" });
      response.set("Cache-Control", "no-store");
      return attempt(response, () => community.syncChat(id, after, watchedIds));
    },
  );
  router.get(
    "/api/community/events/:id/my-like",
    requireAuth,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      return attempt(response, () => community.summary(id, request.user!.id));
    },
  );
  router.post(
    "/api/community/events/:id/chat",
    requireAuth,
    participant,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "event not found" });
      const body = text(request.body?.body, 1, 500);
      if (!body)
        return response
          .status(400)
          .json({ error: "chat must be 1–500 characters" });
      return attempt(
        response,
        () => community.postChat(id, request.user!.id, body),
        201,
      );
    },
  );
  for (const method of ["put", "delete"] as const) {
    router[method](
      "/api/community/events/:id/like",
      requireAuth,
      participant,
      async (request, response) => {
        const id = pathId(request);
        if (!id) return response.status(404).json({ error: "event not found" });
        return attempt(response, () =>
          community.setLike(id, request.user!.id, method === "put"),
        );
      },
    );
  }
  router.post(
    "/api/community/reports",
    requireAuth,
    participant,
    async (request, response) => {
      const { targetType, targetId, reasonCode } = request.body ?? {};
      const detail = text(request.body?.detail, 10, 500);
      if (
        (targetType !== "event" && targetType !== "chat") ||
        typeof targetId !== "string" ||
        !(targetType === "event" ? uuid : integer).test(targetId) ||
        !reasons.has(reasonCode) ||
        !detail
      )
        return response.status(400).json({ error: "invalid report fields" });
      return attempt(
        response,
        async () => {
          const result = await community.report(
            request.user!.id,
            targetType,
            targetId,
            reasonCode,
            detail,
          );
          await recordProductAction?.(request, {
            type: "report_submitted",
            caseId: result.id,
          });
          return result;
        },
        201,
      );
    },
  );

  router.get(
    "/api/community/me/cases",
    requireAuth,
    async (request, response) =>
      attempt(response, () => community.listMyCases(request.user!.id)),
  );
  router.post(
    "/api/community/cases/:id/appeal",
    requireAuth,
    participant,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const reason = text(request.body?.reason, 10, 500);
      if (!reason)
        return response
          .status(400)
          .json({ error: "appeal reason must be 10–500 characters" });
      return attempt(
        response,
        () => community.appeal(id, request.user!.id, reason),
        201,
      );
    },
  );
  router.get(
    "/api/community/moderation/cases",
    requireAuth,
    moderator,
    async (request, response) => {
      const status = request.query.status ?? "open";
      if (status !== "open" && status !== "dismissed" && status !== "actioned")
        return response.status(400).json({ error: "invalid case status" });
      return attempt(response, () => community.listCases(status));
    },
  );
  router.get(
    "/api/community/moderation/cases/:id",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      return attempt(response, () => community.getCase(id));
    },
  );
  router.post(
    "/api/community/moderation/cases/:id/decision",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const { action, reasonCode } = request.body ?? {};
      const note = text(request.body?.note, 10, 500);
      if (!actions.has(action) || !reasons.has(reasonCode) || !note)
        return response.status(400).json({ error: "invalid case decision" });
      return attempt(response, () =>
        community.decideCase(id, request.user!.id, action, reasonCode, note),
      );
    },
  );
  router.post(
    "/api/community/moderation/cases/:id/resume-chat",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "case not found" });
      const note = text(request.body?.note, 10, 500);
      if (!note)
        return response
          .status(400)
          .json({ error: "resume note must be 10–500 characters" });
      return attempt(response, () =>
        community.resumeChat(id, request.user!.id, note),
      );
    },
  );
  router.get(
    "/api/community/moderation/appeals",
    requireAuth,
    moderator,
    async (_request, response) =>
      attempt(response, () => community.listAppeals()),
  );
  router.post(
    "/api/community/moderation/appeals/:id/decision",
    requireAuth,
    moderator,
    async (request, response) => {
      const id = pathId(request);
      if (!id) return response.status(404).json({ error: "appeal not found" });
      const decision = request.body?.decision;
      const note = text(request.body?.note, 10, 500);
      if ((decision !== "upheld" && decision !== "overturned") || !note)
        return response.status(400).json({ error: "invalid appeal decision" });
      return attempt(response, () =>
        community.decideAppeal(id, request.user!.id, decision, note),
      );
    },
  );
  return router;
}
