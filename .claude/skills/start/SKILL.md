---
name: start
description: |
  Prépare le worktree git dédié d'une tâche TOSSE déjà prise, puis y travaille. C'est l'étape de préparation SPÉCIFIQUE À CE REPO du workflow tosse-code, appelée par `/pickup`. Utilise ce skill quand :
  - `/pickup` vient de résoudre une tâche et enchaîne sur la préparation du repo
  - L'utilisateur tape `/start` alors qu'une tâche est déjà en cours dans la conversation
  - Il faut (re)créer et entrer le worktree de la tâche courante
  Chaîne complète : `/pickup` → `/start` (auto) → code → `/build-app` → `/land`. Le point d'entrée utilisateur est `/pickup`, pas ce skill : tout le travail doit se faire dans un worktree isolé, jamais sur le worktree principal partagé.
---

# Start — Préparer le worktree d'une tâche et coder dedans

Ce skill crée le worktree git isolé de la tâche en cours, l'installe, et te laisse travailler dedans.

**Pourquoi un worktree dès le départ ?** Le worktree principal (`dev`) est partagé avec d'autres agents Claude. Travailler dans un worktree dédié par tâche isole complètement la branche de feature, évite de polluer `dev`, et permet à plusieurs agents de bosser en parallèle sans se marcher dessus. C'est l'invariant central du workflow.

## Qui appelle qui

`/pickup` fait tout le travail TOSSE (résoudre/créer la tâche, vérifier les blocages, lire la cascade de contextes, passer la tâche **« En cours »**), **puis** lance ce skill. Ce skill démarre donc avec la tâche déjà connue (titre, id) et le contexte déjà lu.

⚠️ **N'invoque JAMAIS `/pickup` depuis ici** — le sens de l'appel a été inversé et le rappeler créerait une boucle. Ne réimplémente pas non plus sa logique TOSSE : ce skill ne touche pas au statut de la tâche.

Si tu arrives ici **sans tâche résolue** dans la conversation (l'utilisateur a tapé `/start` à froid) : ne lance pas `/pickup` toi-même, dis-lui que le point d'entrée est `/pickup` et arrête-toi. Exception : s'il demande explicitement un worktree sans tâche TOSSE, continue en dérivant le slug de ce qu'il décrit.

## Étape 1 — Dériver le slug de la tâche

Construis un **slug** court et lisible depuis le titre de la tâche : minuscules, mots séparés par des tirets, uniquement `[a-z0-9-]` (l'identifiant de build et le nom de branche en dépendent). Garde-le parlant (5-6 mots max).

Exemple : tâche « Explorateur de skills/plugins/MCP » → slug `extensions-explorer`.

Ce slug sert partout ensuite : branche `feat/<slug>`, dossier worktree `.claude/worktrees/<slug>`, et plus tard le nom de l'app de test (`/build-app`).

## Étape 2 — Mettre `dev` à jour, puis créer le worktree depuis `dev`

On part **toujours de `dev`** (cible d'atterrissage des features → on minimise les conflits au moment du `/land`).

```bash
git fetch origin
# Crée le worktree + la branche de feature à partir du dernier dev distant
git worktree add .claude/worktrees/<slug> -b feat/<slug> origin/dev
```

Si la branche `feat/<slug>` ou le worktree existe déjà (tâche reprise) : ne recrée pas, réutilise l'existant et passe à l'étape suivante.

## Étape 3 — Entrer dans le worktree avec l'outil Claude

**Capital** : entre dans le worktree avec l'outil natif `EnterWorktree`, pas avec un `cd`.

```
EnterWorktree({ path: ".claude/worktrees/<slug>" })
```

C'est ce qui fait suivre le `cwd` de la session à l'app Tosse Code (l'éditeur, le watch fs, le terminal se rebasent dessus). Un `cd` ne déclencherait rien de tout ça.

## Étape 4 — Installer les dépendances

```bash
pnpm install
```

Un worktree neuf partage le `.git` mais a son **propre répertoire de fichiers**, et `node_modules` est gitignoré : il n'est pas recopié. Sans ce `pnpm install`, tout échoue dans le worktree (`tsc`, `vitest`, `vite`, `tauri build`). C'est l'unique étape lente du démarrage — on la fait une fois, ici.

## Étape 5 — Annoncer et travailler

Affiche un récap court : tâche + sous-tâches, contexte pertinent, et « worktree `feat/<slug>` prêt, dépendances installées ». Propose un plan de travail. Puis **code la tâche dans le worktree**.

## Étape 6 — À la fin du travail : ne rien faire d'autre

Quand la tâche est terminée (code écrit, vérifié), **n'enchaîne sur rien automatiquement** — ni `/build-app`, ni `/land`, ni `/done`. Préviens simplement l'utilisateur que la tâche est finie et **attends qu'il indique l'étape suivante**. C'est lui qui décide quand tester (`/build-app`) ou poser sur `dev` (`/land`).

## Ce que ce skill ne fait PAS

- Résoudre/créer la tâche, lire les contextes, la passer « En cours » (→ `/pickup`, en amont)
- Builder ou lancer l'app (→ `/build-app`)
- Fusionner sur `dev` ou nettoyer le worktree (→ `/land`)
- Passer la tâche en Review (→ `/done`, déclenché par `/land`)
- Pousser quoi que ce soit
