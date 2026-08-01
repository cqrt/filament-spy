import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const dia = {}, wt = {};
for (const p of d) {
  dia[p.diameter || '(none)'] = (dia[p.diameter || '(none)'] || 0) + 1;
  wt[p.weightLabel || '(none)'] = (wt[p.weightLabel || '(none)'] || 0) + 1;
}
console.log('diameter:', dia);
console.log('weight labels:', wt);
// spot checks
console.log('\n0.5kg products → label:');
for (const p of d.filter((p) => p.weightKg === 0.5).slice(0, 3)) console.log(' ', p.weightLabel, '|', p.name.slice(0, 60));
console.log('\n2.85mm sample:');
for (const p of d.filter((p) => p.diameter === '2.85mm').slice(0, 4)) console.log(' ', p.store, '|', p.name.slice(0, 70));
