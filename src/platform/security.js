import { rateLimit } from "express-rate-limit";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApiRateLimiter({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
}

export function createCsrfOriginProtection({ environment, applicationOrigin }) {
  return function csrfOriginProtection(request, response, next) {
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
