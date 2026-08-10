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

## "Updates every day"

`.github/workflows/daily-refresh.yml` runs every morning (06:17 UTC), rebuilds `index.html`,
refreshes the **Last refreshed** date stamp, and commits any change. It's the daily heartbeat;
the searches themselves are live on every click.

## Editing the search

Everything lives in [`data/stations.json`](data/stations.json):

- `search` — budget, bedroom range, destination.
- `branches[].stations[]` — add/remove a station, tweak its `note`, `toCanaryWharf` minutes, or
  set a portal `slug` override if a portal uses a non-obvious URL slug.

Then rebuild:

```bash
node scripts/build.mjs
```

## Hosting

`index.html` is a self-contained static page (all CSS inline). Serve the repo root with any
static host. For GitHub Pages: **Settings → Pages → Deploy from branch → root**, and point the
`pleasurealm.london` domain at it.
