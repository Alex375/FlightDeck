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
3. **Jamais l'identité d'une feature vivante.** Une identité `com.tosse.desktop.<slug>` dont le worktree `<slug>` existe encore appartient à une feature en cours : ce sont ses données de test, ne les supprime pas.
4. **Jamais pendant un build, ni sous une app qui tourne.** Le worktree principal est partagé avec les autres agents : supprimer `target` sous les pieds d'un `tauri build` en cours le casse. Et `target/release/bundle` contient le `.app` que `/build-dev` et `/build-app` lancent — une app en cours d'exécution vit DANS le dossier qu'on s'apprête à effacer. Vérifie les deux, et si l'un des deux est vrai, **saute la purge du `target` concerné** (les autres étapes restent possibles).
5. **Jamais de réécriture d'historique, jamais un stash perdu.** Le `git gc` de l'étape 4 n'expire que les reflogs **de branches** : aucun commit d'aucune branche, et **aucun stash**, ne peut disparaître. Pas de `filter-branch`, pas de `--expire=now` global, **pas de `--all`** (il inclut `refs/stash`), pas de force-push.
6. **Un chemin qu'on n'a pas trouvé n'a pas été purgé.** Toute racine est **dérivée**, jamais écrite en dur : un chemin en dur qui n'existe pas fait passer un garde-fou pour vert et fait annoncer un espace qu'on n'a jamais rendu. Si une racine est introuvable, **ne purge rien pour elle** et dis-le dans le rapport.

## Étape 0 — Dériver les racines, puis mesurer

⚠️ **Rien n'est codé en dur ici.** Les racines se dérivent du dépôt courant. (Ce skill a déjà planté pour cette raison : il visait `~/Documents/repositories/tosse-code`, qui n'existe sur aucune machine — tous ses `rm -rf`, son `git gc` et son garde-fou « feature vivante » tapaient à côté.)

```bash
# Racine du checkout PRINCIPAL de tosse-code (même lancé depuis un worktree).
ROOT=$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')
# Garde-fou : c'est bien tosse-code ? Sinon on s'arrête, on ne devine pas.
[ -f "$ROOT/src-tauri/Cargo.toml" ] || { echo "REFUS : $ROOT n'est pas tosse-code"; exit 1; }

# Le repo serveur est un voisin du même parent — absent = on n'y touche pas.
SERVER="$(dirname "$ROOT")/flightdeck-server"
[ -d "$SERVER/.git" ] || SERVER=""

echo "ROOT=$ROOT"; echo "SERVER=${SERVER:-<introuvable, sera SAUTÉ>}"
```

```bash
df -h / | tail -1
du -sh "$ROOT" ${SERVER:+"$SERVER"} 2>/dev/null
pgrep -x "cargo|rustc|cargo-tauri"      # vide (exit 1) = aucun build en cours (invariant 4)
pgrep -fl "target/release/bundle"       # vide = aucune app lancée DEPUIS un target (invariant 4)
```

⚠️ Le test de build se fait sur le **nom** du process (`pgrep -x`), pas sur la ligne de commande complète (`pgrep -f "cargo|rustc|tauri"`) : cette dernière matche le PATH hérité de n'importe quel process (il contient `.cargo/bin`), le chemin du bundle `.app` de dev, et le `pgrep` lui-même — elle renvoyait 27 lignes **sans aucun build**, donc l'étape 2 était systématiquement sautée et les ~19 Go jamais rendus.

⚠️ La seconde ligne est le garde-fou que l'ancienne version tenait par ACCIDENT : son `pgrep -f "cargo|…"` matchait tout process dont le PATH contient `.cargo/bin`, donc aussi l'app `Flight Deck dev build` — il bloquait tout, tout le temps, pour la mauvaise raison. Rendre le test du build précis a découvert le vrai trou : `/build-dev` laisse une app qui TOURNE depuis `target/release/bundle/macos/…`, et un `rm -rf target` l'efface sous ses pieds (macOS garde l'inode ouvert, mais le relaunch échoue et toute ressource chargée paresseusement disparaît). Constaté en conditions réelles le 23/09/2026.

Si un build tourne : saute l'étape 2, fais le reste, et dis-le franchement dans le rapport.
Si une app tourne depuis un `target` : purge `target/debug` (sans danger), **saute `target/release`**, et dis lequel et pourquoi. Proposer de quitter l'app pour récupérer le reste est un choix de l'utilisateur, pas une décision de ce skill.

## Étape 1 — Vérifier que rien n'est en jeu (invariant 1)

```bash
git -C "$ROOT" status --porcelain
[ -n "$SERVER" ] && git -C "$SERVER" status --porcelain
```

Un repo sale n'empêche pas de purger ses `target` (gitignorés), mais **empêche son `git gc`** de l'étape 4. Note lequel est sale.

## Étape 2 — Purger les `target` (le gros morceau)

Quatre `target` peuvent exister, et on les oublie tous les quatre. Ordres de grandeur mesurés le 22/09/2026 :

| Chemin | Produit par | Taille observée |
|---|---|---|
| `<ROOT>/src-tauri/target/debug` | `cargo test --lib`, `tauri dev` | **12 G** (incremental 4,3 G · deps 6,2 G) |
| `<ROOT>/src-tauri/target/release` | `/build-dev`, `/build-app` | **1,9 G** + un `.dmg` de 27 M par version |
| `<ROOT>/flightdeckd/target` | crate dupliquée du serveur | **1,2 G** |
| `<SERVER>/flightdeckd/target` | debug · musl · release · deploy | **5,6 G** |

**Mode par défaut — tout effacer.** C'est le comportement voulu : on lance ce skill à un moment où le travail est posé, donc c'est le bon moment pour repayer une compilation.

```bash
for T in "$ROOT/src-tauri/target" "$ROOT/flightdeckd/target" ${SERVER:+"$SERVER/flightdeckd/target"}; do
  if [ ! -d "$T" ]; then
    echo "absent, RIEN purgé : $T"
  elif pgrep -f "$T/release/bundle" >/dev/null; then
    # Une app tourne dedans : son `release` reste, son `debug` part quand même.
    echo "app en cours depuis $T/release/bundle → SAUTÉ : $T/release"
    [ -d "$T/debug" ] && { echo "purge $T/debug ($(du -sh "$T/debug" | cut -f1))"; rm -rf "$T/debug"; }
  else
    echo "purge $T ($(du -sh "$T" | cut -f1))"
    rm -rf "$T"
  fi
done
```

⚠️ Reporte les `absent` tels quels. Annoncer l'espace d'un `target` qui n'existait pas est un mensonge sur une opération destructive.

Dis explicitement à l'utilisateur ce que ça coûte : le prochain `cargo test --lib` et le prochain `/build-dev` ou `/build-app` repartent d'un build Rust **complet** (~10 min chacun).

**Mode conservateur — `/cleanup --caches`.** Si l'utilisateur a demandé à garder l'incrémental, ne prends que le pur cache (~4 Go rendus, aucune recompilation complète à repayer) :

```bash
rm -rf "$ROOT"/src-tauri/target/{debug,release}/incremental \
       "$ROOT"/flightdeckd/target/*/incremental \
       ${SERVER:+"$SERVER"/flightdeckd/target/*/incremental}
```

⚠️ Un `rm -rf` sur un `target` peut sortir en `Directory not empty` sans avoir échoué : le Finder recrée un `.DS_Store` pendant la suppression. Relance simplement la commande et vérifie avec `ls -d` que le chemin a disparu.

## Étape 3 — Purger les identités de test mortes (`/build-app`)

Chaque `/build-app` crée une identité macOS `com.tosse.desktop.<slug>` éparpillée dans six emplacements de `~/Library`. `/land` la purge normalement à son étape 7b, mais une feature abandonnée sans `/land` la laisse orpheline pour toujours.

⚠️ **L'inventaire liste des IDENTITÉS, pas des fichiers.** Un `find -name "com.tosse.desktop.*"` ramasse aussi les **fichiers annexes de la prod** — `Preferences/com.tosse.desktop.plist` et `HTTPStorages/com.tosse.desktop.binarycookies` existent bel et bien — et le garde-fou d'identité protégée ne peut pas les attraper, puisque `$ID` vaudrait alors `com.tosse.desktop.plist`. Le suffixe se retire **avant** le filtre :

```bash
{
  for d in "Application Support" Caches WebKit HTTPStorages; do ls -1 ~/Library/"$d" 2>/dev/null; done
  ls -1 ~/Library/Preferences 2>/dev/null              | sed 's/\.plist$//'
  ls -1 ~/Library/"Saved Application State" 2>/dev/null | sed 's/\.savedState$//'
} | sed 's/\.binarycookies$//' \
  | grep -xE 'com\.tosse\.desktop\.[a-z0-9][a-z0-9-]*' \
  | grep -vxF 'com.tosse.desktop.dev' \
  | sort -u
```

Les deux identités protégées disparaissent par construction : `com.tosse.desktop.plist` et `com.tosse.desktop.binarycookies` redeviennent `com.tosse.desktop`, que la regex (qui exige un 4ᵉ segment) rejette, et `com.tosse.desktop.dev` est exclu nommément.

Ensuite, la liste des **slugs vivants**, énumérés depuis git — jamais un chemin construit à la main :

```bash
LIVE=$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | xargs -n1 basename)
echo "$LIVE"
```

⚠️ Si cette commande échoue ou sort vide, **n'efface aucune identité** : sans la liste des features vivantes, le garde-fou 3 n'existe plus. Fail closed.

Puis, slug par slug — jamais en glob (invariants 2 et 3) :

```bash
ID="com.tosse.desktop.<slug>"
SLUG="${ID#com.tosse.desktop.}"
case "$ID" in
  com.tosse.desktop|com.tosse.desktop.dev)
    echo "REFUS : $ID est une identité protégée." ;;
  *.plist|*.binarycookies|*.savedState)
    echo "REFUS : $ID est un fichier annexe, pas une identité." ;;
  *)
    if echo "$LIVE" | grep -qxF "$SLUG"; then
      echo "REFUS : le worktree $SLUG est vivant — ce sont les données de test d'une feature en cours."
    else
      rm -rf "$HOME/Library/Application Support/$ID" \
             "$HOME/Library/Caches/$ID" \
             "$HOME/Library/Preferences/$ID.plist" \
             "$HOME/Library/WebKit/$ID" \
             "$HOME/Library/HTTPStorages/$ID" \
             "$HOME/Library/HTTPStorages/$ID.binarycookies" \
             "$HOME/Library/Saved Application State/$ID.savedState"
    fi ;;
esac
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
git -C "$REPO" count-objects -vH                      # loose élevé + 0 pack = jamais gc
git -C "$REPO" log --all --oneline -- '**/target'     # vide = les blobs ne sont QUE dans le reflog
```

⚠️ **Porte d'entrée obligatoire : les stashs.** Le stash est partagé entre le checkout principal et **tous** les worktrees, et d'autres agents peuvent en poser un. `git status --porcelain` ne le voit pas.

```bash
git -C "$REPO" stash list      # NON VIDE → saute l'étape 4 pour ce repo et dis-le
```

Si le repo est clean (étape 1) **et** sans stash :

```bash
git -C "$REPO" reflog expire --expire-unreachable=now \
    $(git -C "$REPO" for-each-ref --format='%(refname)' refs/heads)
git -C "$REPO" gc --prune=now
```

⚠️ **Ne passe JAMAIS `--all` à `reflog expire` ici.** `--all` traite *tous* les reflogs, y compris `refs/stash` : les entrées `stash@{1}` et suivantes ne sont atteignables que par leur reflog, donc elles sont expirées puis élaguées par le `gc --prune=now`. Le travail stashé est alors irrécupérable — et la vérification prescrite ci-dessous (fsck + branches) le rate complètement, puisqu'aucune branche n'a bougé. Restreindre aux reflogs de `refs/heads` donne le même gain d'espace sans ce risque.

**Vérifie après coup, et rapporte la vérification** — c'est une opération destructive, un « ça a marché » non vérifié ne vaut rien :

```bash
git -C "$REPO" fsck --no-progress                     # aucune erreur attendue
git -C "$REPO" for-each-ref --format='%(refname:short)' refs/heads   # toutes les branches encore là
git -C "$REPO" stash list                             # même nombre d'entrées qu'avant
# et le compte de commits hors origin pour chaque branche non poussée, inchangé
```

## Étape 5 — Rapport

Termine par un rapport court et **factuel** :

- espace rendu, par repo (avant → après) et espace libre sur le disque avant → après ;
- ce qui a été supprimé, par catégorie (`target`, identités de test, git) ;
- **ce que ça coûtera** : quels prochains builds repartent de zéro ;
- ce qui a été **sauté** et pourquoi (build en cours, repo sale, stash présent, identité d'une feature vivante, racine introuvable) — ne présente jamais une étape sautée comme faite, et ne compte jamais l'espace d'un chemin absent comme rendu ;
- la vérification post-`gc` (fsck + branches + stashs intacts) si l'étape 4 a tourné.

## Ce que ce skill ne fait PAS

- Supprimer du code, une branche, un commit, un worktree vivant ou un stash
- Toucher `node_modules` ou `~/.cargo/registry` (ils se re-téléchargeraient ; 328 Mo et 1,4 Go)
- Toucher les données de la prod `com.tosse.desktop` ni celles de `/build-dev`
- Réécrire un historique git ou force-pusher quoi que ce soit
- Désinstaller l'app de prod ou toucher `/Applications`
