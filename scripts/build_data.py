#!/usr/bin/env python3
"""Turn the NPPES extract into the compact table the Worker embeds.

    python3 scripts/build_data.py work/providers.jsonl data/seeds.json data/providers.json \
        --nppes-file NPPES_Data_Dissemination_September_2026_V2.zip --weekly-through 2026-10-04 --nucc nucc_taxonomy_261

Row layout (arrays keep the embedded blob small):
  [npi, org(0/1), name, credential, other_name, addr1, addr2, city, state, zip, phone, fax,
   [taxonomy indexes, primary first], enumerated, updated, status(0 active / 1 deactivated), old_atlas_slug]
"""
import argparse, datetime, json, re

KEEP_UPPER = {"LLC", "PLLC", "PC", "P.C.", "PA", "P.A.", "PS", "PSC", "LLP", "LP", "DDS", "DMD", "OD", "MD", "DO", "PHD",
              "PSYD", "LCSW", "LPC", "LMFT", "LMHC", "LPCC", "NCC", "MSW", "MA", "MS", "MSED", "II", "III", "IV", "USA",
              "US", "NY", "NJ", "CA", "TX", "FL", "DBA", "INC", "PT", "OT", "ABA", "ADHD", "HIV", "YMCA", "VA", "LCPC", "MFT"}
SMALL = {"of", "and", "the", "for", "at", "in", "on", "by", "to", "de", "la", "del", "y"}
SLUG_RE = re.compile(r"[^a-z0-9]+")


def tcase(s):
    if not s:
        return None
    if s != s.upper():  # already mixed case: keep as registered
        return s.strip()
    out = []
    for i, w in enumerate(s.split()):
        bare = re.sub(r"[^A-Za-z.]", "", w)
        if bare.upper().replace(".", "") in {x.replace(".", "") for x in KEEP_UPPER} and len(bare) <= 5:
            out.append(w.upper())
        elif i and w.lower() in SMALL:
            out.append(w.lower())
        else:
            parts = re.split(r"([-'/&.])", w.lower())
            out.append("".join(p[:1].upper() + p[1:] if p and p not in "-'/&." else p for p in parts))
            out[-1] = re.sub(r"^Mc([a-z])", lambda m: "Mc" + m.group(1).upper(), out[-1])
    return " ".join(out)


def display_name(r):
    if r["entity"] == "organization":
        return tcase(r.get("org_name") or "")
    parts = [r.get("first"), r.get("middle"), r.get("last"), r.get("suffix")]
    return tcase(" ".join(p for p in parts if p))


PLACEHOLDER = re.compile(r"^<?\s*unavail(able)?\s*>?$|^n/?a$|^none$", re.I)


def clean(v):
    """NPPES uses placeholders such as <UNAVAIL>; treat them as empty."""
    if v is None:
        return None
    v = str(v).strip()
    return None if not v or PLACEHOLDER.match(v) else v


def cred(c):
    if not c:
        return None
    c = (clean(c) or "").strip(",").strip()
    return c or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("extract")
    ap.add_argument("seeds")
    ap.add_argument("out")
    ap.add_argument("--nppes-file", required=True)
    ap.add_argument("--weekly-through", required=True)
    ap.add_argument("--nucc", required=True)
    a = ap.parse_args()

    seeds = json.load(open(a.seeds))
    slug_of = {s["npi"]: s.get("slug") for s in seeds}
    recs = [json.loads(l) for l in open(a.extract) if l.strip()]
    tax_ix, tax = {}, []
    rows = []
    for r in recs:
        taxes = sorted(r["taxonomies"], key=lambda t: (not t["primary"]))
        ids = []
        for t in taxes:
            k = t["code"]
            if k not in tax_ix:
                tax_ix[k] = len(tax)
                tax.append([k, t.get("classification") or "Unknown taxonomy", t.get("specialization"), t.get("grouping")])
            if tax_ix[k] not in ids:
                ids.append(tax_ix[k])
        deact = bool(r.get("deactivated")) and not r.get("reactivated")
        name = display_name(r)
        if not name:
            continue
        rows.append([
            r["npi"], 1 if r["entity"] == "organization" else 0, name, cred(r.get("credential")),
            tcase(clean(r.get("other_org_name"))),
            tcase(clean(r.get("addr1"))), tcase(clean(r.get("addr2"))), tcase(clean(r.get("city"))), r.get("state"),
            (r.get("postal") or "")[:9] or None, r.get("phone"), r.get("fax"), ids,
            r.get("enumerated"), r.get("updated"), 1 if deact else 0, slug_of.get(r["npi"]),
        ])
    found = {r[0] for r in rows}
    # Atlas slugs whose NPI is not in the registry file: send the old URL to the city
    # (or state) page built from the city and state the atlas row recorded.
    fallback = {}
    for s in seeds:
        if s["npi"] in found or not s.get("slug"):
            continue
        m = re.search(r" in (.+), ([A-Z]{2}), listed", s.get("desc") or "")
        if m:
            city = SLUG_RE.sub("-", m.group(1).lower().replace("&", " and ")).strip("-")
            st = m.group(2).lower()
            fallback[s["slug"]] = f"/state/{st}/{city}/"
    now = datetime.datetime.now(datetime.timezone.utc)
    meta = {
        "nppes_file": a.nppes_file, "weekly_through": a.weekly_through, "nucc": a.nucc,
        "built": now.strftime("%Y-%m-%d"), "built_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seeds": len(seeds), "missing": len(seeds) - len(found), "slugFallback": fallback,
    }
    with open(a.out, "w") as f:
        json.dump({"meta": meta, "tax": tax, "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"rows={len(rows)} taxonomies={len(tax)} missing={meta['missing']} fallback={len(fallback)}")


if __name__ == "__main__":
    main()
