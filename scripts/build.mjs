#!/usr/bin/env node
// Regenerates index.html from data/stations.json and stamps today's date.
// Run daily by .github/workflows/daily-refresh.yml so the page "updates every day".
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "stations.json"), "utf8"));
const { search } = data;

const enc = encodeURIComponent;
const slugify = (s) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// --- Portal deep-links (filters baked in: 3–4 bed houses, max £450,000) ---
function rightmove(name) {
  const q = new URLSearchParams({
    searchType: "SALE",
    useLocationIdentifier: "false",
    searchLocation: `${name} Station`,
    radius: "0.5",
    minBedrooms: String(search.bedroomsMin),
    maxBedrooms: String(search.bedroomsMax),
    maxPrice: String(search.budgetMax),
    propertyTypes: "detached,semi-detached,terraced",
    primaryDisplayPropertyType: "houses",
    sortType: "6", // newest listed first
    includeSSTC: "false",
  });
  return `https://www.rightmove.co.uk/property-for-sale/find.html?${q}`;
}
function zoopla(name, slug) {
  const q = new URLSearchParams({
    beds_min: String(search.bedroomsMin),
    beds_max: String(search.bedroomsMax),
    price_max: String(search.budgetMax),
    q: name,
    results_sort: "newest_listings",
    search_source: "for-sale",
  });
  return `https://www.zoopla.co.uk/for-sale/houses/${slug}/?${q}`;
}
function onthemarket(name, slug) {
  const q = new URLSearchParams({
    "min-bedrooms": String(search.bedroomsMin),
    "max-bedrooms": String(search.bedroomsMax),
    "max-price": String(search.budgetMax),
    "sort-field": "update_date",
  });
  return `https://www.onthemarket.com/for-sale/houses/${slug}/?${q}`;
}

const gbp = (n) => "£" + n.toLocaleString("en-GB");
const now = new Date();
const stamp = now.toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
  timeZone: "Europe/London",
});
const iso = now.toISOString();

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function stationCard(st) {
  const slug = st.slug || slugify(st.name);
  return `        <article class="station">
          <div class="station__head">
            <h3>${esc(st.name)}</h3>
            <span class="tt" title="Approx. journey time to ${esc(search.destination)}">${st.toCanaryWharf} min to ${esc(search.destination)}</span>
          </div>
          <p class="station__note">${esc(st.note)}</p>
          <div class="portals">
            <a class="portal portal--rm" href="${rightmove(st.name)}" target="_blank" rel="noopener">Rightmove</a>
            <a class="portal portal--zp" href="${zoopla(st.name, slug)}" target="_blank" rel="noopener">Zoopla</a>
            <a class="portal portal--otm" href="${onthemarket(st.name, slug)}" target="_blank" rel="noopener">OnTheMarket</a>
          </div>
        </article>`;
}

function branchSection(b) {
  return `      <section class="branch${b.primary ? " branch--primary" : ""}" id="${b.id}">
        <div class="branch__head">
          <h2>${esc(b.name)}</h2>
          <p>${esc(b.blurb)}</p>
        </div>
        <div class="stations">
${b.stations.map(stationCard).join("\n")}
        </div>
      </section>`;
}

const inner = `<div class="wrap">
  <header class="hero">
    <p class="eyebrow">Live property search · refreshed daily</p>
    <h1>${esc(search.title)}</h1>
    <ul class="criteria">
      <li><strong>${search.bedroomsMin}–${search.bedroomsMax}</strong> bedroom <strong>houses</strong></li>
      <li>Max <strong>${gbp(search.budgetMax)}</strong></li>
      <li>Direct to <strong>${esc(search.destination)}</strong> on the Elizabeth line</li>
    </ul>
    <p class="refreshed">Last refreshed <time datetime="${iso}">${stamp}</time> · every button opens the current, filtered live results.</p>
  </header>

  <nav class="jump">
    ${data.branches.map((b) => `<a href="#${b.id}">${esc(b.name.split("—")[0].trim())}</a>`).join("\n    ")}
  </nav>

  <main>
${data.branches.map(branchSection).join("\n\n")}
  </main>

  <footer class="foot">
    <p>Filters (3–4 bed houses, max ${gbp(search.budgetMax)}) are baked into every link. Clicking opens live results on each portal, so prices and availability are always current.</p>
    <p>Travel times are approximate off-peak Elizabeth line journeys to ${esc(search.destination)}.</p>
  </footer>
</div>

<style>
  :root{
    --bg:#f6f7f9; --panel:#ffffff; --ink:#161a1d; --muted:#5b6570; --line:#e4e7eb;
    --brand:#5a2d82; --brand-ink:#ffffff; --accent:#0b7a75;
    --rm:#00deb6; --rm-ink:#04352e; --zp:#8046f1; --zp-ink:#ffffff; --otm:#e8511d; --otm-ink:#ffffff;
    --shadow:0 1px 2px rgba(16,24,32,.06),0 6px 20px rgba(16,24,32,.06);
  }
  :root:not([data-theme="light"]){}
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#0f1216; --panel:#171b21; --ink:#eef1f4; --muted:#9aa4b0; --line:#262c34;
      --brand:#b98ce0; --brand-ink:#1a0f27; --accent:#3fd0c9;
      --rm:#00deb6; --rm-ink:#04352e; --zp:#a985f5; --zp-ink:#160a2e; --otm:#ff6a3c; --otm-ink:#2a0d03;
      --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
    }
  }
  :root[data-theme="dark"]{
    --bg:#0f1216; --panel:#171b21; --ink:#eef1f4; --muted:#9aa4b0; --line:#262c34;
    --brand:#b98ce0; --brand-ink:#1a0f27; --accent:#3fd0c9;
    --rm:#00deb6; --rm-ink:#04352e; --zp:#a985f5; --zp-ink:#160a2e; --otm:#ff6a3c; --otm-ink:#2a0d03;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1040px;margin:0 auto;padding:clamp(20px,4vw,44px) clamp(16px,4vw,28px) 64px;}
  .hero{margin-bottom:28px}
  .eyebrow{margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;color:var(--accent)}
  .hero h1{margin:0 0 16px;font-size:clamp(24px,3.6vw,36px);line-height:1.2;letter-spacing:-.01em}
  .criteria{list-style:none;display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px;padding:0}
  .criteria li{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px;box-shadow:var(--shadow)}
  .refreshed{margin:0;color:var(--muted);font-size:14px}
  .jump{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px}
  .jump a{font-size:13px;text-decoration:none;color:var(--ink);background:var(--panel);border:1px solid var(--line);
    border-radius:8px;padding:7px 12px;box-shadow:var(--shadow)}
  .jump a:hover{border-color:var(--brand)}
  .branch{margin:0 0 34px}
  .branch__head h2{margin:0 0 4px;font-size:clamp(18px,2.4vw,22px)}
  .branch__head p{margin:0 0 16px;color:var(--muted);font-size:14px}
  .branch--primary .branch__head h2{color:var(--brand)}
  .branch--primary{background:linear-gradient(180deg,color-mix(in srgb,var(--brand) 8%,var(--panel)),var(--panel));
    border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:var(--shadow)}
  .stations{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
  .station{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow);
    display:flex;flex-direction:column;gap:10px}
  .station__head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .station__head h3{margin:0;font-size:17px}
  .tt{flex:none;font-size:11px;font-weight:700;color:var(--accent);white-space:nowrap}
  .station__note{margin:0;font-size:13px;color:var(--muted);flex:1}
  .portals{display:flex;flex-wrap:wrap;gap:8px}
  .portal{flex:1 1 auto;text-align:center;text-decoration:none;font-weight:700;font-size:13px;
    padding:9px 10px;border-radius:9px;border:1px solid transparent;transition:transform .05s ease}
  .portal:active{transform:translateY(1px)}
  .portal--rm{background:var(--rm);color:var(--rm-ink)}
  .portal--zp{background:var(--zp);color:var(--zp-ink)}
  .portal--otm{background:var(--otm);color:var(--otm-ink)}
  .foot{margin-top:24px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
  .foot p{margin:0 0 6px}
</style>
`;

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(search.title)}</title>
<meta name="description" content="Daily-refreshed live search for ${search.bedroomsMin}–${search.bedroomsMax} bedroom houses under ${gbp(search.budgetMax)} near Abbey Wood and Elizabeth line stations direct to ${esc(search.destination)}.">
</head>
<body>
${inner}</body>
</html>
`;

writeFileSync(join(root, "index.html"), doc);
console.log(`Built index.html — refreshed ${stamp}`);

// Optional body-only preview (for an Artifact) when PREVIEW_OUT is set.
if (process.env.PREVIEW_OUT) {
  writeFileSync(process.env.PREVIEW_OUT, inner);
  console.log(`Wrote preview to ${process.env.PREVIEW_OUT}`);
}
