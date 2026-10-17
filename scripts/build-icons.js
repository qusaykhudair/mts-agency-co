'use strict';
// Rebuilds src/data/fa-icons.json from Font Awesome Free's all.min.js (the file is read as text, never run):
//   node scripts/build-icons.js path/to/all.min.js
// Kept per icon: solid and regular -> [unicode, width], brands -> [width, SVG path], plus every alias name.
// Widths are in 1/512 em, the unit Font Awesome draws its icons in. Only needed when Font Awesome is upgraded;
// copy that version's fa-solid-900.woff2 and fa-regular-400.woff2 to public/fonts at the same time.
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('node scripts/build-icons.js path/to/all.min.js');
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');
const version = (/Font Awesome Free ([\d.]+)/.exec(text) || [])[1] || 'unknown';

// Each pack is an object literal `var p={name:[width,height,[aliases],"unicode","path"],…}` registered right
// after it with d("fas",p), d("far",p) or d("fab",p).
const PACKS = { fas: 'solid', far: 'regular', fab: 'brands' };
const ENTRY = /(?:^|,)(?:"([^"]+)"|([A-Za-z0-9_$-]+)):\[(\d+),(\d+),\[([^\]]*)\],"([0-9a-f]+)",("[^"]*"|\[[^\]]*\])\]/g;

const out = { version, solid: {}, regular: {}, brands: {}, aliases: { solid: {}, regular: {}, brands: {} } };
for (const [prefix, style] of Object.entries(PACKS)) {
  const mark = text.indexOf(`d("${prefix}",p)`);
  if (mark < 0) throw new Error(`pack ${prefix} not found`);
  const start = text.lastIndexOf('var p={', mark) + 'var p={'.length;
  const end = text.lastIndexOf('};!function', mark);
  const body = text.slice(start, end);
  let count = 0;
  for (const m of body.matchAll(ENTRY)) {
    const name = m[1] || m[2];
    const width = Number(m[3]);
    const unicode = m[6];
    if (style === 'brands') {
      if (!m[7].startsWith('"')) continue; // duotone layers do not exist in the free brands
      out.brands[name] = [width, m[7].slice(1, -1)];
    } else out[style][name] = [unicode, width];
    for (const alias of m[5].split(',')) {
      const a = alias.trim();
      if (a.startsWith('"')) out.aliases[style][a.slice(1, -1)] = name;
    }
    count++;
  }
  if (count < 100) throw new Error(`only ${count} icons read from ${prefix}: the file layout changed`);
  console.log(`${style}: ${count} icons, ${Object.keys(out.aliases[style]).length} aliases`);
}

// One icon per line keeps the file readable in a diff.
const lines = [`{"version":${JSON.stringify(version)},`];
for (const style of ['solid', 'regular', 'brands']) {
  const entries = Object.entries(out[style]).map(([k, v]) => `  ${JSON.stringify(k)}:${JSON.stringify(v)}`);
  lines.push(`"${style}":{\n${entries.join(',\n')}\n},`);
}
lines.push(`"aliases":${JSON.stringify(out.aliases)}}`);
const target = path.join(__dirname, '..', 'src', 'data', 'fa-icons.json');
fs.writeFileSync(target, lines.join('\n') + '\n');
console.log(`wrote ${path.relative(process.cwd(), target)} (${Math.round(fs.statSync(target).size / 1024)} KB, Font Awesome ${version})`);
