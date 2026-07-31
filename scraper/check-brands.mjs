import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;

// Simulate app search: every token must appear in searchText
const search = (q) => {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return d.filter((p) => tokens.every((t) => p.searchText.includes(t)));
};

console.log('=== search "bambu lab" (should be ONLY real Bambu Lab filament) ===');
const bambu = search('bambu lab');
console.log('count:', bambu.length);
const brands = {};
for (const p of bambu) brands[p.brand] = (brands[p.brand] || 0) + 1;
console.log('brands in results:', brands);
const polluted = bambu.filter((p) => p.brand !== 'Bambu Lab');
console.log('non-Bambu results:', polluted.length);
for (const p of polluted.slice(0, 10)) console.log('  POLLUTION:', p.brand, '|', p.name);

console.log('\n=== search "esun pla" sample ===');
for (const p of search('esun pla').slice(0, 5)) console.log(' ', p.brand, '|', p.name, '| $' + p.price);

console.log('\n=== search "bambu pla" sample ===');
for (const p of search('bambu pla').slice(0, 8)) console.log(' ', p.store, '|', p.name, '| $' + p.price);

// brand facet distribution
const all = {};
for (const p of d) all[p.brand || 'null'] = (all[p.brand || 'null'] || 0) + 1;
console.log('\ntop brands:', Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 15));
