---
name: release
description: |
  Coupe une release de Tosse Code : bump de version → sync `CLAUDE.md` → push `dev` → PR `dev`→`main` → CI → PAUSE pour review → merge → déclenche le workflow de release GitHub. Utilise ce skill quand :
  - L'utilisateur tape `/release` ou `/release <patch|minor|major>`
  - L'utilisateur dit « fais une release », « publie une version », « sors une release », « on release »
  Le skill est automatique de bout en bout, avec UNE SEULE pause : après CI verte, il attend l'approbation de la review avant de merger dans `main`. À lancer par Alexandre (`Alex375`, admin) — le merge sur `main` et le job `authorize` de la release exigent ses droits.
---

# Release — Publier une version

Ce skill enchaîne tout le processus de release. Il est **automatique** sauf **une pause unique** : il s'arrête après la CI verte pour attendre la review humaine, puis reprend seul jusqu'à la publication.

**Pré-requis de gouvernance** (rappel) : `main` est protégée, tout passe par PR ; le check `test` doit être vert ; le code owner `@Alex375` approuve. Une release embarque **tout l'état courant de `dev`** dans `main` — c'est voulu, on ne demande pas de confirmation de périmètre.

## Étape 1 — Partir d'un `dev` propre et à jour

```bash
git checkout dev
git status            # doit être clean
git fetch origin
git merge --ff-only origin/dev
```

Si l'arbre n'est pas clean, arrête-toi : on ne release pas par-dessus du travail non committé.

## Étape 2 — Déterminer le niveau de bump

- Si l'utilisateur a fourni l'argument (`/release minor`, `patch`, `major`, ou une version `X.Y.Z`), utilise-le.
- Sinon, **déduis-le** des commits de `dev` depuis la dernière release et **annonce ton choix** : en `0.y.z` (cas actuel), nouveautés → `minor`, fix uniquement → `patch`. `major` seulement pour un changement incompatible (schéma SQLite sans migration, format de transcript, comportement cassé).

## Étape 3 — Bumper la version

```bash
pnpm bump <patch|minor|major|X.Y.Z>
```

Le script met à jour les 4 emplacements d'un coup (`tauri.conf.json`, `package.json`, `Cargo.toml`, `Cargo.lock`). **N'édite jamais ces versions à la main.**

## Étape 3b — Mettre à jour `CHANGELOG.md` (les nouveautés affichées DANS l'app)

`CHANGELOG.md` (racine) alimente la page « Mise à jour » de l'app : `release.yml` lit la section de la version qu'on release et la met en description de la release GitHub, que l'updater affiche. Il faut donc une section pour la **nouvelle** version. **Reste simple et rapide** — quelques puces suffisent, ne sur-analyse pas.

1. Liste les commits depuis la dernière release :

   ```bash
   LAST=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo "")
   git log ${LAST:+$LAST..}HEAD --no-merges --pretty=format:'%s'
   ```

2. Résume-les en **3 à 6 puces courtes, orientées utilisateur** (ce que ça change POUR LUI, pas le détail technique). Garde les `feat:` / `fix:` parlants ; **ignore** `chore:`, `docs:`, `test:`, `refactor:`, `chore(release):` et les merges. Reformule en français clair.

3. Ajoute la section **tout en haut** du corps de `CHANGELOG.md` (juste sous le bloc d'en-tête, avant la section précédente), au format **exact** :

   ```md
   ## vX.Y.Z

   - Première nouveauté
   - Deuxième nouveauté
   ```

   où `X.Y.Z` = la version que tu viens de bumper (étape 3). ⚠️ Le `v` du titre est **obligatoire** (`release.yml` cherche `## v<version>`). Si une section `## vX.Y.Z` de cette version existe **déjà** (préparée pendant le dev), garde-la ou affine-la — n'en crée pas une deuxième.

Si tu n'es pas sûr ou qu'il n'y a rien de notable, une seule puce générique suffit : le workflow a de toute façon un repli si la section manque. Ne bloque jamais la release pour le changelog.

## Étape 4 — Synchroniser `CLAUDE.md` avec TOSSE

Avant de pousser, régénère `CLAUDE.md` depuis les contextes TOSSE pour que la release parte avec la doc projet à jour.

Appelle l'outil MCP **`sync_claude_md`** avec le `repository_id` de ce repo (`8c509e62-30cb-4f58-9074-086bac72528d`, cf. le bloc « MCP entity IDs » de `CLAUDE.md`). Il **retourne** le contenu compilé (préambule global + règles + contexte repo + contextes projet/mission/client) mais **ne l'écrit pas** : c'est à toi d'**écrire ce contenu dans le `CLAUDE.md` local** (outil Write).

Le fichier régénéré sera embarqué par le `git add -A` de l'étape suivante. Si rien n'a changé côté contextes, le contenu est identique et il n'y aura simplement pas de diff — c'est bénin.

## Étape 5 — Commiter et pousser `dev`

Le `git add -A` inclut le bump de version, le `CHANGELOG.md` mis à jour (étape 3b) et le `CLAUDE.md` régénéré.

```bash
git add -A
git commit -m "chore(release): vX.Y.Z"
git push origin dev
```

**Pousse directement — NE demande PAS d'autorisation.** La règle générale « ne jamais pousser sur `dev` sans demander » **ne s'applique pas ici** : le fait que l'utilisateur ait déclenché `/release` **vaut autorisation explicite** de pousser sur `dev`. Demander une confirmation à ce stade est exactement le comportement qu'on veut éviter dans ce skill.

## Étape 6 — Ouvrir la PR `dev` → `main`

```bash
gh pr create --base main --head dev \
  --title "Release vX.Y.Z" \
  --body "Release vX.Y.Z. Voir les commits de dev depuis la dernière release."
```

Récupère le numéro/URL de la PR pour la suite.

## Étape 7 — Attendre la CI verte

Le check requis est `test` (`.github/workflows/ci.yml`, ne tourne qu'à la PR vers `main`). **Surveille-le en ré-interrogeant périodiquement** :

```bash
gh pr checks <pr-number>
```

N'utilise **pas** un `gh pr checks --watch` bloquant : la CI peut dépasser le timeout des commandes. Ré-interroge jusqu'à ce que `test` soit `pass`. Si la CI échoue → arrête-toi et rapporte l'échec (ne merge pas).

## Étape 8 — ⏸️ PAUSE : attendre la review

C'est l'unique gate humain. **Arrête-toi ici.** Annonce :
- l'URL de la PR,
- que la CI est verte,
- que tu attends l'**approbation de la review** avant de merger.

**Ne merge pas sans le feu vert explicite de l'utilisateur.** Reprends à l'étape 9 seulement quand il confirme que la review est approuvée.

## Étape 9 — Fusionner dans `main`

Une fois CI verte **et** review approuvée :

```bash
gh pr merge <pr-number> --merge
```

(En tant qu'admin avec `enforce_admins=false`, Alexandre peut finaliser le merge même si une protection résiste.)

⚠️ **TOUJOURS `--merge` (merge commit à deux parents). JAMAIS `--squash` ni `--rebase`, et JAMAIS le bouton « Squash »/« Rebase » de l'UI GitHub.** `dev` est une branche **permanente** re-mergée dans `main` à chaque release : un squash/rebase crée sur `main` un commit orphelin sans lien avec l'historique de `dev` → la base de merge reste figée à la release précédente → **la release SUIVANTE se retrouve avec des conflits sur tout le changeset** (le même diff vu « des deux côtés »). Un vrai merge commit fait avancer la base de merge et évite définitivement ce piège. (Idéalement le repo n'autorise QUE `allow_merge_commit` — `allow_squash_merge`/`allow_rebase_merge` à `false`.)

## Étape 9b — Re-synchroniser `main → dev` (anti-divergence)

Le merge commit de l'étape 9 vit sur `main` mais pas encore sur `dev` → ceinture-et-bretelles, on le ramène tout de suite pour que les deux branches restent alignées :

```bash
git checkout dev
git fetch origin
git merge --ff-only origin/dev      # dev local à jour
git merge origin/main               # ramène le merge commit de release ; doit être propre
git push origin dev
```

Ce merge doit être **propre** (aucun conflit) puisque `main` ne contient que ce que `dev` a produit. S'il y a le moindre conflit, c'est le symptôme du piège squash décrit à l'étape 9 : **arrête-toi et analyse** (probable squash/rebase antérieur à réconcilier via `git merge -s ours origin/main`) plutôt que de résoudre à l'aveugle.

## Étape 10 — Déclencher la release

```bash
gh workflow run release.yml --ref main
```

Le workflow compile une app macOS **par architecture** (Apple Silicon `aarch64` + Intel `x64`, matrice de builds séparés) puis **publie** la release GitHub une fois TOUS les builds vérifiés (`.dmg` + artefact updater signé `.app.tar.gz` + `.sig` par architecture, `latest.json` portant `darwin-aarch64` ET `darwin-x86_64`). Garde-fou intégré : il refuse si la version courante a déjà une release — d'où l'importance du bump à l'étape 3. Un build qui échoue = rien n'est publié (relancer après correction). **Si `release.yml` a changé depuis la dernière release** (ex. la première release en matrice) : lance d'abord un essai à blanc — `gh workflow run release.yml --ref main -f dry_run=true` — qui construit, signe et vérifie tout puis laisse un brouillon sous un tag jetable (`dryrun-vX.Y.Z-<run id>`) ; inspecte-le (deux `.dmg`, `latest.json`), supprime-le (`gh release delete <tag> --yes`), puis lance la vraie release. ⚠️ Toujours depuis `main` : les clés de signature vivent dans deux environnements GitHub réservés à `main` — `release` (certificat de signature de code macOS, pour les builds) et `updater-signing` (clé updater + sa passphrase, pour le seul job `sign`) — un essai depuis une autre branche est refusé (`authorize` + portes des environnements), c'est voulu. Avant de publier, `publish` vérifie chaque signature de `latest.json` contre la clé publique épinglée dans l'app : un échec là (« signed by key X, but the app trusts key Y ») veut dire que le secret de `updater-signing` n'est pas la bonne clé — ne jamais « corriger » en changeant la clé publique (ça couperait l'auto-update de toutes les installs) ; vérifier la clé avec `node scripts/updater-key.mjs check <fichier>`.

## Étape 11 — Suivre et rapporter

Suis le run (`gh run watch` ou `gh run list --workflow=release.yml`) jusqu'à la publication, puis donne à l'utilisateur l'**URL de la release**.

## Ce que ce skill ne fait PAS

- Demander une confirmation de périmètre (volontairement automatique)
- Demander l'autorisation de pousser sur `dev` (déclencher `/release` = autorisation explicite ; cf. étape 5)
- Éditer les versions à la main (toujours via `pnpm bump`)
- Pousser directement sur `main` (interdit — tout passe par la PR)
- Signer/notariser côté Apple (chantier séparé)
