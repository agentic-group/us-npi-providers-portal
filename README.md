# NPI Provider Index (providers.navi-index.com)

US health-care providers (dentists, counselors, optometrists, psychologists, clinical social workers and the
organizations they practice in) from the CMS NPPES NPI Registry. Each provider page answers: NPI number,
primary specialty (NUCC taxonomy), practice address and practice phone. Operated by Agentic, Inc.

Moved out of the US Portal Atlas on 2026-10-06 (the 40,024 `npiregistry-*` rows plus the 251 extra NPIs of the
atlas `/dentists` page). Old atlas URLs `/p/npiregistry-*` answer 301 here (`/p/<slug>` → `/provider/<npi>/`).

## How it works

- `data/providers.json` — the compact provider table (see `scripts/build_data.py` for the row layout).
- `src/app.mjs` renders every page from that table; `src/entry.mjs` adds the edge cache.
- `scripts/build-worker.mjs` embeds the table (gzip + base64) into one module `dist/worker.mjs` (limit 9.5 MB).
- `scripts/test.mjs` runs the built Worker in Node against every page type.

Pages: `/`, `/specialties/`, `/states/`, `/specialty/<spec>/`, `/specialty/<spec>/<st>/`, `/state/<st>/`,
`/state/<st>/<city>/`, `/provider/<npi>/`, `/search/?q=`, `/about/`, `/sitemap.xml` (index → lists + providers-N),
`/robots.txt`, `/llms.txt`, `/api/providers`, `/api/providers/<npi>`, `/api/collection-status`, `/healthz`.

## Refresh the data (on the fleet machine)

```sh
# 1. Download the NPPES monthly file + weekly files once each (https://download.cms.gov/nppes/NPI_Files.html)
#    and the NUCC taxonomy CSV. Do not call the NPPES API once per provider.
python3 scripts/extract_nppes.py data/seeds.json nucc.csv work/providers.jsonl MONTHLY.zip WEEKLY*.zip
python3 scripts/build_data.py work/providers.jsonl data/seeds.json data/providers.json \
  --nppes-file <monthly zip name> --weekly-through <YYYY-MM-DD> --nucc <nucc file name>
npm test
```

## Deploy

No Cloudflare key lives in this repo. Deploy runs on the fleet machine through Grantry (scope `portal-cloudflare`):

```sh
npm i && npm test && python3 scripts/deploy.py      # --attach-domain only the first time
```

`deploy.py` reads production `/healthz` back and fails unless the new release is live.

## Rules

- Show only public NPPES fields. Do not add license numbers, EIN, authorized officials or sex.
- All public text is English.
- robots.txt: training crawlers disallowed, search crawlers (OAI-SearchBot, ChatGPT-User, PerplexityBot) allowed.
