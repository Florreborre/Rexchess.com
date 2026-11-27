// Lägger till nya texter i ordlistorna. Användning: node tools/addlang.mjs tools/lang/<fil>.json
// JSON-filen är { "svensk text": ["engelska", "tyska", "spanska", "franska"] }. Engelskan skrivs in i lang-en.js,
// de övriga i tools/lang/<språk>.txt; därefter byggs lang-de/es/fr.js om med buildlang.mjs.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
const root = process.cwd(), add = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const enFile = path.join(root, 'public/js/lang-en.js'), text = fs.readFileSync(enFile, 'utf8');
const en = (await import(pathToFileURL(enFile))).default;
for (const [k, v] of Object.entries(add)) en[k] = v[0];
fs.writeFileSync(enFile, text.slice(0, text.indexOf('export default')) + 'export default ' + JSON.stringify(en, null, 1) + ';\n');
const keys = Object.keys(en);
for (const [i, lang] of ['de', 'es', 'fr'].entries()) {
  const file = path.join(root, `tools/lang/${lang}.txt`);
  const have = new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.split('|')[0]));
  const lines = Object.entries(add).map(([k, v]) => [keys.indexOf(k), v[i + 1]]).filter(([n]) => !have.has(String(n))).map(([n, v]) => `${n}|${v}`);
  if (lines.length) fs.appendFileSync(file, lines.join('\n') + '\n');
}
execFileSync(process.execPath, [path.join(root, 'tools/buildlang.mjs'), root, path.join(root, 'tools/lang')], { stdio: 'inherit' });
