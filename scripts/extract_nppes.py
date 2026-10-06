#!/usr/bin/env python3
"""Pick the providers in seeds.json out of the CMS NPPES Data Dissemination files.

One monthly full file plus the weekly update files (applied in date order, later
wins) from https://download.cms.gov/nppes/NPI_Files.html. One download per file,
no per-provider API calls. Taxonomy names come from the NUCC code set CSV.

    python3 scripts/extract_nppes.py seeds.json nucc.csv out.jsonl MONTHLY.zip WEEKLY1.zip ...

Output: one JSON object per provider (public NPPES fields: NPI, entity type,
name and credential, practice-location address, phone and fax, taxonomies, dates).
License numbers, EIN, authorized officials and sex are not written.
"""
import csv, io, json, sys, zipfile

csv.field_size_limit(10**9)


def load_nucc(path):
    out = {}
    for r in csv.DictReader(open(path, encoding="utf-8", errors="replace")):
        out[r["Code"].strip()] = {
            "grouping": r["Grouping"].strip(), "classification": r["Classification"].strip(),
            "specialization": r["Specialization"].strip(), "display": (r.get("Display Name") or "").strip(),
        }
    return out


def fmt_date(s):
    s = (s or "").strip()
    if len(s) == 10 and s[2] == "/":  # MM/DD/YYYY
        return f"{s[6:]}-{s[:2]}-{s[3:5]}"
    return s or None


def row_to_rec(h, r, nucc):
    def g(k):
        return (r[h[k]] or "").strip()
    taxes = []
    for i in range(1, 16):
        code = g(f"Healthcare Provider Taxonomy Code_{i}")
        if not code:
            continue
        t = nucc.get(code, {})
        taxes.append({"code": code, "primary": g(f"Healthcare Provider Primary Taxonomy Switch_{i}") == "Y",
                      "classification": t.get("classification"), "specialization": t.get("specialization") or None,
                      "grouping": t.get("grouping")})
    ent = g("Entity Type Code")
    return {
        "npi": g("NPI"),
        "entity": "organization" if ent == "2" else ("individual" if ent == "1" else None),
        "org_name": g("Provider Organization Name (Legal Business Name)") or None,
        "other_org_name": g("Provider Other Organization Name") or None,
        "last": g("Provider Last Name (Legal Name)") or None,
        "first": g("Provider First Name") or None,
        "middle": g("Provider Middle Name") or None,
        "prefix": g("Provider Name Prefix Text") or None,
        "suffix": g("Provider Name Suffix Text") or None,
        "credential": g("Provider Credential Text") or None,
        "addr1": g("Provider First Line Business Practice Location Address") or None,
        "addr2": g("Provider Second Line Business Practice Location Address") or None,
        "city": g("Provider Business Practice Location Address City Name") or None,
        "state": g("Provider Business Practice Location Address State Name") or None,
        "postal": g("Provider Business Practice Location Address Postal Code") or None,
        "country": g("Provider Business Practice Location Address Country Code (If outside U.S.)") or None,
        "phone": g("Provider Business Practice Location Address Telephone Number") or None,
        "fax": g("Provider Business Practice Location Address Fax Number") or None,
        "enumerated": fmt_date(g("Provider Enumeration Date")),
        "updated": fmt_date(g("Last Update Date")),
        "deactivated": fmt_date(g("NPI Deactivation Date")),
        "reactivated": fmt_date(g("NPI Reactivation Date")),
        "taxonomies": taxes,
    }


def scan(zpath, want, nucc, found, label):
    z = zipfile.ZipFile(zpath)
    name = [i.filename for i in z.infolist()
            if i.filename.startswith("npidata_pfile") and "fileheader" not in i.filename][0]
    rd = csv.reader(io.TextIOWrapper(z.open(name), encoding="utf-8", errors="replace"))
    head = next(rd)
    h = {c: i for i, c in enumerate(head)}
    n = hit = 0
    for r in rd:
        n += 1
        if r and r[0] in want:
            rec = row_to_rec(h, r, nucc)
            rec["nppes_file"] = label
            found[r[0]] = rec
            hit += 1
    print(f"{label}: rows={n} hits={hit}", flush=True)


def main():
    seeds, nucc_p, out, monthly, *weeklies = sys.argv[1:]
    want = {s["npi"] for s in json.load(open(seeds))}
    nucc = load_nucc(nucc_p)
    found = {}
    scan(monthly, want, nucc, found, monthly.rsplit("/", 1)[-1])
    for w in sorted(weeklies):
        scan(w, want, nucc, found, w.rsplit("/", 1)[-1])
    with open(out, "w") as f:
        for npi in sorted(found):
            f.write(json.dumps(found[npi], ensure_ascii=False) + "\n")
    missing = sorted(want - set(found))
    json.dump(missing, open(out + ".missing.json", "w"))
    print(f"DONE want={len(want)} found={len(found)} missing={len(missing)}", flush=True)


if __name__ == "__main__":
    main()
