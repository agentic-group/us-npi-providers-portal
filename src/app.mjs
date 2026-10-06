// NPI Provider Index — one Cloudflare Worker that renders every page from the
// embedded provider table (data/providers.json, gzip + base64, built by
// scripts/build-worker.mjs). No database, no origin server.
//
// Answer this site gives: for a provider type in a state or city, who is
// registered, their NPI number, primary specialty (NUCC taxonomy), practice
// address and practice phone — straight from the CMS NPPES NPI Registry.
// Only public NPPES fields are shown. License numbers, EIN, authorized
// officials and sex are not stored here.

const SITE = {
  name: "NPI Provider Index",
  host: "providers.navi-index.com",
  tagline: "US health-care providers from the federal NPI Registry",
  description:
    "Look up US dentists, counselors, optometrists, psychologists and social workers by state and city, with NPI number, primary specialty, practice address and practice phone from the CMS NPPES NPI Registry.",
  operator: "Agentic, Inc.",
  operatorUrl: "https://agentic-company.net/",
  contactUrl: "https://agentic-company.net/#contact",
  ga4: "__GA4__",
  indexnowKey: "__INDEXNOW_KEY__",
  atlas: "https://atlas.navi-index.com/",
};

const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands",
  AA: "Armed Forces Americas", AE: "Armed Forces Europe", AP: "Armed Forces Pacific",
};

// ---------------------------------------------------------------- data ----

let DB = null;

async function loadDb(blob) {
  if (DB) return DB;
  const bin = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const raw = JSON.parse(text);
  const tax = raw.tax.map(([code, classification, specialization, grouping]) => ({ code, classification, specialization, grouping }));
  const rows = raw.rows.map((r) => ({
    npi: r[0], org: r[1] === 1, name: r[2], credential: r[3], otherName: r[4], addr1: r[5], addr2: r[6],
    city: r[7], state: r[8], zip: r[9], phone: r[10], fax: r[11], tax: r[12].map((i) => tax[i]),
    enumerated: r[13], updated: r[14], active: r[15] === 0, oldSlug: r[16],
  }));
  for (const p of rows) {
    p.primary = p.tax[0] || null;
    p.spec = p.primary ? slugify(p.primary.classification) : "other";
    p.citySlug = slugify(p.city || "");
  }
  const byNpi = new Map();
  const bySlug = new Map();
  const active = [];
  for (const p of rows) {
    byNpi.set(p.npi, p);
    if (p.oldSlug) bySlug.set(p.oldSlug, p);
    if (p.active && p.state && p.city) active.push(p);
  }
  active.sort((a, b) => cmp(a.state, b.state) || cmp(a.city, b.city) || cmp(a.name, b.name));
  const specs = new Map(); // slug -> {slug,label,list}
  const states = new Map(); // ST -> list
  const cities = new Map(); // ST|citySlug -> {state,city,citySlug,list}
  for (const p of active) {
    const label = p.primary ? p.primary.classification : "Other";
    if (!specs.has(p.spec)) specs.set(p.spec, { slug: p.spec, label, list: [] });
    specs.get(p.spec).list.push(p);
    if (!states.has(p.state)) states.set(p.state, []);
    states.get(p.state).push(p);
    const ck = p.state + "|" + p.citySlug;
    if (!cities.has(ck)) cities.set(ck, { state: p.state, city: p.city, citySlug: p.citySlug, list: [] });
    cities.get(ck).list.push(p);
  }
  DB = { meta: raw.meta, rows, byNpi, bySlug, active, specs, states, cities };
  return DB;
}

// --------------------------------------------------------------- helpers ----

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function slugify(s) { return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fmtInt(n) { return Number(n).toLocaleString("en-US"); }
function stateName(st) { return STATE_NAMES[st] || st; }
function phoneFmt(p) { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ""); }
function zipFmt(z) { const d = String(z || ""); return d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; }
function specLabel(t) { return t ? (t.specialization ? `${t.classification} — ${t.specialization}` : t.classification) : "Not listed"; }
function plural(label) {
  const l = label.toLowerCase();
  if (/(s|x|ch|sh)$/.test(l)) return label + "es";
  if (/[^aeiou]y$/.test(l)) return label.slice(0, -1) + "ies";
  return label + "s";
}
function addressLine(p) { return [p.addr1, p.addr2].filter(Boolean).join(", "); }
function fullAddress(p) { return `${addressLine(p)}, ${p.city}, ${p.state} ${zipFmt(p.zip)}`; }
function providerUrl(p) { return `/provider/${p.npi}/`; }
function cityUrl(c) { return `/state/${c.state.toLowerCase()}/${c.citySlug}/`; }
function absolute(path) { return `https://${SITE.host}${path}`; }
function countBy(list, key) { const m = new Map(); for (const x of list) { const k = key(x); m.set(k, (m.get(k) || 0) + 1); } return m; }

// ---------------------------------------------------------------- layout ----

const CSS = `:root{--bg:#fff;--fg:#1a1d21;--muted:#5b6470;--line:#e3e6ea;--accent:#0b5cad;--soft:#f4f7fa}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--muted:#a0a8b3;--line:#2b3036;--accent:#7db4ff;--soft:#1b1f24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}header,main,footer{max-width:1040px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
header .brand{font-weight:700;text-decoration:none;color:var(--fg)}nav a{margin-left:14px;font-size:15px}
h1{font-size:1.7rem;line-height:1.25;margin:22px 0 8px}h2{font-size:1.2rem;margin:28px 0 10px}
.lead{color:var(--muted);margin:0 0 16px}.crumbs{font-size:14px;color:var(--muted);margin-top:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 18px;padding:0;list-style:none}
.tbl{width:100%;border-collapse:collapse;font-size:15px}.tbl th,.tbl td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl th{font-size:13px;color:var(--muted);font-weight:600}.wrap{overflow-x:auto}
dl.facts{display:grid;grid-template-columns:200px 1fr;gap:8px 16px;margin:0}dl.facts dt{color:var(--muted)}dl.facts dd{margin:0}
@media (max-width:640px){dl.facts{grid-template-columns:1fr}dl.facts dd{margin-bottom:8px}.hide-sm{display:none}}
.box{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:16px 0}
form.search{display:flex;gap:8px;margin:12px 0 4px;flex-wrap:wrap}form.search input,form.search select{padding:9px 10px;font-size:15px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
form.search input{flex:1;min-width:200px}form.search button{padding:9px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:15px}
.pager{display:flex;gap:12px;margin:16px 0}footer{border-top:1px solid var(--line);margin-top:40px;padding-top:16px;padding-bottom:30px;font-size:14px;color:var(--muted)}`;

function page({ title, description, path, body, jsonld = [], noindex = false, crumbs = [] }) {
  const canonical = absolute(path);
  const ld = [
    { "@context": "https://schema.org", "@type": "WebSite", name: SITE.name, url: absolute("/"), publisher: { "@type": "Organization", name: SITE.operator, url: SITE.operatorUrl } },
  ];
  if (crumbs.length) {
    ld.push({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [{ name: "Home", path: "/" }, ...crumbs].map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: absolute(c.path) })),
    });
  }
  ld.push(...jsonld);
  const ga = SITE.ga4 && !SITE.ga4.startsWith("__")
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${SITE.ga4}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${SITE.ga4}');</script>`
    : "";
  const crumbHtml = crumbs.length
    ? `<div class="crumbs"><a href="/">Home</a> › ${crumbs.map((c, i) => (i === crumbs.length - 1 ? esc(c.name) : `<a href="${c.path}">${esc(c.name)}</a>`)).join(" › ")}</div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ""}<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="${SITE.name}">
<style>${CSS}</style>${ga}
${ld.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, "\\u003c")}</script>`).join("\n")}
</head><body><header><a class="brand" href="/">${SITE.name}</a><nav><a href="/specialties/">Specialties</a><a href="/states/">States</a><a href="/search/">Search</a><a href="/about/">About</a></nav></header>
<main>${crumbHtml}${body}</main>
<footer><p>Data: CMS NPPES NPI Registry (public, U.S. government data) and the NUCC Health Care Provider Taxonomy code set. This site is not affiliated with CMS. Always confirm details with the provider and the state licensing board before a visit.</p>
<p>Operated by <a href="${SITE.operatorUrl}">${SITE.operator}</a> · <a href="/about/">About &amp; sources</a> · <a href="${SITE.contactUrl}">Corrections and removal requests</a> · Part of the <a href="${SITE.atlas}">US Portal Atlas</a></p></footer>
</body></html>`;
}

function providerTable(list, { showCity = true } = {}) {
  return `<div class="wrap"><table class="tbl"><thead><tr><th>Provider</th><th>Primary specialty</th><th>Practice address</th><th>Phone</th><th class="hide-sm">NPI</th></tr></thead><tbody>${list
    .map((p) => `<tr><td><a href="${providerUrl(p)}">${esc(p.name)}</a>${p.credential ? `, ${esc(p.credential)}` : ""}</td><td>${esc(specLabel(p.primary))}</td><td>${esc(addressLine(p))}${showCity ? `<br>${esc(p.city)}, ${p.state} ${esc(zipFmt(p.zip))}` : ` ${esc(zipFmt(p.zip))}`}</td><td>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(phoneFmt(p.phone))}</a>` : "—"}</td><td class="hide-sm">${p.npi}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

function itemListLd(name, path, list) {
  return {
    "@context": "https://schema.org", "@type": "ItemList", name, url: absolute(path), numberOfItems: list.length,
    itemListElement: list.slice(0, 100).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: absolute(providerUrl(p)), name: p.name })),
  };
}

const PER_PAGE = 100;
function paginate(list, url) {
  const n = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const cur = Math.min(n, pages);
  const slice = list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
  const base = url.pathname;
  const nav = pages > 1
    ? `<div class="pager">${cur > 1 ? `<a href="${base}${cur - 1 > 1 ? `?page=${cur - 1}` : ""}">← Previous</a>` : ""}<span>Page ${cur} of ${pages}</span>${cur < pages ? `<a href="${base}?page=${cur + 1}">Next →</a>` : ""}</div>`
    : "";
  return { slice, nav, cur, pages };
}

// ----------------------------------------------------------------- pages ----

function home(db) {
  const specs = [...db.specs.values()].sort((a, b) => b.list.length - a.list.length);
  const states = [...db.states.entries()].sort((a, b) => cmp(stateName(a[0]), stateName(b[0])));
  const topCities = [...db.cities.values()].sort((a, b) => b.list.length - a.list.length).slice(0, 30);
  const title = `${SITE.name} — ${fmtInt(db.active.length)} US providers with NPI, address and phone`;
  const body = `<h1>Find a US dentist, counselor, optometrist or psychologist by NPI</h1>
<p class="lead">${fmtInt(db.active.length)} active providers from the CMS NPPES NPI Registry across ${db.states.size} states and territories. Every listing shows the NPI number, primary specialty (NUCC taxonomy), practice-location address and practice phone, as registered with CMS. Registry file: ${esc(db.meta.nppes_file)}.</p>
<form class="search" action="/search/" method="get"><input name="q" placeholder="Name, NPI, city or ZIP" aria-label="Search"><button>Search</button></form>
<h2>By specialty</h2><ul class="grid">${specs.map((s) => `<li><a href="/specialty/${s.slug}/">${esc(plural(s.label))}</a> (${fmtInt(s.list.length)})</li>`).join("")}</ul>
<h2>By state</h2><ul class="grid">${states.map(([st, l]) => `<li><a href="/state/${st.toLowerCase()}/">${esc(stateName(st))}</a> (${fmtInt(l.length)})</li>`).join("")}</ul>
<h2>Largest cities</h2><ul class="grid">${topCities.map((c) => `<li><a href="${cityUrl(c)}">${esc(c.city)}, ${c.state}</a> (${fmtInt(c.list.length)})</li>`).join("")}</ul>
<div class="box"><strong>What is an NPI?</strong> The National Provider Identifier is the 10-digit number every HIPAA-covered US health-care provider uses on claims. CMS publishes the registry (name, practice address, phone and taxonomy) as public data. An NPI shows a provider is enumerated; it is not a license. Check the state licensing board for license status.</div>`;
  return page({
    title, description: SITE.description, path: "/", body,
    jsonld: [{ "@context": "https://schema.org", "@type": "Dataset", name: SITE.name, description: SITE.description, url: absolute("/"), license: "https://www.usa.gov/government-works", isBasedOn: "https://npiregistry.cms.hhs.gov/", creator: { "@type": "Organization", name: SITE.operator }, dateModified: db.meta.built, variableMeasured: ["NPI", "Primary taxonomy", "Practice address", "Practice phone"] }],
  });
}

function specialtiesIndex(db) {
  const specs = [...db.specs.values()].sort((a, b) => b.list.length - a.list.length);
  const body = `<h1>Provider specialties</h1><p class="lead">Primary NUCC taxonomy classification of each provider, as registered in NPPES.</p>
<div class="wrap"><table class="tbl"><thead><tr><th>Specialty</th><th>Providers</th><th>States</th></tr></thead><tbody>${specs
    .map((s) => `<tr><td><a href="/specialty/${s.slug}/">${esc(plural(s.label))}</a></td><td>${fmtInt(s.list.length)}</td><td>${new Set(s.list.map((p) => p.state)).size}</td></tr>`)
    .join("")}</tbody></table></div>`;
  return page({ title: `Provider specialties — ${SITE.name}`, description: `All provider specialties in ${SITE.name} with provider counts.`, path: "/specialties/", body, crumbs: [{ name: "Specialties", path: "/specialties/" }] });
}

function statesIndex(db) {
  const states = [...db.states.entries()].sort((a, b) => cmp(stateName(a[0]), stateName(b[0])));
  const body = `<h1>Providers by state</h1><div class="wrap"><table class="tbl"><thead><tr><th>State</th><th>Providers</th><th>Cities</th></tr></thead><tbody>${states
    .map(([st, l]) => `<tr><td><a href="/state/${st.toLowerCase()}/">${esc(stateName(st))}</a></td><td>${fmtInt(l.length)}</td><td>${new Set(l.map((p) => p.citySlug)).size}</td></tr>`)
    .join("")}</tbody></table></div>`;
  return page({ title: `Health-care providers by state — ${SITE.name}`, description: `Provider counts by US state from the NPI Registry.`, path: "/states/", body, crumbs: [{ name: "States", path: "/states/" }] });
}

function specialtyPage(db, spec, url) {
  const s = db.specs.get(spec);
  if (!s) return null;
  const byState = [...countBy(s.list, (p) => p.state).entries()].sort((a, b) => cmp(stateName(a[0]), stateName(b[0])));
  const subs = [...countBy(s.list, (p) => p.primary?.specialization || "General").entries()].sort((a, b) => b[1] - a[1]);
  const { slice, nav } = paginate(s.list, url);
  const label = plural(s.label);
  const body = `<h1>${esc(label)} in the United States</h1>
<p class="lead">${fmtInt(s.list.length)} ${esc(label.toLowerCase())} whose primary taxonomy in the NPI Registry is “${esc(s.label)}”, in ${byState.length} states. Pick a state to see providers by city with practice address, phone and NPI.</p>
<h2>${esc(label)} by state</h2><ul class="grid">${byState.map(([st, n]) => `<li><a href="/specialty/${s.slug}/${st.toLowerCase()}/">${esc(stateName(st))}</a> (${fmtInt(n)})</li>`).join("")}</ul>
${subs.length > 1 ? `<h2>Specializations</h2><ul class="grid">${subs.map(([k, n]) => `<li>${esc(k)} (${fmtInt(n)})</li>`).join("")}</ul>` : ""}
<h2>All ${esc(label.toLowerCase())}</h2>${providerTable(slice)}${nav}`;
  return page({
    title: `${label} in the US — NPI, address and phone (${fmtInt(s.list.length)})`,
    description: `${fmtInt(s.list.length)} ${label.toLowerCase()} from the CMS NPI Registry by state and city, with NPI number, practice address and phone.`,
    path: `/specialty/${s.slug}/`, body, noindex: url.searchParams.has("page"),
    crumbs: [{ name: "Specialties", path: "/specialties/" }, { name: label, path: `/specialty/${s.slug}/` }],
    jsonld: [itemListLd(`${label} in the US`, `/specialty/${s.slug}/`, slice)],
  });
}

function specialtyStatePage(db, spec, st, url) {
  const s = db.specs.get(spec);
  const ST = st.toUpperCase();
  if (!s || !STATE_NAMES[ST]) return null;
  const list = s.list.filter((p) => p.state === ST);
  if (!list.length) return null;
  const label = plural(s.label);
  const cities = [...countBy(list, (p) => p.citySlug).entries()].map(([cs, n]) => ({ c: db.cities.get(ST + "|" + cs), n })).sort((a, b) => b.n - a.n);
  const { slice, nav } = paginate(list, url);
  const body = `<h1>${esc(label)} in ${esc(stateName(ST))}</h1>
<p class="lead">${fmtInt(list.length)} ${esc(label.toLowerCase())} with a practice location in ${esc(stateName(ST))}, in ${cities.length} cities, from the CMS NPPES NPI Registry. Each row gives the NPI, practice address and phone.</p>
<h2>By city</h2><ul class="grid">${cities.map(({ c, n }) => `<li><a href="${cityUrl(c)}">${esc(c.city)}</a> (${fmtInt(n)})</li>`).join("")}</ul>
<h2>${esc(label)} in ${esc(stateName(ST))}</h2>${providerTable(slice)}${nav}
<p><a href="/state/${st.toLowerCase()}/">All providers in ${esc(stateName(ST))}</a> · <a href="/specialty/${s.slug}/">${esc(label)} in all states</a></p>`;
  return page({
    title: `${label} in ${stateName(ST)} — NPI, address and phone (${fmtInt(list.length)})`,
    description: `${fmtInt(list.length)} ${label.toLowerCase()} in ${stateName(ST)} from the NPI Registry, by city, with NPI number, practice address and phone.`,
    path: `/specialty/${s.slug}/${st.toLowerCase()}/`, body, noindex: url.searchParams.has("page"),
    crumbs: [{ name: label, path: `/specialty/${s.slug}/` }, { name: stateName(ST), path: `/specialty/${s.slug}/${st.toLowerCase()}/` }],
    jsonld: [itemListLd(`${label} in ${stateName(ST)}`, `/specialty/${s.slug}/${st.toLowerCase()}/`, slice)],
  });
}

function statePage(db, st, url) {
  const ST = st.toUpperCase();
  const list = db.states.get(ST);
  if (!list) return null;
  const specs = [...countBy(list, (p) => p.spec).entries()].sort((a, b) => b[1] - a[1]);
  const cities = [...countBy(list, (p) => p.citySlug).entries()].map(([cs, n]) => ({ c: db.cities.get(ST + "|" + cs), n })).sort((a, b) => cmp(a.c.city, b.c.city));
  const { slice, nav } = paginate(list, url);
  const body = `<h1>Health-care providers in ${esc(stateName(ST))}</h1>
<p class="lead">${fmtInt(list.length)} providers with a practice location in ${esc(stateName(ST))} across ${cities.length} cities, from the CMS NPPES NPI Registry.</p>
<h2>By specialty</h2><ul class="grid">${specs.map(([k, n]) => `<li><a href="/specialty/${k}/${st.toLowerCase()}/">${esc(plural(db.specs.get(k).label))}</a> (${fmtInt(n)})</li>`).join("")}</ul>
<h2>By city</h2><ul class="grid">${cities.map(({ c, n }) => `<li><a href="${cityUrl(c)}">${esc(c.city)}</a> (${fmtInt(n)})</li>`).join("")}</ul>
<h2>All providers in ${esc(stateName(ST))}</h2>${providerTable(slice)}${nav}`;
  return page({
    title: `Health-care providers in ${stateName(ST)} — NPI, address and phone (${fmtInt(list.length)})`,
    description: `${fmtInt(list.length)} providers in ${stateName(ST)} by specialty and city from the NPI Registry, with practice address and phone.`,
    path: `/state/${st.toLowerCase()}/`, body, noindex: url.searchParams.has("page"),
    crumbs: [{ name: "States", path: "/states/" }, { name: stateName(ST), path: `/state/${st.toLowerCase()}/` }],
    jsonld: [itemListLd(`Providers in ${stateName(ST)}`, `/state/${st.toLowerCase()}/`, slice)],
  });
}

function cityPage(db, st, cs, url) {
  const ST = st.toUpperCase();
  const c = db.cities.get(ST + "|" + cs);
  if (!c) return null;
  const groups = new Map();
  for (const p of c.list) { if (!groups.has(p.spec)) groups.set(p.spec, []); groups.get(p.spec).push(p); }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const where = `${c.city}, ${stateName(ST)}`;
  const body = `<h1>Health-care providers in ${esc(where)}</h1>
<p class="lead">${fmtInt(c.list.length)} providers with a practice location in ${esc(c.city)}, ${ST}: ${ordered.map(([k, l]) => `${fmtInt(l.length)} ${esc(plural(db.specs.get(k).label).toLowerCase())}`).join(", ")}. Source: CMS NPPES NPI Registry.</p>
${ordered.map(([k, l]) => `<h2 id="${k}">${esc(plural(db.specs.get(k).label))} in ${esc(c.city)}</h2>${providerTable(l, { showCity: false })}`).join("")}
<p><a href="/state/${st.toLowerCase()}/">All providers in ${esc(stateName(ST))}</a></p>`;
  return page({
    title: `${ordered.length === 1 ? plural(db.specs.get(ordered[0][0]).label) : "Dentists, counselors and other providers"} in ${where} — NPI, address and phone`,
    description: `${fmtInt(c.list.length)} providers in ${where} from the NPI Registry with NPI number, specialty, practice address and phone.`,
    path: cityUrl(c), body,
    crumbs: [{ name: stateName(ST), path: `/state/${st.toLowerCase()}/` }, { name: c.city, path: cityUrl(c) }],
    jsonld: [itemListLd(`Providers in ${where}`, cityUrl(c), c.list)],
  });
}

function providerLd(p) {
  const address = { "@type": "PostalAddress", streetAddress: addressLine(p), addressLocality: p.city, addressRegion: p.state, postalCode: zipFmt(p.zip), addressCountry: "US" };
  const props = [
    { "@type": "PropertyValue", name: "NPI", value: p.npi, propertyID: "NPI" },
    { "@type": "PropertyValue", name: "Primary taxonomy", value: specLabel(p.primary), propertyID: p.primary?.code },
    { "@type": "PropertyValue", name: "NPI enumeration date", value: p.enumerated },
    { "@type": "PropertyValue", name: "Last updated in NPPES", value: p.updated },
  ];
  if (p.org) {
    const isDental = p.spec === "dentist" || /dental/i.test(p.primary?.classification || "");
    return { "@context": "https://schema.org", "@type": isDental ? "Dentist" : "MedicalOrganization", name: p.name, identifier: props[0], address, telephone: phoneFmt(p.phone) || undefined, medicalSpecialty: p.primary?.classification, additionalProperty: props, url: absolute(providerUrl(p)) };
  }
  return {
    "@context": "https://schema.org", "@type": "Person", name: p.name, honorificSuffix: p.credential || undefined, jobTitle: specLabel(p.primary),
    identifier: props[0], additionalProperty: props, url: absolute(providerUrl(p)),
    workLocation: { "@type": "Place", address, telephone: phoneFmt(p.phone) || undefined },
  };
}

function providerPage(db, npi) {
  const p = db.byNpi.get(npi);
  if (!p) return null;
  const ST = p.state;
  const c = db.cities.get(ST + "|" + p.citySlug);
  const nearby = c ? c.list.filter((x) => x.spec === p.spec && x.npi !== p.npi).slice(0, 12) : [];
  const kind = p.org ? "Organization (NPI type 2)" : "Individual (NPI type 1)";
  const status = p.active ? "Active" : `Deactivated in NPPES`;
  const label = p.primary ? p.primary.classification : "Provider";
  const where = p.city ? `${p.city}, ${ST}` : ST;
  const body = `<h1>${esc(p.name)}${p.credential ? `, ${esc(p.credential)}` : ""}</h1>
<p class="lead">${esc(label)} in ${esc(where)} · NPI ${p.npi}</p>
${p.active ? "" : `<div class="box">This NPI is deactivated in the NPPES registry file used for this page. Contact details may no longer be valid.</div>`}
<div class="box"><dl class="facts">
<dt>NPI number</dt><dd>${p.npi}</dd>
<dt>Primary specialty</dt><dd>${esc(specLabel(p.primary))}${p.primary ? ` <span class="hide-sm">(taxonomy ${esc(p.primary.code)})</span>` : ""}</dd>
<dt>Practice address</dt><dd>${esc(addressLine(p))}<br>${esc(p.city)}, ${ST} ${esc(zipFmt(p.zip))}</dd>
<dt>Practice phone</dt><dd>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(phoneFmt(p.phone))}</a>` : "Not listed in NPPES"}</dd>
${p.fax ? `<dt>Practice fax</dt><dd>${esc(phoneFmt(p.fax))}</dd>` : ""}
${p.otherName ? `<dt>Also known as</dt><dd>${esc(p.otherName)}</dd>` : ""}
<dt>Provider type</dt><dd>${kind}</dd>
<dt>Registry status</dt><dd>${status}</dd>
<dt>NPI enumeration date</dt><dd>${esc(p.enumerated || "—")}</dd>
<dt>Last updated in NPPES</dt><dd>${esc(p.updated || "—")}</dd>
</dl></div>
${p.tax.length > 1 ? `<h2>All registered taxonomies</h2><ul>${p.tax.map((t) => `<li>${esc(specLabel(t))} (${esc(t.code)})${t === p.primary ? " — primary" : ""}</li>`).join("")}</ul>` : ""}
<h2>Source</h2><p>CMS NPPES NPI Registry, ${esc(db.meta.nppes_file)} (read ${esc(db.meta.built)}). Verify the current record at <a href="https://npiregistry.cms.hhs.gov/provider-view/${p.npi}" rel="nofollow">npiregistry.cms.hhs.gov/provider-view/${p.npi}</a>. The registry shows enumeration, not licensure: confirm license status with the ${esc(stateName(ST))} licensing board.</p>
${nearby.length ? `<h2>Other ${esc(plural(label).toLowerCase())} in ${esc(where)}</h2>${providerTable(nearby, { showCity: false })}` : ""}
<p>${c ? `<a href="${cityUrl(c)}">All providers in ${esc(where)}</a> · ` : ""}<a href="/specialty/${p.spec}/${ST.toLowerCase()}/">${esc(plural(label))} in ${esc(stateName(ST))}</a></p>`;
  return page({
    title: `${p.name}${p.credential ? `, ${p.credential}` : ""} — ${label} in ${where} (NPI ${p.npi})`,
    description: `${p.name}: ${specLabel(p.primary)} in ${where}. NPI ${p.npi}. Practice address ${fullAddress(p)}${p.phone ? `, phone ${phoneFmt(p.phone)}` : ""}. From the CMS NPI Registry.`,
    path: providerUrl(p), body, noindex: !p.active,
    crumbs: [{ name: stateName(ST), path: `/state/${ST.toLowerCase()}/` }, ...(c ? [{ name: c.city, path: cityUrl(c) }] : []), { name: p.name, path: providerUrl(p) }],
    jsonld: [providerLd(p)],
  });
}

function search(db, url) {
  const q = (url.searchParams.get("q") || "").trim();
  let results = [];
  if (q) {
    const digits = q.replace(/\D/g, "");
    if (/^\d{10}$/.test(digits) && db.byNpi.has(digits)) results = [db.byNpi.get(digits)];
    else if (/^\d{5}$/.test(q)) results = db.active.filter((p) => String(p.zip || "").startsWith(q));
    else {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      results = db.active.filter((p) => { const hay = `${p.name} ${p.otherName || ""} ${p.city} ${p.state} ${p.primary?.classification || ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
    }
  }
  const shown = results.slice(0, 200);
  const body = `<h1>Search providers</h1><form class="search" action="/search/" method="get"><input name="q" value="${esc(q)}" placeholder="Name, NPI, city or ZIP" aria-label="Search"><button>Search</button></form>
${q ? `<p>${fmtInt(results.length)} result${results.length === 1 ? "" : "s"}${results.length > shown.length ? ` (first ${shown.length} shown)` : ""}.</p>${shown.length ? providerTable(shown) : ""}` : `<p class="lead">Search by provider or practice name, 10-digit NPI, city, state or 5-digit ZIP code.</p>`}`;
  return page({ title: q ? `Search: ${q} — ${SITE.name}` : `Search — ${SITE.name}`, description: "Search US providers by name, NPI, city or ZIP.", path: "/search/", body, noindex: true });
}

function about(db) {
  const body = `<h1>About ${SITE.name}</h1>
<p>${SITE.name} lists US health-care providers registered in the National Plan and Provider Enumeration System (NPPES), the registry CMS uses to assign National Provider Identifiers. It answers one question: for a provider type in a state or city, who is registered, and what are their NPI, primary specialty, practice address and practice phone.</p>
<h2>Sources</h2><ul>
<li><a href="https://download.cms.gov/nppes/NPI_Files.html">CMS NPPES Data Dissemination files</a> — ${esc(db.meta.nppes_file)} plus weekly update files through ${esc(db.meta.weekly_through || "—")}. Public U.S. government data.</li>
<li><a href="https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57">NUCC Health Care Provider Taxonomy code set</a> (${esc(db.meta.nucc || "")}) — maps taxonomy codes to specialty names.</li>
</ul>
<h2>What is shown and what is not</h2><p>Each page shows the NPI, provider type, name and credential, primary and other taxonomies, practice-location address, practice phone and fax, enumeration date and last-update date — all fields CMS publishes. License numbers, tax IDs, authorized officials and personal mailing addresses are not shown. An NPI is not a license; check the state licensing board for license status and discipline.</p>
<h2>Coverage</h2><p>${fmtInt(db.rows.length)} providers (${fmtInt(db.active.length)} active) moved here from the US Portal Atlas, where they were first collected from the NPI Registry API in September and October 2026. Built ${esc(db.meta.built)}.</p>
<h2>Corrections</h2><p>Providers update their own record in NPPES; changes appear here after the next registry file. To ask for a correction or removal from this site, use <a href="${SITE.contactUrl}">this form</a>.</p>
<h2>Operator</h2><p>${SITE.operator} (<a href="${SITE.operatorUrl}">${SITE.operatorUrl}</a>). Data API: <a href="/api/providers?limit=10">/api/providers</a>.</p>`;
  return page({ title: `About & sources — ${SITE.name}`, description: "Sources, coverage and update policy of the NPI Provider Index.", path: "/about/", body, crumbs: [{ name: "About", path: "/about/" }] });
}

// ------------------------------------------------------------- machine ----

function apiRow(p) {
  return {
    npi: p.npi, url: absolute(providerUrl(p)), name: p.name, credential: p.credential, entity_type: p.org ? "organization" : "individual",
    primary_taxonomy: p.primary ? { code: p.primary.code, classification: p.primary.classification, specialization: p.primary.specialization } : null,
    taxonomies: p.tax.map((t) => ({ code: t.code, classification: t.classification, specialization: t.specialization })),
    practice_address: { line1: p.addr1, line2: p.addr2, city: p.city, state: p.state, postal_code: p.zip },
    practice_phone: p.phone, practice_fax: p.fax, enumeration_date: p.enumerated, last_updated: p.updated, status: p.active ? "active" : "deactivated",
    source: { name: "CMS NPPES NPI Registry", url: `https://npiregistry.cms.hhs.gov/provider-view/${p.npi}` },
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}

function api(db, url) {
  const st = (url.searchParams.get("state") || "").toUpperCase();
  const sp = url.searchParams.get("specialty") || "";
  const city = slugify(url.searchParams.get("city") || "");
  const zip = url.searchParams.get("zip") || "";
  let list = db.active;
  if (st) list = list.filter((p) => p.state === st);
  if (sp) list = list.filter((p) => p.spec === slugify(sp));
  if (city) list = list.filter((p) => p.citySlug === city);
  if (zip) list = list.filter((p) => String(p.zip || "").startsWith(zip));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
  return json({ total: list.length, limit, offset, source: "CMS NPPES NPI Registry", built: db.meta.built, items: list.slice(offset, offset + limit).map(apiRow) });
}

function sitemapPaths(db) {
  const out = ["/", "/specialties/", "/states/", "/about/"];
  for (const s of db.specs.values()) {
    out.push(`/specialty/${s.slug}/`);
    for (const st of new Set(s.list.map((p) => p.state))) out.push(`/specialty/${s.slug}/${st.toLowerCase()}/`);
  }
  for (const st of db.states.keys()) out.push(`/state/${st.toLowerCase()}/`);
  for (const c of db.cities.values()) out.push(cityUrl(c));
  return out;
}

function xml(body) { return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }); }
function text(body, type = "text/plain; charset=utf-8") { return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } }); }

const SITEMAP_CHUNK = 10000;
function sitemapIndex(db) {
  const n = Math.ceil(db.active.length / SITEMAP_CHUNK);
  const parts = ["/sitemaps/lists.xml", ...Array.from({ length: n }, (_, i) => `/sitemaps/providers-${i + 1}.xml`)];
  return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${parts.map((p) => `<sitemap><loc>${absolute(p)}</loc><lastmod>${db.meta.built}</lastmod></sitemap>`).join("")}</sitemapindex>`);
}
function urlset(paths, lastmod) {
  return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${esc(absolute(p))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`);
}

function robots() {
  return text(`# Training crawls are disallowed; search (including AI search) is allowed.
User-agent: GPTBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: *
Allow: /
Disallow: /search/

Sitemap: ${absolute("/sitemap.xml")}
`);
}

function llms(db) {
  const specs = [...db.specs.values()].sort((a, b) => b.list.length - a.list.length);
  const states = [...db.states.entries()].sort((a, b) => b[1].length - a[1].length);
  return text(`# ${SITE.name}

> ${SITE.description}

${fmtInt(db.active.length)} active providers across ${db.states.size} states and territories. Every provider page gives the NPI number, primary specialty (NUCC taxonomy code and name), practice-location address and practice phone from the CMS NPPES NPI Registry (${db.meta.nppes_file}). Operated by ${SITE.operator}.

## Specialties
${specs.map((s) => `- [${plural(s.label)}](${absolute(`/specialty/${s.slug}/`)}): ${s.list.length} providers`).join("\n")}

## States
${states.map(([st, l]) => `- [${stateName(st)}](${absolute(`/state/${st.toLowerCase()}/`)}): ${l.length} providers`).join("\n")}

## Pages
- Provider page: ${absolute("/provider/<NPI>/")}
- City page: ${absolute("/state/<state>/<city>/")}
- Specialty in a state: ${absolute("/specialty/<specialty>/<state>/")}
- [About and sources](${absolute("/about/")})

## API
- ${absolute("/api/providers?state=TX&specialty=dentist&city=houston&limit=100&offset=0")}
- ${absolute("/api/providers/<NPI>")}
- ${absolute("/api/collection-status")}
- Sitemap: ${absolute("/sitemap.xml")}
`);
}

// -------------------------------------------------------------- router ----

function redirect(to, status = 301) { return new Response(null, { status, headers: { location: to, "cache-control": "public, max-age=86400" } }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } }); }

function notFound() {
  return html(page({ title: `Not found — ${SITE.name}`, description: "Page not found.", path: "/404/", noindex: true, body: `<h1>Page not found</h1><p><a href="/">Browse providers by specialty and state</a> or <a href="/search/">search by name, NPI or ZIP</a>.</p>` }), 404);
}

export async function handle(request, blob, release) {
  const url = new URL(request.url);
  if (url.hostname !== SITE.host && url.hostname.endsWith(".workers.dev") === false && url.hostname !== "localhost") {
    return redirect(`https://${SITE.host}${url.pathname}${url.search}`);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const db = await loadDb(blob);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  const seg = path.split("/").filter(Boolean);
  let res = null;

  if (path === "/robots.txt") res = robots();
  else if (path === "/llms.txt") res = llms(db);
  else if (path === "/sitemap.xml") res = sitemapIndex(db);
  else if (path === "/sitemaps/lists.xml") res = urlset(sitemapPaths(db), db.meta.built);
  else if (/^\/sitemaps\/providers-\d+\.xml$/.test(path)) {
    const i = parseInt(path.match(/(\d+)\.xml$/)[1], 10) - 1;
    const part = db.active.slice(i * SITEMAP_CHUNK, (i + 1) * SITEMAP_CHUNK);
    res = part.length ? urlset(part.map(providerUrl), db.meta.built) : null;
  } else if (SITE.indexnowKey && path === `/${SITE.indexnowKey}.txt`) res = text(SITE.indexnowKey);
  else if (path === "/healthz") res = json({ ok: true, runtime: "cloudflare", release, providers: db.rows.length, active: db.active.length });
  else if (path === "/api/collection-status") res = json({ source: "CMS NPPES NPI Registry", nppes_file: db.meta.nppes_file, weekly_through: db.meta.weekly_through, last_ok_at: db.meta.built_at, built: db.meta.built, providers: db.rows.length, active: db.active.length, missing_from_nppes: db.meta.missing });
  else if (path === "/api/providers") res = api(db, url);
  else if (seg[0] === "api" && seg[1] === "providers" && seg.length === 3) {
    const p = db.byNpi.get(seg[2]);
    res = p ? json(apiRow(p)) : json({ error: "not_found" }, 404);
  } else if (seg[0] === "p" && seg.length === 2) {
    // Old US Portal Atlas row URLs (/p/npiregistry-…) arrive here through the atlas 301.
    const slug = seg[1].startsWith("npiregistry-") ? seg[1] : `npiregistry-${seg[1]}`;
    const p = db.bySlug.get(slug);
    if (p) return redirect(providerUrl(p));
    // NPI no longer in the registry file: send the old URL to its city (or state) page.
    const m = /^\/state\/([a-z]{2})\/([a-z0-9-]+)\/$/.exec(db.meta.slugFallback?.[slug] || "");
    if (m && db.cities.has(m[1].toUpperCase() + "|" + m[2])) return redirect(`/state/${m[1]}/${m[2]}/`);
    if (m && db.states.has(m[1].toUpperCase())) return redirect(`/state/${m[1]}/`);
    return redirect("/");
  } else if (!path.endsWith("/") && !path.includes(".") && seg.length) {
    return redirect(`${path}/${url.search}`);
  } else if (path === "/") res = html(home(db));
  else if (path === "/specialties/") res = html(specialtiesIndex(db));
  else if (path === "/states/") res = html(statesIndex(db));
  else if (path === "/about/") res = html(about(db));
  else if (path === "/search/") res = html(search(db, url));
  else if (path === "/dentists/") return redirect("/specialty/dentist/");
  else if (seg[0] === "provider" && seg.length === 2) { const b = providerPage(db, seg[1]); res = b && html(b); }
  else if (seg[0] === "specialty" && seg.length === 2) { const b = specialtyPage(db, seg[1], url); res = b && html(b); }
  else if (seg[0] === "specialty" && seg.length === 3) { const b = specialtyStatePage(db, seg[1], seg[2], url); res = b && html(b); }
  else if (seg[0] === "state" && seg.length === 2) { const b = statePage(db, seg[1], url); res = b && html(b); }
  else if (seg[0] === "state" && seg.length === 3) { const b = cityPage(db, seg[1], seg[2], url); res = b && html(b); }

  if (!res) res = notFound();
  res.headers.set("x-portal-release", release);
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}
