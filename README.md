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

## 3. Qui peut faire quoi

| | Étudiant | Admin (toi) |
|---|---|---|
| Écrire et exécuter | ✔ (même sans compte) | ✔ |
| Enregistrer ses programmes | ✔ | ✔ |
| Voir les programmes des autres | ✘ | ✔ tous |
| Voir les programmes **publiés** | ✔ | ✔ |
| Publier / retirer, marquer « modèle » | ✘ | ✔ |
| Supprimer | les siens | tous |

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
