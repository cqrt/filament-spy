import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;

const byName = d.filter((p) => /\bsample\b/i.test(p.name));
const byWeight = d.filter((p) => p.weightKg && p.weightKg < 0.2);
console.log('name contains "sample":', byName.length, '| weightKg < 0.2:', byWeight.length);

const union = new Set([...byName, ...byWeight].map((p) => p.id));
console.log('union:', union.size);

console.log('\n--- byName samples ---');
for (const p of byName.slice(0, 10)) console.log(` [${p.store}] ${p.weightKg ?? '?'}kg | ${p.name.slice(0, 75)}`);
console.log('\n--- byWeight (not already in byName) ---');
const rest = byWeight.filter((p) => !/\bsample\b/i.test(p.name));
for (const p of rest.slice(0, 15)) console.log(` [${p.store}] ${p.weightKg}kg | ${p.name.slice(0, 75)}`);

// distribution of small weights
const w = {};
for (const p of byWeight) w[p.weightKg] = (w[p.weightKg] || 0) + 1;
console.log('\nsmall-weight distribution:', w);
