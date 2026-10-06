// Smoke test of dist/worker.mjs in Node: every page type answers with content.
//   node scripts/test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

globalThis.caches = undefined; // no edge cache in Node
const worker = (await import(new URL("../dist/worker.mjs", import.meta.url))).default;
const data = JSON.parse(fs.readFileSync("data/providers.json", "utf8"));
const H = "https://providers.navi-index.com";
const get = async (p, init) => worker.fetch(new Request(H + p, init), {}, {});

const active = data.rows.filter((r) => r[15] === 0 && r[7] && r[8]);
const sample = [active[0], active[Math.floor(active.length / 2)], active[active.length - 1]];
const withSlug = data.rows.find((r) => r[16]);
const checks = [];
async function expect(path, status, contains = []) {
  const r = await get(path);
  const body = await r.text();
  assert.equal(r.status, status, `${path} status ${r.status}`);
  for (const c of contains) assert.ok(body.includes(c), `${path} lacks ${c}`);
  checks.push(path);
  return { r, body };
}

const home = await expect("/", 200, ["NPI Provider Index", "application/ld+json", "/specialty/"]);
assert.ok(!/[぀-ヿ一-鿿]/.test(home.body), "Japanese text on an English page");
for (const p of ["/specialties/", "/states/", "/about/", "/search/?q=dental"]) await expect(p, 200);
for (const r of sample) {
  const { body } = await expect(`/provider/${r[0]}/`, 200, [r[0], "PostalAddress", "application/ld+json"]);
  assert.ok(body.includes("Practice address"));
}
await expect("/specialty/dentist/", 200, ["Dentists in the United States"]);
await expect("/specialty/dentist/tx/", 200, ["Dentists in Texas"]);
await expect("/state/ca/", 200, ["California"]);
const c = data.rows.find((r) => r[8] === "TX" && r[7] === "Houston");
if (c) await expect("/state/tx/houston/", 200, ["Houston"]);
await expect("/robots.txt", 200, ["Sitemap:", "GPTBot"]);
const rob = await (await get("/robots.txt")).text();
assert.ok(!/User-agent: OAI-SearchBot/.test(rob) && !/User-agent: ChatGPT-User/.test(rob));
await expect("/llms.txt", 200, ["## API"]);
const sm = await expect("/sitemap.xml", 200, ["sitemapindex"]);
let urls = 0;
for (const loc of [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(H, ""))) {
  const t = await (await get(loc)).text();
  urls += (t.match(/<url>/g) || []).length;
}
const api = await (await get("/api/providers?limit=5")).json();
assert.equal(api.items.length, 5);
const one = await (await get(`/api/providers/${sample[0][0]}`)).json();
assert.equal(one.npi, sample[0][0]);
await expect("/api/collection-status", 200, ["last_ok_at"]);
if (withSlug) {
  const r = await get(`/p/${withSlug[16]}`);
  assert.equal(r.status, 301); assert.equal(r.headers.get("location"), `/provider/${withSlug[0]}/`);
}
assert.equal((await get("/specialty/dentist")).status, 301);
await expect("/no-such-page/", 404);
assert.equal((await get("/", { method: "HEAD" })).status, 200);
console.log(`ok ${checks.length} paths; sitemap urls=${urls}; active=${active.length}; api total=${api.total}`);
