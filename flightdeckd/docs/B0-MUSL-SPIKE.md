# B0 — Spike : `flightdeckd` en binaire statique musl (x86_64 + aarch64)

> 18/09/2026. Question go/no-go posée par la distribution binaire : peut-on
> produire un `flightdeckd` Linux **statique** pour les deux architectures, avec
> `rusqlite` (SQLite *bundled*, du C) et `rustls` + `ring` (C + asm), sans
> toolchain croisée installée sur la machine ?

## Verdict : GO

Les deux cibles compilent, se lient en **statique** et tournent dans une Debian
de base (aucune lib, aucun musl installé). `ring` passe sur aarch64-musl sans
repli ; aucun changement de code ni de dépendance nécessaire.

| Cible | Taille (release, strip, LTO thin) | `file` | `ldd` (Debian bookworm) |
|---|---|---|---|
| `x86_64-unknown-linux-musl` | 6 556 088 o (6,3 Mio) | ELF x86-64, statically linked, stripped | `not a dynamic executable` |
| `aarch64-unknown-linux-musl` | 6 048 432 o (5,8 Mio) | ELF aarch64, statically linked, stripped | `not a dynamic executable` |

Smoke, dans `debian:bookworm-slim` pour chaque arch (x86_64 en émulation
binfmt de Docker sur un Mac arm64, aarch64 en natif), HOME vide :

- `flightdeckd --version` → `flightdeckd 0.1.0`
- `flightdeckd init --relay https://example.com --label smoke` → config écrite
- `flightdeckd run` → `attach socket ready …` et
  `relay connection ended: HTTP error: 404 Not Found` : le 404 vient d'example.com
  **après** la poignée de main TLS, donc rustls + ring + les racines webpki
  fonctionnent dans le binaire statique (et on n'enregistre rien sur le vrai relais)
- `flightdeckd status` (démon vivant) →
  `{"conversations":[],"label":"smoke","type":"fd_status","version":"0.1.0"}`

## Commandes reproductibles

Il suffit de Docker (n'importe quelle arch d'hôte). Les scripts vivent dans le
crate (`flightdeckd/scripts/`) pour le suivre dans le futur monorepo.

```bash
flightdeckd/scripts/build-musl.sh   # → <racine>/target/musl/dist/flightdeckd-<target>
flightdeckd/scripts/smoke-musl.sh   # ldd + --version + init + run/TLS + status, par arch
flightdeckd/scripts/build-musl.sh --print-dist-dir     # où atterrissent les binaires
TARGETS=aarch64-unknown-linux-musl flightdeckd/scripts/build-musl.sh   # une seule arch
```

`<racine>` est détectée (`scripts/lib-layout.sh` : le plus proche ancêtre dont
le `Cargo.toml` a une table `[workspace]`, **sans sortir du dépôt git** du crate
et **seulement s'il liste vraiment le crate** — `members`, globs compris, hors
`exclude` ; sinon mode autonome avec un avis sur stderr ; `WORKSPACE_ROOT=`
force ; testé par `scripts/test-lib-layout.sh`, lancé par `cargo test`) :
le crate lui-même quand il est **autonome** (aujourd'hui, et après un import
dans tosse-code comme paquet autonome), la racine du **workspace** quand il en
est membre — c'est elle qui est montée dans le builder (son `Cargo.lock`,
`--locked`), avec `-p flightdeckd` et le profil `daemon` du workspace s'il en a
un (sinon `release` ; `PROFILE=` force). Vérifié le 18/09 dans les deux modes :
crate autonome (les deux arches) et workspace simulé (un second membre, lock à
la racine, `[profile.daemon]` → `target/musl/aarch64-unknown-linux-musl/daemon/`).

- `scripts/musl-builder.Dockerfile` : `rust:1-alpine` + `apk add cargo-zigbuild`
  (tire `zig`) + `rustup target add` des deux cibles musl.
- `build-musl.sh` : `cargo zigbuild --locked -p flightdeckd --profile <release|daemon> --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl`
  dans ce conteneur, `<racine>` montée, sous l'uid de l'appelant (rien écrit en
  root) ; registre cargo + cache zig sous `<racine>/target/musl/` ⇒ relances
  incrémentales.
- Durées observées (VM colima 2 CPU, Mac arm64) : **7 min 48 s** à froid pour
  les deux cibles, **1 min 14 s** après une modif de `main.rs`. Image builder ~1,7 Go.

Versions de l'essai : rustc 1.98.1, Alpine 3.24.2, zig 0.16.0,
cargo-zigbuild 0.23.4 ; ring 0.17.14, rustls 0.23.43, rusqlite 0.31.0
(libsqlite3-sys 0.28.0, bundled). L'image de base n'est pas épinglée par
digest (`ARG RUST_IMAGE`) : pour une release, épingler `RUST_IMAGE` et noter le digest.

## Choix de l'outil (et pourquoi pas les autres)

- **cargo-zigbuild (retenu)** : zig sert de compilateur C + éditeur de liens
  croisé pour toutes les cibles depuis un seul conteneur ; même recette sur un
  Mac arm64 ou une CI x86_64.
- `cross` : ses images sont linux/amd64 ⇒ émulées sur un hôte arm64 ; et il
  faut une image par cible. Écarté.
- Build natif par plateforme (`docker run --platform linux/<arch> rust:alpine cargo build`) :
  Alpine est musl natif, donc pas de croisement du tout, mais l'arch étrangère
  compile en émulation (beaucoup plus lent). C'est le **repli n° 1** si zig casse un jour.

## Replis si `ring` cassait (non nécessaires aujourd'hui)

1. Build natif par arch (ci-dessus) : `ring` se compile alors en natif.
2. Fournisseur crypto rustls sans C ni asm (`rustls-rustcrypto`, pur Rust) —
   moins éprouvé, perf moindre, mais aucune toolchain C.
3. `aws-lc-rs` est **à éviter** ici : son build croisé exige cmake + clang
   (+ Go selon les versions), pire que `ring`.

## Points à garder en tête pour la distribution

- Linker zig : avertissement bénin `ignoring deprecated linker optimization setting '1'`.
- Résolveur DNS de musl (`getaddrinfo`) : interroge les serveurs de
  `/etc/resolv.conf` en parallèle, ignore certaines options glibc
  (`rotate`…). Sans effet attendu pour le relais (nom public) ni pour les noms
  MagicDNS Tailscale (résolveur 100.100.100.100 dans `resolv.conf`) — à
  garder en tête si un serveur a un DNS exotique.
- Allocateur musl plus lent que glibc ; sans importance à la charge d'un démon
  de sessions. Si besoin un jour : `mimalloc` en `#[global_allocator]`.
- Binaire statique ⇒ aucune dépendance à la version de glibc du serveur :
  un même binaire par arch couvre Debian/Ubuntu/RHEL/Alpine.
