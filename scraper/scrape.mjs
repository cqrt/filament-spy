#!/usr/bin/env node
/**
 * Filament Spy NZ — scraper
 *
 * Collects 3D-printer filament products from NZ retailers and writes:
 *   data/products.json  — normalised, enriched product list
 *   data/meta.json      — per-store scrape status for the app footer
 *
 * Zero dependencies. Requires Node 20+ (global fetch).
 * Run: node scraper/scrape.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MANUAL_DIR = path.join(DATA_DIR, 'manual');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 (compatible; FilamentSpyBot/1.0; +https://cqrt.github.io/filament-spy)';
const JINA = 'https://r.jina.ai/';
// Plain browser UA (no bot suffix) for endpoints behind Cloudflare.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { timeoutMs = 45000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
          'Accept-Language': 'en-NZ,en;q=0.9',
          ...headers,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, opts));

/**
 * Fetch via the system curl binary. r.jina.ai fingerprints and rejects both
 * Node's HTTP client and browser/bot user agents, but passes curl with its
 * default UA — so deliberately send no -A override. curl ships with Windows 10+
 * and with GitHub's ubuntu-latest runners.
 */
async function curlText(url, { timeoutMs = 60000, ua = null } = {}) {
  const args = ['-s', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000))];
  if (ua) args.push('-A', ua);
  args.push(url);
  const { stdout } = await execFileP('curl', args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5000 });
  return stdout;
}

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' };
function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
const stripHtml = (s = '') => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const money = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ */
/* Enrichment: material, colour, weight, brand                         */
/* ------------------------------------------------------------------ */

const MATERIALS = [
  ['HTPLA', /\bhtpla\b/i],
  ['PLA-CF', /\bpla[ -]?cf\b|pla carbon/i],
  ['PETG-CF', /\bpetg[ -]?cf\b|petg carbon/i],
  ['PLA+', /\bpla\s*(\+|plus|pro\b)/i],
  ['PETG', /\bpetg\b|\bepetg\b/i],
  ['ABS+', /\babs\s*(\+|plus)\b/i],
  ['ABS', /\babs\b|\babsmax\b|\beabs\b/i],
  ['ASA', /\basa\b/i],
  ['TPU', /\btpu\b/i],
  ['TPE', /\btpe\b/i],
  ['HIPS', /\bhips\b/i],
  ['PVA', /\bpva\b/i],
  ['PVB', /\bpvb\b/i],
  ['PCTG', /\bpctg\b/i],
  ['PC', /\bpc\b|polycarbonate/i],
  ['Nylon', /\bnylon\b|\bpa\d*\b|polyamide/i],
  ['PP', /\bpp\b|polypropylene/i],
  ['POM', /\bpom\b|acetal/i],
  ['PMMA', /\bpmma\b|acrylic/i],
  ['PET', /\bpet\b(?!g)|\bepet\b/i],
  ['PLA', /\bpla\b|\bepla\b|pla[ -]?(metal|wood|silk|gloss|matte|marble|galaxy)/i],
];

function detectMaterial(text) {
  for (const [name, re] of MATERIALS) if (re.test(text)) return name;
  return null;
}

// Canonical colour table. Aliases are matched longest-first.
const COLOURS = [
  ['White', '#f5f5f4', ['jade white', 'ivory white', 'white']],
  ['Black', '#171717', ['midnight black', 'jet black', 'black']],
  ['Grey', '#9ca3af', ['blue gray', 'blue grey', 'ash gray', 'ash grey', 'dark gray', 'dark grey', 'light gray', 'light grey', 'nardo gray', 'nardo grey', 'space gray', 'space grey', 'gray', 'grey']],
  ['Charcoal', '#374151', ['charcoal', 'graphite', 'anthracite']],
  ['Silver', '#c0c0c0', ['silver']],
  ['Red', '#dc2626', ['scarlet red', 'candy red', 'fire engine red', 'red']],
  ['Maroon', '#7f1d1d', ['maroon', 'burgundy', 'wine red', 'dark red']],
  ['Orange', '#f97316', ['pumpkin orange', 'mandarin orange', 'orange']],
  ['Yellow', '#facc15', ['lemon yellow', 'sunflower yellow', 'yellow']],
  ['Gold', '#d4af37', ['silk gold', 'iridium gold', 'gold']],
  ['Copper', '#b87333', ['copper']],
  ['Bronze', '#a97142', ['bronze']],
  ['Champagne', '#e2c290', ['champagne']],
  ['Green', '#16a34a', ['grass green', 'mistletoe green', 'bright green', 'bambu green', 'candy green', 'mint lime', 'green']],
  ['Mint', '#6ee7b7', ['mint']],
  ['Lime', '#a3e635', ['lime']],
  ['Olive', '#808000', ['olive', 'khaki']],
  ['Teal', '#14b8a6', ['teal']],
  ['Cyan', '#06b6d4', ['cyan']],
  ['Blue', '#2563eb', ['sky blue', 'ice blue', 'cobalt blue', 'marine blue', 'maine blue', 'dark blue', 'baby blue', 'silk blue', 'blue']],
  ['Navy', '#1e3a8a', ['navy']],
  ['Turquoise', '#40e0d0', ['turqoise', 'turquoise']],
  ['Purple', '#9333ea', ['indigo purple', 'lilac purple', 'purple']],
  ['Indigo', '#4f46e5', ['indigo']],
  ['Violet', '#8b5cf6', ['violet']],
  ['Lavender', '#b57edc', ['lavender', 'lilac']],
  ['Pink', '#ec4899', ['hot pink', 'sakura pink', 'silk pink', 'pink']],
  ['Magenta', '#d946ef', ['magenta']],
  ['Coral', '#fb7185', ['coral', 'salmon']],
  ['Brown', '#92400e', ['cocoa brown', 'dark chocolate', 'latte brown', 'chocolate', 'brown']],
  ['Tan', '#d2b48c', ['desert tan', 'tan']],
  ['Beige', '#e3d0ac', ['beige']],
  ['Cream', '#fffdd0', ['cream']],
  ['Ivory', '#fffff0', ['ivory']],
  ['Jade', '#00a86b', ['jade']],
  ['Clear', '#dbeafe', ['transparent', 'translucent', 'clear', 'natural']],
  ['Glow', '#bef264', ['glow in the dark', 'luminous', 'glow']],
  ['Rainbow', null, ['rainbow']],
  ['Multi', null, ['dual colour', 'dual color', 'tri colour', 'tri color', 'multicolour', 'multi colour', 'multi-colour', 'multicolor', 'gradient', 'silk dual', 'colour changing', 'color changing', 'chameleon', 'mixed', 'multi']],
  ['Colour Changing', null, ['uv colour', 'uv color', 'thermal']],
];

const COLOUR_LOOKUP = [];
for (const [canonical, hex, aliases] of COLOURS) {
  for (const alias of aliases) COLOUR_LOOKUP.push([alias, canonical, hex]);
}
COLOUR_LOOKUP.sort((a, b) => b[0].length - a[0].length);

function detectColour(text) {
  const t = ` ${text.toLowerCase()} `;
  for (const [alias, canonical, hex] of COLOUR_LOOKUP) {
    if (t.includes(alias)) return { colour: canonical, colourHex: hex };
  }
  return { colour: 'Other', colourHex: null };
}

function detectWeight(text) {
  let m = text.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*kg/i);
  if (m) return parseFloat(m[1]) * parseFloat(m[2]);
  // Multi-roll bundles ("6 Rolls Bundle") are 1kg rolls.
  m = text.match(/(\d+)\s*rolls?\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 2 && n <= 48) return n;
  }
  // PrestaShop slugs write 0.75kg as "075kg".
  m = text.match(/\b0(\d{2})\s*kg\b/i);
  if (m) return parseInt(m[1], 10) / 100;
  m = text.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (m) return parseFloat(m[1]);
  m = text.match(/(\d+(?:\.\d+)?)\s*g\b(?!m)/i);
  if (m) {
    const g = parseFloat(m[1]);
    if (g >= 30 && g <= 5000) return g / 1000;
  }
  return null;
}

const KNOWN_BRANDS = [
  'Bambu Lab', 'Polymaker', 'Protopasta', 'eSUN', 'SUNLU', 'Jaycar',
  'MakerBot', 'Ultimaker', 'Prusament', 'Formfutura', 'ColorFabb', 'Fillamentum',
  'ELEGOO', 'Creality', 'Anycubic', 'Flashforge', 'Overture', 'Hatchbox', 'Jamg He',
  'Kingroon', 'Geeetech', '3DEA', 'Pixel', 'Spool', 'KiwiFil', 'AzureFilm', 'Fiberlogy',
  'Nobufil', 'Spectrum', 'BASF', 'MatterHackers', 'Atomic', '3DXTech', 'LDO', 'Marvle3D',
];

// lowercase alias -> canonical brand name
const BRAND_ALIASES = new Map();
for (const b of KNOWN_BRANDS) BRAND_ALIASES.set(b.toLowerCase(), b);
BRAND_ALIASES.set('bambu labs', 'Bambu Lab');
BRAND_ALIASES.set('bambu', 'Bambu Lab');
BRAND_ALIASES.set('esun', 'eSUN');
BRAND_ALIASES.set('elegoo', 'ELEGOO');
BRAND_ALIASES.set('proto-pasta', 'Protopasta');
BRAND_ALIASES.set('kiwifil', 'KiwiFil');

function detectBrand(title, vendor) {
  const t = title.toLowerCase().trim();
  // 1. A brand at the very start of the title is authoritative — it beats the
  //    store vendor (e.g. Spool sells "Bambu PLA Lite" with vendor "Spool").
  for (const [alias, canonical] of BRAND_ALIASES) {
    if (t.startsWith(alias) && (t.length === alias.length || /[\s\-–|(]/.test(t[alias.length]))) {
      return canonical;
    }
  }
  // 2. Vendor (Shopify), canonicalised when recognisable.
  if (vendor && vendor.trim()) {
    const v = vendor.trim();
    return BRAND_ALIASES.get(v.toLowerCase()) || v;
  }
  // 3. Earliest known brand mentioned anywhere in the title.
  let best = null;
  let bestIdx = Infinity;
  for (const [alias, canonical] of BRAND_ALIASES) {
    const i = t.indexOf(alias);
    if (i >= 0 && i < bestIdx) {
      best = canonical;
      bestIdx = i;
    }
  }
  if (best) return best;
  const first = title.split(/\s[-–|]\s|\s/)[0];
  return first && first.length > 2 ? first : null;
}

// Remove compatibility notes like "(eSpool+ and Bambu Lab Reusable Spool
// compatible)" — they pollute brand search with other brands' names.
function cleanName(name) {
  return name
    .replace(/\s*\([^)]*\bcompatible\b[^)]*\)/gi, '')
    .replace(/\s*[-–—]\s*compatible with.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Surface finish (orthogonal to material).
function detectFinish(text) {
  if (/\bsilk\b/i.test(text)) return 'Silk';
  if (/\bmatte\b/i.test(text)) return 'Matte';
  return null;
}

// Refill (loose coil) vs spooled filament. Only tag what's explicit in the name.
function detectFormat(text) {
  if (/\brefills?\b|\brefilament\b|\bno spool\b|without (a )?spool/i.test(text)) return 'Refill';
  if (/\bwith\b[^,–—()]*spool|\((reusable )?spool\)|\bspooled\b|\/spool\b/i.test(text)) return 'Spooled';
  return null;
}

/* ------------------------------------------------------------------ */
/* Filament classification                                             */
/* ------------------------------------------------------------------ */

const FILAMENT_RE =
  /filament|\bpla\b|\bpetg\b|\babs\b|\basa\b|\btpu\b|\btpe\b|\bhips\b|\bpva\b|\bpvb\b|\bpctg\b|nylon|polycarbonate|htpla/i;
const EXCLUDE_RE =
  /dryer|nozzle|extruder|toolboard|hotend|stepper|motherboard|mainboard|\bcable|resin\b|\bglue\b|\btape\b|\bmotor\b|sensor|heater|thermistor|build ?plate|enclosure|\blaser\b|\bcnc\b|solder|arduino|raspberry|micro:bit|batter|charger|power supply|\bled\b|\bfan\b|gift ?card|\bkit(s)?\b.*(printer|tool)|printhead|bowden|coupler|fitting|nozz|spring|belt\b|pulley|bearing|magnet|adhesive|sheet\b|mat\b|spool holder|filament runout|detector|swatch/i;

function looksLikeFilament(text) {
  return FILAMENT_RE.test(text) && !EXCLUDE_RE.test(text);
}

/* ------------------------------------------------------------------ */
/* Store adapters                                                      */
/* ------------------------------------------------------------------ */

const SHOPIFY = [
  { key: 'spool', name: 'Spool', baseUrl: 'https://spool.co.nz', defaultWeightKg: 1 },
  { key: 'bits4bots', name: 'Bits4Bots', baseUrl: 'https://bits4bots.co.nz' },
];

async function scrapeShopify(store) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${store.baseUrl}/products.json?limit=250&page=${page}`;
    const data = await fetchJson(url);
    const products = data.products || [];
    if (!products.length) break;
    for (const p of products) {
      const text = `${p.title} ${p.product_type || ''} ${(p.tags || []).join(' ')}`;
      if (!looksLikeFilament(text)) continue;
      for (const v of p.variants || []) {
        const price = money(v.price);
        if (price == null) continue;
        const was = money(v.compare_at_price);
        // Per-variant image first (colour shots); fall back to the product's
        // linked image, then the product's first image.
        const image =
          v.featured_image?.src ||
          p.images?.find((img) => (img.variant_ids || []).includes(v.id))?.src ||
          p.images?.[0]?.src ||
          '';
        const variantName = v.title && v.title !== 'Default Title' ? v.title : '';
        const name = variantName && !p.title.toLowerCase().includes(variantName.toLowerCase())
          ? `${p.title} - ${variantName}`
          : p.title;
        out.push({
          id: `${store.key}-${v.id}`,
          name: decodeEntities(name).trim(),
          brand: detectBrand(p.title, p.vendor),
          store: store.key,
          storeName: store.name,
          url: `${store.baseUrl}/products/${p.handle}${v.id ? `?variant=${v.id}` : ''}`,
          image,
          price,
          wasPrice: was && was > price ? was : null,
          currency: 'NZD',
          inStock: v.available === true,
          variant: variantName,
          _weightHint: store.defaultWeightKg || null,
        });
      }
    }
    if (products.length < 250) break;
    await sleep(400);
  }
  return out;
}

async function scrape3dea() {
  const store = { key: '3dea', name: '3DEA', baseUrl: 'https://www.3dea.co.nz' };
  const out = [];
  const EXCLUDE_CATS = /resin|printer-parts|printer-kits|accessories|tools|gift-card|build-plate|dryer|nozzles|hotend|extruder/i;
  for (let page = 1; page <= 30; page++) {
    const url = `${store.baseUrl}/shop/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const products = await fetchJson(url);
    if (!Array.isArray(products) || !products.length) break;
    for (const p of products) {
      const cats = (p.categories || []).map((c) => c.slug).join(' ');
      const tags = (p.tags || []).map((t) => t.slug).join(' ');
      const text = `${p.name} ${cats} ${tags}`;
      if (EXCLUDE_CATS.test(cats)) continue;
      if (!looksLikeFilament(text)) continue;
      const minor = p.prices?.currency_minor_unit ?? 2;
      const div = 10 ** minor;
      const price = money(p.prices?.price) / div;
      if (!Number.isFinite(price) || price <= 0) continue;
      const regular = money(p.prices?.regular_price) / div;
      const attr = (n) => (p.attributes || []).find((a) => a.name?.toLowerCase() === n);
      const colourTerms = (attr('colour')?.terms || []).map((t) => t.name).join(' ');
      const materialAttr = (attr('material')?.terms || [])[0]?.name;
      const name = stripHtml(p.name);
      out.push({
        id: `${store.key}-${p.id}`,
        name,
        brand: detectBrand(name, p.brands?.[0]?.name || '3DEA'),
        store: store.key,
        storeName: store.name,
        url: p.permalink,
        image: p.images?.[0]?.src || '',
        price: Math.round(price * 100) / 100,
        wasPrice: p.on_sale && regular > price ? Math.round(regular * 100) / 100 : null,
        currency: 'NZD',
        inStock: p.is_in_stock === true,
        variant: '',
        _colourHint: colourTerms,
        _materialHint: materialAttr || '',
        _weightHint: money(p.weight) || null,
      });
    }
    if (products.length < 100) break;
    await sleep(400);
  }
  return out;
}

const MINDKITS_CATEGORIES = [
  '3D-Printer-Filament',
  'PLA-Filament.aspx',
  'PLA-Filament-2230.aspx',
  'PETG-Filament.aspx',
  'ABS-Filament.aspx',
  'ASA-Filament.aspx',
  'TPU-Filament.aspx',
  'Nylon-Filament.aspx',
  'Composite-Filament.aspx',
  'Polycarbonate-Filament.aspx',
  'Wood-Filament.aspx',
];

async function scrapeMindkits() {
  const store = { key: 'mindkits', name: 'Mindkits', baseUrl: 'https://www.mindkits.co.nz' };
  const out = [];
  const seen = new Set();
  const productRe =
    /<h4 class="productItem-caption-name[^"]*"><a href="([^"]+)">([\s\S]*?)<\/a><\/h4>([\s\S]*?)(?=<h4 class="productItem-caption-name|$)/g;
  for (const cat of MINDKITS_CATEGORIES) {
    for (let pi = 1; pi <= 12; pi++) {
      const pageUrl = pi > 1 ? `${store.baseUrl}/${cat}?pi=${pi}` : `${store.baseUrl}/${cat}`;
      let html;
      try {
        html = await fetchText(pageUrl);
      } catch (err) {
        break; // page beyond range or fetch issue — next category
      }
      let found = 0;
      for (const m of html.matchAll(productRe)) {
        const [, href, rawTitle, block] = m;
        const title = decodeEntities(rawTitle.replace(/<[^>]*>/g, '')).trim();
        if (!title || !looksLikeFilament(title)) continue;
        const price = money(block.match(/CategoryProductPrice'>\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
        if (price == null) continue;
        const was = money(block.match(/CategoryProductRetailPrice'>\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
        // Thumbnail is the img.CategoryProductThumbnail just above the caption
        // (an <input type=image> heart icon sits between them — don't grab that).
        const before = html.slice(Math.max(0, m.index - 2500), m.index);
        const imgMatch =
          before.match(/<img[^>]*class=['"]CategoryProductThumbnail['"][^>]*src=['"]([^'"]+)['"]/i) ||
          before.match(/<img[^>]*src=['"]([^'"]+)['"][^>]*class=['"]CategoryProductThumbnail['"]/i);
        const image = imgMatch
          ? decodeEntities(imgMatch[1])
              .replace(/^\/\//, 'https://')
              .replace(/^\//, `${store.baseUrl}/`)
              .replace(/([?&])(b?w)=\d+/g, '$1$2=600') // request a larger render
          : '';
        const fullUrl = href.startsWith('http') ? href : `${store.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);
        found++;
        out.push({
          id: `${store.key}-${seen.size}`,
          name: title,
          brand: detectBrand(title, null),
          store: store.key,
          storeName: store.name,
          url: fullUrl,
          image,
          price,
          wasPrice: was && was > price ? was : null,
          currency: 'NZD',
          inStock: null, // not reliably shown on category pages
          variant: '',
        });
      }
      if (found === 0) break; // no more pages in this category
      await sleep(500);
    }
    await sleep(400);
  }
  return out;
}

// Only the parent filament category: PrestaShop lists all child-category products under it.
const MARVLE_CATEGORY = '3-filament';
const MARVLE_EXCLUDE_CATS = /build-plate|filament-dryer|display-screen|printer-parts|accessories|combos|gift/i;

async function scrapeMarvle3d() {
  const store = { key: 'marvle3d', name: 'Marvle3D', baseUrl: 'https://marvle3d.co.nz' };
  const out = [];
  const seen = new Set();

  const pushProduct = ({ url, anchor, image, title, price, was, inStock }) => {
    const dbg = (why) => process.env.DEBUG && console.log(`    DROP(${why}) $${price} ${title} | ${url}`);
    if (!url || seen.has(url)) return dbg('dupe-or-no-url');
    if (MARVLE_EXCLUDE_CATS.test(url)) return dbg('excluded-cat');
    const id = (url.match(/\/(\d+(?:-\d+)?)-[^/]+\.html$/) || [])[1];
    if (!id) return dbg('no-id');
    if (price == null) return dbg('no-price');
    if (!title) return dbg('no-title');
    if (!looksLikeFilament(title)) return dbg(`not-filament:${title.match(EXCLUDE_RE)?.[0] || 'no-kw'}`);
    seen.add(url);
    const variant = (anchor || '')
      .split('/')
      .map((a) => a.replace(/^\d+-/, '').replace(/-/g, ' ').trim().replace(/^(colors?|colour)\s*/i, ''))
      .filter(Boolean)
      .join(', ');
    out.push({
      id: `${store.key}-${id}`,
      name: title,
      brand: detectBrand(title, null),
      store: store.key,
      storeName: store.name,
      url: url + (anchor || ''),
      image: image || '',
      price,
      wasPrice: was && was > price ? was : null,
      currency: 'NZD',
      inStock: inStock ?? null,
      variant,
      _colourHint: variant,
    });
  };

  // PrestaShop 1.7 product-list markup.
  const parseHtmlPage = (html) => {
    const blocks = html.split(/<article class="[^"]*js-product-miniature/).slice(1);
    for (const b of blocks) {
      const linkM = b.match(/<a href="(https:\/\/marvle3d\.co\.nz\/[^"]+?\.html)(#\/[^"]*)?" class="thumbnail product-thumbnail"/);
      if (!linkM) continue;
      const [, url, anchor] = linkM;
      const imgM = b.match(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"/);
      const titleM = b.match(/product-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/);
      const title = decodeEntities(
        (titleM ? titleM[1] : imgM?.[2] || '').replace(/<[^>]*>/g, '')
      ).trim();
      const price = money(b.match(/<span class="price"[^>]*>\s*\$?([\d,.]+)/)?.[1]);
      const was = money(b.match(/<span class="regular-price"[^>]*>\s*\$?([\d,.]+)/)?.[1]);
      const inStock = /out-of-stock hide/.test(b) ? true : /out-of-stock/.test(b) ? false : null;
      pushProduct({ url, anchor, image: imgM?.[1], title, price, was, inStock });
    }
    return {
      count: blocks.length,
      firstId: blocks[0]?.match(/data-id-product="(\d+)"/)?.[1] || null,
    };
  };

  // Reader-proxy fallback (page 1 only — the proxy cache ignores ?p=N).
  const scrapeViaProxy = async (target) => {
    let md = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(4000 * attempt);
      try {
        md = await curlText(`${JINA}${target}`);
      } catch {
        md = '';
      }
      if (md && md.length > 1000 && !/Just a moment|Enable JavaScript and cookies/i.test(md)) break;
      md = '';
    }
    if (!md) throw new Error('blocked by Cloudflare (direct + reader proxy)');
    const products = new Map();
    const itemRe =
      /!\[Image \d+:\s*([^\]]+)\]\((https:\/\/marvle3d\.co\.nz\/[^)\s]+?\.(?:jpg|jpeg|png|webp))\)\]\((https:\/\/marvle3d\.co\.nz\/[^)\s]+?\.html)(?:#\/([^)\s]+))?\)/g;
    for (const m of md.matchAll(itemRe)) {
      const [, altTitle, image, url, anchor] = m;
      if (!products.has(url)) {
        products.set(url, { url, anchor, image, title: decodeEntities(altTitle).trim(), end: m.index + m[0].length });
      }
    }
    const priceRe = /\$([\d,]+(?:\.\d+)?)\$([\d,]+(?:\.\d+)?)\s*Regular price|\$([\d,]+(?:\.\d+)?)\s*Price/g;
    const priceMatches = [...md.matchAll(priceRe)].map((m) => ({
      idx: m.index,
      price: money(m[1] || m[3]),
      was: m[2] ? money(m[2]) : null,
    }));
    let pIdx = 0;
    for (const e of products.values()) {
      while (pIdx < priceMatches.length && priceMatches[pIdx].idx < e.end) pIdx++;
      const pr = priceMatches[pIdx] || null;
      if (pIdx < priceMatches.length) pIdx++;
      pushProduct({ url: e.url, anchor: e.anchor, image: e.image, title: e.title, price: pr?.price ?? null, was: pr?.was ?? null, inStock: null });
    }
  };

  // Direct fetch passes Cloudflare with a browser UA; paginate until empty or wrapped.
  let firstPageId = null;
  for (let page = 1; page <= 15; page++) {
    const target = `${store.baseUrl}/${MARVLE_CATEGORY}${page > 1 ? `?page=${page}` : ''}`;
    let html = '';
    try {
      // curl passes Cloudflare's TLS fingerprinting where Node fetch cannot.
      html = await curlText(target, { ua: BROWSER_UA });
      if (/Just a moment|Enable JavaScript and cookies/i.test(html)) html = '';
    } catch {
      html = '';
    }
    if (!html) {
      if (page > 1) break; // keep what we have
      await scrapeViaProxy(target);
      break;
    }
    const { count, firstId } = parseHtmlPage(html);
    if (!count) break;
    if (page === 1) firstPageId = firstId;
    else if (firstId && firstId === firstPageId) break; // pagination wrapped to page 1
    await sleep(800);
  }
  return out;
}

async function scrapeJaycar() {
  // Jaycar is behind DataDome bot protection; attempt a plain fetch but expect failure.
  const res = await fetch('https://www.jaycar.co.nz/3d-printing-filament/c/450', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (DataDome bot protection)`);
  return []; // If it ever succeeds, parsing would go here.
}

/* ------------------------------------------------------------------ */
/* Manual files (data/manual/<store>.json)                             */
/* ------------------------------------------------------------------ */

async function loadManual() {
  const out = [];
  let files = [];
  try {
    files = await readdir(MANUAL_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.example.json')) continue;
    const key = f.replace(/\.json$/, '');
    try {
      const arr = JSON.parse(await readFile(path.join(MANUAL_DIR, f), 'utf8'));
      for (const p of arr) {
        if (p._note || typeof p.price !== 'number' || !p.name) continue;
        out.push({
          id: p.id || `manual-${key}-${out.length + 1}`,
          name: p.name,
          brand: p.brand || detectBrand(p.name, null),
          store: key,
          storeName: p.storeName || key,
          url: p.url || '',
          image: p.image || '',
          price: p.price,
          wasPrice: typeof p.wasPrice === 'number' && p.wasPrice > p.price ? p.wasPrice : null,
          currency: p.currency || 'NZD',
          inStock: typeof p.inStock === 'boolean' ? p.inStock : null,
          variant: p.variant || '',
        });
      }
      console.log(`  manual: loaded ${arr.length} entr${arr.length === 1 ? 'y' : 'ies'} from ${f}`);
    } catch (err) {
      console.warn(`  manual: failed to parse ${f}: ${err.message}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const ADAPTERS = [
  ...SHOPIFY.map((s) => ({ key: s.key, name: s.name, url: s.baseUrl, fn: () => scrapeShopify(s) })),
  { key: '3dea', name: '3DEA', url: 'https://www.3dea.co.nz', fn: scrape3dea },
  { key: 'mindkits', name: 'Mindkits', url: 'https://www.mindkits.co.nz', fn: scrapeMindkits },
  { key: 'marvle3d', name: 'Marvle3D', url: 'https://marvle3d.co.nz', fn: scrapeMarvle3d },
  { key: 'jaycar', name: 'Jaycar', url: 'https://www.jaycar.co.nz', fn: scrapeJaycar },
];

function enrich(p) {
  const text = `${p.name} ${p.variant || ''}`;
  const material = detectMaterial(`${p._materialHint || ''} ${text}`) || 'Other';
  const { colour, colourHex } = detectColour(`${p._colourHint || ''} ${text}`);
  const weightKg = detectWeight(text) || p._weightHint || null;
  const pricePerKg = weightKg ? Math.round((p.price / weightKg) * 100) / 100 : null;
  const finish = detectFinish(text);
  const format = detectFormat(text);
  const clean = {
    id: p.id,
    name: cleanName(p.name),
    brand: p.brand || null,
    material,
    colour,
    colourHex,
    weightKg,
    finish,
    format,
    store: p.store,
    storeName: p.storeName,
    url: p.url,
    image: p.image || '',
    price: p.price,
    wasPrice: p.wasPrice || null,
    pricePerKg,
    currency: p.currency || 'NZD',
    inStock: p.inStock,
  };
  clean.searchText = `${clean.name} ${clean.brand || ''} ${material} ${colour} ${finish || ''} ${format || ''} ${p.variant || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
}

async function main() {
  const startedAt = new Date();
  console.log(`Filament Spy scrape started ${startedAt.toISOString()}`);
  const all = [];
  const stores = {};

  // ONLY=spool,marvle3d node scraper/scrape.mjs — scrape a subset and print
  // results without touching data/products.json (for debugging adapters).
  const only = process.env.ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const adapters = only ? ADAPTERS.filter((a) => only.includes(a.key)) : ADAPTERS;

  for (const adapter of adapters) {
    const t0 = Date.now();
    process.stdout.write(`→ ${adapter.name} … `);
    try {
      const products = await adapter.fn();
      all.push(...products);
      stores[adapter.key] = {
        name: adapter.name,
        url: adapter.url,
        status: products.length ? 'ok' : 'empty',
        count: products.length,
        durationMs: Date.now() - t0,
      };
      console.log(`${products.length} products (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      stores[adapter.key] = {
        name: adapter.name,
        url: adapter.url,
        status: 'error',
        count: 0,
        error: err.message,
        durationMs: Date.now() - t0,
      };
      console.log(`FAILED: ${err.message}`);
    }
  }

  // Manual entries (e.g. jaycar)
  const manual = await loadManual();
  for (const p of manual) {
    all.push(p);
    if (!stores[p.store] || stores[p.store].status === 'error' || stores[p.store].count === 0) {
      stores[p.store] = {
        name: p.storeName,
        url: stores[p.store]?.url || '',
        status: 'manual',
        count: (stores[p.store]?.count || 0) + 1,
      };
    } else {
      stores[p.store].count += 1;
    }
  }

  // For stores that failed this run, keep their last-known-good products.
  let previous = [];
  try {
    previous = JSON.parse(await readFile(path.join(DATA_DIR, 'products.json'), 'utf8')).products || [];
  } catch { /* first run */ }
  for (const adapter of ADAPTERS) {
    const st = stores[adapter.key];
    if (!st || (st.status !== 'error' && st.status !== 'empty')) continue;
    const old = previous.filter((p) => p.store === adapter.key);
    if (old.length) {
      all.push(...old.map((o) => ({ ...o, _preEnriched: true })));
      stores[adapter.key] = { ...st, status: 'stale', count: old.length };
      console.log(`  ${adapter.name}: keeping ${old.length} products from previous run (stale)`);
    }
  }

  // De-dupe globally by id, then enrich.
  const byId = new Map();
  for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p);
  const products = [...byId.values()].map((p) =>
    p._preEnriched ? (({ _preEnriched, ...rest }) => rest)(p) : enrich(p)
  );
  products.sort((a, b) => (a.pricePerKg ?? a.price) - (b.pricePerKg ?? b.price));

  if (only) {
    console.log(`\nONLY mode (${only.join(', ')}): not writing data files. Sample:`);
    for (const p of products.slice(0, 20)) {
      console.log(`  $${p.price} ${p.wasPrice ? `(was $${p.wasPrice}) ` : ''}| ${p.name} | ${p.material} | ${p.colour} | ${p.weightKg ?? '?'}kg`);
    }
    console.log(`  … ${products.length} total`);
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(
    path.join(DATA_DIR, 'products.json'),
    JSON.stringify({ generatedAt, products }, null, 0)
  );
  await writeFile(
    path.join(DATA_DIR, 'meta.json'),
    JSON.stringify({ generatedAt, stores, productCount: products.length }, null, 2)
  );

  console.log(`\nDone: ${products.length} products from ${Object.keys(stores).length} stores`);
  console.log(`Wrote ${path.relative(ROOT, path.join(DATA_DIR, 'products.json'))} and meta.json`);

  // Non-zero exit only if every automatic store failed.
  const anyOk = Object.values(stores).some((s) => s.status === 'ok' && s.count > 0);
  if (!anyOk) {
    console.error('ERROR: every store failed to produce data');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
