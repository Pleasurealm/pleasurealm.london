# Abbey Wood & Elizabeth line → Canary Wharf — live house search

A single-page dashboard of **live property searches** for **3–4 bedroom houses under £450,000**
near Abbey Wood and every Elizabeth line station with a direct train to **Canary Wharf**.

Each station has three buttons — **Rightmove**, **Zoopla**, **OnTheMarket** — and every button
opens that portal's *current, filtered* results (3–4 bed houses, max £450k, ~0.5 mile of the
station). Because the portals render live, prices and availability are always up to date.

## Why links instead of scraped listings?

Rightmove/Zoopla/OnTheMarket block automated scraping and offer no free API, so copying their
listings onto this page would be both fragile and against their terms. Live deep-links give you
genuinely current results with zero risk — the search happens in your browser, on the portal.

## The list

`index.html` is a filterable **list** — one row per station, grouped by Elizabeth line branch,
with a search box that filters by station, area, or address. Each row carries the three live
portal buttons.

### Real listing rows (optional)

The page is **data-ready**: if `data/listings.json` exists, each station shows actual property
rows (price / beds / type / address / agent / link, sorted by price) and the header shows a total
count. Without that file the list stays in live-search mode.

To populate real rows automatically every day, connect the [PropertyData API](https://propertydata.co.uk/api)
(legitimate, keyed, ~£28/mo with a free trial — it won't IP-block the CI runner the way scraping does):

1. Get an API key from PropertyData.
2. Add it as a repo secret named **`PROPERTYDATA_KEY`** (Settings → Secrets and variables → Actions).

That's it — the daily job runs `scripts/fetch-listings.mjs`, writes `data/listings.json`, and the
list fills with live rows. If PropertyData changes its endpoint or field names, adjust `ENDPOINT`
and `mapListing()` in that script. Nothing overwrites good data unless at least one station returns
rows.

> Scraping Rightmove/Zoopla directly is deliberately **not** implemented: it breaches their terms
> and their anti-bot blocks datacenter IPs, so a CI scraper returns nothing without a paid proxy.

## "Updates every day"

`.github/workflows/daily-refresh.yml` runs every morning (06:17 UTC): it fetches listings (if a key
is set), rebuilds `index.html`, refreshes the **Last refreshed** stamp, and commits any change. The
portal links are live on every click regardless.

## Editing the search

Everything lives in [`data/stations.json`](data/stations.json):

- `search` — budget, bedroom range, destination.
- `branches[].stations[]` — add/remove a station, tweak its `note`, `toCanaryWharf` minutes, or
  set a portal `slug` override if a portal uses a non-obvious URL slug.

Then rebuild:

```bash
node scripts/build.mjs
```

## Exposure-protection agent

`scripts/serus-scan.mjs` is a small autonomous agent that protects **Moses
Kityamuwesi Kisubika** and **Pleasurealm Ltd** from online exposure using
[Serus](https://serus.ai) (`https://api.serus.ai/v1`). Every morning it asks
Serus to scan for each subject's exposed personal data — OSINT footprint,
data-broker listings and dark-web breach hits — and records what it finds.

**What it does each run:**

- **Scans** each subject via Serus (OSINT, data-broker and dark-web).
- **Monitors** for change: it diffs against the previous run and reports how many
  exposures are **new**, how many were **resolved**, and — the important one — how
  many previously-removed items have **reappeared** (a common data-broker
  behaviour). New high/critical hits and any reappearance raise a GitHub Actions
  warning and, if configured, a webhook alert.
- **Tracks removal lifecycle** (`found → requested → in-progress → removed`) and,
  when auto-remove is on, re-requests removal for anything still listed.
- **Records a trend** — one aggregate point per day in
  [`data/exposure-history.json`](data/exposure-history.json) so you can see
  exposure going down over time.

**Privacy-by-design (this repo is public):**

- The only things committed are aggregates: [`data/exposure.json`](data/exposure.json)
  (counts, severities, categories, deltas), `data/exposure-history.json` (the
  trend) and `data/exposure-state.json` (**irreversible SHA-256 fingerprints**
  used purely for change detection). No names, emails, URLs, source sites or
  unmasked values ever land in the repo — the agent must not become the very
  exposure it exists to reduce.
- Raw (masked) findings are uploaded as a **private, 7-day GitHub artifact**,
  never committed. `.gitignore` blocks `*-raw.json` as a backstop.
- Sensitive identifiers to scan for (phone, address, personal emails) go in the
  **`SERUS_SUBJECTS_JSON`** secret and are merged in memory — never on disk. The
  committed [`data/serus-watch.json`](data/serus-watch.json) holds only
  already-public identifiers (legal name, company name, public domains).
- Any webhook alert body is aggregate-only (counts + severities), never PII.

**Setup:**

1. Create a Serus API key (Dashboard → Settings → Developer → API Keys, `ak_...`).
2. Add it as the repo secret **`SERUS_API_KEY`** (Settings → Secrets and variables → Actions).
3. *(Optional)* add **`SERUS_SUBJECTS_JSON`** with extra sensitive identifiers, e.g.
   `[{"id":"moses","identifiers":{"phones":["+44..."],"emails":["personal@..."]}}]`.
4. *(Optional)* set the repo **variable** `SERUS_AUTO_REMOVE` to `true` to let the
   agent open data-broker removal/opt-out requests for anything Serus marks
   removable. It is **off by default** — removals are outward-facing and spend
   Serus credits, so they stay opt-in.
5. *(Optional)* add the **`SERUS_ALERT_WEBHOOK`** secret (e.g. a Slack/Teams
   incoming webhook) to receive an aggregate alert when new high/critical
   exposures appear or a removed item reappears.

Without `SERUS_API_KEY` the agent is a no-op (exits 0, changes nothing).

`.github/workflows/serus-scan.yml` runs it daily at 05:42 UTC (and on demand via
*Run workflow*) and commits `data/exposure.json` only when it changes. Serus's
API paths/fields live in `EP` and `mapFinding()` inside the script — adjust those
two to match [docs.serus.ai](https://docs.serus.ai/) if the API changes, exactly
like the PropertyData adapter in `fetch-listings.mjs`.

> Note: this agent covers exposure of *personal/private* data (breaches, broker
> listings, doxxing-style leaks). It does not, and should not, be used to suppress
> lawful journalism or accurate public-interest reporting.

## Hosting

`index.html` is a self-contained static page (all CSS inline). Serve the repo root with any
static host. For GitHub Pages: **Settings → Pages → Deploy from branch → root**, and point the
`pleasurealm.london` domain at it.
