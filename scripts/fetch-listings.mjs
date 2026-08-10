#!/usr/bin/env node
// Pulls current for-sale listings into data/listings.json so the dashboard
// renders real property rows. Runs in the daily GitHub Action BEFORE build.mjs.
//
// Source: PropertyData (https://propertydata.co.uk/api) — a legitimate, keyed
// UK listings API that won't IP-block a CI runner. Set the key as a repo secret
// named PROPERTYDATA_KEY. With no key this script exits 0 and changes nothing,
// so the site simply stays in live-search mode.
//
// PropertyData's endpoint/field names can change — the ENDPOINT and the
// mapListing() adapter below are the two things to adjust if they do. Nothing
// here overwrites listings.json unless at least one station returns rows.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KEY = process.env.PROPERTYDATA_KEY;
if (!KEY) {
  console.log("PROPERTYDATA_KEY not set — leaving listings.json untouched (live-search mode).");
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { search, branches } = JSON.parse(readFileSync(join(root, "data", "stations.json"), "utf8"));
const stations = branches.flatMap((b) => b.stations);

const ENDPOINT = process.env.PROPERTYDATA_ENDPOINT || "https://api.propertydata.co.uk/sourced-properties";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map one provider record to our row shape. Kept forgiving: providers vary.
function mapListing(raw) {
  const price = Number(raw.price ?? raw.asking_price ?? raw.value ?? 0) || 0;
  const beds = Number(raw.bedrooms ?? raw.beds ?? raw.num_bedrooms ?? 0) || null;
  const type = raw.type ?? raw.property_type ?? raw.propertyType ?? null;
  const address = raw.address ?? raw.display_address ?? raw.title ?? null;
  const url = raw.url ?? raw.details_url ?? raw.link ?? null;
  const agent = raw.agent ?? raw.agent_name ?? raw.branch ?? null;
  const added = raw.first_published_date ?? raw.listed_date ?? raw.date ?? null;
  return { price, beds, type, address, url, agent, added: added ? String(added).slice(0, 10) : null };
}

function keep(row) {
  const okType = !row.type || /terrace|semi|detached|house|end of terrace|townhouse|bungalow/i.test(row.type);
  const okPrice = !row.price || row.price <= search.budgetMax;
  const okBeds = !row.beds || (row.beds >= search.bedroomsMin && row.beds <= search.bedroomsMax);
  return okType && okPrice && okBeds;
}

async function fetchStation(st) {
  const q = new URLSearchParams({
    key: KEY,
    postcode: st.outcode,
    max_price: String(search.budgetMax),
    min_beds: String(search.bedroomsMin),
    max_beds: String(search.bedroomsMax),
    type: "houses",
    results: "25",
  });
  const res = await fetch(`${ENDPOINT}?${q}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.warn(`  ${st.name} (${st.outcode}): HTTP ${res.status} — skipped`);
    return [];
  }
  const body = await res.json().catch(() => ({}));
  const arr = Array.isArray(body) ? body
    : body.properties || body.data || body.results || body.listings || [];
  const rows = arr.map(mapListing).filter(keep);
  console.log(`  ${st.name} (${st.outcode}): ${rows.length} rows`);
  return rows;
}

const byStation = {};
let total = 0;
for (const st of stations) {
  try {
    const rows = await fetchStation(st);
    if (rows.length) { byStation[st.name] = rows; total += rows.length; }
  } catch (e) {
    console.warn(`  ${st.name}: ${e.message} — skipped`);
  }
  await sleep(350); // be gentle with the API
}

if (total === 0) {
  console.log("No rows returned from any station — leaving listings.json untouched.");
  process.exit(0);
}

writeFileSync(
  join(root, "data", "listings.json"),
  JSON.stringify({ updated: new Date().toISOString(), source: "propertydata", byStation }, null, 2) + "\n",
);
console.log(`Wrote data/listings.json — ${total} rows across ${Object.keys(byStation).length} stations.`);
