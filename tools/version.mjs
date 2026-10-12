// Change le numéro de version (?v=…) des fichiers du site, pour que les navigateurs
// rechargent les nouveaux fichiers après une mise en ligne (GitHub Pages les garde 10 min en cache).
// À lancer avant chaque envoi sur GitHub :  node tools/version.mjs
import fs from 'node:fs';
const v = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);   // ex : 202610122030
for (const f of ['index.html', 'js/app.js']) {
  const url = new URL('../' + f, import.meta.url);
  const s = fs.readFileSync(url, 'utf8');
  const n = (s.match(/\?v=[0-9a-z]+/g) || []).length;
  fs.writeFileSync(url, s.replace(/\?v=[0-9a-z]+/g, '?v=' + v));
  console.log(`${f} : ${n} référence(s) → ?v=${v}`);
}
