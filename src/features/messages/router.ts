import express from "express";
import type { createMessageRepository } from "./repository.ts";

export function createMessageRouter({
  messages,
}: {
  messages: ReturnType<typeof createMessageRepository>;
}) {
  const router = express.Router();

  router.post("/", async (request, response) => {
    const { name } = request.body ?? {};
    const normalizedName = typeof name === "string" ? name.trim() : "";

    if (normalizedName.length < 1 || normalizedName.length > 80) {
      return response.status(400).json({
        error: "name must be between 1 and 80 characters",
      });
    }

    const message = `Hello, ${normalizedName}!`;
    const createdMessage = await messages.create(
      request.user!.id,
      normalizedName,
      message,
    );

    return response.status(201).json(createdMessage);
  });

  router.get("/", async (request, response) => {
    const limit = Number(request.query.limit ?? 20);
    const offset = Number(request.query.offset ?? 0);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return response.status(400).json({
        error: "limit must be an integer between 1 and 100",
      });
    }

    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      return response.status(400).json({
        error: "offset must be an integer between 0 and 10000",
      });
    }

    const items = await messages.list({
      userId: request.user!.id,
      limit,
      offset,
    });

    return response.json({
      items,
      pagination: { limit, offset },
    });
  });

  return router;
}
