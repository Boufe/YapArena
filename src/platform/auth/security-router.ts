import express from "express";
import type { Request, RequestHandler } from "express";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  AccountOperationError,
  type AccountOperationCredential,
  type createAccountOperationRepository,
} from "./account-operations.ts";
import type { createSecurityPasskeyRepository } from "./security-passkeys.ts";
import type { createSessionRepository } from "./sessions.ts";
import { SessionUnavailableError } from "./sessions.ts";
import { createRequireAuthentication, getCookieSettings } from "./router.ts";
import { hashSessionToken } from "./session-tokens.ts";
import { createApiRateLimiter } from "../security.ts";
import type {
  createProviderWalletOperations,
  ProviderWalletTarget,
} from "./provider-wallet-operations.ts";
import { normalizeWalletAddress, validChainId } from "./siwe.ts";
import type { createLegacyProviderLink } from "./legacy-provider-link.ts";
import type { createAccountAccessRepository } from "./account-access.ts";
import type { createProviderIdentityRecovery } from "./provider-identity-recovery.ts";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}
function encoded(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32768 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
function invalid(): never {
  throw new AccountOperationError(400, "invalid security operation");
}

function registration(value: unknown): RegistrationResponseJSON {
  const body = object(value),
    response = object(body?.response);
  if (
    !body ||
    !response ||
    body.type !== "public-key" ||
    !encoded(body.id) ||
    !encoded(body.rawId) ||
    !encoded(response.clientDataJSON) ||
    !encoded(response.attestationObject)
  )
    invalid();
  return {
    id: body.id,
    rawId: body.rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: response.clientDataJSON,
      attestationObject: response.attestationObject,
    },
  };
}
function authentication(value: unknown): AuthenticationResponseJSON {
  const body = object(value),
    response = object(body?.response);
  if (
    !body ||
    !response ||
    body.type !== "public-key" ||
    !encoded(body.id) ||
    !encoded(body.rawId) ||
    !encoded(response.clientDataJSON) ||
    !encoded(response.authenticatorData) ||
    !encoded(response.signature) ||
    (response.userHandle !== undefined &&
      response.userHandle !== null &&
      !encoded(response.userHandle))
  )
    invalid();
  return {
    id: body.id,
    rawId: body.rawId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: response.clientDataJSON,
      authenticatorData: response.authenticatorData,
      signature: response.signature,
      ...(typeof response.userHandle === "string"
        ? { userHandle: response.userHandle }
        : {}),
    },
  };
}
export function parseAccountOperationCredential(
  value: unknown,
): AccountOperationCredential {
  const body = object(value);
  if (!body) invalid();
  if (body.type === "password" && exact(body, ["type"]))
    return { type: "password" };
  if (
    body.type === "wallet" &&
    uuid(body.walletId) &&
    exact(body, ["type", "walletId"])
  )
    return { type: "wallet", walletId: body.walletId };
  if (
    body.type === "passkey" &&
    uuid(body.keyId) &&
    exact(body, ["type", "keyId"])
  )
    return { type: "passkey", keyId: body.keyId };
  invalid();
}
export function parseAccountOperationApproval(value: unknown) {
  const body = object(value);
  if (
    !body ||
    !uuid(body.id) ||
    !exact(body, ["id", "password", "signature", "authentication"]) ||
    (body.password !== undefined &&
      (typeof body.password !== "string" || body.password.length > 1024)) ||
    (body.signature !== undefined &&
      (typeof body.signature !== "string" || body.signature.length > 8194))
  )
    invalid();
  return {
    id: body.id,
    ...(typeof body.password === "string" ? { password: body.password } : {}),
    ...(typeof body.signature === "string"
      ? { signature: body.signature }
      : {}),
    ...(body.authentication !== undefined
      ? { authentication: authentication(body.authentication) }
      : {}),
  };
}
const credential = parseAccountOperationCredential;
const proof = parseAccountOperationApproval;
function walletTarget(body: Record<string, unknown>): ProviderWalletTarget {
  const address = normalizeWalletAddress(body.address);
  if (
    !address ||
    !validChainId(body.chainId) ||
    (body.purpose !== "link" && body.purpose !== "unlink") ||
    (body.purpose === "unlink" && !uuid(body.targetWalletId)) ||
    (body.purpose === "link" && body.targetWalletId !== undefined)
  )
    invalid();
  return {
    purpose: body.purpose,
    address,
    chainId: body.chainId,
    ...(typeof body.targetWalletId === "string"
      ? { targetWalletId: body.targetWalletId }
      : {}),
  };
}
function providerToken(request: Request) {
  const header = request.get("authorization");
  if (
    !header?.startsWith("Bearer ") ||
    header.length <= 7 ||
    header.length > 12000
  )
    throw new AccountOperationError(401, "provider authentication required");
  return header.slice(7);
}
function providerChange(value: unknown): Record<string, string> {
  const terms = object(value);
  if (
    !terms ||
    !exact(terms, ["action", "method", "target"]) ||
    !["link", "remove", "update"].includes(String(terms.action)) ||
    !["email", "google_oauth", "passkey"].includes(String(terms.method)) ||
    typeof terms.target !== "string" ||
    !terms.target.length ||
    terms.target.length > 2048 ||
    (terms.action === "update" && terms.method !== "email")
  )
    invalid();
  return {
    action: String(terms.action),
    method: String(terms.method),
    target: terms.target,
  };
}

export type SecurityRouterOptions = {
  sessions: ReturnType<typeof createSessionRepository>;
  operations: ReturnType<typeof createAccountOperationRepository>;
  passkeys: ReturnType<typeof createSecurityPasskeyRepository>;
  walletOperations?: ReturnType<typeof createProviderWalletOperations>;
  legacyProviderLink?: ReturnType<typeof createLegacyProviderLink>;
  providerIdentityRecovery?: ReturnType<typeof createProviderIdentityRecovery>;
  access?: ReturnType<typeof createAccountAccessRepository>;
  environment: string;
  applicationOrigin: string;
  sessionDurationMs?: number;
  siweRpcUrls?: Readonly<Record<string, string>>;
  sharedAccountLimiter?: RequestHandler;
  sharedAccessLimiter?: RequestHandler;
};

export function createAccountSecurityRouter({
  sessions,
  operations,
  passkeys,
  walletOperations,
  legacyProviderLink,
  providerIdentityRecovery,
  access,
  environment,
  applicationOrigin,
  sessionDurationMs = 604800000,
  siweRpcUrls = {},
  sharedAccountLimiter,
  sharedAccessLimiter,
}: SecurityRouterOptions) {
  const router = express.Router(),
    cookie = getCookieSettings(environment);
  const session = (request: Request) => {
    const token: unknown = request.cookies[cookie.name];
    if (!request.user || typeof token !== "string")
      throw new AccountOperationError(401, "authentication required");
    return {
      userId: request.user.id,
      sessionTokenHash: hashSessionToken(token),
      origin: applicationOrigin,
    };
  };
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  router.use((request, response, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.get("origin") !== applicationOrigin
    )
      return response
        .status(403)
        .json({ error: "request origin is not allowed" });
    return next();
  });
  if (access) {
    const publicAccess = express.Router();
    publicAccess.use(
      "/security/access",
      createApiRateLimiter({ windowMs: 900000, limit: 30 }),
    );
    if (sharedAccessLimiter)
      publicAccess.use("/security/access", sharedAccessLimiter);
    publicAccess.post("/security/access/login", async (request, response) => {
      const body = object(request.body);
      if (!body || Object.keys(body).length) invalid();
      return response.json(
        await access.loginOptions({ origin: applicationOrigin }),
      );
    });
    publicAccess.post(
      "/security/access/login/:id/complete",
      async (request, response) => {
        const body = object(request.body),
          id = request.params.id;
        if (!body || !uuid(id) || !exact(body, ["authentication"])) invalid();
        const result = await access.login({
          id,
          authentication: authentication(body.authentication),
          origin: applicationOrigin,
          sessionDurationMs,
        });
        response.cookie(cookie.name, result.token, {
          ...cookie.options,
          maxAge: sessionDurationMs,
        });
        return response.status(204).end();
      },
    );
    publicAccess.post(
      "/security/access/reconciliation/candidate",
      async (request, response) => {
        const body = object(request.body);
        if (!body || Object.keys(body).length) invalid();
        return response.json(
          await access.reconciliationCandidate(providerToken(request)),
        );
      },
    );
    publicAccess.post(
      "/security/access/reconciliation",
      async (request, response) => {
        const body = object(request.body);
        if (!body || !exact(body, ["credential"])) invalid();
        return response.json(
          await access.reconciliationOptions({
            token: providerToken(request),
            credential: credential(body.credential),
            origin: applicationOrigin,
          }),
        );
      },
    );
    publicAccess.post(
      "/security/access/reconciliation/:id/complete",
      async (request, response) => {
        const body = object(request.body),
          id = request.params.id;
        if (!body || !uuid(id) || !exact(body, ["approval"])) invalid();
        const approval = proof(body.approval);
        if (approval.id !== id) invalid();
        const result = await access.reconcile({
          ...approval,
          token: providerToken(request),
          origin: applicationOrigin,
          rpcUrls: siweRpcUrls,
          sessionDurationMs,
        });
        response.cookie(cookie.name, result.token, {
          ...cookie.options,
          maxAge: sessionDurationMs,
        });
        return response.status(204).end();
      },
    );
    router.use(publicAccess);
  }
  router.use(createRequireAuthentication({ sessions, environment }));
  const mutations = express.Router();
  mutations.use(createApiRateLimiter({ windowMs: 900000, limit: 30 }));
  if (sharedAccountLimiter) mutations.use(sharedAccountLimiter);
  router.get("/security/passkeys", async (request, response) =>
    response.json({ passkeys: await passkeys.list(session(request).userId) }),
  );
  mutations.post("/security/passkeys/enrollment", async (request, response) => {
    const body = object(request.body);
    if (!body || Object.keys(body).length) invalid();
    return response.json(await passkeys.enrollmentOptions(session(request)));
  });
  mutations.post("/security/operations", async (request, response) => {
    const body = object(request.body),
      terms = object(body?.terms);
    if (!body || !terms || !exact(body, ["purpose", "terms", "credential"]))
      invalid();
    const key =
      body.purpose === "security.passkey.enroll"
        ? "challengeId"
        : body.purpose === "security.passkey.remove"
          ? "keyId"
          : null;
    const exactTerms =
      body.purpose === "provider.credentials.change"
        ? providerChange(terms)
        : key && uuid(terms[key]) && exact(terms, [key])
          ? { [key]: terms[key] }
          : null;
    if (!exactTerms) invalid();
    const operation = await operations.create({
      ...session(request),
      purpose: String(body.purpose),
      terms: exactTerms,
      credential: credential(body.credential),
    });
    return response.json({
      id: operation.id,
      expiresAt: operation.expiresAt,
      authorizationMessage: operation.authorizationMessage,
      authenticationOptions: operation.authenticationOptions,
    });
  });
  mutations.post("/security/provider/change", async (request, response) => {
    const body = object(request.body);
    if (!body || !exact(body, ["terms", "approval"])) invalid();
    await operations.authorize({
      ...session(request),
      ...proof(body.approval),
      purpose: "provider.credentials.change",
      terms: providerChange(body.terms),
      rpcUrls: siweRpcUrls,
      requestId: String(request.id),
    });
    return response.status(204).end();
  });
  mutations.post(
    "/security/passkeys/enrollment/:id/complete",
    async (request, response) => {
      const body = object(request.body),
        id = request.params.id;
      if (!body || !uuid(id) || !exact(body, ["response", "approval"]))
        invalid();
      const context = session(request);
      const approval =
        body.approval === undefined
          ? undefined
          : await operations.prepare({
              ...context,
              ...proof(body.approval),
              purpose: "security.passkey.enroll",
              terms: { challengeId: id },
              rpcUrls: siweRpcUrls,
              requestId: String(request.id),
            });
      const result = await passkeys.completeEnrollment({
        ...context,
        id,
        response: registration(body.response),
        sessionDurationMs,
        approval,
      });
      response.cookie(cookie.name, result.token, {
        ...cookie.options,
        maxAge: sessionDurationMs,
      });
      return response.json({ keyId: result.keyId });
    },
  );
  mutations.delete("/security/passkeys/:id", async (request, response) => {
    const body = object(request.body),
      keyId = request.params.id;
    if (!body || !uuid(keyId) || !exact(body, ["approval"])) invalid();
    const context = session(request);
    const approval = await operations.prepare({
      ...context,
      ...proof(body.approval),
      purpose: "security.passkey.remove",
      terms: { keyId },
      rpcUrls: siweRpcUrls,
      requestId: String(request.id),
    });
    const result = await passkeys.remove({
      ...context,
      keyId,
      sessionDurationMs,
      approval,
    });
    response.cookie(cookie.name, result.token, {
      ...cookie.options,
      maxAge: sessionDurationMs,
    });
    return response.status(204).end();
  });
  if (walletOperations) {
    mutations.post("/security/wallet/operations", async (request, response) => {
      const body = object(request.body);
      if (
        !body ||
        !exact(body, [
          "purpose",
          "address",
          "chainId",
          "targetWalletId",
          "credential",
        ])
      )
        invalid();
      return response.json(
        await walletOperations.create({
          ...session(request),
          ...walletTarget(body),
          credential: credential(body.credential),
        }),
      );
    });
    mutations.post(
      "/security/wallet/operations/:id/complete",
      async (request, response) => {
        const body = object(request.body),
          id = request.params.id;
        if (
          !body ||
          !uuid(id) ||
          !exact(body, [
            "purpose",
            "address",
            "chainId",
            "targetWalletId",
            "approval",
            "proposedSignature",
          ]) ||
          (body.proposedSignature !== undefined &&
            (typeof body.proposedSignature !== "string" ||
              body.proposedSignature.length > 8194))
        )
          invalid();
        const approval = proof(body.approval);
        if (approval.id !== id) invalid();
        const result = await walletOperations.complete({
          ...session(request),
          ...walletTarget(body),
          ...approval,
          ...(typeof body.proposedSignature === "string"
            ? { proposedSignature: body.proposedSignature }
            : {}),
          rpcUrls: siweRpcUrls,
          sessionDurationMs,
          requestId: String(request.id),
        });
        response.cookie(cookie.name, result.token, {
          ...cookie.options,
          maxAge: sessionDurationMs,
        });
        return response.json({ wallet: result.wallet });
      },
    );
  }
  if (legacyProviderLink) {
    mutations.post(
      "/security/provider/candidate",
      async (request, response) => {
        const body = object(request.body);
        if (!body || Object.keys(body).length) invalid();
        return response.json(
          await legacyProviderLink.candidate(
            session(request).userId,
            providerToken(request),
          ),
        );
      },
    );
    mutations.post("/security/provider/link", async (request, response) => {
      const body = object(request.body);
      if (!body || !exact(body, ["credential"])) invalid();
      return response.json(
        await legacyProviderLink.create({
          ...session(request),
          token: providerToken(request),
          credential: credential(body.credential),
        }),
      );
    });
    mutations.post(
      "/security/provider/link/:id/complete",
      async (request, response) => {
        const body = object(request.body),
          id = request.params.id;
        if (!body || !uuid(id) || !exact(body, ["approval"])) invalid();
        const approval = proof(body.approval);
        if (approval.id !== id) invalid();
        const result = await legacyProviderLink.complete({
          ...session(request),
          ...approval,
          token: providerToken(request),
          rpcUrls: siweRpcUrls,
          sessionDurationMs,
          requestId: String(request.id),
        });
        response.cookie(cookie.name, result.token, {
          ...cookie.options,
          maxAge: sessionDurationMs,
        });
        return response.status(204).end();
      },
    );
  }
  if (providerIdentityRecovery) {
    mutations.post(
      "/security/provider/recovery/candidate",
      async (request, response) => {
        const body = object(request.body);
        if (!body || Object.keys(body).length) invalid();
        return response.json(
          await providerIdentityRecovery.candidate(
            session(request).userId,
            providerToken(request),
          ),
        );
      },
    );
    mutations.post("/security/provider/recovery", async (request, response) => {
      const body = object(request.body);
      if (!body || !exact(body, ["credential"])) invalid();
      const selected = credential(body.credential);
      if (selected.type !== "passkey") invalid();
      return response.json(
        await providerIdentityRecovery.create({
          ...session(request),
          token: providerToken(request),
          credential: selected,
        }),
      );
    });
    mutations.post(
      "/security/provider/recovery/:id/complete",
      async (request, response) => {
        const body = object(request.body),
          id = request.params.id;
        if (!body || !uuid(id) || !exact(body, ["approval"])) invalid();
        const approval = proof(body.approval);
        if (
          approval.id !== id ||
          !approval.authentication ||
          approval.password !== undefined ||
          approval.signature !== undefined
        )
          invalid();
        const result = await providerIdentityRecovery.complete({
          ...session(request),
          ...approval,
          token: providerToken(request),
          rpcUrls: siweRpcUrls,
          sessionDurationMs,
          requestId: String(request.id),
        });
        response.cookie(cookie.name, result.token, {
          ...cookie.options,
          maxAge: sessionDurationMs,
        });
        return response.status(204).end();
      },
    );
  }
  router.use(mutations);
  router.use(
    (
      error: unknown,
      _request: Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof AccountOperationError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof SessionUnavailableError)
        return response.status(401).json({ error: "authentication required" });
      if (object(error)?.code === "23505")
        return response
          .status(409)
          .json({ error: "this passkey is already registered" });
      return next(error);
    },
  );
  return router;
}
