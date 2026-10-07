/* global caches */
// R2 bucket is private. Every request is authorized before consulting the cache.
const types = {
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  vtt: "text/vtt",
};
const pathPattern =
  /^debates\/[0-9a-f-]{36}\/[a-zA-Z0-9-]+\/hls\/(?:master\.m3u8|captions\.vtt|(?:240|480|720)\/(?:index\.m3u8|segment\d{5}\.ts))$/;
const decode = (value) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

export async function authorized(access, path, secret, now = Date.now()) {
  try {
    if (!secret || secret.length < 32 || !access || access.length > 1024)
      return false;
    const [payload, signature, extra] = access.split(".");
    if (!payload || !signature || extra) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(signature),
        new TextEncoder().encode(payload),
      ))
    )
      return false;
    const claim = JSON.parse(new TextDecoder().decode(decode(payload)));
    const seconds = Math.floor(now / 1000);
    return (
      typeof claim.prefix === "string" &&
      path.startsWith(claim.prefix) &&
      /^debates\/[0-9a-f-]{36}\/[a-zA-Z0-9-]+\/hls\/$/.test(claim.prefix) &&
      Number.isInteger(claim.exp) &&
      claim.exp > seconds &&
      claim.exp <= seconds + 300
    );
  } catch {
    return false;
  }
}

export function rewritePlaylist(body, requestUrl) {
  const url = new URL(requestUrl);
  const signed = (relative) => {
    if (
      !/^(?:master\.m3u8|captions\.vtt|(?:240|480|720)\/index\.m3u8|segment\d{5}\.ts)$/.test(
        relative,
      )
    )
      throw new Error("unsupported playlist URI");
    const child = new URL(relative, url);
    child.search = url.search;
    return child.href;
  };
  return body
    .split("\n")
    .map((line) => {
      if (!line || line.startsWith("#"))
        return line.replace(
          /URI="([^"]+)"/g,
          (_match, uri) => `URI="${signed(uri)}"`,
        );
      return signed(line.trim());
    })
    .join("\n");
}

export async function serveReplay(
  request,
  env,
  context,
  cache = caches.default,
) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": env.APP_ORIGIN,
    Vary: "Origin",
  };
  const deny = (status) => new Response(null, { status, headers });
  if (origin && origin !== env.APP_ORIGIN) return deny(403);
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers":
          "Content-Range, Accept-Ranges, Content-Length",
      },
    });
  if (!["GET", "HEAD"].includes(request.method)) return deny(405);
  const path = url.pathname.slice(1);
  if (
    !pathPattern.test(path) ||
    !(await authorized(
      url.searchParams.get("access"),
      path,
      env.REPLAY_SIGNING_SECRET,
    ))
  )
    return deny(403);
  const extension = path.split(".").at(-1);
  const range = request.headers.get("Range");
  if (range && !/^bytes=\d+-\d*$/.test(range)) return deny(416);
  const cacheKey = new Request(`${url.origin}/${path}`);
  // Only immutable segments are shared in the edge cache. Signed playlists and
  // reviewed captions never enter a public/shared response cache.
  let objectResponse =
    extension === "ts" && !range ? await cache.match(cacheKey) : null;
  if (!objectResponse) {
    const object = await env.REPLAY_BUCKET.get(
      path,
      range ? { range: request.headers } : undefined,
    );
    if (!object) return deny(404);
    const objectHeaders = new Headers({
      "Content-Type": types[extension],
      "Accept-Ranges": "bytes",
    });
    let status = 200;
    if (range) {
      if (
        !object.range ||
        !("offset" in object.range) ||
        !("length" in object.range)
      )
        return deny(416);
      status = 206;
      objectHeaders.set(
        "Content-Range",
        `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      );
      objectHeaders.set("Content-Length", String(object.range.length));
    } else objectHeaders.set("Content-Length", String(object.size));
    objectResponse = new Response(object.body, {
      status,
      headers: objectHeaders,
    });
    if (extension === "ts" && !range) {
      const cached = objectResponse.clone();
      cached.headers.set(
        "Cache-Control",
        "public, max-age=31536000, immutable",
      );
      context.waitUntil(cache.put(cacheKey, cached));
    }
  }
  const outputHeaders = new Headers(objectResponse.headers);
  for (const [key, value] of Object.entries(headers))
    outputHeaders.set(key, value);
  outputHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length",
  );
  let body = objectResponse.body;
  if (extension === "m3u8") {
    const playlist = await objectResponse.text();
    if (playlist.length > 256_000) return deny(502);
    try {
      body = rewritePlaylist(playlist, request.url);
    } catch {
      return deny(502);
    }
    outputHeaders.delete("Content-Length");
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: objectResponse.status,
    headers: outputHeaders,
  });
}

export default { fetch: serveReplay };
