import { readFile } from 'node:fs/promises';
const { products } = JSON.parse(await readFile(new URL('../data/products.json', import.meta.url), 'utf8'));

const by = (fn) => products.reduce((m, p) => { const k = fn(p); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log('TOTAL:', products.length);
console.log('\nBY STORE:', JSON.stringify(by(p => p.store), null, 1));
console.log('\nBY MATERIAL:', JSON.stringify(by(p => p.material), null, 1));
console.log('\nBY COLOUR (top 15):', Object.entries(by(p => p.colour)).sort((a, b) => b[1] - a[1]).slice(0, 15));
console.log('\nMissing weight:', products.filter(p => !p.weightKg).length, '| Missing image:', products.filter(p => !p.image).length);
console.log('On sale:', products.filter(p => p.wasPrice).length, '| In stock known:', products.filter(p => p.inStock !== null).length);

for (const store of [...new Set(products.map(p => p.store))]) {
  console.log(`\n===== ${store} samples =====`);
  for (const p of products.filter(p => p.store === store).slice(0, 4)) {
    console.log(`  ${p.name} | ${p.material} | ${p.colour} | ${p.weightKg}kg | $${p.price}${p.wasPrice ? ' (was $' + p.wasPrice + ')' : ''} | $/kg:${p.pricePerKg} | img:${p.image ? 'y' : 'n'} | stock:${p.inStock}`);
  }
}

console.log('\n===== suspicious (non-filament?) =====');
const sus = /dryer|nozzle|extruder|printer|resin|glue|tape|sheet|plate|pen\b/i;
for (const p of products.filter(p => sus.test(p.name)).slice(0, 15)) console.log(`  [${p.store}] ${p.name}`);
