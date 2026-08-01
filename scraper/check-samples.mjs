import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/products.json', 'utf8')).products;

console.log('material=Other total:', d.filter((p) => p.material === 'Other').length);
const mat = {};
for (const p of d) mat[p.material] = (mat[p.material] || 0) + 1;
console.log('materials:', Object.entries(mat).sort((a, b) => b[1] - a[1]));

const fin = {};
for (const p of d) fin[p.finish || '(none)'] = (fin[p.finish || '(none)'] || 0) + 1;
console.log('\nfinishes:', fin);

const show = (re, label) => {
  const hits = d.filter((p) => re.test(p.name));
  console.log(`\n${label}: ${hits.length}`);
  for (const p of hits.slice(0, 4)) console.log(`  ${p.material} / ${p.finish || '-'} | ${p.name.slice(0, 65)}`);
};
show(/panchroma/i, 'Panchroma');
show(/twinkling/i, 'Twinkling');
show(/cr[ -]?(wood|silk)|\bwood\b/i, 'Wood/CR-Wood/CR-Silk');
show(/marble/i, 'Marble');
show(/tpu[ -]?9[58]/i, 'TPU 95/98');
show(/\br(petg|pla)\b/i, 'rPETG/rPLA');
