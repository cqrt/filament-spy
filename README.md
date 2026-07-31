# 🕵️ Filament Spy NZ

A PriceSpy-style price comparison for **3D printer filament** in New Zealand. A single-page
static web app that lets you search and filter filament by **material, colour, brand, store
and price-per-kg** across NZ retailers, and surfaces the best deals.

**Live site:** https://cqrt.github.io/filament-spy

## Retailers

| Store | Method | Status |
|---|---|---|
| [spool.co.nz](https://spool.co.nz) | Shopify `products.json` API | ✅ Automatic |
| [bits4bots.co.nz](https://bits4bots.co.nz) | Shopify `products.json` API | ✅ Automatic |
| [3dea.co.nz](https://www.3dea.co.nz) | WooCommerce Store API | ✅ Automatic |
| [mindkits.co.nz](https://www.mindkits.co.nz) | Category page HTML | ✅ Automatic |
| [marvle3d.co.nz](https://marvle3d.co.nz) | PrestaShop category pages via curl ([r.jina.ai](https://r.jina.ai) reader proxy as fallback) | ✅ Automatic |
| [jaycar.co.nz](https://www.jaycar.co.nz) | Blocked by DataDome bot protection | ⚠️ Manual file only — see `data/manual/` |

## How it works

GitHub Pages can only serve static files and browsers block cross-site scraping (CORS), so
the data is collected **server-side** ahead of time:

1. `scraper/scrape.mjs` (Node 20+, zero dependencies) pulls every retailer's catalogue,
   normalises it (material, colour, brand, spool weight, $/kg, sale price, stock) and writes
   `data/products.json` + `data/meta.json`.
2. A GitHub Action (`.github/workflows/scrape.yml`) runs the scraper **twice a day** and
   commits the fresh data straight to this repo.
3. `index.html` — the entire app in one file, no build step — loads the JSON and gives you
   instant search, facet filters and deal sorting.

## Setup (one-time)

1. Create a GitHub repository named **`filament-spy`** under your account.
2. Push this code:
   ```sh
   git remote add origin https://github.com/cqrt/filament-spy.git
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from
   a branch"**, Branch: `main` / `(root)` → Save.
4. **Actions** tab → enable workflows → run **"Update filament data"** once manually
   (or push the included `data/products.json`).
5. Visit `https://<your-username>.github.io/filament-spy/` — done. Data now refreshes
   itself twice daily.

## Local development

```sh
# Regenerate the data (takes a couple of minutes)
node scraper/scrape.mjs

# Serve the app (any static server works)
python -m http.server 8000
# → http://localhost:8000
```

## Adding a store

- **Shopify stores** are one-liners: add an entry to the `SHOPIFY` list in
  `scraper/scrape.mjs`.
- **Other platforms**: write an adapter that returns normalised products
  (`{ name, brand, store, url, image, price, wasPrice, inStock, variant }`) — the enrichment
  pipeline (material/colour/weight/$-per-kg detection) is shared.
- **Stores that can't be scraped**: drop a `<storekey>.json` file of normalised products in
  `data/manual/` (see `jaycar.example.json`).

## Notes & disclaimer

- Prices are read from public catalogue pages/APIs and cached for ~12 hours; always confirm
  the final price (and shipping) on the retailer's site. All product names, prices and
  images remain the property of the respective retailers.
- Marvle3D's Cloudflare blocks Node's HTTP client but not curl with a browser user agent, so
  it is scraped directly; the free [r.jina.ai](https://r.jina.ai) reader proxy is used as a
  fallback. If a store fails during a run, its previous data is kept and flagged "stale".
- The scraper is deliberately gentle: a handful of requests per store, twice a day, with a
  descriptive user agent.
