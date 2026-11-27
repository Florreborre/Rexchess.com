// Bygger lang-de.js, lang-es.js och lang-fr.js. Varje rad i xx.txt är "nummer|översättning", där numret är platsen
// i den engelska ordlistan. Saknas en rad (t.ex. öppningsnamn) används den engelska texten, som är den internationella.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const [root, dir] = process.argv.slice(2);
const en = (await import(pathToFileURL(path.join(root, 'public/js/lang-en.js')))).default;
const keys = Object.keys(en);
const names = { de: 'Tysk', es: 'Spansk', fr: 'Fransk' };
for (const lang of ['de', 'es', 'fr']) {
  const rows = new Map();
  for (const line of fs.readFileSync(path.join(dir, `${lang}.txt`), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\|(.*)$/);
    if (m) rows.set(Number(m[1]), m[2]);
  }
  const out = {};
  let own = 0, bad = 0;
  keys.forEach((k, i) => {
    let v = rows.get(i);
    if (v === undefined) v = en[k];
    else own++;
    // Platshållarna {1}, {2} … måste vara samma som i originalet.
    const want = (k.match(/\{\d\}/g) || []).sort().join(), got = (v.match(/\{\d\}/g) || []).sort().join();
    if (want !== got) { bad++; console.log(`${lang} #${i}: platshållare stämmer inte: "${v}"`); v = en[k]; }
    out[k] = v;
  });
  fs.writeFileSync(path.join(root, `public/js/lang-${lang}.js`),
    `// ${names[lang]} översättning, byggd från samma nycklar som lang-en.js. Öppningsnamn är på engelska.\nexport default ${JSON.stringify(out, null, 1)};\n`);
  console.log(lang, `${own} egna översättningar, ${keys.length - own} från engelskan, ${bad} fel`);
}
