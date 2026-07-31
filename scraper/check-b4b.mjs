import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;
const b4b = d.filter((p) => p.store === 'bits4bots');

// eSun PLA+ Refilament variants: should each have a distinct colour image
const pla = b4b.filter((p) => /PLA\+.*Refilament|Refilament.*PLA\+/i.test(p.name) || /pla refilament/i.test(p.image));
console.log('=== eSun PLA Refilament variants ===');
for (const p of pla.slice(0, 10)) console.log(` ${p.colour.padEnd(8)} ${p.image.slice(-55)}`);
const imgs = new Set(pla.map((p) => p.image));
console.log('distinct images:', imgs.size, 'of', pla.length);

// PETG Basic check
const petg = b4b.filter((p) => /petg basic/i.test(p.name));
console.log('\n=== eSun PETG Basic variants ===');
for (const p of petg.slice(0, 8)) console.log(` ${p.colour.padEnd(8)} ${p.image.slice(-55)}`);
console.log('distinct images:', new Set(petg.map((p) => p.image)).size, 'of', petg.length);

// overall: how many b4b products share an image with >5 other products
const counts = {};
for (const p of b4b) counts[p.image] = (counts[p.image] || 0) + 1;
const heavy = Object.entries(counts).filter(([, c]) => c > 5);
console.log('\nimages shared by >5 products:', heavy.length);
for (const [img, c] of heavy.slice(0, 5)) console.log(` ${c}x ...${img.slice(-60)}`);
