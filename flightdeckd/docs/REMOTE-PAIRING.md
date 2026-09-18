# Appareiller un serveur distant & y ouvrir des repos — protocole (proposition)

> Statut : **proposition de design, à affiner ensemble.** Rien n'est implémenté ici
> — c'est le parcours qu'on veut offrir, plus les mécanismes dessous. Le transport
> SSH et le modèle « repo distant » (`ssh_target`) existent déjà (voir
> [`M0-APP-REMOTE.md`](M0-APP-REMOTE.md)) ; ce document conçoit **l'onboarding
> humain** posé au-dessus.

## 0. Le but, en une phrase

Depuis Flight Deck sur le Mac, un utilisateur doit pouvoir, **en autonomie**,
transformer une machine Linux « nue » (rien d'installé, mais il peut s'y connecter
une fois) en **serveur Flight Deck**, puis y **ouvrir une conversation dans un de ses
repos** — sans jamais éditer un fichier de config à la main.

Deux parcours distincts :
- **Parcours A — Appairer un appareil** (une fois par machine).
- **Parcours B — Ajouter un repo distant** (autant de fois qu'on veut, une fois la
  machine appairée).

## 1. L'étoile polaire (CADRAGE) et ce que l'alpha en fait

Le CADRAGE fixe la cible : la page **« Serveurs distants → Ajouter un serveur »**
donne **une seule commande à coller sur le serveur**. Elle installe le nécessaire ET
émet un **ticket d'appairage auto-suffisant** (endpoint, jeton, clé, clé SSH jetable)
qu'on recolle dans Flight Deck → connecté. Ça **inverse le bootstrap** : *c'est le
serveur qui se présente*, Flight Deck n'a plus besoin de tes creds SSH perso.

En **alpha (SSH-first, sans démon)**, on garde exactement cette forme, en plus léger :
la « commande à coller » ne fait qu'**autoriser Flight Deck en SSH + installer/logger
`claude`**. Le même geste, plus tard, installera le démon — le code SSH n'est pas
jetable (il devient le bootstrap d'install du démon, cf. CADRAGE « Alpha path »).

**Principe directeur retenu : la clé privée ne quitte JAMAIS le Mac.** Flight Deck
génère une paire de clés *dédiée à ce serveur*, et la commande à coller ne transporte
que la **clé publique**. (C'est plus sûr que faire générer la clé par le serveur et la
rapatrier dans un ticket — voir « Décisions » §7, point 1.)

---

## 2. Parcours A — Appairer un appareil (le protocole)

Ce que l'utilisateur vit, écran par écran. Objectif : **3 gestes** (nommer → coller
une commande sur le serveur → coller un code de retour).

### A.1 — « Serveurs distants », état vide

```
┌─ Flight Deck ─ Réglages › Serveurs distants ───────────────┐
│                                                            │
│   Aucun serveur distant.                                   │
│   Un serveur Flight Deck est une machine Linux toujours    │
│   allumée qui fait tourner tes conversations.              │
│                                                            │
│                 [ + Ajouter un serveur ]                   │
└────────────────────────────────────────────────────────────┘
```

### A.2 — « Ajouter un serveur » : Flight Deck prépare le geste

L'utilisateur donne le **minimum** : un **nom** et **comment on joint la machine**
(hôte + port, ou un alias `~/.ssh/config` s'il en a déjà un). Flight Deck **génère à
cet instant une paire de clés dédiée** à ce serveur (jamais réutilisée ailleurs).

```
┌─ Ajouter un serveur ───────────────────────────────────────┐
│  Nom            [ mon-vps                        ]         │
│  Adresse        [ 51.15.xx.xx                     ] : [22]  │
│  Utilisateur    [ armand              ] (défaut: root)     │
│                                                            │
│  Flight Deck a créé une clé d'accès dédiée à ce serveur.   │
│  Colle cette commande UNE FOIS sur le serveur (SSH, console│
│  du fournisseur…) — elle autorise Flight Deck et prépare   │
│  Claude :                                                  │
│                                                            │
│   ┌──────────────────────────────────────────────────┐    │
│   │ curl -fsSL https://get.flightdeck.app/pair | sh \ │    │
│   │   -s -- --key 'ssh-ed25519 AAAA…flightdeck-mon-vps'│ 📋 │
│   └──────────────────────────────────────────────────┘    │
│                                                            │
│  ⌛ En attente que le serveur se présente…                 │
└────────────────────────────────────────────────────────────┘
```

**Ce que la commande fait sur le serveur, en autonomie** (le script servi par nous) :
1. **Autorise Flight Deck** : ajoute la clé **publique** reçue en argument à
   `~/.ssh/authorized_keys` (avec un commentaire `flightdeck-mon-vps` pour pouvoir la
   révoquer d'un coup plus tard).
2. **Installe `claude`** s'il manque (`curl … claude.ai/install.sh | sh`), le met sur
   le `PATH`.
3. **Connecte Claude sur le serveur, avec SON propre compte** : lance le *device flow*
   (`claude` login / `setup-token`) → imprime une URL + un code que l'utilisateur
   ouvre dans son navigateur pour valider. C'est **le compte du serveur** qui sera
   consommé (aligné CADRAGE ; ça remplace le bricolage actuel de copie du token du
   Keychain).
4. **Se présente** : imprime un court **ticket de retour** (empreinte de la clé d'hôte
   + « prêt »), à recoller dans Flight Deck.

### A.3 — Recoller le ticket → connecté

```
┌─ Ajouter un serveur ───────────────────────────────────────┐
│  Le serveur s'est présenté. Colle son ticket :             │
│   ┌──────────────────────────────────────────────────┐    │
│   │ fdpair:mon-vps:51.15.xx.xx:22:armand:SHA256:9f…   │ 📋 │
│   └──────────────────────────────────────────────────┘    │
│                        [ Connecter ]                       │
└────────────────────────────────────────────────────────────┘
```

Flight Deck :
- **épingle l'empreinte de la clé d'hôte** du ticket (TOFU — trust on first use — sans
  le trou de sécurité `StrictHostKeyChecking no` du prototype actuel),
- se connecte en SSH avec **sa** clé dédiée,
- **vérifie** que `claude` est présent + authentifié (`ssh … claude --version` + un
  test d'auth),
- enregistre le serveur.

### A.4 — Le serveur apparaît

```
┌─ Serveurs distants ────────────────────────────────────────┐
│  ● mon-vps     armand@51.15.xx.xx:22      ✓ Claude prêt     │
│                [ Ajouter un repo ]   [ Tester ]   [ ⋯ ]     │
└────────────────────────────────────────────────────────────┘
```

> **Repli alpha sans hébergement.** Tant qu'on n'héberge pas `get.flightdeck.app`,
> l'écran A.2 montre à la place un **script auto-contenu** (Flight Deck l'écrit avec
> la clé publique dedans) — même parcours, zéro infra. On passe au `curl … | sh` servi
> par nous dès qu'on a le domaine (garde-fous CADRAGE : servi par **nous** en HTTPS,
> ticket signé/vérifiable). Voir §7, point 4.

### Ce que ça stocke (raccord au code existant)

Un serveur appairé = une entrée « machine » :
`{ label, host, port, user, identity_file (clé dédiée, chmod 600, sous les données de
l'app), host_key_fingerprint }`. Aujourd'hui le transport lit sa cible via
`repos.ssh_target` + un `ssh_config` pointé par `TOSSE_SSH_CONFIG` ; l'appairage
**produit exactement ça** (il génère l'entrée `Host` et la clé) — donc **le transport
est déjà prêt à consommer** ce que ce parcours crée. Ce qui manque = l'UI + le script
de bootstrap + le login `claude` côté serveur.

---

## 3. Parcours B — Ajouter un repo qui vit sur la machine distante

Une fois `mon-vps` appairé, on veut ouvrir une conversation dans un de ses dossiers.
Le sélecteur de dossier natif du Mac ne voit que le Mac → il faut **parcourir le
distant**. Le CADRAGE prévoit déjà ça dans l'interface de transport (`list_repos`,
`browse`).

### B.1 — « Nouvelle conversation » : choisir la machine

Aujourd'hui la sidebar propose « Nouvelle conversation dans <repo local> ». On ajoute
un **sélecteur de machine** en tête :

```
┌─ Nouvelle conversation ────────────────────────────────────┐
│  Machine :  ( Ce Mac ▾ )                                    │
│             ┌───────────────────────┐                      │
│             │ • Ce Mac              │                      │
│             │ • mon-vps    (distant)│  ←                    │
│             └───────────────────────┘                      │
└────────────────────────────────────────────────────────────┘
```

### B.2 — Sélectionner un repo sur la machine distante

Machine = `mon-vps` → au lieu du picker natif, un **navigateur distant** (peuplé en
SSH). Trois façons, de la plus transparente à la plus manuelle :

```
┌─ Ajouter un repo sur mon-vps ──────────────────────────────┐
│  ● Repos détectés  ○ Parcourir  ○ Chemin exact             │
│  ┌────────────────────────────────────────────────────┐   │
│  │ ~/code/api           (git · main)                  │   │
│  │ ~/code/site          (git · main, 3 modifs)        │   │
│  │ ~/work/demo          (git)                         │   │
│  └────────────────────────────────────────────────────┘   │
│                          [ Ouvrir une conversation ici ]   │
└────────────────────────────────────────────────────────────┘
```

- **Repos détectés** (défaut, le plus transparent) : Flight Deck lance un scan borné
  en SSH (`find ~ -maxdepth 3 -name .git` → dossiers git), comme le
  `scan_local_git_repos` local mais côté serveur, et liste avec le nom de branche.
- **Parcourir** : une arborescence peuplée à la demande en SSH (l'app a déjà
  `folder_tree`/`browse_folders` — on le route vers le distant). « Comme le picker
  local, mais sur le serveur. »
- **Chemin exact** : un champ (`/srv/app`), repli qui marche toujours.

### B.3 — C'est un repo comme un autre

Le dossier choisi devient un repo distant ; il apparaît dans la sidebar sous
`mon-vps`. **Toute** conversation qu'on y ouvre tourne sur le serveur — l'indicateur
« … » et la réponse s'affichent pareil (déjà prouvé). On peut en ouvrir plusieurs.

### Comment la sélection marche, dessous (l'explication demandée)

- Flight Deck parle au serveur par **le même canal SSH** que les conversations.
- « Détecter / Parcourir » = Flight Deck exécute une **commande bornée** sur le serveur
  (`find`, ou un listing de dossier) et rend le résultat. Rien n'est monté ; c'est de
  la lecture ponctuelle à la demande.
- Choisir un dossier = créer un `RepoRecord{ ssh_target: "mon-vps", path: "/le/chemin/
  sur/le/serveur" }`. **C'est le champ `ssh_target` que j'ai déjà ajouté.**
- Ouvrir une conversation dedans = `spawn_session` voit le `ssh_target` du repo et
  lance `claude` **sur le serveur** dans ce dossier (le transport existant). Le repo est
  identifié par le couple **(machine, chemin)** ; une conversation appartient à la
  machine où elle tourne et ne « migre » pas (CADRAGE : pas de sync bidirectionnelle).

---

---

## 3-bis. Le faire AUJOURD'HUI, à la main (avant l'UI)

Le parcours self-service ci-dessus n'est pas encore construit — mais la plomberie
(transport + `ssh_target`) l'est. Voici le protocole **manuel équivalent**, que tu
peux suivre **en autonomie** pour connecter **n'importe quelle** box et y ouvrir une
conversation, dès maintenant. C'est ce que l'UI d'appairage automatisera.

**Prérequis sur la box distante** (ce que le bootstrap fera un jour tout seul) :
- `claude` installé et sur le `PATH` (`curl -fsSL https://claude.ai/install.sh | sh`),
- un compte Claude connecté dessus. Deux options :
  - *propre* : `claude` login sur la box (son propre compte) — la cible ;
  - *raccourci démo* : réutiliser ton token du Mac (ce que fait déjà
    `open-flightdeck-remote.sh` pour le conteneur).
- `sshd` en écoute, et **ta clé publique autorisée** (`ssh-copy-id`, ou coller ta
  pubkey dans `~/.ssh/authorized_keys` de la box).

**1 — Pouvoir `ssh <alias>` vers la box.** Ajoute un bloc dans `~/.ssh/config` (ou
dans un fichier dédié que tu passeras via `TOSSE_SSH_CONFIG`) :

```sshconfig
Host ma-box
    HostName 203.0.113.10       # IP/DNS joignable depuis ce Mac
    Port 22
    User armand
    IdentityFile ~/.ssh/id_ed25519
```

Vérifie : `ssh ma-box "hostname && claude --version"` doit répondre depuis la box.

**2 — Ouvrir l'app pointée sur un repo de cette box.** Le repo distant, c'est le
couple *(alias, chemin sur la box)*. Lance le build en semant cette conversation :

```bash
TOSSE_SSH_CONFIG="$HOME/.ssh/config" \
TOSSE_SEED_REMOTE_SSH="ma-box" \
TOSSE_SEED_REMOTE_PATH="/home/armand/code/mon-projet" \
TOSSE_SEED_REMOTE_NAME="mon-projet (ma-box)" \
  "…/Flight Deck dev build.app/Contents/MacOS/tosse-code"
```

(Le lanceur `open-flightdeck-remote.sh` fait pareil mais est câblé sur le conteneur
`flightdeck-m0` / `/work/demo` ; ici tu vises la box que tu veux.)

**3 — Dans l'app** : ouvre la conversation semée → envoie un message → elle tourne
sur `ma-box` dans `/home/armand/code/mon-projet`. Chaque conversation que tu ouvres
dans ce repo est distante.

> C'est exactement ce que l'UI d'appairage rendra sans terminal : l'étape 1 = « coller
> une commande sur le serveur », l'étape 2 = « choisir un dossier de la box ». Même
> résultat, zéro ligne de commande.

---

## 4. Ce qui existe déjà vs ce que ce protocole demande de construire

| Brique | État |
|---|---|
| Transport SSH (spawn `claude` distant, stream) | ✅ fait (`feat/remote-ssh`) |
| Modèle « repo distant » `repos.ssh_target` (+ migration) | ✅ fait |
| `spawn_session` route local/distant selon le repo | ✅ fait |
| **UI « Serveurs distants » + « Ajouter un serveur »** | ⛏️ à faire |
| **Script de bootstrap** (autorise la clé + installe/logge claude + ticket) | ⛏️ à faire |
| **Login `claude` avec le compte du serveur** (device flow) | ⛏️ à faire (remplace le hack copie-token) |
| **Persistance « machine »** (host/port/user/clé/empreinte) | ⛏️ à faire (aujourd'hui : `ssh_config` + `ssh_target`) |
| **Sélecteur de machine** dans « Nouvelle conversation » | ⛏️ à faire |
| **Navigateur/scan de repos distants** (`browse`/`find` en SSH) | ⛏️ à faire |
| Vérif host-key propre (TOFU au lieu de `StrictHostKeyChecking no`) | ⛏️ à faire |

## 5. Compatibilité future (rien de jeté)

- La **commande à coller** SSH-first devient, en V3, la commande qui **installe le
  démon** ; le ticket gagne juste l'endpoint/jeton/clé-publique du démon en plus.
- La **clé SSH dédiée** reste le tunnel de repli « zéro-config réseau » (`ssh -L`).
- **`browse`/`list_repos`** en SSH aujourd'hui = les mêmes verbes que le démon exposera
  nativement demain (interface de transport identique côté UI).

## 6. Hors périmètre de CE protocole (volontairement)

- **Joignabilité réseau** (NAT, IP changeante, relais) — invariant CADRAGE n°4 :
  décidé plus tard. Ici on suppose la machine **directement joignable** (IP publique,
  LAN, ou conteneur local). À noter clairement dans l'UI (« Adresse joignable depuis ce
  Mac »).
- **Éditeur / git / terminal distants** — le 1er jet ne rend distant que la
  conversation ; ces panneaux restent locaux (voir `M0-APP-REMOTE.md`).
- **Le téléphone** vers le serveur — parcours séparé (relais), plus tard.

## 7. Décisions à trancher ensemble

1. **Sens de la clé SSH.** *Recommandé :* Flight Deck génère la paire, la commande ne
   porte que la **clé publique** (la privée ne quitte pas le Mac). Alternative « ticket
   qui rapatrie une clé privée jetable » = 1 seul copier-coller au lieu de 2, mais une
   privée voyage. → je propose **pubkey-sortante**. OK ?
2. **Auth `claude` sur le serveur.** *Recommandé :* le bootstrap logge le serveur avec
   **son propre compte** (device flow) → propre, aligné CADRAGE, tue le hack copie-
   token. À confirmer : quel plan Max vit sur le serveur ? (le tien, un dédié ?)
3. **Sélection de repo — priorité alpha.** Les 3 (détecter / parcourir / chemin) à
   terme ; pour le 1er jet, on livre lequel d'abord ? *Je proposerais* **détecter +
   chemin exact** (parcours-arbre juste après).
4. **Hébergement du script.** On part sur le **script auto-contenu collé** (zéro infra,
   testable tout de suite avec le conteneur), et on bascule sur `curl … | sh` servi par
   nous quand le domaine est prêt ? (le CADRAGE veut « servi par nous, HTTPS, ticket
   signé » — ça vient à ce moment-là).
5. **Granularité « machine ».** Une entrée = un **hôte SSH**. Suffisant, ou tu veux
   dès l'alpha viser « un conteneur précis sur un hôte » (ex. `docker exec`) ? *Je
   proposerais* hôte simple pour l'alpha.

## 8. Comment j'aimerais qu'on avance

Tu lis, tu réagis sur les 5 décisions du §7 (et tout le reste). Dès qu'on est
d'accord sur la forme, je peux :
- soit **maquetter visuellement** les écrans A.2 / B.2 (pour valider « à quoi ça
  ressemble » avant tout code),
- soit **implémenter** le plus petit bout de bout-en-bout : « Ajouter un serveur »
  (script + clé + login) → il apparaît → « Ajouter un repo » (chemin exact d'abord) →
  conversation distante — le tout en vrai, testable sur le conteneur.

Dis-moi lequel des deux tu veux en premier.
