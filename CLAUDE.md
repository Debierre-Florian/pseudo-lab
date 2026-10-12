# CLAUDE.md — Pseudo-Lab

> Ce fichier est lu automatiquement par Claude Code. Il contient TOUT le contexte du projet : lis-le en entier
> avant de modifier quoi que ce soit. L'utilisateur (Florian) est étudiant en BUT Informatique, débutant en
> développement web, francophone. **Réponds-lui toujours en français**, explique simplement ce que tu as changé
> et quels fichiers il doit renvoyer sur GitHub.

---

## 1. Le projet en une phrase

Site web **gratuit** où des étudiants écrivent du **pseudo-code français** (`action … debut … fin`), l'**exécutent
dans le navigateur**, l'enregistrent sur leur compte, et où un **admin (Florian) décide ce qui est partagé** avec la promo.

Public : promo de BUT Informatique, cours R1.01 « Algo ». Le pseudo-code reproduit celui des TD du prof
(variables, constantes, si/sinon si/fsi, cas de, tant que, pour, repeter, tableaux 1D, matrices, entrer/sortir).

## 2. Stack et contraintes (à respecter)

- **HTML/CSS/JavaScript pur**, modules ES (`<script type="module">`). **Aucun build, aucun npm au runtime, aucun framework.**
  Le site doit rester déployable en copiant simplement les fichiers sur GitHub Pages.
- Bibliothèques **copiées dans `vendor/`** (pas de CDN) : CodeMirror 5.65.16 (`vendor/codemirror/`) et supabase-js v2 UMD (`vendor/supabase.js`).
- Hébergement : **GitHub Pages** (dépôt public). Base de données + comptes : **Supabase** (offre gratuite).
- L'exécution du pseudo-code est **100 % côté navigateur** (aucun serveur, aucune API payante).
- Les chemins sont **relatifs** (le site est servi sous `https://user.github.io/depot/`), jamais absolus (`/js/...` est interdit).
- Interface en **français**. Messages d'erreur du pseudo-code en **français, avec numéro de ligne**.
- Accessibilité de base : labels, focus visible, contraste, `prefers-color-scheme` (clair + sombre), mobile.
- **Sécurité** : jamais de `innerHTML` avec du texte venant d'un utilisateur (titres, pseudos, code). Utiliser `h()` (app.js) / `textContent`.
  La clé Supabase `anon` est publique par conception ; la **clé `service_role` ne doit JAMAIS apparaître** dans le dépôt.

## 3. Arborescence

```
index.html                 page unique (vues : éditeur, projets, mes programmes, partagés, admin, aide) + dialogues connexion / projet
css/style.css              thème clair/sombre, mise en page, console
js/pseudo.js               ★ INTERPRÉTEUR (lexer → parser → interpréteur). Marche aussi dans Node.
js/app.js                  interface : éditeur CodeMirror, console, vues, comptes, enregistrement
js/backend-local.js        mode démo : comptes/programmes dans localStorage (pseudo « admin » = rôle admin)
js/backend-supabase.js     vrais comptes + base Supabase (même interface que backend-local)
js/config.js               supabaseUrl + supabaseAnonKey (vide = mode démo)
lang/langage.json          ★ FICHIER DE BASE : mots-clés, types, fonctions intégrées, options
lang/modele.pseudo         squelette proposé aux étudiants (bouton « Charger… → Modèle de base »)
lang/exemples/index.json   liste des exemples (id, titre, td, fichier, test{entrees, contient})
lang/exemples/*.pseudo     8 exemples corrigés (TD1/TD2)
supabase/schema.sql        tables profiles + programs + settings + projects, RLS, triggers (installation complète)
supabase/migration-projets.sql  migration idempotente « projets + permissions » (déjà incluse à la fin de schema.sql)
tests/run.mjs              tests Node de l'interpréteur + exemples + modèle   → node tests/run.mjs
tests/td-reels.mjs         passe les programmes d'un fichier de TD (.md) à l'interpréteur
vendor/                    CodeMirror 5, supabase-js
.github/workflows/keepalive.yml   (optionnel) ping Supabase pour éviter la mise en pause
README.md                  guide de mise en ligne
```

## 4. Architecture de l'interpréteur (`js/pseudo.js`)

Exports : `normalise, PseudoError, StopSignal, makeLang, lex, parse, fmt, Interpreter, runSource`.

### 4.1 `makeLang(json)` — pont avec `lang/langage.json`
Construit : `single` (mot normalisé → nom canonique), `phrases` (mots-clés à plusieurs mots, triés du plus long au plus court),
`types` (alias → `entier|reel|booleen|caractere|chaine`), `funcs` (alias → nom canonique de fonction intégrée),
`soft` (mots-clés « contextuels » utilisables comme noms de variable : `a`, `de`, `pas`), `options`.
`normalise(s)` = minuscules + suppression des accents (c'est pourquoi `début` = `debut`).

### 4.2 `lex(src, lang)`
Jetons : `{type:'num'|'str'|'word'|'op'|'bad'|'eof', line, raw, value?, norm?, kw?}`.
- Les mots ont `norm` (normalisé) et `kw` (nom canonique du mot-clé, ou `null` si identifiant).
- Les expressions à plusieurs mots (`tant que`, `fin si`, `allant de`, `cas de`, `retour a la ligne`…) sont **fusionnées en un seul jeton** (même ligne obligatoire).
- `jusqu'a` est géré à part. `&&` et `||` deviennent les mots `et` / `ou`.
- Commentaires `//` et `/* */`. Les antislashs Markdown (`\[`, `\*`, `\_`) sont ignorés (les étudiants collent depuis Obsidian).
- Une erreur lexicale (guillemet non fermé, caractère inconnu) produit un jeton `bad` ; **l'erreur n'est levée que quand le parser l'atteint**
  (pour que la première erreur *dans l'ordre du fichier* soit rapportée, pas la première erreur lexicale).

### 4.3 `Parser` (classe interne, analyse descendante récursive)
Méthodes : `parseProgram, bareDecl, parseConst, parseVarList, parseTypeDecl, parseType, parseBlock, parseStatement, parseLvalue,
parseAssign, parseOut, parseIn, expectClose, parseIf, parseWhile, parseFor, parseRepeat, parseCase,
parseExpr → parseOr → parseAnd → parseNot → parseCmp → parseAdd → parseMul → parseUnary → parsePrimary`.
Utilitaires : `isKw(canon)`, `isOp(v)`, `acceptKw`, `acceptOp`, `expectOp`, `expectIdent`, `isIdent(tok)`, `fail(msg, tok, line)`.
`CLOSERS = {sinon, fsi, ftq, fpour, jusqua, fcas, fin}` : `parseBlock` s'arrête sur l'un d'eux (c'est l'appelant qui valide le bon fermant via `expectClose`).

Structure d'un programme : `[action NOM] {const|var|type|déclaration nue} {instructions avant debut} debut {instructions} fin`.
Retourne `{name, decls, pre, body}`.

**Nœuds d'instruction** : `assign{target,expr,eq?}`, `out{args}`, `nl`, `in{targets}`, `if{clauses[{cond,body,line}],els}`,
`while{cond,body}`, `repeat{body,cond}`, `for{v,from,to,step,body}`, `case{subject,branches[{vals,body}],def}`,
`callstmt{name,norm,args}`, `return{expr|null}`. Programme : `{name, decls, pre, body, subs}` ; sous-programme :
`{kind:'fonction'|'procedure', name, norm, params[{name,norm,type,mode:'valeur'|'var'}], ret, decls, body, line, endLine}`.
**Nœuds d'expression** : `num, str, bool, var{name,norm}, idx{name,norm,idx[]}, neg, not, bin{op,l,r}, call{fn,args}` (intégrée), `ucall{name,norm,args}` (fonction de l'étudiant).
Opérateurs `bin` : `+ - * / div mod = != < > <= >= et ou` (`%` → `mod`, `==` → `=`, `<>` → `!=`).
**Déclarations** : `const{name,norm,type,expr}`, `var{name,norm,type}`, `type{name,norm,type}` ;
types : `{k:'base',name}`, `{k:'named',name,norm}`, `{k:'array',dims[{lo,hi}],elem}`.

### 4.4 `Interpreter`
- **Exécution par générateurs** : `*exec(stmt)` / `*execBlock(list)`. Un `yield {t:'read', label}` demande une saisie (la valeur revient via `gen.next(valeur)`),
  un `yield {t:'tick'}` toutes les 4096 instructions rend la main au navigateur (l'interface reste fluide, le bouton Stop fonctionne).
  `async run()` pilote le générateur. **Les expressions (`ev`) sont synchrones** (point important pour les fonctions, voir section 12).
- `io = { write(texte), read(label) → Promise<string>, warn?(texte) }` : fourni par `app.js` (console) ou par les tests (entrées scriptées).
- `opts = { strict, sortirRetourLigne, maxInstructions }` ; `onReady(interp)` permet à l'UI de récupérer l'interpréteur pour `stop()`.
- **Variables** : `this.vars: Map(nomNormalisé → {name, norm, kind:'scalar'|'array', type, value | dims,data, isConst})`.
  Portées : `this.vars` (globale) + `this.local` (sous-programme en cours) ; toujours passer par `lookup(norm)` (voir 12.0).
  Types : `this.types: Map(nom → noeud de type)`.
- Méthodes clés : `declare, resolveType, newVar, getVar, getScalar, offset (indices + bornes), arrVar, coerce (typage à l'affectation), assign, ev, binop, call (fonctions intégrées), cond, step (garde anti-boucle infinie)`.
- Tableaux : stockage plat `data[]`, `dims[{lo,hi,size}]`, indices **vérifiés** (`indice 0 en dehors du tableau « T » (cases valides : 1 à 10)`), 1 à n dimensions (`T[i][j]` ou `T[i, j]`).
- Erreurs : `PseudoError(msg, ligne)` → message `Ligne N : …`. Arrêt utilisateur : `StopSignal`.
- `runSource(src, lang, io, opts)` → `{ok, error?, stopped?, interp}` (ne jette pas pour les erreurs de pseudo-code).

## 5. Le pseudo-code actuellement supporté

```
action nom                                  // « action », « programme » ou « algorithme »
const var N = 10                            // aussi : const N 10 / const var N : 10 / var const X 0.95
type vecteur = tableau[1..N] de type entier // aussi tableau[N] ; matrices : tableau[1..N][1..M] ; « entiers » accepté
var i, total : entier                       // types : entier, reel, booleen, caractere, chaine (+ alias : bool, char, texte…)
var T : vecteur
debut
  x <- 3                                    // aussi := et ← ; « = » accepté avec avertissement ; += et -=
  sortir("a", x)   entrer(x)   entrer(a, b) retour a la ligne
  si (…) alors … sinon si (…) alors … sinon … fsi       // « sinon si » sur la MÊME ligne = chaîné, un seul fsi
  tant que (…) faire … ftq        // « faire » ou « alors » acceptés
  pour i allant de 1 a N [pas 2] faire … fpour
  repeter … jusqu'a (…)
  cas de x :  1 : …  2, 3 : …  sinon : …  fcas       // fcas optionnel (le « fin » du programme ferme aussi)
fin
```
Opérateurs : `+ - * / div mod %`, `= != <> < > <= >=`, `et ou non` (et `&& ||`), `VRAI FAUX`. Fonctions intégrées : `racine/sqrt, abs, partie_entiere, arrondi, min, max, longueur, aleatoire`.
Les instructions placées **entre les déclarations et `debut`** (ex. `reduction <- 0`) sont tolérées (tableau `pre`).

**Fonctions et procédures** (syntaxe du CM R1.01 de I. Delignières, implémentée — voir 12.0) :
```
action TestDivision
procedure division_entiere(a : entier, b : entier; var q : entier, var r : entier)
debut                                      // pas de var locale ici, sinon : var x : entier avant debut
  q <- a DIV b
  r <- a MOD b
fin
fonction somme_carres(n : entier) : entier
var i, terme : entier                      // variables locales
debut
  ...
  retourner(terme)                         // aussi : retourner terme, retourne, retournez, renvoyer
fin
var nb, d, quotient, reste : entier        // variables globales (visibles dans les sous-programmes)
debut
  division_entiere(nb, d, quotient, reste) // appel de procédure : juste le nom (pas d'« appeler »)
  sortir(somme_carres(nb))                 // appel de fonction dans une expression
fin
```
Sous-programmes acceptés : avant `action`, entre l'en-tête et `debut`, ou après le `fin` du principal. `FIN FONCTION` / `FIN PROCEDURE` optionnels après `fin`.
Paramètres : `,` ou `;` comme séparateur, groupement `a, b : entier`, `var` = par variable (référence), sinon par valeur (copie, y compris les tableaux). Type `cc` = chaîne.

## 6. Décisions de conception (ne pas les casser sans demander)

1. **Tolérance** : accents et casse ignorés ; variantes d'écriture acceptées (voir `langage.json`). Les TD réels de l'étudiant contiennent des variantes et des fautes : le parser doit accepter les variantes, mais signaler les vraies erreurs avec un message clair.
2. `sortir` **ne passe pas à la ligne** tout seul (cohérent avec `retour a la ligne` des TD). Option `sortirRetourLigne` (langage.json + case à cocher dans l'UI).
3. **Mode tolérant (défaut)** : variable non déclarée → créée avec **avertissement** ; variable lue avant d'avoir une valeur → valeur par défaut (0, FAUX, "") avec avertissement ; décimal rangé dans un `entier` → **tronqué avec avertissement**.
   **Mode strict** (case à cocher) : tout cela devient une **erreur**. Les avertissements sont dédupliqués (`warn(key, …)`).
4. Une condition doit être **booléenne** (`si (x mod 5)` est une erreur pédagogique voulue). Comparer deux types différents est une erreur. `et`/`ou` sont **court-circuités**.
5. `/` = division réelle ; `div` = division entière ; `mod` = reste. Division par zéro = erreur claire.
6. Saisie : `entrer` convertit selon le type déclaré (entier, réel avec virgule acceptée, booléen `oui/non/y/n/vrai/faux`, texte) ; saisie invalide → message et **nouvelle demande**.
7. Garde-fou : 3 000 000 d'instructions maximum (`maxInstructions`) puis erreur « boucle infinie ? » ; bouton Stop (interrompt aussi un `entrer` en attente).
8. Les mots-clés « contextuels » (`a`, `de`, `pas`) peuvent rester des noms de variables (`soft` dans langage.json).
9. Chaque `PseudoError` porte un numéro de ligne ; l'UI surligne la ligne fautive dans l'éditeur.

## 7. Interface (`js/app.js`)

- `state` (objet global, exposé en `window.__pl` pour le débogage) : `lang, backend, me, cm, doc, dirty, running, interp, view…`.
- `h(tag, attrs, ...enfants)` : création DOM sûre. `toast(msg, kind)`.
- `con` : console façon terminal (`write, warn, info, error, read(label)` avec `<input>` en ligne, `cancelRead`).
- `defineMode(lang)` : coloration CodeMirror **générée depuis langage.json** (mots-clés, types, atomes VRAI/FAUX, fonctions intégrées).
- `setupEditor`, `setDoc`, `save`, `run`, `stop`, `fillLoader`/`onLoaderChange` (modèle de base, exemples, modèles admin), `openProgram`.
- Vues : `showView(name)` + `renderMine`, `renderShared`, `renderAdmin` ; navigation par `#hash`.
- Comptes : `openAuth`, `submitAuth`, `logout`, `renderAuthBox`. L'onglet Admin n'apparaît que si `state.me.role === 'admin'`.
- Règle : un étudiant qui ouvre un programme qui n'est pas le sien obtient une **copie** (id null, titre « (copie) ») ; un admin édite l'original.
- Démarrage : `init()` charge `lang/langage.json`, `modele.pseudo`, `exemples/index.json`, choisit le backend (Supabase si `config.js` rempli, sinon démo).

### Interface commune des backends (`backend-local.js` et `backend-supabase.js`)
`demo, session(), signUp({email,password,pseudo}), signIn({email,password}), signOut(), listMine(), listShared(), listAll() (admin), listTemplates(),
save({id,title,td,code,project_id}), remove(id), setFlags(id,{published,is_template}) (admin),
getSettings(), setSettings(patch) (admin), listProjects(), getProject(id), saveProject({id?,…}) (admin), removeProject(id) (admin),
listProjectWork(projectId), listStudents() (admin), setStudent(id, patch) (admin), setAllStudents(patch) (admin)`.
Un programme : `{id, owner, author, title, td, code, project_id, published, is_template, created_at, updated_at}`.
`session()` renvoie aussi `can_run, can_free, can_view_others`. Un projet : `{id, title, td, instructions, starter_code, run_enabled, share_work, visible, hidden_for[], created_at, updated_at}`.
`setProjectsFlags(ids, patch)` (admin) : modifie plusieurs projets d'un coup (« tout afficher / tout masquer » un TD).
Rendu : `submitWork(id)` (« J'ai fini »), `newAttempt(id)` (nouvel essai s'il en reste), `setWork(id, patch)` (admin : déverrouiller
`{submitted_at:null}`, `{extra_attempts:n}`). Projet : `submit_mode, run_after_submit, max_attempts` ; programme : `submitted_at,
attempts, extra_attempts, versions[{n,code,at}]`.
Toute nouvelle fonctionnalité de données doit être ajoutée **aux deux backends** et à `schema.sql`.

## 8. Base de données et sécurité (`supabase/schema.sql`)

- `profiles(id → auth.users, pseudo unique (insensible à la casse), role 'student'|'admin')`, créé par le trigger `handle_new_user` (pseudo pris → suffixe).
- `programs(id, owner → profiles, title, td, code, published, is_template, created_at, updated_at)`.
- **RLS activée** : un étudiant lit ses programmes + ceux `published`/`is_template` ; l'admin (`is_admin()`) lit/modifie/supprime tout.
- Trigger `programs_guard` : seul l'admin peut changer `published`/`is_template` ; le propriétaire ne change jamais ; `updated_at` automatique.
- `settings` (une ligne, id=1 : `run_enabled`, `free_programs`), `projects` (créés par l'admin seulement), `programs.project_id`
  (unique par (owner, project_id) ; `on delete set null` : supprimer un projet rend le travail « libre »).
  Permissions = **ET** de tous les niveaux : exécuter = global ET `profiles.can_run` ET `projects.run_enabled` (interface seulement, voir `runBlock` dans app.js) ;
  enregistrer hors projet = `settings.free_programs` ET `profiles.can_free` (RLS via `can_free()`) ; voir le travail des autres =
  `projects.share_work` ET `profiles.can_view_others` (RLS via `can_see_work()`). L'admin a toujours tout. `profiles_guard` empêche de changer le rôle depuis le site.
- Le rôle admin ne se donne **que** par SQL : `update public.profiles set role='admin' where lower(pseudo)=lower('Pseudo');`
- Réglage Supabase nécessaire : Authentication → Providers → Email : **Enable email provider = ON**, **Confirm email = OFF** (sinon la limite d'envoi de mails bloque les inscriptions).
- Toute modification du schéma doit être fournie comme **script SQL de migration idempotent** (`create … if not exists`, `drop policy if exists`…) que l'utilisateur colle dans Supabase › SQL Editor, + mise à jour de `schema.sql`.

## 9. Déploiement (l'utilisateur le fait lui-même, sans git en ligne de commande)

1. Fichiers sur un dépôt GitHub **public**, `index.html` à la **racine** du dépôt. Pages : Settings → Pages → Deploy from a branch → `main` / root.
2. `js/config.js` contient l'URL du projet Supabase et la clé **anon**. Vide = mode démo (bandeau jaune).
3. Après chaque modification : commit sur GitHub, attendre 1–2 min, puis **Ctrl+Maj+R** (cache du navigateur, ça a déjà piégé l'utilisateur).
   **Avant chaque envoi : `node tools/version.mjs`** — change le `?v=…` des fichiers (index.html, imports et fetch de app.js).
   GitHub Pages sert les fichiers avec `max-age=600` : sans ce numéro, un navigateur peut garder un ancien `app.js` avec un
   nouveau `index.html` (ex. bouton « Nouvel essai » resté caché). Tout nouvel import/fetch dans app.js doit porter `?v=…` / `+ V`.
4. À chaque livraison, **liste précisément les fichiers modifiés/ajoutés** pour que l'utilisateur sache quoi renvoyer sur GitHub.

## 10. Tests et vérification

- `node tests/run.mjs` : tests de l'interpréteur (entrées scriptées via `exec(src, inputs, opts)`), exemples (`lang/exemples/index.json` : chaque exemple a `test.entrees` et `test.contient`), modèle de base. **Doit rester entièrement vert.**
- `node tests/td-reels.mjs chemin/TD.md` : exécute chaque `action … fin` d'un fichier de TD avec des entrées bidon et affiche erreurs/avertissements (utile pour vérifier la tolérance sur du vrai code d'étudiant).
- Serveur local : `python3 -m http.server 8000` puis http://localhost:8000 (ouvrir `index.html` en double-clic ne marche pas : modules ES + fetch).
- Test navigateur de bout en bout (Playwright/Chromium si dispo) à refaire après un changement d'interface : exécuter un exemple avec saisie, erreur surlignée, Stop, inscription/connexion démo, page admin, publication, vue mobile 390 px sans défilement horizontal, aucune erreur console.

## 11. Méthode de travail attendue

1. **Lire avant de modifier** (`pseudo.js`, `langage.json`, `app.js`). Faire des changements minimaux et ciblés ; ne pas réécrire ce qui marche.
2. Les mots-clés vont dans `langage.json`, la logique dans `pseudo.js` ; ne pas coder de mots-clés en dur dans `app.js` (la coloration les lit déjà dans le JSON).
3. **Tests d'abord ou en même temps** : chaque fonctionnalité = cas de test dans `tests/run.mjs` (cas normal + au moins une erreur attendue avec numéro de ligne) + un exemple dans `lang/exemples/`.
4. Lancer `node tests/run.mjs` à chaque étape ; ne jamais livrer avec un test rouge.
5. Messages d'erreur : français, tutoiement, concrets, avec la ligne (« Ligne 12 : … »). Pas de jargon.
6. Mettre à jour la **documentation** à chaque ajout : onglet « Aide » (`index.html`), `lang/modele.pseudo` (aide-mémoire), `README.md`, et la section 5 de ce fichier.
7. Ne pas ajouter de dépendance (npm, CDN, framework). Si une bibliothèque est vraiment nécessaire, la copier dans `vendor/` et expliquer pourquoi.
8. Compatibilité : **les programmes déjà enregistrés par les étudiants doivent continuer à fonctionner** (aucune rupture de syntaxe existante).
9. Terminer chaque tâche par un résumé simple pour l'utilisateur : ce qui change pour les étudiants, la liste des fichiers à renvoyer sur GitHub, et ce qu'il faut faire côté Supabase (souvent : rien).

---

## 12. TÂCHE N°1 — Fonctions et procédures écrites par l'étudiant

### 12.0 ✅ FAIT (octobre 2026) — choix retenus (d'après le CM « Procédures et fonctions » et la fiche TD3)
- `action` = programme principal uniquement. `fonction` / `procedure` (accents ignorés). Appel direct `p(...)`, sans `appeler`.
- Modes : **par valeur** par défaut, **`var`** = par variable. Pas de `E/S/ES`. Les tableaux par valeur sont **copiés** (avertissement
  si une *procédure* modifie un tableau reçu par valeur). Types des paramètres vérifiés (entier/réel compatibles, caractère/chaîne compatibles).
- **Globales visibles** dans les sous-programmes (le cours le dit), masquées par une locale ou un paramètre de même nom.
- **Vérifications statiques** (`checkProgram`, avant exécution) : sous-programme inexistant, nombre de paramètres, valeur donnée à un
  paramètre `var`, procédure utilisée dans une expression, fonction sans aucun `retourner`. Erreurs à l'analyse : `retourner` hors
  fonction, `retourner valeur` dans une procédure, doublon de nom, nom d'une fonction intégrée, type de retour ou de paramètre manquant.
  À l'exécution : mauvais type, fonction terminée sans `retourner` (ligne du `fin`), type de retour, récursion > `maxAppels`.
- **Architecture** : portées = `this.vars` (globale) + `this.local` (Map du sous-programme en cours, sauvegardée/restaurée par `callUser`).
  Paramètre `var` = objet proxy avec `get/set value` vers la variable ou la case de l'appelant. `retourner` = `throw new ReturnSignal`.
- **`entrer` dans une fonction appelée dans une expression est autorisé** (TD3 ex6 `oui_non()` le fait) : `walk` marque `n.u` sur
  les expressions qui contiennent un appel (`ucall`), et `uu` sur les instructions concernées. Ces instructions passent par
  `execU` / `evg` (versions générateur) ; toutes les autres gardent le chemin rapide `exec` / `ev` synchrone.
  ⚠ Ne pas ajouter de `yield*` dans `exec` : un générateur plus gros est ~15 % plus lent (mesuré). Résultat : pour 1 000 000 d'itérations,
  5,5 s contre 6,3 s avant la tâche. Repli synchrone `callSync` (erreur si `entrer`) pour les rares endroits non convertis (indice à gauche de `<-`, bornes, constantes).
- **Récursivité** : `maxAppels = 200` par défaut, car chaque appel empile ~10 générateurs et la pile JS déborde vers 320–400 niveaux.
  Un débordement de pile restant est converti en `PseudoError` (« trop d'appels imbriqués »).

### 12.1 Questions à poser AVANT de coder (l'utilisateur a le cours sous les yeux)
1. Demande-lui de **coller un exemple de fonction ET de procédure tels qu'écrits dans son cours/TD** (c'est la référence absolue, ne pas inventer la syntaxe).
2. Le mot **`action`** désigne aujourd'hui le programme principal (alias de `programme`). Dans certains cours d'algo, `action` désigne aussi une **procédure**. Confirme avec lui comment son cours distingue : programme principal / procédure / fonction.
3. **Paramètres** : y a-t-il des modes (`E` entrée, `S` sortie, `ES` entrée-sortie ; ou `donnée` / `résultat` ; ou `var`) ? Les tableaux sont-ils passés par référence ?
4. **Retour** : `retourner expr` ? `nom_fonction <- expr` ? `retour expr` ?
5. **Appel de procédure** : `appeler p(…)` ou simplement `p(…)` ?
6. Où se placent les sous-programmes : **avant** le programme principal, après, ou n'importe où ? Les fonctions ont-elles leurs propres `const/var` locales ?
7. Récursivité attendue ?

### 12.2 Syntaxe cible par défaut (si le cours ne dit rien de contraire — à valider avec l'utilisateur)
```
fonction carre(x : entier) : entier
var y : entier
debut
  y <- x * x
  retourner y
fin

procedure afficher_ligne(n : entier, E c : caractere)
var i : entier
debut
  pour i allant de 1 a n faire
    sortir(c)
  fpour
  retour a la ligne
fin

procedure echanger(ES a : entier, ES b : entier)
var t : entier
debut
  t <- a
  a <- b
  b <- t
fin

action principal
var r, u, v : entier
debut
  r <- carre(5)
  afficher_ligne(10, "*")        // ou : appeler afficher_ligne(10, "*")
  u <- 1   v <- 2
  echanger(u, v)
fin
```
Rester **tolérant** : accepter les variantes (`fonction`/`function`, `procedure`/`procédure`, `retourner`/`retourne`/`retour`, appel avec ou sans `appeler`).

### 12.3 Changements à faire — `lang/langage.json`
Ajouter dans `motsCles` : `fonction`, `procedure`, `retourner` (+ `appeler` si utile, + éventuels `E`/`S`/`ES`, `donnee`/`resultat` si le cours les utilise).
Attention aux **conflits** : `E`, `S` sont des noms de variable plausibles → les rendre **contextuels** (`contextuels`) et ne les interpréter comme modes qu'en position de paramètre.

### 12.4 Changements à faire — `Parser` (`js/pseudo.js`)
- `parseProgram` : aujourd'hui la boucle `while (!isKw('debut'))` lit les déclarations du programme principal. Il faut reconnaître **`fonction`/`procedure`** à ce niveau
  (et aussi *après* le `fin` du programme principal si le cours le permet) et appeler une nouvelle méthode `parseSubprogram()`.
  Attention : le corps d'un sous-programme a **son propre `debut … fin`** ; ne pas confondre avec le `debut` du programme principal.
  Retourner `{name, decls, pre, body, subs}` avec `subs = [{kind:'fonction'|'procedure', name, norm, params:[{name,norm,type,mode}], ret:type|null, decls, body, line}]`.
- `parseSubprogram` : en-tête (`nom`, `(` paramètres `)`, `: typeRetour` pour une fonction), déclarations locales (`const/var/type`), `debut`, `parseBlock`, `fin` (avec `expectClose`).
  Paramètres : `nom : type`, plusieurs séparés par `,` ; regrouper `a, b : entier` comme pour `parseVarList` ; types tableau acceptés (`tableau[…] de …` ou un type nommé).
- `parseStatement` : nouvelle instruction `retourner expr` (nœud `return{expr}`) ; **appel de procédure comme instruction** (nœud `callstmt{name,norm,args}`) — c'est le cas aujourd'hui rejeté dans `parseAssign` avec le message « les procédures et fonctions personnalisées ne sont pas encore gérées ». Supprimer/adapter ce message.
- `parsePrimary` : l'appel `nom(args)` est aujourd'hui accepté **uniquement** pour les fonctions intégrées (`lang.funcs`) et sinon erreur « la fonction … n'existe pas ». Désormais : si `nom` est une fonction **utilisateur** (connue après avoir parsé toute la liste des `subs`, donc faire la vérification d'existence **à l'exécution** ou en seconde passe) → nœud `call{fn:'<utilisateur>', name, norm, args, user:true}`.
  Priorité : une fonction utilisateur peut-elle masquer une intégrée ? Décider (suggestion : erreur « nom déjà utilisé par une fonction intégrée »).
- Erreurs de parsing à soigner (en français) : `retourner` hors d'une fonction, fonction sans `retourner` accessible, mauvais nombre de paramètres (à l'exécution), doublon de nom de sous-programme.

### 12.5 Changements à faire — `Interpreter` (`js/pseudo.js`)
1. **Portées** : remplacer l'accès direct à `this.vars` par une **pile de portées** (`this.frames`). Recherche d'une variable : portée locale d'abord, puis **globale** (variables/constantes du programme principal) — vérifier avec l'utilisateur si le cours autorise l'accès aux globales depuis un sous-programme (sinon : erreur pédagogique « la variable x n'est pas visible dans la fonction »). Adapter `getVar/getScalar/assign/arrVar/declare/newVar`.
2. **Enregistrement des sous-programmes** : `this.subs: Map(norm → définition)` rempli dans `main()` avant l'exécution.
3. **Appel** :
   - créer une nouvelle portée, déclarer les paramètres et les `var` locales, lier les arguments ;
   - **passage par valeur** (mode entrée) : copier la valeur (pour un tableau : copie profonde) ; **par référence** (modes sortie / entrée-sortie) : l'argument doit être une variable ou une case de tableau (`lvalue`), sinon erreur « l'argument n°2 doit être une variable » ; à la fin de l'appel, recopier (ou lier un alias vers la variable de l'appelant) ;
   - vérifier **nombre et types** des arguments avec des messages clairs (`la fonction carre attend 1 paramètre, tu en donnes 2`) ;
   - `retourner` : mécanisme de retour (signal interne ou exception interne capturée par l'appel) ; une **fonction** doit renvoyer une valeur du type déclaré (utiliser `coerce`), une **procédure** ne renvoie rien ; fonction terminée sans `retourner` = erreur « la fonction n'a pas retourné de valeur ».
4. **Récursivité** : profondeur maximale (ex. 1000 appels) avec erreur française « trop d'appels imbriqués : récursion infinie ? ». Le compteur d'instructions `step` reste global.
5. **⚠ Point d'architecture crucial** : `ev` (évaluation des expressions) est **synchrone**, mais le corps d'une fonction est exécuté par des **générateurs** (`*exec`) qui peuvent faire `yield` (saisie `entrer`, `tick` pour l'UI).
   - Appel de **procédure comme instruction** (`callstmt`) : se fait dans `*exec` → utiliser `yield*` sur le corps ; `entrer` et Stop fonctionnent normalement.
   - Appel de **fonction dans une expression** : option recommandée = **exécuter le corps en synchrone** en pilotant le générateur à la main (`const g = this.execBlock(body); let r = g.next(); while(!r.done){ if (r.value.t === 'read') throw erreur « entrer n'est pas autorisé dans une fonction appelée depuis une expression » ; /* 'tick' : ignorer */ r = g.next(); }`). Le compteur `maxInstructions` protège toujours des boucles infinies.
   - Alternative (plus générale, plus lente) : transformer `ev` en générateur partout. Ne la choisir que si l'utilisateur veut `entrer` dans une fonction, et **mesurer l'impact** sur les performances (exécuter un `pour` de 1 000 000 d'itérations avant/après).
   - Documenter le choix dans ce fichier.
6. Les **avertissements**/erreurs doivent garder le bon numéro de ligne (celui de l'instruction dans le sous-programme).

### 12.6 Autres fichiers à mettre à jour
- `index.html` (onglet **Aide**) : carte « Fonctions et procédures » avec la syntaxe retenue.
- `lang/modele.pseudo` : section d'aide-mémoire sur `fonction` / `procedure` / `retourner`.
- `lang/exemples/` : ajouter au moins 3 exemples (fonction simple, procédure avec paramètre de sortie type `echanger`, récursivité type factorielle/fibonacci) + lignes dans `index.json` avec `test{entrees, contient}`.
- `tests/run.mjs` : voir 12.7.
- `README.md` + section 5 de ce fichier : décrire la nouvelle syntaxe.
- La coloration CodeMirror se met à jour toute seule via `langage.json` (vérifier dans le navigateur).

### 12.7 Critères d'acceptation (la tâche est finie quand TOUT est vrai)
1. `node tests/run.mjs` est **entièrement vert**, y compris les anciens tests (aucune régression sur la syntaxe existante).
2. Nouveaux tests couvrant : fonction avec valeur de retour utilisée dans une expression ; fonction appelée dans une condition ; procédure avec paramètre par valeur ; procédure avec paramètre de sortie/entrée-sortie (`echanger`) ; tableau passé en paramètre et modifié ; variables locales qui n'écrasent pas les globales ; récursivité (factorielle de 5 = 120, fibonacci) ; erreurs : mauvais nombre d'arguments, mauvais type, argument non-variable pour un paramètre de sortie, fonction sans `retourner`, récursion infinie, `retourner` hors fonction, appel d'un sous-programme inexistant — **chacune avec le bon numéro de ligne**.
3. Les 8 exemples existants fonctionnent toujours, + les nouveaux exemples passent.
4. `node tests/td-reels.mjs` sur les TD de l'utilisateur ne produit **pas de nouvelles erreurs** par rapport à avant.
5. Test navigateur : un programme avec fonction + procédure s'exécute, `entrer` marche dans une procédure, Stop interrompt une récursion/boucle, l'erreur d'un sous-programme surligne la bonne ligne.
6. Performance : un `pour` de 1 000 000 d'itérations s'exécute dans un temps comparable à avant (pas de dégradation notable).
7. Aide, modèle, README et ce fichier mis à jour. Résumé final en français avec la liste exacte des fichiers à renvoyer sur GitHub.

---

## 12bis. ✅ FAIT — Projets et permissions (octobre 2026)
Choix de l'utilisateur : projet = exercice (titre, TD, consigne, code de départ) créé par l'admin, un travail par étudiant ;
réglages par projet ET par étudiant ET global, combinés par ET ; le formulaire de création d'un projet impose de choisir
exécution oui/non et travail des autres oui/non (radios sans valeur par défaut). `refreshPerms()` relit réglages + profil + projet
juste avant chaque exécution. Tests : section « permissions » de `tests/run.mjs` (backend démo).

Ensuite : page d'**accueil** (`view-home`) pour les visiteurs non connectés (seule page publique) ; accès aux vues
décidé par `viewAllowed()` dans app.js : étudiant → l'éditeur seulement après avoir ouvert un projet ou un programme
(`state.doc.opened`), ou directement s'il a droit aux programmes libres (bouton « + Nouveau programme » dans Mes programmes) ;
Aide et Admin réservées à l'admin. Navigation : `showView(route, push)` ajoute une entrée d'historique (`pushState`) pour que
le bouton Retour du navigateur revienne à la page précédente ; routes `#vue` et `#projects/<id>` (travail rendu). Les
permissions sont relues (`refreshPerms`) à chaque changement de page pour un étudiant ; liste « Charger… » réservée à l'admin ; `applyEditorRules()` verrouille titre/TD (travail de
projet, ou sans programmes libres), cache « Nouveau » et désactive « Enregistrer » hors projet. Le trigger `programs_guard`
impose le titre/TD du projet au travail d'un étudiant. L'admin garde toutes les fonctionnalités.

Visibilité : `projects.visible` (décoché = en préparation, invisible pour tous les étudiants) et `projects.hidden_for uuid[]`
(étudiants pour qui il reste invisible). RLS via `can_use_project(pid)` : lecture du projet, enregistrement dedans et
« travail des autres ». Le formulaire impose le choix Visible/Masqué ; la page Projets range les projets par TD avec
« tout afficher / tout masquer ». L'éditeur s'ouvre **vide** (le modèle de base ne sert plus qu'à l'admin : liste « Charger… »
et bouton « Prendre le modèle de base » du formulaire de projet).

Rendu « J'ai fini » (option du projet) : confirmation, puis travail verrouillé (`programs_guard` remet l'ancien code si un
étudiant modifie un travail rendu, compte l'essai, ajoute la version dans `versions`). Option « exécution seulement après
J'ai fini » (`runBlock`). `max_attempts` essais par projet + `extra_attempts` donnés par l'admin à un étudiant ; « Nouvel essai »
(bouton dans l'éditeur `#btn-retry` et sur la carte du projet) repart du code rendu. L'admin voit l'état/essais de chacun, ouvre
n'importe quelle version (copie), déverrouille ou donne +1 essai (page « Travail des étudiants »).

## 13. Idées d'évolutions ultérieures (ne pas les faire sans demande)

- Bouton **« mot de passe oublié »** (Supabase `resetPasswordForEmail`) + page de réinitialisation.
- **Code d'inscription** à communiquer en cours (champ supplémentaire vérifié côté base).
- **Enregistrements** (structures `type pers = enregistrement … fin`), champs `p.nom`.
- Chaînes de caractères : indexation `s[i]`, concaténation, `longueur`.
- Instruction `selon`, boucle `pour … decroissant`.
- Mode « pas à pas » / affichage des variables pendant l'exécution (utile pédagogiquement).
- Export/téléchargement d'un programme en `.pseudo`, import depuis un fichier.
- Admin : liste des comptes, réinitialisation, statistiques, correction automatique par jeux d'entrées/sorties attendus.
- Partage par lien direct vers un programme publié.

## 14. Pièges connus

- **Cache navigateur** : après un déploiement, l'ancien `config.js` ou `pseudo.js` peut rester → Ctrl+Maj+R ou navigation privée. À rappeler à l'utilisateur.
  Le numéro de version `?v=…` (`node tools/version.mjs`, voir section 9) évite ce problème pour les étudiants.
- **Mode démo silencieux** : si `config.js` est vide ou si `vendor/supabase.js` ne charge pas, le site retombe en démo (bandeau jaune) ; les comptes sont alors locaux au navigateur.
- Supabase : « Enable email provider » doit être **ON** ; « Confirm email » **OFF** ; sinon « Trop de tentatives ». Le message « Success. No rows returned » d'un `update` SQL **ne prouve pas** qu'une ligne a été modifiée (vérifier avec un `select`).
- `fin` est ambigu : fin du programme / fin d'un sous-programme / `fin si`, `fin pour`, `fin tant que` (fusionnés par le lexer s'ils sont sur la même ligne). Avec les sous-programmes, bien vérifier l'imbrication des `fin`.
- `a`, `de`, `pas` sont des mots contextuels : ne pas les rendre « durs » (`kw` non-soft) sous peine de casser les boucles `pour i allant de 1 a N` et les variables nommées `a`.
- Les entrées utilisateur affichées dans l'UI passent toujours par `textContent`/`h()` (jamais `innerHTML`).
- Les fichiers de TD de l'étudiant (Markdown Obsidian) contiennent des échappements `\[` `\*` et des erreurs réelles : ne pas « corriger » le parser pour qu'il accepte du code faux ; il doit **expliquer** l'erreur.
