// Lance : node tests/run.mjs
import fs from 'node:fs';
import { makeLang, runSource } from '../js/pseudo.js';

const lang = makeLang(JSON.parse(fs.readFileSync(new URL('../lang/langage.json', import.meta.url), 'utf8')));

export async function exec(src, inputs = [], opts = {}) {
  let out = '';
  const warns = [];
  const queue = [...inputs];
  const io = {
    write: (t) => { out += t; },
    read: async (label) => { const v = queue.shift(); if (v !== undefined) out += `⟨${v}⟩\n`; return v; },
    warn: (m) => warns.push(m),
  };
  const r = await runSource(src, lang, io, opts);
  return { out, warns, error: r.error ? r.error.message : null, ok: r.ok };
}

let fails = 0;
async function check(name, src, inputs, expectOut, opts) {
  const r = await exec(src, inputs, opts);
  const good = expectOut instanceof RegExp ? expectOut.test(r.error || r.out) : (r.out === expectOut && !r.error);
  if (!good) { fails++; console.log(`✗ ${name}\n  sortie : ${JSON.stringify(r.out)}\n  erreur : ${r.error}\n  attendu: ${expectOut}`); }
  else console.log(`✓ ${name}`);
  return r;
}

if (process.argv[1].endsWith('run.mjs')) {
  const R = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

  await check('addition (TD1 ex7)', `
action addition
const var prix_menu1 = 15
const var prix_menu2 = 20
const var prix_menu3 = 25
var nombre_menu1, nombre_menu2, nombre_menu3, addition : entier
debut
  sortir("Combien de menu 1, 2 et 3 ?")
  entrer(nombre_menu1, nombre_menu2, nombre_menu3)
  addition <- (prix_menu1 * nombre_menu1) + (prix_menu2 * nombre_menu2) + (prix_menu3 * nombre_menu3)
  sortir("Voici l'addition : ", addition)
fin`, ['1', '2', '3'], "Combien de menu 1, 2 et 3 ?⟨1⟩\n⟨2⟩\n⟨3⟩\nVoici l'addition : 130");

  await check('durée convertie (TD1 ex8)', `
action durée_convertit
const var min_sec_fixe = 60
var heure, minute, seconde, seconde_entrer : entier
debut
  entrer(seconde_entrer)
  minute <- seconde_entrer div min_sec_fixe
  heure <- minute div min_sec_fixe
  seconde <- seconde_entrer mod min_sec_fixe
  minute <- minute mod min_sec_fixe
  sortir(heure, ":", minute, ":", seconde)
fin`, ['3725'], '⟨3725⟩\n1:2:5');

  await check('tri de 3 valeurs', `
action trie
var x, y, z, t : entier
debut
  entrer(x, y, z)
  si (x > y) alors
    t <- x
    x <- y
    y <- t
  fsi
  si (x > z) alors
    t <- x
    x <- z
    z <- t
  fsi
  si (y > z) alors
    t <- y
    y <- z
    z <- t
  fsi
  sortir(x, " ", y, " ", z)
fin`, ['9', '2', '5'], '⟨9⟩\n⟨2⟩\n⟨5⟩\n2 5 9');

  await check('sinon si enchaînés (IMC)', `
action IMC
var poids, taille, resultat : reel
debut
  entrer(poids)
  entrer(taille)
  taille <- taille / 100
  resultat <- poids / (taille*taille)
  si (resultat < 18.5) alors
    sortir("maigre")
  sinon si (resultat < 25) alors
    sortir("normal")
  sinon si (resultat < 30) alors
    sortir("surpoids")
  sinon
    sortir("obese")
  fsi
fin`, ['70', '175'], '⟨70⟩\n⟨175⟩\nnormal');

  await check('cas de', `
action c
var m : entier
debut
  entrer(m)
  cas de m :
    1 :
      sortir("janvier")
    2, 3 :
      sortir("fevrier ou mars")
    sinon :
      sortir("autre")
  fcas
fin`, ['3'], '⟨3⟩\nfevrier ou mars');

  await check('tableau 1D + recherche', `
action p
const var N = 5
type vecteur = tableau[1..N] de type entiers
var i, c, v : entier
var T : vecteur
debut
  pour i allant de 1 a N faire
    T[i] <- i * 2
  fpour
  c <- 0
  entrer(v)
  pour i allant de 1 a N faire
    si (T[i] = v) alors c <- c + 1 fsi
  fpour
  sortir(c)
fin`, ['6'], '⟨6⟩\n1');

  await check('matrice 2D', `
action m
const var N = 3
type mat = tableau[1..N][1..N] de type entier
var M : mat
var i, j, s : entier
debut
  s <- 0
  pour i allant de 1 a N faire
    pour j allant de 1 a N faire
      M[i][j] <- i * j
      s <- s + M[i][j]
    fpour
  fpour
  pour i allant de 1 a N faire
    pour j allant de 1 a N faire
      sortir(M[i][j], " ")
    fpour
    retour a la ligne
  fpour
  sortir(s)
fin`, [], '1 2 3 \n2 4 6 \n3 6 9 \n36');

  await check('tant que + répéter + pas', `
action b
var n, s : entier
debut
  n <- 1
  s <- 0
  tant que (n <= 4) faire
    s <- s + n
    n <- n + 1
  ftq
  sortir(s, " ")
  repeter
    n <- n - 1
  jusqu'a n <= 2
  sortir(n, " ")
  pour n allant de 10 a 1 pas -4 faire
    sortir(n, ",")
  fpour
fin`, [], '10 2 10,6,2,');

  await check('indice hors tableau', `
action e
const var N = 3
var T : tableau[1..N] de entier
var i : entier
debut
  pour i allant de 1 a N faire
    T[i] <- 1
  fpour
  T[N + 1] <- 5
fin`, [], /Ligne 10 : indice 4 en dehors du tableau « T »/);

  await check('fsi oublié', `
action e
var a : entier
debut
  a <- 1
  si (a = 1) alors
    sortir("x")
fin`, [], /Ligne 6 : le bloc « si » ouvert ici n'est pas fermé/);

  await check('guillemet oublié', `
action e
debut
  sortir("abc)
fin`, [], /Ligne 4 : il manque le guillemet fermant/);

  await check('condition non booléenne', `
action e
var x : entier
debut
  x <- 5
  si (x mod 5) alors sortir("a") fsi
fin`, [], /la condition doit donner VRAI ou FAUX/);

  await check('boucle infinie coupée', `
action e
debut
  tant que (VRAI) faire
  ftq
fin`, [], /boucle infinie/, { maxInstructions: 10000 });

  await check('retour à la ligne auto (option)', `
action o
debut
  sortir("a")
  sortir("b")
fin`, [], 'a\nb\n', { sortirRetourLigne: true });

  // troncature + warning
  const t = await exec(`
action w
var r : entier
debut
  r <- 7 / 2
  sortir(r)
fin`);
  console.log(t.out === '3' && t.warns.length === 1 ? '✓ troncature entier + avertissement' : `✗ troncature ${JSON.stringify(t)}`);
  if (!(t.out === '3' && t.warns.length === 1)) fails++;

  // validation de saisie
  const v = await exec(`
action w
var n : entier
debut
  entrer(n)
  sortir(n + 1)
fin`, ['abc', '41']);
  console.log(v.out.endsWith('42') && v.warns.length === 1 ? '✓ re-demande si saisie invalide' : `✗ saisie ${JSON.stringify(v)}`);
  if (!(v.out.endsWith('42') && v.warns.length === 1)) fails++;

  // exemples du site
  const idx = JSON.parse(R('../lang/exemples/index.json'));
  for (const e of idx) {
    const src = R(`../lang/exemples/${e.fichier}`);
    const r = await exec(src, e.test?.entrees || [], {});
    const okOut = e.test ? r.out.includes(e.test.contient) : true;
    if (r.error || !okOut) { fails++; console.log(`✗ exemple ${e.fichier} : ${r.error || 'sortie inattendue ' + JSON.stringify(r.out)}`); }
    else console.log(`✓ exemple ${e.fichier}${r.warns.length ? ' (' + r.warns.length + ' avertissements !)' : ''}`);
  }
  const modele = await exec(R("../lang/modele.pseudo"), ["1","2","3","4","5"]);
  console.log(modele.error ? `✗ modele.pseudo : ${modele.error}` : '✓ modele.pseudo');
  if (modele.error) fails++;

  console.log(fails ? `\n${fails} échec(s)` : '\nTout est vert.');
  process.exit(fails ? 1 : 0);
}
