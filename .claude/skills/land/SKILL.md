---
name: land
description: |
  Pose le travail d'un worktree sur la branche `dev` du worktree principal, nettoie le worktree, puis lance `/done`. Utilise ce skill quand :
  - L'utilisateur tape `/land`
  - L'utilisateur dit « mets ça sur dev », « balance la feature sur dev », « on intègre », « pose le travail »
  - Une feature développée dans un worktree (via `/start`) est finie et vérifiée, et doit rejoindre `dev`
  C'est l'étape de fin du workflow tosse-code : la feature de Claude doit finir sur la branche `dev` du worktree principal. Gère les merges concurrents et les conflits prudemment.
---

# Land — Poser la feature sur `dev`

Ce skill prend la branche de feature du worktree courant et la fusionne dans `dev` sur le **worktree principal**, pousse, supprime le worktree, puis clôture la tâche via `/done`.

**Objectif final** : peu importe le détail, la feature doit se retrouver sur la branche `dev` du **worktree principal**. C'est tout.

**Quatre faits à reporter en fin de course** : ce skill se termine **toujours** par un tableau récapitulatif (étape 9) qui répond, au minimum, à quatre questions — *y a-t-il eu des conflits au merge ? · `dev` est-il poussé ? · le worktree est-il nettoyé ? · as-tu une modification de contexte TOSSE à proposer ?* Garde ces informations sous la main pendant toute l'opération (note-les au fil des étapes 5, 7, 8) pour pouvoir les reporter fidèlement à la fin.

> Ce skill ne s'applique que si tu travailles **dans un worktree** (flux `/start`). Si tu n'es pas dans un worktree, le travail est déjà sur la branche courante : saute les étapes worktree, va directement à « mettre dev à jour / committer / pousser / `/done` ». (Dans ce cas, la ligne « worktree nettoyé » du tableau final vaut `N/A — pas de worktree`.)

## Étape 1 — Vérifier que le travail est fini

Le code doit compiler et les tests passer. Si tu n'as pas vérifié récemment, lance d'abord :

```bash
pnpm typecheck && pnpm test
cargo test --lib   # depuis src-tauri/, si du Rust a changé
```

Si ça casse, **arrête-toi** : on ne pose pas du travail rouge sur `dev`.

## Étape 2 — Worktree propre

Commit tout ce qui reste dans le worktree (message descriptif). `git status` doit être clean avant de continuer — sinon la suppression du worktree échouera et la fusion serait partielle.

## Étape 3 — Sortir du worktree avec l'outil Claude

```
ExitWorktree({ action: "keep" })
```

`keep` (pas `remove`) : on garde le worktree sur le disque le temps de fusionner. La session revient au worktree principal. (`ExitWorktree` refuse de toute façon de `remove` un worktree entré via `path` — la suppression réelle se fait à l'étape 7 avec `git worktree remove`.)

Note le nom du slug / de la branche `feat/<slug>` avant de sortir.

## Étape 4 — Mettre `dev` à jour (worktree principal)

```bash
git checkout dev
git fetch origin
git merge --ff-only origin/dev
```

**Garde-fou « merge concurrent »** : `dev` est partagé avec d'autres agents. Si un merge est déjà en cours dans le worktree principal (`.git/MERGE_HEAD` présent) ou si l'arbre de travail est sale avec des changements qui ne sont pas les tiens → **un autre merge est en cours et te bloque** : arrête-toi, explique la situation, et demande à l'utilisateur de te **prévenir quand cet autre merge est terminé**. Reprends seulement après son feu vert. (Si rien ne te bloque, continue normalement — pas besoin de t'arrêter par précaution.)

## Étape 5 — Fusionner la feature dans `dev`

```bash
git merge feat/<slug>
```

`dev` a **presque toujours avancé** depuis la création de ton worktree : d'autres agents y ont posé de nouvelles features entre le moment où tu as coupé ta branche et maintenant. Deux cas.

### Cas A — Aucun conflit (fast-forward ou merge propre)

Le merge passe tout seul. Rien de spécial : va directement à l'étape 6 (revérification).

### Cas B — Un ou plusieurs conflits

`git merge` s'arrête et laisse les fichiers en conflit dans l'arbre. **Ne résous JAMAIS en bloc ni à l'aveugle.** L'objectif est double et **non négociable** : **ni ton travail, ni les nouvelles features de `dev` ne doivent être cassés.** Les deux doivent continuer à marcher aussi bien qu'avant le merge — c'est aussi important que ta feature.

Procède **fichier par fichier**, jamais en gros :

```bash
git diff --name-only --diff-filter=U   # la liste des fichiers en conflit
```

Pour **chaque** fichier en conflit :

1. **Ouvre-le et lis chaque zone de conflit.** Repère bien les deux côtés : entre `<<<<<<< HEAD` et `=======` = ce que **`dev`** a fait (le travail des autres agents) ; entre `=======` et `>>>>>>> feat/<slug>` = **ton** travail.
2. **Comprends l'intention des DEUX côtés avant de toucher quoi que ce soit.** Que cherche à faire le code de `dev` ? Que cherche à faire le tien ? Ce ne sont pas des lignes à trancher pour « choisir un gagnant » — ce sont deux intentions à **réconcilier**.
3. **Conflit simple / mécanique** (imports ajoutés des deux côtés, ajouts indépendants dans des zones voisines, formatage, renommage local sans ambiguïté…) → **combine les deux côtés** en préservant **les deux** intentions, puis résous-le.
4. **Conflit plus complexe** (les deux côtés modifient la même logique, la même signature, le même flux ; ou tu ne vois pas d'emblée comment les deux cohabitent) → **prends le temps.** Concrètement :
   - Lis le **fichier entier**, pas seulement la zone de conflit — le contexte autour explique souvent le pourquoi.
   - Va voir les **autres fichiers modifiés des deux côtés** pour comprendre dans quel changement global s'inscrit chaque bout de code (`git diff HEAD...MERGE_HEAD` pour le côté `dev`, `git diff HEAD...feat/<slug>` pour le tien). Un conflit isolé ne se résout bien que replacé dans le changement complet dont il fait partie.
   - Écris alors une résolution qui **satisfait les deux** : plus de marqueurs de conflit **et** tout reste fonctionnel des deux côtés (ta feature ET les nouvelles features de `dev`).
5. **Si, après avoir vraiment cherché à comprendre, tu n'es pas certain de ne rien casser** (logique ambiguë, comportement de `dev` que tu n'arrives pas à cerner) → **arrête-toi et demande** à l'utilisateur plutôt que de deviner. Un mauvais merge sur `dev` impacte tous les autres agents.

Quand toutes les zones sont résolues, finalise le merge :

```bash
git add <fichiers résolus>
git commit          # message de merge par défaut : ok
```

Puis **résume brièvement à l'utilisateur** quels conflits tu as rencontrés et comment tu les as tranchés (surtout les complexes) — pour transparence. Inutile d'attendre sa validation si tu es confiant ; mais s'il y avait le moindre doute, c'est le moment de le signaler.

## Étape 6 — Vérifier après le merge (impératif, surtout après un conflit)

`dev` a bougé — et si tu as résolu des conflits, tu viens de réécrire du code touchant **les deux côtés**. Revérifie que **tout** tient ensemble : ton travail comme les features de `dev`.

```bash
pnpm typecheck && pnpm test
cargo test --lib    # depuis src-tauri/, si du Rust est impliqué dans le merge
```

Si quoi que ce soit casse, la cause la plus probable est la résolution du conflit : **reprends-la**, ne pousse pas du rouge sur `dev`. En cas de merge non trivial, envisage aussi `/build-dev` pour voir l'app tourner sur le `dev` fusionné avant de pousser.

## Étape 7 — Pousser `dev`, puis nettoyer le worktree

Pousse **automatiquement** (pas de question — c'est le comportement voulu de ce skill) :

```bash
git push origin dev
```

Puis supprime le worktree et sa branche (maintenant fusionnée) :

```bash
git worktree remove .claude/worktrees/<slug>
git branch -d feat/<slug>
```

L'ordre compte : on retire d'abord le worktree (qui avait `feat/<slug>` checké out), ce qui libère la branche, puis on la supprime. `git branch -d` (minuscule) ne réussit que si la branche est bien fusionnée — c'est une sécurité voulue ; si ça refuse, c'est que le merge n'a pas pris, ne force pas, enquête.

## Étape 7b — Purger les données de test isolées du build (`/build-app`)

Si la feature a été buildée via `/build-app`, ce build a créé une **identité macOS isolée** `com.tosse.desktop.<slug>` (données, caches, prefs, storage) — dérivée du slug du worktree. Une fois le worktree supprimé, ces données deviennent **orphelines** et polluent `~/Library` au fil des features (App Support, Caches, Preferences, WebKit…). Purge-les maintenant.

⚠️ **Cible le slug EXACT, jamais un glob.** Un glob du genre `com.tosse.desktop.*` attraperait aussi la **prod** `com.tosse.desktop` et le plist prod `com.tosse.desktop.plist` — les détruire ferait perdre des préférences à l'app de prod d'Alexandre. On construit donc l'identifiant complet depuis le slug et on ne supprime que celui-là.

**Garde-fou** : refuse de purger si l'identifiant dérivé est une identité protégée — la prod `com.tosse.desktop` ou l'identité fixe de `/build-dev` `com.tosse.desktop.dev`. Le slug d'un worktree `/start` ne vaut jamais l'un de ces deux, mais vérifie quand même.

```bash
ID="com.tosse.desktop.<slug>"                       # <slug> = basename du worktree
if [ "$ID" = "com.tosse.desktop" ] || [ "$ID" = "com.tosse.desktop.dev" ]; then
  echo "REFUS : $ID est une identité protégée (prod/dev) — pas de purge."
else
  rm -rf \
    "$HOME/Library/Application Support/$ID" \
    "$HOME/Library/Caches/$ID" \
    "$HOME/Library/Preferences/$ID.plist" \
    "$HOME/Library/WebKit/$ID" \
    "$HOME/Library/HTTPStorages/$ID" \
    "$HOME/Library/HTTPStorages/$ID.binarycookies" \
    "$HOME/Library/Saved Application State/$ID.savedState"
  echo "Données de test isolées purgées : $ID"
fi
```

Si `/build-app` n'a jamais tourné pour ce slug, ces chemins n'existent pas — le `rm -rf` est un no-op inoffensif. Lance-le quand même : c'est le **point unique** qui garantit que `~/Library` ne se remplit pas d'identités mortes. (Note ce résultat pour la ligne optionnelle du tableau final.)

## Étape 7c — Purger les artefacts de build (délègue à `/cleanup`)

Le worktree supprimé à l'étape 7 a emporté **son** `src-tauri/target` avec lui — dont le `.app` produit par `/build-app`, qui vivait dedans. Restent les artefacts du **worktree principal** et des autres repos, que rien ne vide jamais : le 22/09/2026 ils avaient atteint **21 Go** à eux seuls.

Lance le skill **`/cleanup`** (outil Skill). C'est le point unique qui connaît tous les emplacements (les quatre `target`, les identités `com.tosse.desktop.<slug>` orphelines, les dépôts jamais `gc`) et tous les garde-fous (identités protégées, features vivantes, build en cours). Ne réimplémente pas la purge ici.

Un land est **exactement** le bon moment pour ça : le travail est posé et vérifié, donc repayer une compilation complète ne bloque personne. Lance `/cleanup` en mode par défaut (tout effacer) sauf si l'utilisateur a demandé à garder l'incrémental.

Reporte son résultat dans le tableau final (espace rendu + ce qui repartira de zéro au prochain build).

## Étape 8 — Clôturer la tâche

Lance le skill `/done` (outil Skill). Il résume le travail, met à jour le contexte de la tâche et la passe en **Review**. Ce repo n'a pas de `/deploy`, donc `/done` ne déclenchera rien d'autre — c'est `/land` qui a joué le rôle de mise en intégration.

## Étape 9 — Reporting final à l'utilisateur (tableau récapitulatif)

Une fois `/done` terminé, **le tout dernier message que tu affiches est un tableau récapitulatif du land**. C'est la conclusion obligatoire du skill : l'utilisateur doit pouvoir lire l'état de l'opération d'un seul coup d'œil.

**Quatre lignes sont NON NÉGOCIABLES** et apparaissent toujours, même quand tout s'est bien passé :

| Vérification | Statut | Détail |
|---|---|---|
| Conflits au merge | ✅ Aucun · **ou** ⚠️ Oui | `merge propre / fast-forward` — **ou** `N fichier(s) : a.ts, b.rs` |
| `dev` poussé | ✅ Oui · **ou** ❌ Non | commit court (`abc1234`) poussé sur `origin/dev` — **ou** la raison du blocage |
| Worktree nettoyé | ✅ Oui · **ou** ❌ Non · **ou** ➖ N/A | worktree `.claude/worktrees/<slug>` **et** branche `feat/<slug>` supprimés — **ou** la raison — **ou** `pas de worktree` (flux hors-worktree) |
| Modif de contexte à proposer | ✅ Non · **ou** 💡 Oui | `rien à mettre à jour` — **ou** quel contexte (`repo` / `projet` / `mission` / `client` / `tâche`) et quoi y changer |

Règles de ce tableau :

- **Ces quatre lignes sont obligatoires**, dans cet ordre, et présentes même si tout est vert. Ne les omets jamais, ne les fusionne jamais.
- **Reflète la réalité, pas l'intention.** Chaque statut décrit ce qui s'est *effectivement* passé (push réellement effectué, worktree réellement supprimé), pas ce qui aurait dû arriver. Si une étape a échoué ou a été sautée, dis-le franchement (❌ + raison) plutôt que de cocher ✅.
- **Si un conflit a eu lieu** (⚠️), ajoute **sous le tableau** un court récap : quels fichiers, et comment tu as tranché (surtout les conflits complexes) — cohérent avec ce que tu as déjà expliqué à l'étape 5.
- **Ligne « modif de contexte »** : c'est une **recommandation**, pas un fait mécanique. Réponds `💡 Oui` seulement si le travail a révélé quelque chose qui mérite d'être écrit dans un contexte TOSSE — nouvelle décision structurante, changement de stack/pattern, info durable — en respectant la règle d'or (une info à UN SEUL niveau, pas de redondance avec un contexte parent). Sinon `✅ Non`. Si `/done` (étape 8) a déjà proposé ou appliqué une mise à jour de contexte via `tosse-manager`, reprends-la ici (contexte visé + ce qui change) plutôt que de la réinventer. En cas de doute, cite ta suggestion et laisse l'utilisateur trancher — n'édite pas un contexte de ta propre initiative dans cette ligne.
- **Tu peux ajouter d'autres lignes** utiles au-dessus ou en dessous des quatre obligatoires (ex : `typecheck + tests` verts, `cargo test --lib` lancé, build vérifié via `/build-dev`, données de test isolées purgées (`com.tosse.desktop.<slug>`, étape 7b), artefacts de build purgés via `/cleanup` + espace rendu (étape 7c), tâche passée en **Review** par `/done`…). Elles enrichissent le rapport mais ne remplacent jamais les quatre lignes cœur.
- Marqueurs visuels : `✅` ok / rien à signaler · `⚠️` a nécessité une intervention · `❌` échec/non fait · `➖` sans objet · `💡` suggestion à valider. But : l'état se lit en un clin d'œil.

## Ce que ce skill ne fait PAS

- Pousser ou merger sur `main` (→ `/release`)
- Passer la tâche en « Fait » (réservé à un humain)
- Résoudre des conflits **à l'aveugle** ou forcer un merge douteux : il les résout fichier par fichier, en comprenant les deux côtés, et s'arrête pour demander en cas de doute réel
