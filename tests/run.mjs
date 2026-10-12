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

  // ================= fonctions et procédures (syntaxe du CM R1.01) =================
  await check('fonction dans une expression (CM somme_carres)', `
programme math
fonction somme_carres(n : entier):entier
/* fonction du cours */
var i, terme : entier
debut
  terme<-0
  pour i allant de 1 à n faire
    terme <- terme + i*i
  fpour
  retourner(terme)
fin
var nbre, x : entier
debut
  entrer(nbre)
  x <- somme_carres(nbre) * 2 + somme_carres(2)
  sortir(x, " ", somme_carres(nbre))
fin`, ['3'], '⟨3⟩\n33 14');

  await check('fonction dans une condition (booléen)', `
action v
fonction est_pair(nombre : entier) : booleen
debut
  si ((nombre % 2) = 0) alors
    retourner vrai
  sinon
    retourner faux
  fsi
fin
var k : entier
debut
  pour k allant de 1 a 4 faire
    si est_pair(k) et non est_pair(k + 1) alors sortir(k, " pair ") sinon sortir(k, " impair ") fsi
  fpour
fin`, [], '1 impair 2 pair 3 impair 4 pair ');

  await check('procédure par valeur : l\'appelant ne change pas (TD3 ex4)', `
action parametres
procedure test( X: entier, Y : entier)
debut
  X <- Y + X
  Y <- X * X
  X <- Y - X
  sortir(X, " ", Y, " / ")
fin
var A, B : entier
debut
  A <-2
  B <-7
  test(A,B)
  sortir (A, " ", B)
fin`, [], '72 81 / 2 7');

  await check('procédure avec paramètres var (CM division_entiere)', `
action TestDivision
procedure division_entiere(a : entier, b : entier; var q : entier, var r : entier)
debut
  q <- a DIV b
  r <- a MOD b
fin
var nb, d, quotient, reste : entier
debut
  entrer(nb, d)
  division_entiere(nb, d, quotient, reste)
  sortir(quotient, " ", reste)
fin`, ['17', '5'], '⟨17⟩\n⟨5⟩\n3 2');

  await check('échanger (var x, var y) + case de tableau en paramètre var', `
action On_inverse_en_masse
procedure intervertir(var x : entier, var y : entier)
var
  Temp : entier
debut
  Temp <- x
  x <- y
  y <- Temp
fin
var X1, Y1 : entier
var T : tableau[1..3] de entier
debut
  X1 <- 5
  Y1 <- 1
  si X1 > Y1 alors
    intervertir(X1, Y1)
  fsi
  T[1] <- 10   T[3] <- 30
  intervertir(T[1], T[3])
  sortir(X1, Y1, " ", T[1], " ", T[3])
fin`, [], '15 30 10');

  await check('tableau en paramètre : var = modifié, par valeur = copie', `
action tab
const N = 4
type vecteur = tableau[1..N] de entier
procedure decale_tableau(var tab : vecteur)
var i, premier : entier
debut
  premier <- tab[1]
  pour i allant de 1 a N - 1 faire
    tab[i] <- tab[i + 1]
  fpour
  tab[N] <- premier
fin
fonction somme(t : vecteur) : entier
var i, s : entier
debut
  s <- 0
  pour i allant de 1 a N faire
    s <- s + t[i]
    t[i] <- 0
  fpour
  retourner s
fin
var V : vecteur
var i : entier
debut
  pour i allant de 1 a N faire
    V[i] <- i
  fpour
  decale_tableau(V)
  sortir(somme(V), " ")
  pour i allant de 1 a N faire
    sortir(V[i])
  fpour
fin`, [], '10 2341');

  await check('variables locales et globales (masquage, accès aux globales)', `
action portee
procedure p(n : entier)
var i : entier
debut
  i <- 100
  total <- total + n
fin
var i, total : entier
debut
  i <- 1
  total <- 0
  p(5)
  p(2)
  sortir(i, " ", total)
fin`, [], '1 7');

  await check('récursivité : factorielle et fibonacci', `
action rec
fonction fact(n : entier) : entier
debut
  si n <= 1 alors
    retourner 1
  fsi
  retourner n * fact(n - 1)
fin
fonction fib(n : entier) : entier
debut
  si n < 2 alors retourner n fsi
  retourner fib(n - 1) + fib(n - 2)
fin
debut
  sortir(fact(5), " ", fib(10))
fin`, [], '120 55');

  await check('entrer dans une fonction appelée dans une expression (TD3 oui_non)', `
action questions
fonction oui_non() : cc
var Rep : cc
debut
  Rep <- ""
  tq Rep <> "Oui" et Rep <> "Non" faire
    sortir("Tapez Oui ou Non ")
    entrer(Rep)
  ftq
  retourner(Rep)
fin
var Rep1 : chaine
debut
  sortir("Etes-vous en première année ? ")
  Rep1 := oui_non()
  sortir("Réponse : ", Rep1)
fin`, ['peut-être', 'Oui'], 'Etes-vous en première année ? Tapez Oui ou Non ⟨peut-être⟩\nTapez Oui ou Non ⟨Oui⟩\nRéponse : Oui');

  await check('entrer dans une procédure + sous-programme après le programme + FIN PROCEDURE', `
action saisie
var a : entier
debut
  lire_positif(a)
  sortir(a)
fin
PROCEDURE lire_positif(var n : entier)
debut
  repeter
    entrer(n)
  jusqu'a n > 0
fin
FIN PROCEDURE`, ['-3', '8'], '⟨-3⟩\n⟨8⟩\n8');

  await check('paramètres groupés « a, b : entier » + robot (procédure sans paramètre)', `
action Guider_Robot
procedure tourner_droite()
debut
  sortir("D")
fin
procédure progresser (n: entier)
var
  i: entier
debut
  pour i allant de 1 à n faire
    sortir(".")
  fpour
fin
fonction plus(a, b : entier) : entier
debut
  retourner a + b
fin
debut
  tourner_droite()
  progresser(plus(1, 2))
fin`, [], 'D...');

  // --- erreurs attendues (avec le bon numéro de ligne) ---
  await check('erreur : mauvais nombre de paramètres', `
action e
fonction carre(x : entier) : entier
debut
  retourner x * x
fin
var r : entier
debut
  r <- carre(5, 2)
fin`, [], /^Ligne 9 : la fonction « carre » attend 1 paramètre, tu en donnes 2$/);

  await check('erreur : mauvais type de paramètre', `
action e
procedure p(n : entier)
debut
  sortir(n)
fin
debut
  p("abc")
fin`, [], /^Ligne 8 : le paramètre n°1 de « p » \(« n »\) doit être un entier mais tu lui donnes le texte "abc"$/);

  await check('erreur : valeur donnée à un paramètre var', `
action e
procedure echanger(var a : entier, var b : entier)
var t : entier
debut
  t <- a
  a <- b
  b <- t
fin
var u : entier
debut
  u <- 1
  echanger(u, 2 + 3)
fin`, [], /^Ligne 13 : le paramètre n°2 de « echanger » \(« b »\) est passé par variable \(var\)/);

  await check('erreur : fonction sans retourner', `
action e
fonction f(x : entier) : entier
var y : entier
debut
  y <- x
fin
debut
  sortir(f(1))
fin`, [], /^Ligne 3 : la fonction « f » ne contient aucun « retourner »/);

  await check('erreur : fonction terminée sans retourner (un chemin oublié)', `
action e
fonction signe(x : entier) : entier
debut
  si x > 0 alors
    retourner 1
  fsi
fin
debut
  sortir(signe(-4))
fin`, [], /^Ligne 8 : la fonction « signe » s'est terminée sans « retourner »/);

  await check('erreur : récursion infinie', `
action e
fonction f(n : entier) : entier
debut
  retourner f(n + 1)
fin
debut
  sortir(f(1))
fin`, [], /^Ligne 5 : trop d'appels imbriqués/);

  await check('erreur : retourner hors fonction', `
action e
var x : entier
debut
  x <- 1
  retourner x
fin`, [], /^Ligne 6 : « retourner » ne peut s'utiliser que dans une fonction/);

  await check('erreur : procédure inexistante', `
action e
debut
  sortir("a")
  afficher_tout(3)
fin`, [], /^Ligne 5 : la procédure « afficher_tout » n'existe pas/);

  await check('erreur : fonction inexistante', `
action e
var x : entier
debut
  x <- doubler(3)
fin`, [], /^Ligne 5 : la fonction « doubler » n'existe pas/);

  await check('erreur : procédure utilisée dans un calcul', `
action e
procedure p(n : entier)
debut
  sortir(n)
fin
var x : entier
debut
  x <- p(3) + 1
fin`, [], /^Ligne 9 : « p » est une procédure : elle ne retourne pas de valeur/);

  await check('erreur : retourner une valeur dans une procédure', `
action e
procedure p(n : entier)
debut
  retourner n
fin
debut
  p(1)
fin`, [], /^Ligne 5 : « p » est une procédure : elle ne retourne pas de valeur/);

  await check('erreur : type retourné incorrect', `
action e
fonction f(n : entier) : entier
debut
  retourner "abc"
fin
debut
  sortir(f(1))
fin`, [], /^Ligne 5 : la fonction « f » doit retourner un entier mais elle retourne le texte "abc"$/);

  await check('erreur : deux sous-programmes du même nom', `
action e
procedure p()
debut
fin
procedure P(x : entier)
debut
fin
debut
fin`, [], /^Ligne 6 : il y a déjà une fonction ou procédure nommée « P »/);

  await check('erreur : type de retour oublié (TD3 points_gagnés)', `
action e
fonction points(pas : entier)
var t : entier
debut
  retourner pas * 3
fin
debut
fin`, [], /^Ligne 3 : il manque le type de la valeur retournée par la fonction « points »/);

  await check('erreur : paramètres sans type', `
action e
fonction points(pas : entier, droite, gauche) : entier
debut
  retourner pas
fin
debut
fin`, [], /^Ligne 3 : il manque le type du paramètre « gauche »/);

  await check("erreur dans un sous-programme : la ligne est celle du sous-programme", `
action e
fonction moyenne(s : entier, n : entier) : reel
debut
  retourner s / n
fin
debut
  sortir(moyenne(10, 2), " ")
  sortir(moyenne(10, 0))
fin`, [], /^Ligne 5 : division par zéro$/);

  await check('erreur : sous-programme écrit après « debut »', `
action e
debut
  sortir("a")
  fonction f(x : entier) : entier
fin`, [], /^Ligne 5 : les fonctions et procédures s'écrivent avant le « debut »/);

  // un tableau modifié dans une procédure sans « var » : avertissement pédagogique
  const bv = await exec(`
action w
type vecteur = tableau[1..2] de entier
procedure raz(t : vecteur)
debut
  t[1] <- 0
fin
var V : vecteur
debut
  V[1] <- 5
  raz(V)
  sortir(V[1])
fin`);
  const bvOk = bv.out === '5' && bv.warns.some((w) => /passé par valeur/.test(w));
  console.log(bvOk ? '✓ tableau par valeur modifié → avertissement' : `✗ tableau par valeur ${JSON.stringify(bv)}`);
  if (!bvOk) fails++;

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

  // ================= permissions (backend démo = mêmes règles que supabase/schema.sql) =================
  const { createLocalBackend } = await import('../js/backend-local.js');
  const B = createLocalBackend();
  const ok = (name, cond) => { console.log(cond ? `✓ ${name}` : `✗ ${name}`); if (!cond) fails++; };
  const refuse = async (name, fn) => { try { await fn(); ok(name, false); } catch { ok(name, true); } };
  const as = (email) => B.signIn({ email, password: 'secret1' });
  await B.signUp({ email: 'a@x.fr', password: 'secret1', pseudo: 'admin' });
  const alice = await B.signUp({ email: 'alice@x.fr', password: 'secret1', pseudo: 'alice' });
  const bob = await B.signUp({ email: 'bob@x.fr', password: 'secret1', pseudo: 'bob' });
  ok('permissions : tout est autorisé par défaut', bob.can_run && bob.can_free && bob.can_view_others);
  await refuse('permissions : un étudiant ne peut pas créer de projet', () => B.saveProject({ title: 'X' }));
  await refuse('permissions : un étudiant ne peut pas changer les réglages', () => B.setSettings({ run_enabled: false }));
  await as('a@x.fr');
  const pr = await B.saveProject({ title: 'TD3', starter_code: 'action a\ndebut\nfin', run_enabled: false, share_work: false });
  await B.setSettings({ free_programs: false });
  await as('alice@x.fr');
  await refuse('permissions : programmes libres coupés en global → refus', () => B.save({ title: 'libre', td: '', code: '' }));
  const w = await B.save({ title: 'TD3', td: '', code: 'x', project_id: pr.id });
  ok('permissions : enregistrer dans un projet reste possible', w.project_id === pr.id);
  await refuse('permissions : un seul travail par étudiant et par projet', () => B.save({ title: 'bis', td: '', code: '', project_id: pr.id }));
  const w2 = await B.save({ id: w.id, title: 'Renommé', td: 'X', code: 'y' });
  ok('permissions : un étudiant ne peut pas renommer son travail de projet', w2.title === 'TD3' && w2.code === 'y');
  await as('bob@x.fr');
  ok('permissions : travail des autres caché si le projet ne le partage pas', (await B.listProjectWork(pr.id)).length === 0);
  await as('a@x.fr');
  await B.setSettings({ free_programs: true });
  await B.saveProject({ id: pr.id, share_work: true });
  await B.setStudent(alice.id, { can_free: false, can_view_others: false });
  await as('bob@x.fr');
  ok('permissions : travail des autres visible (projet ET étudiant d\'accord)', (await B.listProjectWork(pr.id)).length === 1);
  ok('permissions : programme libre permis pour bob', !!(await B.save({ title: 'libre', td: '', code: '' })).id);
  await as('alice@x.fr');
  await refuse('permissions : programme libre refusé pour alice seule', () => B.save({ title: 'libre', td: '', code: '' }));
  ok('permissions : alice ne voit pas le travail des autres (réglage individuel)', (await B.listProjectWork(pr.id)).every((p) => p.owner === alice.id));
  ok('permissions : réglages individuels renvoyés par session()', (await B.session()).can_free === false);
  await as('a@x.fr');
  await B.setAllStudents({ can_run: false });
  ok('permissions : réglage pour tous les étudiants', (await B.listStudents()).every((s) => s.can_run === false));
  // visibilité : projet masqué (en préparation) ou masqué pour certains étudiants
  const prep = await B.saveProject({ title: 'TD5 ex1', td: 'TD5', visible: false });
  const ex2 = await B.saveProject({ title: 'TD5 ex2', td: 'TD5', visible: true, hidden_for: [alice.id] });
  await as('bob@x.fr');
  ok('visibilité : un projet masqué est invisible pour les étudiants', !(await B.listProjects()).some((p) => p.id === prep.id));
  ok('visibilité : getProject refuse un projet masqué', (await B.getProject(prep.id)) === null);
  await refuse('visibilité : impossible d\'enregistrer dans un projet masqué', () => B.save({ title: 'x', td: '', code: '', project_id: prep.id }));
  ok('visibilité : bob voit l\'exercice qui n\'est masqué que pour alice', (await B.listProjects()).some((p) => p.id === ex2.id));
  await as('alice@x.fr');
  ok('visibilité : alice ne voit pas l\'exercice masqué pour elle', !(await B.listProjects()).some((p) => p.id === ex2.id));
  await as('a@x.fr');
  ok('visibilité : l\'admin voit tout', (await B.listProjects()).filter((p) => p.td === 'TD5').length === 2);
  await B.setProjectsFlags([prep.id, ex2.id], { visible: true });
  await as('bob@x.fr');
  ok('visibilité : « tout afficher » sur un TD rend ses projets visibles', (await B.listProjects()).some((p) => p.id === prep.id));
  // rendu « J'ai fini » : verrouillage, essais, versions
  await as('a@x.fr');
  const exam = await B.saveProject({ title: 'Contrôle', td: 'TD6', submit_mode: true, run_after_submit: true, max_attempts: 2 });
  await as('bob@x.fr');
  const t1 = await B.save({ title: 'x', td: '', code: 'v1', project_id: exam.id });
  const r1 = await B.submitWork(t1.id);
  ok('rendu : « J\'ai fini » enregistre l\'heure, compte l\'essai et garde la version', !!r1.submitted_at && r1.attempts === 1 && r1.versions.length === 1 && r1.versions[0].code === 'v1');
  await refuse('rendu : un travail rendu est verrouillé', () => B.save({ id: t1.id, title: 'x', td: '', code: 'triche' }));
  await B.newAttempt(t1.id);
  await B.save({ id: t1.id, title: 'x', td: '', code: 'v2' });
  const r2 = await B.submitWork(t1.id);
  ok('rendu : nouvel essai puis 2e rendu (2 versions)', r2.attempts === 2 && r2.versions.map((v) => v.code).join() === 'v1,v2');
  await refuse('rendu : plus d\'essai au-delà du nombre fixé par l\'admin', () => B.newAttempt(t1.id));
  await as('a@x.fr');
  await B.setWork(t1.id, { extra_attempts: 1 });
  await as('bob@x.fr');
  ok('rendu : l\'admin peut donner un essai de plus', (await B.newAttempt(t1.id)).submitted_at === null);
  await B.submitWork(t1.id);
  await as('a@x.fr');
  ok('rendu : l\'admin peut déverrouiller sans compter d\'essai', (await B.setWork(t1.id, { submitted_at: null })).attempts === 3);

  await as('a@x.fr');
  await B.removeProject(pr.id);
  ok('permissions : supprimer un projet garde le travail (devient libre)', (await B.listAll()).some((p) => p.id === w.id && p.project_id === null));

  console.log(fails ? `\n${fails} échec(s)` : '\nTout est vert.');
  process.exit(fails ? 1 : 0);
}
