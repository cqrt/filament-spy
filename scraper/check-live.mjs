import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const withCompat = d.filter((p) => /compatible/i.test(p.name)).length;
const bambuInName = d.filter((p) => /bambu/i.test(p.name) && p.brand !== 'Bambu Lab').length;
const esunRefil = d.filter((p) => /refilament/i.test(p.name));
console.log('local data: products:', d.length, '| names containing "compatible":', withCompat, '| non-Bambu products with bambu in name:', bambuInName);
for (const p of esunRefil.slice(0, 3)) console.log(' sample:', p.brand, '|', p.name);
const search = (q) => {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return d.filter((p) => tokens.every((t) => p.searchText.includes(t)));
};
const bp = search('bambu pla');
const bad = bp.filter((p) => p.brand !== 'Bambu Lab');
console.log('search "bambu pla":', bp.length, 'results, non-Bambu:', bad.length);
for (const p of bad.slice(0, 6)) console.log('  BAD:', p.brand, '|', p.name);
