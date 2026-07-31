import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const finishes = {}, formats = {};
for (const p of d) {
  finishes[p.finish || '(none)'] = (finishes[p.finish || '(none)'] || 0) + 1;
  formats[p.format || '(none)'] = (formats[p.format || '(none)'] || 0) + 1;
}
console.log('finish:', finishes);
console.log('format:', formats);
console.log('\nsilk samples:');
for (const p of d.filter((p) => p.finish === 'Silk').slice(0, 4)) console.log(' ', p.store, '|', p.name, '|', p.format);
console.log('\nmatte samples:');
for (const p of d.filter((p) => p.finish === 'Matte').slice(0, 4)) console.log(' ', p.store, '|', p.name, '|', p.format);
console.log('\nrefill samples:');
for (const p of d.filter((p) => p.format === 'Refill').slice(0, 5)) console.log(' ', p.store, '|', p.name);
console.log('\nspooled samples:');
for (const p of d.filter((p) => p.format === 'Spooled').slice(0, 5)) console.log(' ', p.store, '|', p.name);
