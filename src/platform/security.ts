import { rateLimit } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApiRateLimiter({
  windowMs,
  limit,
  skip,
}: {
  windowMs: number;
  limit: number;
  skip?: (request: Request) => boolean;
}) {
  return rateLimit({
    windowMs,
    limit,
    skip,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
}

export function createCsrfOriginProtection({
  environment,
  applicationOrigin,
}: {
  environment: string;
  applicationOrigin?: string;
}) {
  return function csrfOriginProtection(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    if (environment !== "production" || safeMethods.has(request.method)) {
      return next();
    }

    if (!request.headers.cookie) {
      return next();
    }

    if (request.get("origin") !== applicationOrigin) {
      return response
        .status(403)
        .json({ error: "request origin is not allowed" });
    }

    return next();
  };
}
