// An in-process OpenID Connect issuer for callback tests and local browser
// checks (Decision 0009, point 10). It signs RS256 ID tokens with a real key,
// publishes the JWK set, checks PKCE and client credentials at the token
// endpoint, and lets the caller choose who "signs in" and how the token is
// tampered with. It never runs in a deployed service.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { html } from "../dist/platform/html.js";

export type TestIdentity = {
  subject: string;
  email: string;
  emailVerified?: boolean;
  authTime?: number;
};
export type Tamper = {
  state?: string;
  foreignKey?: boolean;
  claims?: Record<string, unknown>;
};
type Code = {
  redirectUri: string;
  codeChallenge: string;
  signWith: KeyObject | undefined;
  claims: Record<string, unknown>;
};

const base64url = (value: string) => Buffer.from(value).toString("base64url");
export async function startIssuer({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}) {
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "issuer-key";
  const codes = new Map<string, Code>();
  const requests: Record<string, string>[] = [];
  const logouts: URL[] = [];
  let available = true;
  let tokenCalls = 0;
  // The identity the browser sign-in page completes with.
  let next: TestIdentity | undefined;

  function sign(claims: Record<string, unknown>, key = signing.privateKey) {
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64url(JSON.stringify(claims));
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(key)
      .toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  function issueCode(
    parameters: Record<string, string>,
    identity: TestIdentity,
    tamper: Tamper = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      redirectUri: parameters.redirect_uri!,
      codeChallenge: parameters.code_challenge!,
      signWith: tamper.foreignKey ? stranger.privateKey : undefined,
      claims: {
        iss: issuer,
        aud: clientId,
        sub: identity.subject,
        email: identity.email,
        email_verified: identity.emailVerified ?? true,
        iat: now,
        exp: now + 600,
        auth_time: identity.authTime ?? now,
        nonce: parameters.nonce,
        ...tamper.claims,
      },
    });
    const callback = new URL(parameters.redirect_uri!);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", tamper.state ?? parameters.state!);
    return callback;
  }

  async function body(request: IncomingMessage) {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    return new URLSearchParams(raw);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", issuer);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const redirect = (target: URL | string) => {
      response.writeHead(302, { Location: String(target) });
      response.end();
    };
    if (!available) return json(503, { error: "temporarily_unavailable" });
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}oauth/token`,
        jwks_uri: `${issuer}.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    if (url.pathname === "/.well-known/jwks.json")
      return json(200, {
        keys: [
          {
            ...signing.publicKey.export({ format: "jwk" }),
            kid,
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    // A minimal stand-in for Universal Login, for browser checks.
    if (url.pathname === "/authorize" && request.method === "GET") {
      const parameters = Object.fromEntries(url.searchParams);
      requests.push(parameters);
      const fields = Object.entries(parameters).map(
        ([key, value]) =>
          html`<input type="hidden" name="${key}" value="${value}">`,
      );
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(
        html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test identity provider</title></head><body><main><h1>Test identity provider</h1><p data-connection>${parameters.connection ?? "any"}</p><p data-login-hint>${parameters.login_hint ?? ""}</p><form method="post" action="/authorize/complete">${fields}<button name="decision" value="allow">Sign in</button><button name="decision" value="deny">Cancel</button></form></main></body></html>`.toString(),
      );
    }
    if (url.pathname === "/authorize/complete" && request.method === "POST") {
      const parameters = Object.fromEntries(await body(request));
      const callback = new URL(parameters.redirect_uri!);
      if (parameters.decision !== "allow" || !next) {
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("state", parameters.state!);
        return redirect(callback);
      }
      return redirect(issueCode(parameters, next));
    }
    if (url.pathname === "/v2/logout") {
      logouts.push(url);
      return redirect(url.searchParams.get("returnTo") ?? "/");
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      tokenCalls += 1;
      const form = await body(request);
      const code = form.get("code") ?? "";
      const entry = codes.get(code);
      codes.delete(code);
      if (
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret
      )
        return json(401, { error: "invalid_client" });
      if (
        !entry ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("redirect_uri") !== entry.redirectUri ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== entry.codeChallenge
      )
        return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: randomBytes(16).toString("hex"),
        token_type: "Bearer",
        expires_in: 3600,
        id_token: sign(entry.claims, entry.signWith),
      });
    }
    return json(404, { error: "not_found" });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  function parse(authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    if (`${url.origin}/` !== issuer || url.pathname !== "/authorize")
      throw new Error(`not an authorization request: ${authorizationUrl}`);
    const parameters = Object.fromEntries(url.searchParams);
    requests.push(parameters);
    return parameters;
  }

  return {
    issuer,
    requests,
    logouts,
    get tokenCalls() {
      return tokenCalls;
    },
    setAvailable(value: boolean) {
      available = value;
    },
    // Who completes the next browser sign-in on the provider page.
    setNext(identity: TestIdentity | undefined) {
      next = identity;
    },
    // Simulates the person completing sign-in at the provider. Returns the
    // callback path and query the browser would follow.
    authorize(
      authorizationUrl: string,
      identity: TestIdentity,
      tamper?: Tamper,
    ) {
      const callback = issueCode(parse(authorizationUrl), identity, tamper);
      return callback.pathname + callback.search;
    },
    deny(authorizationUrl: string) {
      const parameters = parse(authorizationUrl);
      const callback = new URL(parameters.redirect_uri!);
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "cancelled");
      callback.searchParams.set("state", parameters.state!);
      return callback.pathname + callback.search;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
export type TestIssuer = Awaited<ReturnType<typeof startIssuer>>;
