// Worker entry: edge cache (Cache API) around the renderer. Worker responses are
// not cached by Cloudflare on their own, so GET/HEAD pages without a query are
// kept at the edge, keyed by release so a new deploy never serves old HTML.
import { handle } from "./app.mjs";

const BLOB = __DATA_BLOB__;
const RELEASE = __RELEASE__;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cacheable = (request.method === "GET" || request.method === "HEAD") && !url.search && typeof caches !== "undefined";
    if (!cacheable) return handle(request, BLOB, RELEASE);
    const key = new Request(`${url.origin}${url.pathname}?__rel=${RELEASE}`, { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) {
      if (request.method === "HEAD") return new Response(null, { status: hit.status, headers: hit.headers });
      return hit;
    }
    const res = await handle(new Request(request.url, { method: "GET", headers: request.headers }), BLOB, RELEASE);
    if (res.status === 200 || res.status === 301) {
      const copy = res.clone();
      ctx?.waitUntil?.(cache.put(key, copy));
    }
    if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
    return res;
  },
};
