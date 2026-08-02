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
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * Run fn over items with a concurrency cap and a small stagger between tasks.
 */
async function mapLimit(items, limit, fn, staggerMs = 120) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      await fn(items[i++], i - 1);
      if (staggerMs) await sleep(staggerMs);
    }
  });
  await Promise.all(workers);
}

/* ------------------------------------------------------------------ */
/* Image cache: download each image once, serve from the repo           */
/* ------------------------------------------------------------------ */

const IMAGE_DIR = path.join(DATA_DIR, 'images');

function imageCacheName(url) {
  const ext = (url.match(/\.(jpe?g|png|webp|gif)(\?|#|$)/i)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  return `${hash}.${ext}`;
}

async function curlDownload(url, dest, { timeoutMs = 30000 } = {}) {
  await execFileP(
    'curl',
    ['-s', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', BROWSER_UA, '-o', dest, url],
    { timeout: timeoutMs + 5000 }
  );
}

async function looksLikeImageFile(file) {
  try {
    const fd = await open(file, 'r');
    const buf = Buffer.alloc(12);
    await fd.read(buf, 0, 12, 0);
    await fd.close();
    if (buf[0] === 0xff && buf[1] === 0xd8) return true; // jpeg
    if (buf[0] === 0x89 && buf[1] === 0x50) return true; // png
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return true;
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') return true;
    return false;
  } catch {
    return false;
  }
}

const fileExists = (f) => stat(f).then((s) => s.size > 0).catch(() => false);

/**
 * Download every remote product image exactly once into data/images/
 * (keyed by URL hash, so unchanged images are never re-fetched), rewrite
 * product image fields to the local paths, and prune cache files that are
 * no longer referenced. Failed downloads keep the original remote URL.
 */
async function cacheImages(products) {
  const urls = new Set();
  const referenced = new Set();
  for (const p of products) {
    if (/^https?:\/\//.test(p.image)) urls.add(p.image);
    else if (p.image.startsWith('data/images/')) referenced.add(p.image.slice('data/images/'.length));
  }
  await mkdir(IMAGE_DIR, { recursive: true });
  let downloaded = 0;
  let reused = 0;
  let failed = 0;
  let done = 0;
  const list = [...urls];
  for (const url of list) referenced.add(imageCacheName(url));
  await mapLimit(list, 4, async (url) => {
    const fname = imageCacheName(url);
    const dest = path.join(IMAGE_DIR, fname);
    if (await fileExists(dest)) {
      reused++;
    } else {
      try {
        await curlDownload(url, dest);
        if (!(await looksLikeImageFile(dest))) throw new Error('not an image');
        downloaded++;
      } catch {
        failed++;
        await rm(dest, { force: true }).catch(() => {});
      }
    }
    if (++done % 200 === 0) console.log(`  images: ${done}/${list.length} (${downloaded} new)`);
  });
  for (const p of products) {
    if (/^https?:\/\//.test(p.image) && (await fileExists(path.join(IMAGE_DIR, imageCacheName(p.image))))) {
      p.image = `data/images/${imageCacheName(p.image)}`;
    }
  }
  let pruned = 0;
  for (const f of await readdir(IMAGE_DIR).catch(() => [])) {
    if (!referenced.has(f)) {
      await rm(path.join(IMAGE_DIR, f), { force: true }).catch(() => {});
      pruned++;
    }
  }
  console.log(`Images: ${reused} cached, ${downloaded} downloaded, ${failed} failed, ${pruned} pruned`);
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
  ['HTPLA', /\bhtpla\d*\b/i],
  ['PLA-CF', /\be?pla[ -]?cf\b|pla carbon/i],
  ['PETG-CF', /\be?petg[ -]?cf\b|petg carbon|cr[ -]?carbon\b/i], // ePETG-CF, Creality CR-Carbon
  ['PAHT-CF', /\be?paht[ -]?cf\b/i],
  ['PPA-CF', /\bppa[ -]?cf\b/i],
  ['PLA+', /\bpla\s*(\+|plus|pro\b)/i],
  ['PETG', /\bpetg\b|\bepetg\b|\brpetg\b/i], // rPETG = recycled PETG (KiwiFil)
  ['ABS+', /\babs\s*(\+|plus)\b/i],
  ['ABS', /\babs\b|\babsmax\b|\beabs\b/i],
  ['ASA', /\basa\b/i],
  ['TPU 85A', /\be?tpu[ -]?85a?\b/i],
  ['TPU 87A', /\be?tpu[ -]?87a?\b/i],
  ['TPU 90A', /\be?tpu[ -]?90a?\b/i], // Polyflex TPU90
  ['TPU 92A', /\be?tpu[ -]?92a?\b/i],
  ['TPU 95A', /\be?tpu[ -]?95a?\b|\bcr[ -]?tpu\b/i], // eTPU 95A, Creality CR-TPU
  ['TPU 98A', /\be?tpu[ -]?98a?\b/i],
  ['TPU-LW', /\btpu[ -]?lw\b/i],
  ['TPU', /\btpu\b/i],
  ['TPE', /\btpe\b/i],
  ['HIPS', /\bhips\b/i],
  ['PVA', /\bpva\b|\baquatek\b/i], // AquaTek = water-soluble support (PVA)
  ['PVB', /\bpvb\b|\bpolycast\b/i], // Polymaker PolyCast = PVB
  ['PCTG', /\bpctg\b/i],
  ['PC', /\bpc\b|polycarbonate/i],
  ['Nylon', /\bnylon\b|\bpa\d*\b|polyamide/i],
  ['PEEK', /\be?peek\b/i],
  ['PPS', /\bpps\b|\bppsf\b|\bppsu\b/i],
  ['PEI', /\bpei\b|\bultem\b/i],
  ['PSU', /\bpsu\b/i],
  ['PEBA', /\bpeba\b/i],
  ['PVC', /\bpvc\b|polyvinyl chloride/i],
  ['PP', /\bpp\b|polypropylene/i],
  ['POM', /\bpom\b|acetal/i],
  ['PMMA', /\bpmma\b|acrylic/i],
  ['PET', /\bpet\b(?!g)|\bepet\b|\bemate\b/i], // eSUN eMATE = PET
  // rPLA = recycled PLA (KiwiFil). Silk is always PLA (no silk PETG exists).
  // Other PLA series: Panchroma, eTwinkling/Twinkling, CR-Wood/CR-Silk,
  // eMarble/Marble, Wood, eSUN Copper, MakerBot TOUGH.
  ['PLA', /\bpla\b|\bepla\b|\brpla\b|pla[ -]?(metal|wood|silk|gloss|matte|marble|galaxy)|\bsilk\b|\bpanchroma\b|e?twinkling\b|cr[ -]?(wood|silk)\b|\be?marble\b|\bwood\b|\bcopper\b|\btough\b/i],
];

function detectMaterial(text) {
  for (const [name, re] of MATERIALS) if (re.test(text)) return name;
  return null;
}

// eSUN's unlabelled series are all PLA: Gloss (PLA Gloss), Matte (ePLA-Matte),
// Silk (Silk PLA). Their PETG/ABS products are always labelled, so this only
// runs as a last resort when no material keyword was found anywhere.
function esunSeriesMaterial(text) {
  if (!/\besun\b/i.test(text)) return null;
  return /\b(gloss|matte|silk)\b/i.test(text) ? 'PLA' : null;
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
  ['Multi', null, ['dual colour', 'dual color', 'tri colour', 'tri color', 'multicolour', 'multi colour', 'multi-colour', 'multicolor', 'gradient', 'silk dual', 'colour changing', 'color changing', 'chameleon', 'chromapulse', 'bi-colour', 'bi-color', 'bi colour', 'bi color', 'tri-colour', 'tri-color', 'mixed', 'multi']],
  ['Colour Changing', null, ['uv colour', 'uv color', 'thermal']],
];

const COLOUR_LOOKUP = [];
for (const [canonical, hex, aliases] of COLOURS) {
  for (const alias of aliases) COLOUR_LOOKUP.push([alias, canonical, hex]);
}
COLOUR_LOOKUP.sort((a, b) => b[0].length - a[0].length);

// Colour pairs joined by '-' or '/' ("Purple-Pink", "Red/Gold") => Multi with
// both component colours. Known alias pairs (e.g. "Blue-Gray") stay a single
// colour. Everything else uses the single-colour alias table (multi aliases
// like "tri-colour" => Multi on their own).
const COLOUR_WORDS = [
  'white', 'black', 'grey', 'gray', 'silver', 'red', 'orange', 'yellow', 'gold',
  'copper', 'bronze', 'green', 'mint', 'lime', 'teal', 'cyan', 'blue', 'navy',
  'purple', 'violet', 'lavender', 'pink', 'magenta', 'coral', 'brown', 'tan',
  'beige', 'cream', 'ivory', 'jade', 'natural', 'rainbow',
];
const COLOUR_WORD_CANON = { gray: 'Grey', natural: 'Clear', rainbow: 'Rainbow' };
const canonicalOfColour = (w) =>
  COLOUR_WORD_CANON[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1).toLowerCase();
function detectColours(text) {
  const t = ` ${text.toLowerCase()} `;
  // Translucency is a finish, not a colour: strip those words so a real colour
  // can win ("Translucent Blue" => Blue). If nothing else remains, the alias
  // pass on the original text maps it to Clear.
  const stripped = t.replace(/\b(semi[- ]?translucent|translucent|transparent)\b/g, ' ');
  const pairRe = new RegExp(`\\b(${COLOUR_WORDS.join('|')})\\s*[-/]\\s*(${COLOUR_WORDS.join('|')})\\b`, 'i');
  const m = stripped.match(pairRe);
  if (m) {
    const spaceForm = `${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
    const aliasEntry = COLOUR_LOOKUP.find(([alias]) => alias === spaceForm);
    if (aliasEntry) {
      const [, canonical, hex] = aliasEntry;
      return { colour: canonical, colourHex: hex, colours: [canonical] };
    }
    const a = canonicalOfColour(m[1]);
    const b = canonicalOfColour(m[2]);
    if (a !== b) return { colour: 'Multi', colourHex: null, colours: ['Multi', a, b] };
  }
  for (const [alias, canonical, hex] of COLOUR_LOOKUP) {
    if (stripped.includes(alias)) return { colour: canonical, colourHex: hex, colours: [canonical] };
  }
  for (const [alias, canonical, hex] of COLOUR_LOOKUP) {
    if (t.includes(alias)) return { colour: canonical, colourHex: hex, colours: [canonical] };
  }
  return { colour: 'Other', colourHex: null, colours: ['Other'] };
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
  if (/\bwood\b|\bcr[ -]?wood\b/i.test(text)) return 'Wood';
  if (/\bmarble\b/i.test(text)) return 'Marble';
  if (/\b(semi[- ]?translucent|translucent|transparent)\b/i.test(text)) return 'Translucent';
  return null;
}

// Refill (loose coil) vs spooled filament. Only tag what's explicit in the name.
function detectFormat(text) {
  if (/\brefills?\b|\brefilament\b|\bno spool\b|without (a )?spool/i.test(text)) return 'Refill';
  if (/\bwith\b[^,–—()]*spool|\((reusable )?spool\)|\bspooled\b|\/spool\b/i.test(text)) return 'Spooled';
  return null;
}

// Filament diameter. 3mm is the older name for 2.85mm.
function detectDiameter(text) {
  if (/1\.75\s*mm/i.test(text)) return '1.75mm';
  if (/2\.85\s*mm|\b3\s*mm\b/i.test(text)) return '2.85mm';
  return null;
}

// Display label for a spool weight: 0.5kg -> "500g", 10kg -> "10kg".
function weightLabelOf(weightKg) {
  if (!weightKg) return null;
  return weightKg < 1 ? `${Math.round(weightKg * 1000)}g` : `${weightKg}kg`;
}

/* ------------------------------------------------------------------ */
/* Filament classification                                             */
/* ------------------------------------------------------------------ */

const FILAMENT_RE =
  /filament|\bpla\b|\bpetg\b|\babs\b|\basa\b|\btpu\b|\btpe\b|\bhips\b|\bpva\b|\bpvb\b|\bpctg\b|nylon|polycarbonate|htpla/i;
const EXCLUDE_RE =
  /dryer|nozzle|extruder|toolboard|hotend|stepper|motherboard|mainboard|\bcable|resin\b|\bglue\b|\btape\b|\bmotor\b|sensor|heater|thermistor|build ?plate|enclosure|\blaser\b|\bcnc\b|solder|arduino|raspberry|micro:bit|batter|charger|power supply|\bled\b|\bfan\b|gift ?card|\bkit(s)?\b.*(printer|tool)|printhead|bowden|coupler|fitting|nozz|spring|belt\b|pulley|bearing|magnet|adhesive|sheet\b|mat\b|spool holder|filament runout|detector|swatch|espool|master spool|filament (cutter|buffer)|desiccant|drying solution|drywise|dry ?box|cleaning filament/i;

function looksLikeFilament(text) {
  return FILAMENT_RE.test(text) && !EXCLUDE_RE.test(text);
}

// Sample-size listings (50g "Sample - ..." rolls, 0.1kg cleaning filament) —
// pointless in a price comparison, so they're dropped from the data entirely.
const isSampleProduct = (p) => /\bsample\b/i.test(p.name) || (p.weightKg != null && p.weightKg <= 0.1);

/* ------------------------------------------------------------------ */
/* Store adapters                                                      */
/* ------------------------------------------------------------------ */

const SHOPIFY = [
  { key: 'spool', name: 'Spool', baseUrl: 'https://spool.co.nz', defaultWeightKg: 1 },
  { key: 'bits4bots', name: 'Bits4Bots', baseUrl: 'https://bits4bots.co.nz' },
  { key: 'formtech', name: 'Formtech', baseUrl: 'https://www.formtech.co.nz' },
];

// Ask the Shopify CDN for a ~480px render instead of the full-size original.
const shopifySized = (url, width = 480) =>
  url && !/([?&])width=/.test(url) ? `${url}${url.includes('?') ? '&' : '?'}width=${width}` : url;

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
        const image = shopifySized(
          v.featured_image?.src ||
            p.images?.find((img) => (img.variant_ids || []).includes(v.id))?.src ||
            p.images?.[0]?.src ||
            ''
        );
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
          _descHint: stripHtml(p.body_html || '').slice(0, 300),
        });
      }
    }
    if (products.length < 250) break;
    await sleep(400);
  }
  return out;
}

// Pick the srcset variant closest to ~480w; fall back to thumbnail, then full src.
function pickSizedImage(img) {
  if (img?.srcset) {
    const entries = img.srcset
      .split(',')
      .map((s) => s.trim().match(/(\S+)\s+(\d+)w/))
      .filter(Boolean)
      .map((m) => ({ url: m[1], w: +m[2] }));
    if (entries.length) {
      entries.sort((a, b) => Math.abs(a.w - 480) - Math.abs(b.w - 480));
      return entries[0].url;
    }
  }
  return img?.thumbnail || img?.src || '';
}

const WOO_STORES = [
  {
    key: '3dea', name: '3DEA', baseUrl: 'https://www.3dea.co.nz', apiPath: '/shop/wp-json/wc/store/v1/products', gstRate: 1, weightHint: 'api',
    excludeCats: /resin|printer-parts|printer-kits|accessories|tools|gift-card|build-plate|dryer|nozzles|hotend|extruder/i,
  },
  {
    key: '3dps', name: '3D Printing Services', baseUrl: 'https://3dprintingservices.co.nz', apiPath: '/wp-json/wc/store/v1/products', gstRate: 1.15, weightHint: 'none', // prices are GST-exclusive; weight field is shipping weight
    excludeCats: /resin|printer-parts|printer-kits|accessories|tools|gift-card|build-plate|dryer|nozzles|hot-end|hotend|extruder/i,
  },
];

async function scrapeWoo(store) {
  const out = [];
  const EXCLUDE_CATS = store.excludeCats;
  for (let page = 1; page <= 30; page++) {
    const url = `${store.baseUrl}${store.apiPath}?per_page=100&page=${page}`;
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
      const price = (money(p.prices?.price) / div) * store.gstRate;
      if (!Number.isFinite(price) || price <= 0) continue;
      const regular = (money(p.prices?.regular_price) / div) * store.gstRate;
      const attr = (n) => (p.attributes || []).find((a) => a.name?.toLowerCase() === n);
      const colourTerms = (attr('colour')?.terms || []).map((t) => t.name).join(' ');
      const materialAttr = (attr('material')?.terms || [])[0]?.name;
      const name = stripHtml(p.name);
      out.push({
        id: `${store.key}-${p.id}`,
        name,
        brand: detectBrand(name, p.brands?.[0]?.name || store.name),
        store: store.key,
        storeName: store.name,
        url: p.permalink,
        image: pickSizedImage(p.images?.[0]),
        price: Math.round(price * 100) / 100,
        wasPrice: p.on_sale && regular > price ? Math.round(regular * 100) / 100 : null,
        currency: 'NZD',
        inStock: p.is_in_stock === true,
        variant: '',
        _colourHint: colourTerms,
        _materialHint: materialAttr || '',
        _weightHint: store.weightHint === 'api' ? money(p.weight) || null : null,
        _descHint: stripHtml(p.short_description || ''),
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
              .replace(/([?&])(b?w)=\d+/g, '$1$2=480') // request a card-sized render
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

// PB Tech: custom ASP.NET site, server-rendered cards, GST-inc price in the
// ginc block, stock counts in data attributes, pagination via ?pg=N.
const PBTECH_CATEGORIES = [
  'category/toys-hobbies-stem/3d-printers-cutters-engravers/3d-printer-filament-resins/3d-printer-filament',
  'category/consumables/ink/3d-printing-filament',
];

async function scrapePbtech() {
  const store = { key: 'pbtech', name: 'PB Tech', baseUrl: 'https://www.pbtech.co.nz' };
  const out = [];
  const seen = new Set();
  for (const cat of PBTECH_CATEGORIES) {
    let firstPageFirstCode = null;
    for (let pg = 1; pg <= 30; pg++) {
      const target = `${store.baseUrl}/${cat}${pg > 1 ? `?pg=${pg}` : ''}`;
      // Intermittent "Managed Security Challenge" (JS) — retry with backoff,
      // keep whatever was collected so far.
      let html = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(3000 * attempt);
        try {
          html = await curlText(target, { ua: BROWSER_UA });
        } catch {
          html = '';
        }
        if (html && !/Managed Security Challenge|Just a moment|Enable JavaScript and cookies/i.test(html)) break;
        html = '';
      }
      if (!html) break;
      const cards = html.split(/<div class="js-product-card/).slice(1);
      if (!cards.length) break;
      const firstCode = cards[0].match(/data-product-code="([^"]+)"/)?.[1];
      if (pg === 1) firstPageFirstCode = firstCode;
      else if (firstCode && firstCode === firstPageFirstCode) break; // wrapped
      for (const c of cards) {
        const code = c.match(/data-product-code="([^"]+)"/)?.[1];
        if (!code || seen.has(code)) continue;
        const title = decodeEntities(
          c.match(/class="product-image-thumb[^"]*"[^>]*alt="([^"]*)"/)?.[1] || ''
        ).trim();
        if (!title || !looksLikeFilament(title)) continue;
        const href = c.match(/<a href="(product\/[^"]+)" class="js-product-link/)?.[1];
        const gincIdx = c.indexOf('class="ginc"');
        const price = money((gincIdx >= 0 ? c.slice(gincIdx) : c).match(/full-price">\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
        if (price == null) continue;
        const pbStock = parseInt(c.match(/data-stock-pb="[^"]*?(\d+)/)?.[1] || '0', 10);
        const otherStock = parseInt(c.match(/data-stock-other="[^"]*?(\d+)/)?.[1] || '0', 10);
        const inStock = pbStock > 0 || otherStock > 0 ? true : c.includes('js-stock-info') ? false : null;
        // Full-size primary image: /thumbs/150/<folder>/<code>.webp -> /imgprod/<folder>/<code>.jpg
        const thumb =
          c.match(/<source[^>]*srcset="(https:\/\/www\.pbtech\.co\.nz\/thumbs\/150\/[^"\s]+?\.webp[^"\s]*)"/)?.[1] || '';
        const image = thumb ? thumb.replace('/thumbs/150/', '/imgprod/').replace(/\.webp.*$/, '.jpg') : '';
        seen.add(code);
        out.push({
          id: `${store.key}-${code}`,
          name: title,
          brand: detectBrand(title, null),
          store: store.key,
          storeName: store.name,
          url: href ? `${store.baseUrl}/${href}` : '',
          image,
          price,
          wasPrice: null, // category pages show a single "PB Tech price"
          currency: 'NZD',
          inStock,
          variant: '',
        });
      }
      await sleep(600);
    }
  }
  return out;
}

// 3D Max: OpenCart. The parent category lists the whole range (resin is
// filtered out by the classifier). Sale prices via price-new/price-old.
async function scrape3dmax() {
  const store = { key: '3dmax', name: '3D Max', baseUrl: 'https://3dmax.co.nz' };
  const out = [];
  const seen = new Set();
  let firstPageFirst = null;
  for (let page = 1; page <= 20; page++) {
    const target = `${store.baseUrl}/filament-resins${page > 1 ? `?page=${page}` : ''}`;
    let html = '';
    try {
      html = await curlText(target, { ua: BROWSER_UA });
    } catch {
      html = '';
    }
    if (!html) break;
    const cards = html.split(/<div class="product-layout/).slice(1);
    if (!cards.length) break;
    const firstTitle = cards[0].match(/<h4>\s*<a href="[^"]+">([^<]+)/)?.[1];
    if (page === 1) firstPageFirst = firstTitle;
    else if (firstTitle && firstTitle === firstPageFirst) break; // wrapped
    for (const c of cards) {
      const href = c.match(/<div class="image">\s*<a href="([^"]+)"/)?.[1]?.trim();
      const title = decodeEntities(c.match(/<h4>\s*<a href="[^"]+">([^<]+)/)?.[1] || '').trim();
      if (!href || !title || !looksLikeFilament(title)) continue;
      const pid = c.match(/cart\.add\('(\d+)'/)?.[1] || href.split('/').pop();
      if (seen.has(pid)) continue;
      const price = money(
        c.match(/<span class="price-new">\s*\$?([\d,]+(?:\.\d+)?)/)?.[1] ||
          c.match(/<p class="price">[\s\S]*?\$?([\d,]+(?:\.\d+)?)/)?.[1]
      );
      if (price == null) continue;
      const was = money(c.match(/<span class="price-old">\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
      // Full-size original: /image/cache/<path>-NNNxNNN.ext -> /image/catalog/<path>.ext
      const imgM = c.match(/<img src="(https:\/\/3dmax\.co\.nz\/image\/cache\/[^"]+?\.(?:jpe?g|png|webp))"/);
      const image = imgM
        ? imgM[1].replace(/\/image\/cache\/(.+?)-\d+x\d+\.(jpe?g|png|webp)$/, '/image/$1.$2')
        : c.match(/<img src="([^"]+)"/)?.[1] || '';
      const inStock = /out of stock|pre[- ]?order/i.test(c) ? false : true;
      seen.add(pid);
      out.push({
        id: `${store.key}-${pid}`,
        name: title,
        brand: detectBrand(title, null),
        store: store.key,
        storeName: store.name,
        url: href,
        image,
        price,
        wasPrice: was && was > price ? was : null,
        currency: 'NZD',
        inStock,
        variant: '',
        _descHint: stripHtml(c.match(/<p>([\s\S]*?)<\/p>/)?.[1] || ''),
      });
    }
    await sleep(600);
  }
  return out;
}

// Wondershop: custom site, single category page for the whole filament range.
// Blocks carry variant colour names, sale prices and explicit stock status.
async function scrapeWondershop() {
  const store = { key: 'wondershop', name: 'Wondershop', baseUrl: 'https://www.wondershop.nz' };
  const out = [];
  const seen = new Set();
  let html = '';
  try {
    html = await curlText(`${store.baseUrl}/c/filaments`, { ua: BROWSER_UA });
  } catch {
    html = '';
  }
  if (!html) throw new Error('fetch failed');
  for (const c of html.split(/<div id="prls_(prit_\d+_\d+)"/).slice(1)) {
    const title = decodeEntities(c.match(/<div class="name">\s*<a href="[^"]+">([^<]+)/)?.[1] || '').trim();
    if (!title || !looksLikeFilament(title)) continue;
    const href = c.match(/<a href="(\/i\/[^"]+\.html)"/)?.[1];
    if (!href) continue;
    const pid = c.match(/^(prit_\d+_\d+)/)?.[1] || href;
    if (seen.has(pid)) continue;
    const price = money(c.match(/<div class="price">\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
    if (price == null) continue;
    const was = money(c.match(/<span class="price-o">\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]);
    const variant = decodeEntities(c.match(/<div class="l dots">([^<]+)/)?.[1] || '').trim();
    const image = c.match(/<img src="(\/uploads\/[^"]+?)"/)?.[1] || '';
    const inStock = /Discontinued/i.test(c) ? false : /In Stock/i.test(c) ? true : null;
    seen.add(pid);
    out.push({
      id: `${store.key}-${pid}`,
      name: variant && !title.toLowerCase().includes(variant.toLowerCase()) ? `${title} - ${variant}` : title,
      brand: detectBrand(title, 'Wondershop'),
      store: store.key,
      storeName: store.name,
      url: `${store.baseUrl}${href}`,
      image: image ? `${store.baseUrl}${image}` : '',
      price,
      wasPrice: was && was > price ? was : null,
      currency: 'NZD',
      inStock,
      variant,
      _colourHint: variant,
    });
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
  ...WOO_STORES.map((w) => ({ key: w.key, name: w.name, url: w.baseUrl, fn: () => scrapeWoo(w) })),
  { key: 'mindkits', name: 'Mindkits', url: 'https://www.mindkits.co.nz', fn: scrapeMindkits },
  { key: 'marvle3d', name: 'Marvle3D', url: 'https://marvle3d.co.nz', fn: scrapeMarvle3d },
  { key: 'pbtech', name: 'PB Tech', url: 'https://www.pbtech.co.nz', fn: scrapePbtech },
  { key: '3dmax', name: '3D Max', url: 'https://3dmax.co.nz', fn: scrape3dmax },
  { key: 'wondershop', name: 'Wondershop', url: 'https://www.wondershop.nz', fn: scrapeWondershop },
  { key: 'jaycar', name: 'Jaycar', url: 'https://www.jaycar.co.nz', fn: scrapeJaycar },
];

function enrich(p) {
  const text = `${p.name} ${p.variant || ''}`;
  const material =
    detectMaterial(`${p._materialHint || ''} ${text}`) ||
    detectMaterial(p._descHint || '') ||
    esunSeriesMaterial(text) ||
    'Other';
  const { colour, colourHex, colours } = detectColours(`${p._colourHint || ''} ${text}`);
  const weightKg = detectWeight(text) || p._weightHint || null;
  const pricePerKg = weightKg ? Math.round((p.price / weightKg) * 100) / 100 : null;
  const finish = detectFinish(text);
  const format = detectFormat(text);
  const diameter = detectDiameter(text);
  const weightLabel = weightLabelOf(weightKg);
  const clean = {
    id: p.id,
    name: cleanName(p.name),
    brand: p.brand || null,
    material,
    colour,
    colourHex,
    colours,
    weightKg,
    weightLabel,
    diameter,
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
  clean.searchText = `${clean.name} ${clean.brand || ''} ${material} ${(colours || [colour]).join(' ')} ${finish || ''} ${format || ''} ${diameter || ''} ${weightLabel || ''} ${p.variant || ''}`
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

  // If a store returned suspiciously few products vs its best known run
  // (partial scrape behind bot protection), prefer its previous data over
  // the partial one. High-water marks persist in meta.json so the floor
  // never ratchets downward over successive bad runs.
  const HIGH_WATER_SEED = { marvle3d: 134 };
  let prevMeta = null;
  try {
    prevMeta = JSON.parse(await readFile(path.join(DATA_DIR, 'meta.json'), 'utf8'));
  } catch { /* first run */ }
  const highWater = {};
  for (const adapter of ADAPTERS) {
    highWater[adapter.key] = Math.max(
      HIGH_WATER_SEED[adapter.key] || 0,
      prevMeta?.stores?.[adapter.key]?.hw || 0,
      stores[adapter.key]?.count || 0
    );
    if (stores[adapter.key]) stores[adapter.key].hw = highWater[adapter.key];
  }
  for (const adapter of ADAPTERS) {
    const st = stores[adapter.key];
    if (!st || st.status !== 'ok') continue;
    const old = previous.filter((p) => p.store === adapter.key);
    if (old.length >= 30 && st.count < highWater[adapter.key] * 0.6) {
      for (let i = all.length - 1; i >= 0; i--) if (all[i].store === adapter.key) all.splice(i, 1);
      all.push(...old.map((o) => ({ ...o, _preEnriched: true })));
      stores[adapter.key] = { ...st, status: 'stale', count: old.length };
      console.log(`  ${adapter.name}: only ${st.count} products vs best ${highWater[adapter.key]} — keeping previous data (stale)`);
    }
  }

  // De-dupe globally by id, then enrich.
  const byId = new Map();
  for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p);
  const products = [...byId.values()].map((p) =>
    p._preEnriched ? (({ _preEnriched, ...rest }) => rest)(p) : enrich(p)
  );
  products.sort((a, b) => (a.pricePerKg ?? a.price) - (b.pricePerKg ?? b.price));

  // Drop sample-size listings entirely (50g rolls, cleaning filament).
  const keepProducts = products.filter((p) => !isSampleProduct(p));
  const dropped = products.length - keepProducts.length;
  if (dropped) console.log(`Dropped ${dropped} sample-size listings`);

  if (only) {
    console.log(`\nONLY mode (${only.join(', ')}): not writing data files. Sample:`);
    for (const p of products.slice(0, 20)) {
      console.log(`  $${p.price} ${p.wasPrice ? `(was $${p.wasPrice}) ` : ''}| ${p.name} | ${p.material} | ${p.colour} | ${p.weightKg ?? '?'}kg`);
    }
    console.log(`  … ${products.length} total`);
    return;
  }

  // Cache product images into the repo (one download per unique image, ever).
  if (!process.env.SKIP_IMAGES) await cacheImages(keepProducts);

  await mkdir(DATA_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(
    path.join(DATA_DIR, 'products.json'),
    JSON.stringify({ generatedAt, products: keepProducts }, null, 0)
  );
  await writeFile(
    path.join(DATA_DIR, 'meta.json'),
    JSON.stringify({ generatedAt, stores, productCount: keepProducts.length }, null, 2)
  );

  console.log(`\nDone: ${keepProducts.length} products from ${Object.keys(stores).length} stores`);
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
