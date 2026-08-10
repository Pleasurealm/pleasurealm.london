#!/usr/bin/env node
// Regenerates index.html from data/stations.json (+ optional data/listings.json)
// and stamps today's date. Run daily by .github/workflows/daily-refresh.yml.
//
// LIST MODE:
//   - If data/listings.json exists, real property rows are rendered under each
//     station (price / beds / type / address / agent / link), sorted by price.
//   - If it does not, each station shows a live-search row whose buttons open
//     the current, filtered results on Rightmove / Zoopla / OnTheMarket.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "stations.json"), "utf8"));
const { search } = data;

let listings = { updated: null, byStation: {} };
const listingsPath = join(root, "data", "listings.json");
if (existsSync(listingsPath)) {
  try { listings = JSON.parse(readFileSync(listingsPath, "utf8")); }
  catch (e) { console.warn("Could not parse listings.json:", e.message); }
}
const listingsFor = (name) =>
  (listings.byStation && listings.byStation[name] ? listings.byStation[name] : [])
    .slice()
    .sort((a, b) => (a.price || 0) - (b.price || 0));
const totalListings = Object.values(listings.byStation || {}).reduce((n, a) => n + a.length, 0);

const enc = encodeURIComponent;
const slugify = (s) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// --- Portal deep-links (filters baked in: 3–4 bed houses, max £450,000) ---
function rightmove(name) {
  const q = new URLSearchParams({
    searchType: "SALE", useLocationIdentifier: "false",
    searchLocation: `${name} Station`, radius: "0.5",
    minBedrooms: String(search.bedroomsMin), maxBedrooms: String(search.bedroomsMax),
    maxPrice: String(search.budgetMax),
    propertyTypes: "detached,semi-detached,terraced",
    primaryDisplayPropertyType: "houses", sortType: "6", includeSSTC: "false",
  });
  return `https://www.rightmove.co.uk/property-for-sale/find.html?${q}`;
}
function zoopla(name, slug) {
  const q = new URLSearchParams({
    beds_min: String(search.bedroomsMin), beds_max: String(search.bedroomsMax),
    price_max: String(search.budgetMax), q: name,
    results_sort: "newest_listings", search_source: "for-sale",
  });
  return `https://www.zoopla.co.uk/for-sale/houses/${slug}/?${q}`;
}
function onthemarket(name, slug) {
  const q = new URLSearchParams({
    "min-bedrooms": String(search.bedroomsMin), "max-bedrooms": String(search.bedroomsMax),
    "max-price": String(search.budgetMax), "sort-field": "update_date",
  });
  return `https://www.onthemarket.com/for-sale/houses/${slug}/?${q}`;
}

const gbp = (n) => "£" + Number(n).toLocaleString("en-GB");
const now = new Date();
const stamp = now.toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London",
});
const iso = now.toISOString();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function listingRow(p) {
  const bits = [];
  if (p.beds) bits.push(`${p.beds} bed`);
  if (p.type) bits.push(esc(p.type));
  if (p.agent) bits.push(esc(p.agent));
  if (p.added) bits.push(`added ${esc(p.added)}`);
  const meta = bits.join(" · ");
  const href = p.url ? ` href="${esc(p.url)}" target="_blank" rel="noopener"` : "";
  return `            <li class="lst"><a class="lst__link"${href}>
              <span class="lst__price">${p.price ? gbp(p.price) : "POA"}</span>
              <span class="lst__addr">${esc(p.address || "Address on portal")}</span>
              <span class="lst__meta">${meta}</span>
            </a></li>`;
}

function stationBlock(st, branch) {
  const slug = st.slug || slugify(st.name);
  const rows = listingsFor(st.name);
  const hay = esc(`${st.name} ${branch.name} ${st.note} ${rows.map((r) => r.address || "").join(" ")}`).toLowerCase();
  const listBody = rows.length
    ? `          <ul class="listings">
${rows.map(listingRow).join("\n")}
          </ul>`
    : `          <p class="empty">No stored rows yet — open the live results:</p>`;
  return `        <div class="station" data-search="${hay}">
          <div class="station__row">
            <div class="station__id">
              <h3>${esc(st.name)}</h3>
              <span class="tt">${st.toCanaryWharf} min → ${esc(search.destination)}</span>
              ${rows.length ? `<span class="count">${rows.length} listing${rows.length === 1 ? "" : "s"}</span>` : ""}
            </div>
            <div class="portals">
              <a class="portal portal--rm" href="${rightmove(st.name)}" target="_blank" rel="noopener">Rightmove</a>
              <a class="portal portal--zp" href="${zoopla(st.name, slug)}" target="_blank" rel="noopener">Zoopla</a>
              <a class="portal portal--otm" href="${onthemarket(st.name, slug)}" target="_blank" rel="noopener">OnTheMarket</a>
            </div>
          </div>
          <p class="station__note">${esc(st.note)}</p>
${listBody}
        </div>`;
}

function branchSection(b) {
  return `      <section class="branch${b.primary ? " branch--primary" : ""}" id="${b.id}">
        <div class="branch__head">
          <h2>${esc(b.name)}</h2>
          <p>${esc(b.blurb)}</p>
        </div>
        <div class="stations">
${b.stations.map((st) => stationBlock(st, b)).join("\n")}
        </div>
      </section>`;
}

const countLine = totalListings
  ? `<strong>${totalListings}</strong> live listings across the line`
  : `live searches — one row per station`;
const listingsUpdated = listings.updated
  ? ` · listings pulled ${esc(new Date(listings.updated).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" }))}`
  : "";

const inner = `<div class="wrap">
  <header class="hero">
    <p class="eyebrow">Live list · refreshed daily</p>
    <h1>${esc(search.title)}</h1>
    <ul class="criteria">
      <li><strong>${search.bedroomsMin}–${search.bedroomsMax}</strong> bed <strong>houses</strong></li>
      <li>Max <strong>${gbp(search.budgetMax)}</strong></li>
      <li>Direct to <strong>${esc(search.destination)}</strong></li>
      <li class="criteria__count">${countLine}</li>
    </ul>
    <p class="refreshed">Last refreshed <time datetime="${iso}">${stamp}</time>${listingsUpdated}</p>
    <input id="filter" class="filter" type="search" placeholder="Filter the list — station, area, address…" autocomplete="off">
  </header>

  <nav class="jump">
    ${data.branches.map((b) => `<a href="#${b.id}">${esc(b.name.split("—")[0].trim())}</a>`).join("\n    ")}
  </nav>

  <main>
${data.branches.map(branchSection).join("\n\n")}
  </main>

  <footer class="foot">
    <p>Filters (${search.bedroomsMin}–${search.bedroomsMax} bed houses, max ${gbp(search.budgetMax)}) are baked into every portal link — clicking opens live results, so prices and availability are always current.</p>
    <p>Travel times are approximate off-peak Elizabeth line journeys to ${esc(search.destination)}.</p>
  </footer>
</div>

<style>
  :root{
    --bg:#f6f7f9; --panel:#ffffff; --ink:#161a1d; --muted:#5b6570; --line:#e4e7eb;
    --brand:#5a2d82; --accent:#0b7a75;
    --rm:#00deb6; --rm-ink:#04352e; --zp:#8046f1; --zp-ink:#fff; --otm:#e8511d; --otm-ink:#fff;
    --shadow:0 1px 2px rgba(16,24,32,.06),0 6px 20px rgba(16,24,32,.06);
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#0f1216; --panel:#171b21; --ink:#eef1f4; --muted:#9aa4b0; --line:#262c34;
      --brand:#b98ce0; --accent:#3fd0c9;
      --rm:#00deb6; --rm-ink:#04352e; --zp:#a985f5; --zp-ink:#160a2e; --otm:#ff6a3c; --otm-ink:#2a0d03;
      --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
    }
  }
  :root[data-theme="dark"]{
    --bg:#0f1216; --panel:#171b21; --ink:#eef1f4; --muted:#9aa4b0; --line:#262c34;
    --brand:#b98ce0; --accent:#3fd0c9;
    --rm:#00deb6; --rm-ink:#04352e; --zp:#a985f5; --zp-ink:#160a2e; --otm:#ff6a3c; --otm-ink:#2a0d03;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1040px;margin:0 auto;padding:clamp(20px,4vw,44px) clamp(16px,4vw,28px) 64px;}
  .hero{margin-bottom:22px}
  .eyebrow{margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;color:var(--accent)}
  .hero h1{margin:0 0 14px;font-size:clamp(23px,3.5vw,34px);line-height:1.2;letter-spacing:-.01em}
  .criteria{list-style:none;display:flex;flex-wrap:wrap;gap:10px;margin:0 0 12px;padding:0}
  .criteria li{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px;box-shadow:var(--shadow)}
  .criteria__count{background:var(--brand)!important;color:#fff;border-color:transparent!important}
  .refreshed{margin:0 0 14px;color:var(--muted);font-size:14px}
  .filter{width:100%;padding:12px 14px;font-size:15px;border:1px solid var(--line);border-radius:12px;
    background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}
  .filter:focus{outline:2px solid var(--brand);outline-offset:1px}
  .jump{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}
  .jump a{font-size:13px;text-decoration:none;color:var(--ink);background:var(--panel);border:1px solid var(--line);
    border-radius:8px;padding:7px 12px;box-shadow:var(--shadow)}
  .jump a:hover{border-color:var(--brand)}
  .branch{margin:0 0 30px}
  .branch__head h2{margin:0 0 4px;font-size:clamp(18px,2.4vw,22px)}
  .branch__head p{margin:0 0 14px;color:var(--muted);font-size:14px}
  .branch--primary .branch__head h2{color:var(--brand)}
  .stations{display:flex;flex-direction:column;gap:10px}
  .station{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow)}
  .station__row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .station__id{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .station__id h3{margin:0;font-size:17px}
  .tt{font-size:12px;font-weight:700;color:var(--accent);white-space:nowrap}
  .count{font-size:12px;font-weight:700;background:var(--brand);color:#fff;border-radius:999px;padding:2px 9px}
  .station__note{margin:8px 0 0;font-size:13px;color:var(--muted)}
  .portals{display:flex;gap:7px;flex-wrap:wrap}
  .portal{text-decoration:none;font-weight:700;font-size:12.5px;padding:7px 12px;border-radius:8px;white-space:nowrap}
  .portal--rm{background:var(--rm);color:var(--rm-ink)}
  .portal--zp{background:var(--zp);color:var(--zp-ink)}
  .portal--otm{background:var(--otm);color:var(--otm-ink)}
  .listings{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
  .lst__link{display:grid;grid-template-columns:minmax(84px,auto) 1fr;grid-auto-rows:auto;column-gap:12px;
    text-decoration:none;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:9px 12px;background:var(--bg)}
  .lst__link:hover{border-color:var(--brand)}
  .lst__price{grid-row:1;font-weight:800;font-size:15px}
  .lst__addr{grid-row:1;font-size:14px;align-self:center}
  .lst__meta{grid-column:1 / -1;grid-row:2;color:var(--muted);font-size:12.5px;margin-top:2px}
  .empty{margin:10px 0 0;font-size:12.5px;color:var(--muted)}
  .foot{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
  .foot p{margin:0 0 6px}
  .no-match{display:none!important}
  .branch.no-match{display:none!important}
</style>

<script>
  (function(){
    var input=document.getElementById('filter');
    if(!input)return;
    input.addEventListener('input',function(){
      var q=input.value.trim().toLowerCase();
      document.querySelectorAll('.branch').forEach(function(branch){
        var any=false;
        branch.querySelectorAll('.station').forEach(function(st){
          var hit=!q||(st.getAttribute('data-search')||'').indexOf(q)!==-1;
          st.classList.toggle('no-match',!hit);
          if(hit)any=true;
        });
        branch.classList.toggle('no-match',!any);
      });
    });
  })();
</script>
`;

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(search.title)}</title>
<meta name="description" content="Daily-refreshed live list of ${search.bedroomsMin}-${search.bedroomsMax} bedroom houses under ${gbp(search.budgetMax)} near Abbey Wood and Elizabeth line stations direct to ${esc(search.destination)}.">
</head>
<body>
${inner}</body>
</html>
`;

writeFileSync(join(root, "index.html"), doc);
console.log(`Built index.html — ${stamp} — ${totalListings} listing rows`);

if (process.env.PREVIEW_OUT) {
  writeFileSync(process.env.PREVIEW_OUT, inner);
  console.log(`Wrote preview to ${process.env.PREVIEW_OUT}`);
}
