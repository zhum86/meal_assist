// Turns an exported dishes file into data/default-dishes.js, which the app
// loads on first run. (A .js file works when index.html is opened from file://;
// a .json file can't be fetched there.)
// Usage: node tools/update-defaults.mjs data/dishes-YYYY-MM-DD.json
import fs from 'fs';
import path from 'path';

const src = process.argv[2];
if (!src) {
  console.error('Usage: node tools/update-defaults.mjs <exported dishes .json>');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
if (data.app !== 'family-meals' || data.kind !== 'dishes' || !Array.isArray(data.dishes)) {
  console.error(`${src} is not an exported dish database.`);
  process.exit(1);
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'default-dishes.js');
fs.writeFileSync(out, `// Generated from ${path.basename(src)} by tools/update-defaults.mjs. Loaded on first run.\nwindow.DEFAULT_DISHES = ${JSON.stringify(data, null, 1)};\n`);
console.log(`Wrote ${data.dishes.length} dishes to data/default-dishes.js`);
