import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { createIdentityRepository } from "./repository.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";

type Repository = ReturnType<typeof createIdentityRepository>;
const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;
const topicPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

function pagination(query: Record<string, unknown>) {
  const parse = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number <= max ? number : null;
  };
  const limit = parse(query.limit, 20, 50);
  const offset = parse(query.offset, 0, 10_000);
  return limit !== null && limit >= 1 && offset !== null
    ? { limit, offset }
    : null;
}

function profileInput(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["handle", "displayName", "bio"].includes(key),
    )
  )
    return null;
  const handle = value.handle;
  const displayName = value.displayName;
  const bio = value.bio ?? null;
  if (typeof handle !== "string" || !handlePattern.test(handle)) return null;
  if (
    typeof displayName !== "string" ||
    displayName.trim().length < 1 ||
    displayName.trim().length > 80
  )
    return null;
  if (bio !== null && (typeof bio !== "string" || bio.length > 500))
    return null;
  return { handle, displayName: displayName.trim(), bio };
}

function profileChanges(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    !keys.length ||
    keys.some(
      (key) => !["displayName", "bio", "publicationState"].includes(key),
    )
  )
    return null;
  const changes: {
    displayName?: string;
    bio?: string | null;
    publicationState?: "draft" | "published";
  } = {};
  if ("displayName" in value) {
    if (
      typeof value.displayName !== "string" ||
      value.displayName.trim().length < 1 ||
      value.displayName.trim().length > 80
    )
      return null;
    changes.displayName = value.displayName.trim();
  }
  if ("bio" in value) {
    if (
      value.bio !== null &&
      (typeof value.bio !== "string" || value.bio.length > 500)
    )
      return null;
    changes.bio = value.bio;
  }
  if ("publicationState" in value) {
    if (
      value.publicationState !== "draft" &&
      value.publicationState !== "published"
    )
      return null;
    changes.publicationState = value.publicationState;
  }
  return changes;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export function createIdentityRouter({
  identity,
  recordProductAction,
}: {
  identity: Repository;
  recordProductAction?: ProductActionRecorder;
}) {
  const router = Router();
  const requireParticipant = createRequireRole(identity, ["participant"]);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/profile", async (request, response) => {
    const profile = await identity.getProfile(request.user!.id);
    return profile
      ? response.json({ profile })
      : response.status(404).json({ error: "profile not found" });
  });
  router.post("/profile", requireParticipant, async (request, response) => {
    const input = profileInput(request.body);
    if (!input)
      return response.status(400).json({ error: "invalid profile fields" });
    try {
      const profile = await identity.createProfile(
        request.user!.id,
        input.handle,
        input.displayName,
        input.bio,
      );
      return response.status(201).json({ profile });
    } catch (error) {
      if (isUniqueViolation(error))
        return response
          .status(409)
          .json({ error: "profile or handle already exists" });
      throw error;
    }
  });
  router.patch("/profile", requireParticipant, async (request, response) => {
    const changes = profileChanges(request.body);
    if (!changes)
      return response.status(400).json({ error: "invalid profile fields" });
    const current = await identity.getProfile(request.user!.id);
    if (!current)
      return response.status(404).json({ error: "profile not found" });
    if (current.publicationState === "hidden")
      return response.status(403).json({ error: "profile is restricted" });
    const profile = await identity.updateProfile(request.user!.id, changes);
    return profile
      ? response.json({ profile })
      : response.status(409).json({ error: "profile could not be updated" });
  });

  router.get("/roles", async (request, response) =>
    response.json({ roles: await identity.getRoles(request.user!.id) }),
  );
  router.get("/follows", async (request, response) => {
    const page = pagination(request.query);
    if (!page)
      return response
        .status(400)
        .json({ error: "invalid pagination parameters" });
    return response.json(
      await identity.listFollows(request.user!.id, page.limit, page.offset),
    );
  });
  router.get("/activity", async (request, response) => {
    const page = pagination(request.query);
    if (!page)
      return response
        .status(400)
        .json({ error: "invalid pagination parameters" });
    return response.json(
      await identity.listActivity(request.user!.id, page.limit, page.offset),
    );
  });
  for (const [route, type] of [
    ["/topics/:slug", "topic"],
    ["/people/:slug", "profile"],
  ] as const) {
    router.get(`/follows${route}`, async (request, response) => {
      const slug = request.params.slug;
      if (
        typeof slug !== "string" ||
        !(type === "topic" ? topicPattern : handlePattern).test(slug)
      )
        return response.status(404).json({ error: "resource not found" });
      return response.json({
        following: await identity.isFollowing(request.user!.id, type, slug),
      });
    });
    router.put(
      `/follows${route}`,
      requireParticipant,
      async (request, response) => {
        const slug = request.params.slug;
        if (
          typeof slug !== "string" ||
          !(type === "topic" ? topicPattern : handlePattern).test(slug)
        )
          return response.status(404).json({ error: "resource not found" });
        const result = await identity.follow(request.user!.id, type, slug);
        if (result === "missing")
          return response.status(404).json({ error: "resource not found" });
        if (result === "self")
          return response
            .status(409)
            .json({ error: "cannot follow your own profile" });
        if (result === "created")
          await recordProductAction?.(request, {
            type: "follow_created",
            targetType: type,
            slug,
          });
        return response.status(result === "created" ? 201 : 204).end();
      },
    );
    router.delete(
      `/follows${route}`,
      requireParticipant,
      async (request, response) => {
        const slug = request.params.slug;
        if (
          typeof slug !== "string" ||
          !(type === "topic" ? topicPattern : handlePattern).test(slug)
        )
          return response.status(404).json({ error: "resource not found" });
        await identity.unfollow(request.user!.id, type, slug);
        return response.status(204).end();
      },
    );
  }
  return router;
}

export function createRequireRole(
  identity: Pick<Repository, "getRoles">,
  allowed: readonly string[],
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.user)
      return response.status(401).json({ error: "authentication required" });
    const roles = await identity.getRoles(request.user.id);
    if (!roles.some((role) => allowed.includes(role))) {
      return response.status(403).json({ error: "insufficient role" });
    }
    return next();
  };
}
