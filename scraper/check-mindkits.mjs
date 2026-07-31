import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const mk = d.filter((p) => p.store === 'mindkits');
console.log('mindkits products:', mk.length);
const noImg = mk.filter((p) => !p.image);
console.log('without image:', noImg.length);
// group image URLs by pattern
const hosts = {};
for (const p of mk) {
  const m = (p.image || '').match(/https?:\/\/[^/]+(\/[^?]*)/);
  const key = m ? m[1].split('/').slice(0, 3).join('/') : '(none)';
  hosts[key] = (hosts[key] || 0) + 1;
}
console.log('image path prefixes:', hosts);
for (const p of mk.slice(0, 8)) console.log(' ', p.image, '|', p.name.slice(0, 50));
// duplicates? same image for many products
const counts = {};
for (const p of mk) counts[p.image] = (counts[p.image] || 0) + 1;
const dupes = Object.entries(counts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
console.log('\nmost reused image URLs:');
for (const [img, c] of dupes.slice(0, 6)) console.log(` ${c}x ${img}`);
