#!/usr/bin/env python3
"""Publish dist/worker.mjs to the portal Cloudflare account through Grantry (no raw key).

Runs on the fleet machine (needs /workspace/agent-loop/grantry_mcp.py).

    npm ci && npm test && python3 scripts/deploy.py [--attach-domain] [--dry-run]

Steps: upload metadata + worker → PUT the Worker script → (first time) attach
providers.navi-index.com as the Worker's custom domain → read production back and
compare the provider count and release with dist/build.json.
"""
import argparse, json, os, pathlib, subprocess, sys, time, urllib.request

sys.path.insert(0, os.environ.get("GRANTRY_MCP_DIR", "/workspace/agent-loop"))
from grantry_mcp import Grantry  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE = json.loads((ROOT / "site.json").read_text())
CF = SITE["cloudflare"]
ACCOUNT, SCOPE, ZONE, SCRIPT, HOST = CF["account"], CF["grantry_scope"], CF["zone_id"], CF["worker"], SITE["host"]


def call(g, tool, args, tries=3):
    last = ""
    for i in range(tries):
        try:
            r = g.call(tool, args)
            if isinstance(r, dict) and "content" in r:
                t = r["content"][0]["text"]
                try:
                    return json.loads(t)
                except Exception:
                    return {"text": t}
            return r
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        print(f"{tool}: {last[:300]} — retry", file=sys.stderr)
        time.sleep(3)
    sys.exit(f"{tool} failed 3 times: {last[:300]}")


def upload(g, path, ctype):
    for _ in range(3):
        up = call(g, "grantry_create_upload_url", {"max_uses": 2, "ttl_seconds": 900})
        if isinstance(up, dict) and up.get("upload_url"):
            r = subprocess.run(["curl", "-sS", "-F", f"file=@{path};type={ctype}", up["upload_url"]], capture_output=True, text=True)
            try:
                return json.loads(r.stdout)["file_id"]
            except (ValueError, KeyError):
                print(f"upload {path.name} failed: {r.stdout[:200]} {r.stderr[:200]}", file=sys.stderr)
        time.sleep(3)
    sys.exit(f"could not upload {path}")


def fetch(path, ua="Mozilla/5.0"):
    req = urllib.request.Request(f"https://{HOST}{path}", headers={"User-Agent": ua, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, dict(r.headers), r.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--attach-domain", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    worker = ROOT / "dist" / "worker.mjs"
    build = json.loads((ROOT / "dist" / "build.json").read_text())
    meta = ROOT / "dist" / "metadata.json"
    meta.write_text(json.dumps({"main_module": "worker.mjs", "compatibility_date": "2026-09-24"}))
    print(f"worker {build['size']:,} bytes, release {build['release']}")
    if a.dry_run:
        return 0
    g = Grantry()
    ids = {n: upload(g, p, t) for n, p, t in (("metadata.json", meta, "application/json"), ("worker.mjs", worker, "application/javascript+module"))}
    res = call(g, "cloudflare_request", {
        "scope": SCOPE, "method": "PUT", "path": f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", "timeout_ms": 120000,
        "files": [{"field": "metadata", "file_id": ids["metadata.json"], "content_type": "application/json", "filename": "metadata.json"},
                  {"field": "worker.mjs", "file_id": ids["worker.mjs"], "content_type": "application/javascript+module", "filename": "worker.mjs"}]})
    if res.get("status") != 200:
        sys.exit(f"Worker upload failed: {json.dumps(res)[:400]}")
    print("worker uploaded")
    if a.attach_domain:
        recs = call(g, "cloudflare_list_dns_records", {"scope": SCOPE, "zone_id": ZONE, "name": HOST})
        for r in recs.get("results", []):
            if r["type"] in ("A", "AAAA", "CNAME") and not (r.get("meta") or {}).get("origin_worker_id"):
                sys.exit(f"{HOST} already has a {r['type']} record ({r['content']}); not touching it")
        dom = call(g, "cloudflare_request", {"scope": SCOPE, "method": "PUT", "path": f"/accounts/{ACCOUNT}/workers/domains",
                                             "body": {"hostname": HOST, "service": SCRIPT, "zone_id": ZONE, "environment": "production"}})
        if dom.get("status") != 200:
            sys.exit(f"custom domain failed: {json.dumps(dom)[:400]}")
        print("custom domain attached")
    for i in range(60):
        try:
            s, h, b = fetch("/healthz")
            hz = json.loads(b)
            if s == 200 and hz.get("release") == build["release"]:
                print(f"live: release {hz['release']} providers {hz['providers']} active {hz['active']}")
                return 0
            print(f"live release {hz.get('release')} != {build['release']}, waiting")
        except Exception as e:  # noqa: BLE001
            print(f"not reachable yet: {e}")
        time.sleep(5)
    sys.exit("production did not switch to the new release in 5 minutes")


if __name__ == "__main__":
    sys.exit(main())
