// Build dist/worker.mjs: bundle src/ with the provider table embedded
// (data/providers.json → gzip → base64). One self-contained ES module.
//   node scripts/build-worker.mjs
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const MAX = 9_500_000;
const data = fs.readFileSync("data/providers.json");
JSON.parse(data); // fail early on broken data
const blob = gzipSync(data, { level: 9 }).toString("base64");
let commit = "local";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
const release = createHash("sha256").update(fs.readFileSync("src/app.mjs")).update(fs.readFileSync("src/entry.mjs")).update(data).digest("hex").slice(0, 16);
const site = JSON.parse(fs.readFileSync("site.json", "utf8"));
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/entry.mjs"], outfile: "dist/worker.mjs", bundle: true, format: "esm", platform: "neutral", minify: true,
  define: { __DATA_BLOB__: JSON.stringify(blob), __RELEASE__: JSON.stringify(release) },
  plugins: [{
    name: "site-values",
    setup(b) {
      b.onLoad({ filter: /src[\\/]app\.mjs$/ }, (a) => ({
        loader: "js",
        contents: fs.readFileSync(a.path, "utf8").replace("__GA4__", site.ga4_measurement_id || "").replace("__INDEXNOW_KEY__", site.indexnow_key || ""),
      }));
    },
  }],
});
const size = fs.statSync("dist/worker.mjs").size;
fs.writeFileSync("dist/build.json", JSON.stringify({ commit, release, size, data_bytes: data.length, built_at: new Date().toISOString() }, null, 2));
console.log(`dist/worker.mjs ${size.toLocaleString()} bytes (${Math.round((size / MAX) * 100)}% of limit), release ${release}`);
if (size > MAX) { console.error("Worker over the size limit"); process.exit(1); }
