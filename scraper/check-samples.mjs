import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const other = d.filter((p) => p.material === 'Other');
const byStore = {};
for (const p of other) byStore[p.store] = (byStore[p.store] || 0) + 1;
console.log('material=Other by store:', byStore, '| total:', other.length);
console.log('\n3dea Other samples:');
for (const p of other.filter((p) => p.store === '3dea').slice(0, 12)) console.log('  |', p.name.slice(0, 70));
