# Pseudo-Lab

Un site gratuit où les étudiants écrivent leur **pseudo-code français** (`action … debut … fin`),
l'**exécutent en ligne**, l'enregistrent sur leur compte, et où **l'admin décide de ce qui est partagé**.

* Aucun framework, aucune installation : ce sont des fichiers HTML/CSS/JS.
* L'exécution se fait **dans le navigateur** de l'étudiant (rien à héberger côté serveur).
* Comptes + sauvegarde : **Supabase** (gratuit). Hébergement : **GitHub Pages** (gratuit).

## 1. Tester tout de suite (mode démo)

```bash
cd pseudocode-lab
python3 -m http.server 8000      # puis ouvre http://localhost:8000
```

Tant que `js/config.js` est vide, le site tourne en **mode démo** : comptes et programmes sont stockés
dans ton navigateur. Inscris-toi avec le pseudo **`admin`** pour voir l'interface prof.
(Ouvrir `index.html` en double-cliquant ne marche pas : il faut ce petit serveur.)

## 2. Mettre en ligne gratuitement

### a) Base de données (Supabase)
1. Crée un compte sur supabase.com → **New project** (région Europe, mot de passe de base au choix).
2. **SQL Editor → New query** : colle tout `supabase/schema.sql` → **Run**.
3. **Authentication → Providers → Email** : pour que les étudiants puissent se connecter tout de suite,
   décoche **Confirm email** (sinon ils doivent cliquer un lien reçu par mail).
4. **Project Settings → API** : copie *Project URL* et la clé *anon public* dans `js/config.js`.
   (La clé anon est publique par conception : la sécurité vient des règles RLS du fichier SQL.)

### b) Site (GitHub Pages)
1. Crée un dépôt GitHub, pousse le dossier.
2. **Settings → Pages → Deploy from a branch → main / (root)**. Le site est en ligne en 1 minute.

### c) Te donner le rôle admin
Crée ton compte depuis le site, puis dans le SQL Editor de Supabase :

```sql
update public.profiles set role = 'admin' where lower(pseudo) = lower('TonPseudo');
```

Recharge le site : l'onglet **Admin** apparaît.

### d) Mise à jour « projets + permissions » (si ta base existait avant)
Dans le SQL Editor de Supabase, colle tout `supabase/migration-projets.sql` → **Run** (une seule fois ; sans danger si relancé).
Tant que ce n'est pas fait, le site marche mais l'onglet Projets affiche « La base n'est pas à jour ».

## 3. Qui peut faire quoi

| | Étudiant | Admin (toi) |
|---|---|---|
| Écrire et exécuter | ✔ (même sans compte) | ✔ |
| Enregistrer ses programmes | ✔ | ✔ |
| Voir les programmes des autres | ✘ | ✔ tous |
| Voir les programmes **publiés** | ✔ | ✔ |
| Publier / retirer, marquer « modèle » | ✘ | ✔ |
| Supprimer | les siens | tous |
| Créer / modifier / supprimer des **projets** | ✘ | ✔ |
| Travailler dans un projet | ✔ (un travail par projet) | ✔ voit le travail de tous |
| Voir le travail des autres dans un projet | si le projet **et** son compte l'autorisent | ✔ |
| Exécuter | si le global, son compte **et** le projet l'autorisent | ✔ toujours |
| Enregistrer hors projet (« programmes libres ») | si le global **et** son compte l'autorisent | ✔ |

Sans être connecté, on ne voit que la page d'**accueil**. Un étudiant arrive sur **Projets** : l'éditeur ne s'ouvre
qu'une fois un projet (ou un de ses programmes) choisi. L'onglet **Aide** est réservé à l'admin. La liste « Charger un modèle ou un exemple »
n'est visible que par l'admin. Un étudiant ne peut pas renommer son travail de projet (titre et TD = ceux du projet,
imposés aussi par la base) ; sans « programmes libres », il n'a plus « Nouveau » et ne peut enregistrer que dans un projet.

Un projet peut être **masqué** (en préparation) pour tous les étudiants, ou seulement pour certains ; la page Projets
les range par TD avec « tout afficher / tout masquer ». L'éditeur s'ouvre vide (sauf code de départ du projet).

Option de projet **« J'ai fini »** : l'étudiant rend son travail (avec confirmation), qui est alors verrouillé ; option
« exécution seulement après J'ai fini » ; nombre d'essais par projet (« Nouvel essai » repart du code rendu). L'admin voit
toutes les versions rendues, peut déverrouiller ou donner un essai de plus à un étudiant.

Les réglages se font dans **Admin → Réglages** (global + une case par étudiant, avec « tous / aucun » par colonne)
et sur chaque carte de **Projets** (exécution, travail des autres ; le formulaire de création oblige à choisir).
⚠ Le blocage de l'exécution est fait par l'interface : le pseudo-code tourne dans le navigateur, un étudiant
très motivé pourrait le contourner (outils de développement). Enregistrement et lecture, eux, sont protégés par la base.

Un étudiant qui ouvre un programme partagé obtient une **copie** : il peut l'exécuter et la modifier sans toucher à l'original.
Les règles sont appliquées par la base (RLS + trigger dans `schema.sql`), pas seulement par l'interface.

## 4. Le fichier de base du pseudo-code

* `lang/langage.json` : tous les mots-clés acceptés (une écriture de plus = une ligne de plus). Lu par l'interpréteur **et** par la coloration.
* `lang/modele.pseudo` : le squelette proposé aux étudiants (bouton « Charger… → Modèle de base »).
* `lang/exemples/` : exemples corrigés, listés dans `index.json`.
* Tu peux aussi marquer n'importe quel programme comme **Modèle** depuis l'admin : il apparaît dans la liste « Charger… » de tous.

Détails de comportement :
* `sortir` ne passe **pas** à la ligne tout seul (cohérent avec `retour a la ligne` des TD). Option dans la console, valeur par défaut dans `langage.json` (`sortirRetourLigne`).
* Accents et majuscules ignorés ; `=` et `==`, `%` et `mod`, `faire` ou `alors`… sont tolérés.
* Erreurs en français avec numéro de ligne. Avertissements (variable non déclarée, non initialisée, décimal rangé dans un `entier`) ; **mode strict** pour les transformer en erreurs.
* Boucle infinie : arrêt automatique après 3 000 000 d'instructions, et bouton **Stop**.
* **Fonctions et procédures** (syntaxe du CM R1.01) : écrites après `action …` et avant le `debut` du programme
  (ou après son `fin`). `fonction nom(x : entier) : entier … retourner(…)`, `procedure nom(a : entier; var r : reel)`.
  Paramètres par valeur (copie) ou par variable (`var`), variables locales, accès aux variables globales, récursivité
  (200 appels imbriqués au maximum). Appel direct : `r <- carre(5)`, `echanger(u, v)`. `entrer` marche aussi dans une
  fonction. `FIN FONCTION` / `FIN PROCEDURE` après le `fin` sont tolérés.

## 5. Tests

```bash
node tests/run.mjs                              # interpréteur + exemples
node tests/td-reels.mjs chemin/vers/TD.md       # passe les programmes d'un fichier de TD à l'interpréteur
```

## 6. Pas (encore) géré

Enregistrements (structures), fichiers, fonctions qui retournent un tableau.
Le code est organisé pour les ajouter : `js/pseudo.js` (lexer → parser → interpréteur).

## Structure

```
index.html  css/style.css
js/pseudo.js            interpréteur (marche aussi dans Node)
js/app.js               interface
js/backend-local.js     mode démo (navigateur)
js/backend-supabase.js  vrais comptes
js/config.js            ← tes clés Supabase ici
lang/                   langage.json, modele.pseudo, exemples/
supabase/schema.sql     base de données + règles de sécurité
vendor/                 CodeMirror 5 et supabase-js (copiés, pas de CDN)
```
