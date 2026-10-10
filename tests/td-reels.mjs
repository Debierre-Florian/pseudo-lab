// Passe chaque programme (action ... fin) d'un fichier TD à l'interpréteur avec des entrées bidon.
import fs from 'node:fs';
import { exec } from './run.mjs';
const file = process.argv[2];
const txt = fs.readFileSync(file, 'utf8');
// découpe : un programme commence à une ligne "action" et va jusqu'au prochain "action"/titre ##
const lines = txt.split('\n');
const progs = []; let cur = null;
for (const l of lines) {
  if (/^action\b/i.test(l)) { cur = { start: progs.length + 1, lines: [l] }; progs.push(cur); continue; }
  if (/^#{1,4} /.test(l)) { cur = null; continue; }
  if (cur) cur.lines.push(l);
}
for (const p of progs) {
  const name = p.lines[0].trim();
  const inputs = Array.from({ length: 60 }, (_, i) => String((i * 7 + 3) % 10 + 1));
  const r = await exec(p.lines.join('\n'), inputs);
  const head = r.error ? `ERREUR → ${r.error}` : 'OK';
  console.log(`\n■ ${name} : ${head}`);
  for (const w of r.warns.slice(0, 4)) console.log(`   ⚠ ${w}`);
  if (r.warns.length > 4) console.log(`   ⚠ (+${r.warns.length - 4} autres)`);
}
