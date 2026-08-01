import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const multi = d.filter((p) => p.colour === 'Multi');
console.log('display colour = Multi:', multi.length);
const withComponents = d.filter((p) => (p.colours || []).length > 2);
console.log('Multi with components:', withComponents.length);
for (const p of withComponents.slice(0, 15)) console.log(`  [${p.store}] ${JSON.stringify(p.colours)} | ${p.name.slice(0, 60)}`);
// sanity: single-colour products unchanged
const sp = d.find((p) => /silk purple-pink/i.test(p.name));
console.log('\nSilk Purple-Pink:', sp?.material, sp?.colour, JSON.stringify(sp?.colours));
const bg = d.find((p) => /blue[- ]gr(a|e)y/i.test(p.name));
console.log('Blue-Gray product:', bg?.colour, JSON.stringify(bg?.colours), '|', bg?.name.slice(0, 50));
console.log('\nOther:', d.filter((p) => p.material === 'Other').length);
