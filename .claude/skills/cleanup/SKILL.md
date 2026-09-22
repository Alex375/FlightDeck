---
name: cleanup
description: |
  Récupère l'espace disque mangé par les artefacts de build et les identités de test mortes de Flight Deck (tosse-code + flightdeck-server). Utilise ce skill quand :
  - L'utilisateur tape `/cleanup`
  - L'utilisateur dit « fais du ménage », « nettoie les builds », « ça prend trop de place », « purge les artefacts »
  - `/land` arrive à son étape de purge (il délègue ici)
  - Tu constates qu'un `du -sh` de `target` dépasse ~10 Go
  Ce skill ne touche QUE des fichiers regénérables : jamais une source, jamais un commit, jamais une identité protégée.
---

# Cleanup — Récupérer l'espace des artefacts de build

Le développement de Flight Deck accumule **beaucoup** de gras : chaque feature buildée via `/build-app` crée son propre `target` release et sa propre identité macOS, chaque `cargo test --lib` nourrit un `target/debug` qui ne se vide jamais, et la crate `flightdeckd` existe en double (tosse-code + flightdeck-server) donc en double `target`. Ce n'est pas une hypothèse : le 22/09/2026, les deux repos pesaient **21 Go**, dont 19,5 Go de pur artefact, sur un Mac qui n'avait plus que 31 Go libres.

**Aucun autre skill ne fait ce ménage.** En particulier `/release` n'a **aucune** étape de nettoyage — si tu ne release jamais, ce n'est pas ce qui te sauve. `/land` a bien une purge (7b/7c) mais elle est déléguée à ce skill : ici est le **point unique** qui connaît tous les emplacements.

## Les invariants de sûreté (à ne jamais enfreindre)

1. **Jamais de source non committée.** Ce skill ne supprime que des chemins gitignorés (`target/`, bundles, overlays) et des dossiers de `~/Library`. Avant toute suppression dans un repo, `git status --porcelain` doit être vide — s'il ne l'est pas, **n'y touche pas** et dis-le : le travail en cours passe avant l'espace disque.
2. **Jamais une identité protégée.** `com.tosse.desktop` est la **prod** (les vraies conversations d'Alexandre, ~17 Mo) et `com.tosse.desktop.dev` est l'identité fixe de `/build-dev`. Elles ne se purgent **jamais**, et on ne s'en approche pas avec un glob (`com.tosse.desktop*` les attraperait toutes les deux).
3. **Jamais l'identité d'une feature vivante.** Une identité `com.tosse.desktop.<slug>` dont le worktree `.claude/worktrees/<slug>` existe encore appartient à une feature en cours : ce sont ses données de test, ne les supprime pas.
4. **Jamais pendant un build.** Le worktree principal est partagé avec les autres agents : supprimer `target` sous les pieds d'un `tauri build` en cours le casse. Vérifie d'abord, et si un build tourne, **saute la purge des `target`** (les autres étapes restent possibles).
5. **Jamais de réécriture d'historique.** Le `git gc` de l'étape 4 n'expire que les entrées de reflog **inatteignables depuis un ref** : aucun commit d'aucune branche ne peut disparaître. Pas de `filter-branch`, pas de `--expire=now` global, pas de force-push.

## Étape 0 — Mesurer avant (pour pouvoir reporter)

```bash
df -h / | tail -1
du -sh ~/Documents/repositories/tosse-code ~/Documents/repositories/flightdeck-server 2>/dev/null
pgrep -fl "cargo|rustc|tauri" | grep -v pgrep    # vide = aucun build en cours (invariant 4)
```

Si un build tourne : saute l'étape 2, fais le reste, et dis-le franchement dans le rapport.

## Étape 1 — Vérifier que rien n'est en jeu (invariant 1)

```bash
git -C ~/Documents/repositories/tosse-code status --porcelain
git -C ~/Documents/repositories/flightdeck-server status --porcelain
```

Un repo sale n'empêche pas de purger ses `target` (gitignorés), mais **empêche son `git gc`** de l'étape 4. Note lequel est sale.

## Étape 2 — Purger les `target` (le gros morceau)

Quatre `target` existent, et on les oublie tous les quatre. Ordres de grandeur mesurés le 22/09/2026 :

| Chemin | Produit par | Taille observée |
|---|---|---|
| `tosse-code/src-tauri/target/debug` | `cargo test --lib`, `tauri dev` | **12 G** (incremental 4,3 G · deps 6,2 G) |
| `tosse-code/src-tauri/target/release` | `/build-dev`, `/build-app` | **1,9 G** + un `.dmg` de 27 M par version |
| `tosse-code/flightdeckd/target` | crate dupliquée du serveur | **1,2 G** |
| `flightdeck-server/flightdeckd/target` | debug · musl · release · deploy | **5,6 G** |

**Mode par défaut — tout effacer.** C'est le comportement voulu : on lance ce skill à un moment où le travail est posé, donc c'est le bon moment pour repayer une compilation.

```bash
rm -rf ~/Documents/repositories/tosse-code/src-tauri/target \
       ~/Documents/repositories/tosse-code/flightdeckd/target \
       ~/Documents/repositories/flightdeck-server/flightdeckd/target
```

Dis explicitement à l'utilisateur ce que ça coûte : le prochain `cargo test --lib` et le prochain `/build-dev` ou `/build-app` repartent d'un build Rust **complet** (~10 min chacun).

**Mode conservateur — `/cleanup --caches`.** Si l'utilisateur a demandé à garder l'incrémental, ne prends que le pur cache (~4 Go rendus, aucune recompilation complète à repayer) :

```bash
rm -rf ~/Documents/repositories/tosse-code/src-tauri/target/{debug,release}/incremental \
       ~/Documents/repositories/tosse-code/flightdeckd/target/*/incremental \
       ~/Documents/repositories/flightdeck-server/flightdeckd/target/*/incremental
```

⚠️ Un `rm -rf` sur un `target` peut sortir en `Directory not empty` sans avoir échoué : le Finder recrée un `.DS_Store` pendant la suppression. Relance simplement la commande et vérifie avec `ls -d` que le chemin a disparu.

## Étape 3 — Purger les identités de test mortes (`/build-app`)

Chaque `/build-app` crée une identité macOS `com.tosse.desktop.<slug>` éparpillée dans six emplacements de `~/Library`. `/land` la purge normalement à son étape 7b, mais une feature abandonnée sans `/land` la laisse orpheline pour toujours.

```bash
# Inventaire : ce qui existe, moins les deux identités protégées.
for d in "Application Support" Caches Preferences WebKit HTTPStorages "Saved Application State"; do
  find ~/Library/"$d" -maxdepth 1 -name "com.tosse.desktop.*" 2>/dev/null
done | grep -vE "com\.tosse\.desktop\.dev(\.|$)"
```

Pour **chaque** slug trouvé, avant de supprimer : vérifie que `~/Documents/repositories/tosse-code/.claude/worktrees/<slug>` **n'existe pas** (invariant 3). Puis, slug par slug — jamais en glob (invariants 2 et 3) :

```bash
ID="com.tosse.desktop.<slug>"
if [ "$ID" = "com.tosse.desktop" ] || [ "$ID" = "com.tosse.desktop.dev" ]; then
  echo "REFUS : $ID est une identité protégée."
else
  rm -rf "$HOME/Library/Application Support/$ID" \
         "$HOME/Library/Caches/$ID" \
         "$HOME/Library/Preferences/$ID.plist" \
         "$HOME/Library/WebKit/$ID" \
         "$HOME/Library/HTTPStorages/$ID" \
         "$HOME/Library/HTTPStorages/$ID.binarycookies" \
         "$HOME/Library/Saved Application State/$ID.savedState"
fi
```

⚠️ La ligne `$ID.binarycookies` est facile à oublier : macOS écrit les cookies **à côté** du dossier `HTTPStorages/$ID`, pas dedans.

Cherche aussi les bundles égarés hors d'un `target` (un `.app` ou `.dmg` copié sur le Bureau ou dans les téléchargements pour tester) :

```bash
find ~/Downloads ~/Desktop -maxdepth 2 \( -name "FlightDeck*.app" -o -name "*dev build*.dmg" \) 2>/dev/null
```

## Étape 4 — Repacker les dépôts git

Un repo jamais `gc` garde ses objets en loose et, s'il a un jour vu un `git add .` avant son `.gitignore`, garde des **binaires de `target` vivants dans le reflog** — invisibles dans l'historique mais bien présents sur le disque. Constaté le 22/09/2026 sur flightdeck-server : `.git` à **269 Mo** pour 228 Ko de source, dont 303 Mo de blobs `flightdeckd/target/debug/deps/*` qu'aucune branche ne référençait. Après repack : **400 Ko**.

Diagnostic :

```bash
git -C <repo> count-objects -vH                      # loose élevé + 0 pack = jamais gc
git -C <repo> log --all --oneline -- '**/target'      # vide = les blobs ne sont QUE dans le reflog
```

Si le repo est clean (étape 1) :

```bash
git -C <repo> reflog expire --expire-unreachable=now --all
git -C <repo> gc --prune=now
```

`--expire-unreachable` (et pas `--expire`) est le point clé : il ne jette que les entrées de reflog pointant vers des commits qu'aucun ref n'atteint. L'historique d'annulation des branches vivantes survit.

**Vérifie après coup, et rapporte la vérification** — c'est une opération destructive, un « ça a marché » non vérifié ne vaut rien :

```bash
git -C <repo> fsck --no-progress                     # aucune erreur attendue
git -C <repo> for-each-ref --format='%(refname:short)' refs/heads   # toutes les branches encore là
# et le compte de commits hors origin pour chaque branche non poussée, inchangé
```

## Étape 5 — Rapport

Termine par un rapport court et **factuel** :

- espace rendu, par repo (avant → après) et espace libre sur le disque avant → après ;
- ce qui a été supprimé, par catégorie (`target`, identités de test, git) ;
- **ce que ça coûtera** : quels prochains builds repartent de zéro ;
- ce qui a été **sauté** et pourquoi (build en cours, repo sale, identité d'une feature vivante) — ne présente jamais une étape sautée comme faite ;
- la vérification post-`gc` (fsck + branches intactes) si l'étape 4 a tourné.

## Ce que ce skill ne fait PAS

- Supprimer du code, une branche, un commit, un worktree vivant ou un stash
- Toucher `node_modules` ou `~/.cargo/registry` (ils se re-téléchargeraient ; 328 Mo et 1,4 Go)
- Toucher les données de la prod `com.tosse.desktop` ni celles de `/build-dev`
- Réécrire un historique git ou force-pusher quoi que ce soit
- Désinstaller l'app de prod ou toucher `/Applications`
