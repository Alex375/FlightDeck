# Déménagement de `flightdeckd` dans `tosse-code` (monorepo, workspace Cargo)

> 18/09/2026 — plan, **rien n'est encore déplacé**. Décision d'Armand : le crate
> rejoint `tosse-code` dans un workspace Cargo après la vague 2. Ce document
> recense ce qui bouge, ce qui casse, dans quel ordre, et comment garder
> l'historique. État de référence : `flightdeck-server` `program/wave2`
> (wave1 0.1.1 + D5 0.2.0) ; `tosse-code` `dev` @ `0eccd99`.

## 1. En bref

- **Le crate est déjà autonome** : aucun chemin hors de `flightdeckd/` dans le
  code, les tests ni les scripts (vérifié : pas de `../`, `include_str!`,
  `include_bytes!`, `CARGO_MANIFEST_DIR`). Ce qui casse, ce sont les **outils
  autour** (Dockerfile M1, fixtures, script musl) et le **câblage du workspace**.
- **Un bloquant dur** : `rusqlite` 0.31 (flightdeckd) contre 0.32 (tosse-code) —
  deux `libsqlite3-sys` déclarant `links = "sqlite3"` dans le même workspace, et
  Cargo refuse de résoudre. `flightdeckd` doit passer en 0.32 **avant**.
  *Vérifié* sur un workspace jetable (deux membres, rusqlite 0.31 et 0.32) :
  `cargo generate-lockfile` → « package `libsqlite3-sys` links to the native
  library `sqlite3`, but it conflicts with a previous package », précédé du
  warning « virtual workspace defaulting to `resolver = "1"` ».
- **Deux pièges silencieux** : un workspace **virtuel** retombe en `resolver = 1`
  s'il n'est pas précisé (les features fuient entre membres, `test-util` de tokio
  compris) ; et les **profils** ne se lisent qu'à la racine, donc le
  `[profile.release]` de l'app doit y monter (sinon l'app perd `lto`,
  `opt-level = "s"`… sans erreur), et `flightdeckd` hériterait de
  `panic = "abort"` (un panic dans une session tuerait **toutes** les sessions).
  Parade : un profil `daemon` dédié.
- **Historique** : `git filter-repo` sur un clone jetable (garder et renommer
  les chemins qui bougent), puis `merge --allow-unrelated-histories` dans
  `tosse-code`. Les SHA changent → archiver la table de correspondance.
- **CI** : ajouter `cargo test -p flightdeckd` au job macOS existant (les tests
  passent sur macOS) ; un job Linux conseillé (la cible de prod) ; le build musl
  dans un workflow de release dédié. Deux chemins à corriger (`rust-cache`, bundle
  Tauri) car le `target/` monte à la racine.

## 2. Inventaire : ce qui déménage, ce qui reste

Arborescence cible proposée dans `tosse-code` (tout le côté serveur sous un seul
dossier, frère de `src-tauri/`) :

```
tosse-code/
  Cargo.toml                    NOUVEAU — [workspace] (cf. §4)
  Cargo.lock                    ← src-tauri/Cargo.lock (+ les deps de flightdeckd)
  src-tauri/                    inchangé (sauf [profile.release] qui monte à la racine)
  flightdeckd/                  ← flightdeck-server/flightdeckd/
    src/ tests/ scripts/        le crate, tel quel
    docs/                       ← flightdeck-server/docs/
    live/m1/                    ← flightdeck-server/m1-daemon/ (+ base.Dockerfile, cf. m0)
    live/bootstrap-fixtures/    ← flightdeck-server/bootstrap-fixtures/
```

| Dans `flightdeck-server` | Sort | Pourquoi / ce qu'il faut adapter |
|---|---|---|
| `flightdeckd/` (22 fichiers : `Cargo.toml`, `Cargo.lock`, `src/` ×13, `tests/` ×4, `scripts/` ×3, `.gitignore`) | **DÉMÉNAGE** → `flightdeckd/` | Le `Cargo.lock` du crate **disparaît** (un seul lock par workspace). `.gitignore` du crate (`/target`) devient inutile mais inoffensif. |
| `flightdeckd/scripts/{build-musl.sh, smoke-musl.sh, musl-builder.Dockerfile}` | **DÉMÉNAGE** (avec le crate) | `build-musl.sh` monte aujourd'hui **le crate** dans le conteneur : dans un workspace, il n'y a plus de lock au niveau du crate et `--locked` échoue. Il faut monter **la racine du workspace** et passer `-p flightdeckd`. Les binaires passent de `flightdeckd/target/musl/dist/` à `target/musl/dist/` (racine). `smoke-musl.sh` : suivre ce chemin. |
| `flightdeckd/tests/` (`attach_bridge`, `cli_e2e`, `config_lock`, `shutdown`) | **DÉMÉNAGE** | Portables : `CARGO_BIN_EXE_flightdeckd` + `/tmp`. Tournent sur macOS **et** Linux. |
| `m1-daemon/` (`Dockerfile`, `entrypoint.sh`, `scripts/up.sh`, `tests/detach_test.py`, `tests/phone-cut-test.mjs`) | **DÉMÉNAGE** → `flightdeckd/live/m1/` | C'est le banc live du démon ET de l'app : les tests `#[ignore]` de tosse-code (`actor_survives_ssh_cut_and_replays`, `remote_transport_streams_over_ssh`) visent `flightdeck-m1:2224`. Le `Dockerfile` compile aujourd'hui le crate depuis la racine du repo (`COPY flightdeckd/Cargo.lock …`) et `up.sh` fait `docker build … .` à la racine : dans tosse-code, ce contexte embarquerait `node_modules/` et `target/`. **À réécrire** : l'image prend le **binaire musl statique** de `build-musl.sh` (plus de compilation dans Docker, plus de dépendance au lock), contexte restreint à `live/m1/`. |
| `m0-ssh-remote/Dockerfile` | **DÉMÉNAGE seul** → `flightdeckd/live/m1/base.Dockerfile` (ou fusionné en étage de base du Dockerfile M1) | L'image M1 fait `FROM flightdeck-m0:latest` : sans lui, pas de banc M1. |
| `m0-ssh-remote/` (le reste : `docker-compose.yml`, `scripts/*` — `remote-claude.sh`, `render-stream.py`, `inject-secrets.sh`…, `runs/`, `README.md`) | **RESTE** (archive du prototype M0) | Preuve M0 historique, remplacée par M1. **Question ouverte** : `inject-secrets.sh` rafraîchit les creds de *tous* les conteneurs flightdeck (commit `c39f6ba`), et le conteneur `flightdeck-test:2223` apparié dans l'app d'Armand en dépend peut-être — si oui, le déplacer avec `live/m1/`. |
| `bootstrap-fixtures/` (`Dockerfile`, `fixture.sh`, `askpass.sh`, `flightdeckd.service`, `d-linger-experiment.sh`) | **DÉMÉNAGE** → `flightdeckd/live/bootstrap-fixtures/` | Banc de l'installeur Mac (`src-tauri/src/bootstrap/`) : sa place est à côté de lui. `fixture.sh` pointe `$HERE/../flightdeckd/target/musl/dist` et `$HERE/../flightdeckd/scripts/build-musl.sh` → à corriger (binaire à la racine `target/musl/dist/`). Le `Dockerfile` n'a pas de chemin externe (contexte temporaire). |
| `docs/M1-DAEMON.md` (contrat du protocole : `fd_*`, curseur, `fd_skip`, verrou de config, permissions) | **DÉMÉNAGE** → `flightdeckd/docs/` | Référence du contrat que `src-tauri/src/supervisor/transport.rs` implémente en face. |
| `docs/B0-MUSL-SPIKE.md`, `docs/B6-FIXTURES.md` | **DÉMÉNAGE** | Suivent leurs scripts / fixtures ; chemins cités à corriger. |
| `docs/CADRAGE.md`, `CDC-M1-DAEMON.md`, `M0-APP-REMOTE.md`, `M0-TEST-PAIRING.md`, `REMOTE-PAIRING.md` | **DÉMÉNAGE** (historique de conception) | Rien à adapter hors liens relatifs. |
| `docs/program/plan-2026-09-18.json` | **À décider** (archive de l'orchestrateur) | Déménage par défaut avec `docs/` ; l'exclure du `filter-repo` si l'orchestrateur préfère le garder ailleurs. |
| `docs/MONOREPO-MOVE.md` (ce fichier) | déménage | — |
| `README.md` | **RESTE**, réécrit en pierre tombale | « Déménagé dans `tosse-code/flightdeckd` @ `<sha>` » + table de correspondance des SHA. Puis archiver le repo (GitHub *Archive*). |
| `.gitignore` racine | **RESTE**, mais **reporter** ses motifs secrets dans celui de tosse-code | tosse-code ignore `target/` mais **pas** `*.pem`, `*.key`, `id_ed25519*`, `id_rsa*`, `pairing-ticket*.json`, `.env`, `.colima/` — à ajouter avant que les bancs live y tournent. |

## 3. Dépendances : `flightdeckd` contre `tosse-code/src-tauri`

Un workspace = **un seul** `Cargo.lock` et une seule résolution. Les versions
semver-compatibles fusionnent ; les incompatibles coexistent en double — sauf
celles qui déclarent un `links`, qui **empêchent la résolution**.

| Dépendance | flightdeckd (déclaré → verrouillé) | tosse-code (déclaré → verrouillé) | Effet dans un workspace | Action |
|---|---|---|---|---|
| **rusqlite** | `0.31` bundled → 0.31.0 (libsqlite3-sys 0.28.0) | `0.32` bundled → 0.32.1 (libsqlite3-sys 0.30.1) | **BLOQUANT** : deux `libsqlite3-sys` avec `links = "sqlite3"` → Cargo refuse de résoudre le workspace | **Passer flightdeckd en `0.32` avant** (API utilisée : `Connection::open`, `pragma_update`, `execute`, `query_map`, `params!` — rien de cassé attendu ; tests registry à relancer) |
| **tokio-tungstenite** | `0.23` (webpki-roots) → 0.23.1 / tungstenite 0.23.0 | `0.24` (webpki-roots) → 0.24.0 / tungstenite 0.24.0 | Doublon (deux piles WS compilées), pas d'erreur | Passer en `0.24` (API utilisée identique : `connect_async`, `accept_async`, `Message::Text(String)`, `Ping(Vec<u8>)`) |
| **serde_json** | `1` → 1.0.151, **sans** `preserve_order` | `1` + **`preserve_order`** → 1.0.150 | Fusion ; mais avec le resolver 2, les features s'unifient **entre les membres construits ensemble** : `cargo test -p flightdeckd` → sans `preserve_order`, `cargo test --workspace` → avec. L'ordre des clés des frames `fd_*` changerait selon la commande | Activer `preserve_order` dans flightdeckd aussi (sortie déterministe, `type` en tête des frames) et corriger le seul test qui compare un JSON sérialisé brut : `attach.rs` `a_farewell_needing_several_slow_writes_still_gets_through` (`r#"{"reason":"stalled","type":"fd_detach"}"#`) |
| **tokio** | `1` `full` (+ dev : `test-util`) → 1.53.1 | `1` (process, io-util, rt-multi-thread, macros, sync, time, net) → 1.52.3 | Fusion (même 1.x) ; le lock garde celui de l'app → flightdeckd redescend en 1.52.3, sans effet | Rien. `test-util` reste confiné aux tests **si** `resolver = "2"` (cf. §4) |
| **rustls** | `0.23` (ring, std, tls12) → 0.23.43 | `0.23` (ring) → 0.23.40 | Fusion, même fournisseur `ring` 0.17.14 des deux côtés | Rien |
| **dirs** | `5` → 5.0.1 | `6.0.0` (transitif) | Doublon mineur | Passer en `6` (`home_dir` inchangé) |
| serde, uuid (v4), futures-util, libc, anyhow, tracing, tempfile (dev) | 1 / 1 / 0.3 / 0.2 / 1 / 0.1 / 3 | mêmes majeures | Fusion | Rien |
| clap 4, tracing-subscriber 0.3 | propres à flightdeckd | — | Ajouts au lock | Rien |

Toolchain : `stable` des deux côtés, edition 2021 des deux côtés.

## 4. Câblage du workspace (côté tosse-code, au moment du déménagement)

1. **`Cargo.toml` racine** (nouveau) :
   ```toml
   [workspace]
   members = ["src-tauri", "flightdeckd"]
   resolver = "2"   # OBLIGATOIRE : un workspace virtuel retombe sinon en resolver 1
                    # (features unifiées entre TOUS les membres, dev-deps comprises)

   # Déplacé depuis src-tauri/Cargo.toml : les profils des membres sont IGNORÉS
   # (simple warning) — l'app perdrait lto / opt-level "s" sans erreur.
   [profile.release]
   panic = "abort"
   codegen-units = 1
   lto = true
   opt-level = "s"
   strip = true

   # flightdeckd NE DOIT PAS être en panic = "abort" : un panic dans une tâche
   # de session tuerait le démon et toutes les sessions (en unwind, seule la
   # tâche meurt). `panic`/`lto` ne se surchargent pas par paquet → profil dédié.
   [profile.daemon]
   inherits = "release"
   panic = "unwind"
   lto = "thin"
   opt-level = 3
   codegen-units = 16
   ```
   `build-musl.sh` compile alors avec `--profile daemon` (sortie
   `target/<cible>/daemon/flightdeckd`).
2. **`Cargo.lock`** : `git mv src-tauri/Cargo.lock Cargo.lock`, puis
   `cargo check -p flightdeckd` (ajoute ses deps en gardant les versions déjà
   verrouillées pour l'app). Vérifier que `git diff Cargo.lock` ne montre **que
   des ajouts** (et d'éventuelles descentes de versions pour flightdeckd) —
   aucune montée de dépendance de l'app.
3. **Tauri** : dans un workspace, `tauri build` écrit dans `<racine>/target`
   (il lit `target_directory` via `cargo metadata`) : le bundle passe de
   `src-tauri/target/release/bundle/` à `target/release/bundle/`.
4. **`scripts/bump-version.mjs`** : `CARGO_LOCK` pointe
   `src-tauri/Cargo.lock` → `Cargo.lock`. Il ne touche que l'entrée
   `tosse-code` : la version de `flightdeckd` reste indépendante (0.1.x / 0.2.x,
   gatée par `flightdeckd --version` côté Mac) — ne **pas** l'aligner sur celle
   de l'app.
5. **Références croisées** à mettre à jour : les commentaires des tests live de
   tosse-code (`session.rs:3675`, `transport.rs:2063` : « flightdeck-server:
   `m1-daemon/scripts/up.sh` ») ; dans les docs de flightdeckd, « tosse-code
   `transport.rs` » devient un chemin du même repo.
6. **Suite naturelle (après le déménagement)** : extraire le contrat curseur
   (`is_replayable_line`, les formes `fd_*`, `fd_skip`) dans un petit crate
   partagé `flightdeck-protocol` utilisé par `flightdeckd` ET `src-tauri` — la
   règle « partagé ligne pour ligne avec transport.rs » devient une dépendance
   au lieu d'une discipline.

## 5. Garder l'historique git

`flightdeck-server` est petit (38 commits, dont 23 touchent `flightdeckd/`).
Méthode retenue : **`git filter-repo`** (plusieurs dossiers + renommages en une
passe ; `git subtree split` ne sait extraire qu'un préfixe à la fois et ne
renomme pas).

```bash
# 0. Figer flightdeck-server : wave1 et wave2 intégrées (main), plus aucun commit.
brew install git-filter-repo

# 1. Clone JETABLE (filter-repo réécrit tout) — jamais le repo de travail.
git clone --no-local ~/Documents/repositories/flightdeck-server /tmp/fds-move
cd /tmp/fds-move && git checkout main
git filter-repo \
  --path flightdeckd/ --path m1-daemon/ --path bootstrap-fixtures/ --path docs/ \
  --path m0-ssh-remote/Dockerfile \
  --path-rename m1-daemon/:flightdeckd/live/m1/ \
  --path-rename bootstrap-fixtures/:flightdeckd/live/bootstrap-fixtures/ \
  --path-rename docs/:flightdeckd/docs/ \
  --path-rename m0-ssh-remote/Dockerfile:flightdeckd/live/m1/base.Dockerfile
#    (ajouter --invert-paths --path docs/program/ si le plan ne doit pas suivre)
cp .git/filter-repo/commit-map /tmp/fds-commit-map.txt   # ancien SHA → nouveau SHA

# 2. Import dans tosse-code, sur une branche.
cd ~/Documents/repositories/tosse-code
git checkout -b chore/monorepo-flightdeckd dev
git remote add fds-move /tmp/fds-move && git fetch fds-move
git merge --allow-unrelated-histories --no-ff fds-move/main \
  -m "chore: import flightdeckd with its history from flightdeck-server"
git remote remove fds-move

# 3. Commit(s) suivants sur la même branche : workspace (§4), chemins (§2), CI (§6),
#    flightdeckd/docs/flightdeck-server-commit-map.txt ← /tmp/fds-commit-map.txt
```

- `git log --follow flightdeckd/src/attach.rs` remonte jusqu'au scaffold
  d'août ; auteurs, dates et `Co-Authored-By` sont conservés.
- Les **SHA changent** : or ils sont cités dans le CRM, les docs et les notes de
  déploiement (ex. « 0.1.1 = `93f846b` » déployé sur josty-cc). La table
  `commit-map` versionnée dans `flightdeckd/docs/` garde la traçabilité.
- Les binaires de déploiement déjà produits
  (`flightdeckd/target/deploy/…`, hors git) ne bougent pas : leurs `sha256`
  restent la référence.

## 6. Impact CI (`tosse-code/.github/workflows`)

**`ci.yml`** (PR vers `main`, `macos-latest`) :

- `Swatinem/rust-cache` : `workspaces: ./src-tauri -> target` →
  `workspaces: . -> target` (le `target/` monte à la racine ; le premier run
  repart à froid).
- L'étape `cargo test --lib` (`working-directory: src-tauri`) reste valable :
  lancée dans `src-tauri/`, cargo ne sélectionne que le paquet de l'app.
- **Ajouter** `cargo test -p flightdeckd` (unitaires + intégration). Ils
  passent sur macOS (Unix sockets, `flock`, `peer_cred` → `getpeereid`,
  `/tmp`) : c'est là qu'ils ont toujours tourné. ~1–2 min de compilation en
  plus, moins avec le cache.
- **Conseillé** : un job `ubuntu-latest` `cargo test -p flightdeckd` — la prod
  est Linux (`SO_PEERCRED`, sémantique `flock`, systemd) et le runner Linux est
  moins cher que le macOS.
- **Ne PAS mettre en CI** les bancs live (`live/m1` `detach_test.py`,
  `phone-cut-test.mjs`, `live/bootstrap-fixtures`) : ils exigent Docker, des
  credentials Claude et le relais de prod. Ils restent manuels, comme les tests
  `#[ignore]` de l'app.

**`release.yml`** (app) :

- `rust-cache` : même correction de chemin.
- `APP="$(find src-tauri/target -type d -path '*/release/bundle/macos/*.app' …)"`
  → `find target …` (sinon la release ne trouve plus le `.app`).

**Nouveau workflow de release du démon** (manuel, comme celui de l'app) :
`build-musl.sh` (Docker ; sur `ubuntu-latest` x86_64 l'aarch64 se croise via
zig, et `smoke-musl.sh` a besoin de `docker/setup-qemu-action` pour exécuter
l'aarch64) → `smoke-musl.sh` → publication des deux binaires + `SHA256SUMS`
sous un tag distinct de l'app (`flightdeckd-vX.Y.Z`). À articuler avec B2
(épinglage de l'image `RUST_IMAGE` par digest) et avec la façon dont
l'installeur Mac se procure le binaire (téléchargement de release ou binaire
embarqué dans le bundle de l'app) — hors de ce document.

## 7. Ordre proposé

**Préalables dans `flightdeckd`, faisables dès maintenant sur `program/wave2`**
(chacun testé, sans rien déplacer) :

1. `rusqlite` 0.31 → 0.32 (**bloquant**).
2. `tokio-tungstenite` 0.23 → 0.24, `dirs` 5 → 6 (doublons).
3. `serde_json` + `preserve_order` et le test d'ordre des clés corrigé.
4. `build-musl.sh` / `smoke-musl.sh` rendus « workspace-aware » (monter la
   racine du workspace, `-p flightdeckd`, profil et dossier de sortie
   paramétrables) — fonctionne aussi en standalone.
5. `live/m1` : l'image M1 consomme le binaire musl (plus de compilation dans
   Docker), étage de base M0 intégré.

**Le déménagement** (une branche tosse-code, une PR vers `dev`) :

6. Geler `flightdeck-server` (wave1 + wave2 intégrées à `main`).
7. `filter-repo` + import avec historique (§5).
8. Workspace, profils, lock, `bump-version.mjs`, chemins, `.gitignore` (§2, §4).
9. CI (§6).
10. Vérifications : `cargo test -p flightdeckd` ; `cd src-tauri && cargo test
    --lib` ; `pnpm tauri build --config src-tauri/dev-build.conf.json` → bundle
    sous `target/release/bundle/` ; `build-musl.sh` + `smoke-musl.sh` ; banc M1
    + `detach_test.py` A/B/C/D ; tests `#[ignore]` de l'app contre `:2224`.
11. `flightdeck-server` : README pierre tombale + archivage.

**Alternative moins risquée**, si le workspace doit attendre : importer
`flightdeckd/` avec son historique comme **paquet autonome** dans tosse-code
(son propre `Cargo.lock`, son propre `target/`, pas de `[workspace]`). Ni
conflit `links`, ni profil hérité, ni chemin Tauri/CI qui bouge ; seul un
`cargo test --manifest-path flightdeckd/Cargo.toml` s'ajoute à la CI. Le
passage au workspace (§4) devient une deuxième PR, indépendante. Coût : deux
locks, deux `target/`, les dépendances communes compilées deux fois.
