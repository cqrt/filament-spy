// Jaycar browser scraper — uses real Chromium via Playwright to pass DataDome.
// Run LOCALLY (residential IP), not in CI:  node jaycar-browser.mjs
// Output: data/manual/jaycar.json  (merged by scrape.mjs automatically)
// Env: HEADLESS=0 shows the browser window (needed — DataDome blocks headless).
//      SLOW=1 doubles delays.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANUAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'manual');
const HEADLESS = process.env.HEADLESS !== '0' && false; // DataDome blocks headless: always headed
const PACE = process.env.SLOW ? 2 : 1;
const BASE = 'https://www.jaycar.co.nz';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => sleep((lo + Math.random() * (hi - lo)) * PACE * 1000);
const money = (s) => {
  const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};
const TILE = 'a[data-id="viewItemLink"]';

async function main() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled', '--start-minimized'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    viewport: { width: 1366, height: 850 },
  });
  const page = await ctx.newPage();

  const seen = new Set();
  const products = [];
  let zeroBatches = 0;

  const url = `${BASE}/search?q=filament`;
  console.log('visiting', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await jitter(4, 7);

  // DataDome interstitial: wait it out / reload a couple of times
  for (let attempt = 0; attempt < 3; attempt++) {
    let blocked = false;
    let tiles = 0;
    try {
      const html = await page.content();
      blocked = /datadome|captcha-delivery/i.test(html);
      tiles = await page.locator(TILE).count();
    } catch {
      await jitter(3, 5);
      continue; // page still navigating (DataDome redirect)
    }
    console.log(`attempt ${attempt + 1}: blocked=${blocked} tiles=${tiles}`);
    if (!blocked && tiles > 0) break;
    await jitter(8, 14);
    if (blocked) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  for (let pageIdx = 0; pageIdx < 30; pageIdx++) {

    // human-ish scroll for lazy content
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 500 + Math.random() * 400);
      await jitter(0.8, 1.8);
    }

    const tiles = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[data-id="viewItemLink"]')) {
        // climb to the card root (contains image + price + button)
        let card = a;
        for (let i = 0; i < 6; i++) {
          if (card.parentElement) card = card.parentElement;
          if (card.querySelector('picture img') && /\$\d/.test(card.innerText)) break;
        }
        const name = a.querySelector('span')?.textContent?.trim() || a.getAttribute('title')?.replace(/ details$/, '') || '';
        const amounts = [...card.innerText.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
        const img = card.querySelector('picture img')?.src || '';
        const btn = card.querySelector('button[data-id="addToCartButton"]');
        const inStock = btn ? btn.getAttribute('aria-disabled') !== 'true' : null;
        out.push({ href: a.href, name, amounts, img, inStock, text: card.innerText });
      }
      return out;
    });

    let added = 0;
    for (const t of tiles) {
      const sku = t.href.match(/\/p\/([A-Za-z0-9]+)/)?.[1] || t.href;
      if (seen.has(sku)) continue;
      if (!t.name || !t.amounts.length) continue;
      if (!/filament|pla\b|petg|abs\b|asa\b|tpu|nylon|hips|pv[ab]\b|polycast|pc\b/i.test(t.name)) continue;
      if (/resin/i.test(t.name) && !/filament/i.test(t.name)) continue;
      const price = t.amounts[0];
      const was = t.amounts.find((v) => v > price) || null;
      seen.add(sku);
      added++;
      products.push({
        id: `jaycar-${sku}`,
        name: t.name.replace(/\s+/g, ' '),
        store: 'jaycar',
        storeName: 'Jaycar',
        url: t.href,
        image: t.img,
        price,
        wasPrice: was,
        currency: 'NZD',
        inStock: t.inStock,
        variant: '',
      });
    }
    const showing = await page.evaluate(() => {
      const m = document.body.innerText.match(/Showing (\d+) of (\d+)/);
      return m ? { shown: +m[1], total: +m[2] } : null;
    });
    console.log(`batch ${pageIdx}: +${added} new SKUs (total ${products.length})${showing ? ` | site says ${showing.shown}/${showing.total}` : ''}`);
    if (showing && showing.shown >= showing.total) break;
    if (added === 0) {
      zeroBatches++;
      if (zeroBatches >= 2 && pageIdx > 0) break; // two empty batches: tail is all accessories
    } else zeroBatches = 0;

    // click "Load More"
    const more = page.locator('button[aria-label="Load More"]').first();
    if ((await more.count()) === 0) break;
    try {
      await more.scrollIntoViewIfNeeded();
      await jitter(1, 2);
      await more.click();
    } catch {
      break;
    }
    await jitter(3, 6);
  }

  await browser.close();

  if (!products.length) throw new Error('no products extracted — DataDome or markup change');
  mkdirSync(MANUAL_DIR, { recursive: true });
  writeFileSync(path.join(MANUAL_DIR, 'jaycar.json'), JSON.stringify(products, null, 2));
  console.log(`saved ${products.length} products to data/manual/jaycar.json`);
  for (const p of products.slice(0, 5)) console.log('  ', p.price, '|', p.name.slice(0, 60));
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
