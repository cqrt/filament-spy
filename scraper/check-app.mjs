// Sanity checks: extract inline <script> from index.html and syntax-check it;
// validate data/products.json shape expected by the app.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = readFileSync('index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('no inline script found');
writeFileSync('scraper/.app-inline.js', m[1]);
execFileSync(process.execPath, ['--check', 'scraper/.app-inline.js'], { stdio: 'inherit' });
console.log('inline JS: syntax OK,', m[1].length, 'chars');

const data = JSON.parse(readFileSync('data/products.json', 'utf8'));
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
console.log('products:', data.products.length, 'generatedAt:', data.generatedAt);
const required = ['id', 'name', 'material', 'colour', 'store', 'storeName', 'url', 'price', 'searchText'];
const missing = data.products.filter((p) => required.some((k) => !(k in p)));
console.log('products missing required fields:', missing.length);
const badPrice = data.products.filter((p) => !(p.price > 0) || (p.wasPrice && p.wasPrice <= p.price));
console.log('suspicious prices:', badPrice.length);
const noImg = data.products.filter((p) => !p.image).length;
console.log('without image:', noImg);
const noWeight = data.products.filter((p) => !p.weightKg).length;
console.log('without weight:', noWeight, `(${(noWeight / data.products.length * 100).toFixed(1)}%)`);
const otherMat = data.products.filter((p) => p.material === 'Other').length;
const otherCol = data.products.filter((p) => p.colour === 'Other').length;
console.log('material=Other:', otherMat, `(${(otherMat / data.products.length * 100).toFixed(1)}%)`, ' colour=Other:', otherCol, `(${(otherCol / data.products.length * 100).toFixed(1)}%)`);
console.log('stores:', Object.entries(meta.stores).map(([k, s]) => `${k}:${s.status}:${s.count}`).join(' '));
// sample prices per kg sanity
const withKg = data.products.filter((p) => p.pricePerKg);
const crazy = withKg.filter((p) => p.pricePerKg < 3 || p.pricePerKg > 500);
console.log('pricePerKg sane:', withKg.length, 'outliers:', crazy.length);
for (const p of crazy.slice(0, 8)) console.log('  outlier:', p.pricePerKg, p.store, p.name.slice(0, 70), p.weightKg);
