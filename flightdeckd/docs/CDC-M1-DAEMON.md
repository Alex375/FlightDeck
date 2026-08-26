# Cahier des charges — M1 : `flightdeckd`, le démon serveur

> Suite de l'alpha SSH (Mac↔serveur, cf. `M0-APP-REMOTE.md`). M1 = **le serveur
> possède ses sessions ET devient un nœud du relais**. À valider avant de démarrer.

## 1. Pourquoi (les deux besoins qui convergent)

Un **agent qui tourne SUR le serveur** est nécessaire pour **deux** usages qui, en
alpha SSH, ne marchent pas :

1. **Sessions détachées** — la session `claude` survit à une coupure/déconnexion du
   client (cas train : réseau intermittent). Aujourd'hui `claude` est lié au canal SSH
   → le Mac coupe, `claude` meurt. Il faut un process **sur le serveur** qui possède la
   session indépendamment de tout client.
2. **Téléphone en direct** — le téléphone atteint le serveur **sans passer par le Mac**
   (Mac éteint). Il faut que **le serveur soit présent sur le relais**.

Les deux = **le même agent serveur**. C'est la première pierre de `flightdeckd`
(CADRAGE : *« le core de tosse-code sans Tauri, embarquant le client relais »*).

## 2. Principe

```
   Téléphone (PWA)                    Mac (Flight Deck) = console d'admin
        │                                   │  (installe/appaire en SSH,
        │  WS (relais)                      │   pilote aussi le serveur)
        ▼                                   ▼
   ┌──────────────── Relais (Railway, EXISTANT) ────────────────┐
   │            route  phone ⇄ /mac  par macId                  │
   └───────────────────────────┬───────────────────────────────┘
                               │ WS sortant (le serveur se présente comme un /mac)
                               ▼
              Serveur distant :  flightdeckd  ──►  claude (sessions détachées)
                                 (compte Claude PROPRE au serveur)
```

- Le **démon** compose le relais **en sortant** (pas de port ouvert, marche derrière
  NAT) et répond aux RPC du téléphone en pilotant `claude` **en local**.
- Le **Mac** ne sert qu'à **installer/appairer** (SSH) et, optionnellement, à piloter
  le serveur comme client (via le relais aussi). **Le Mac n'est jamais dans le chemin
  de données téléphone→serveur.**
- Le **relais Railway est réutilisé** quasi tel quel.

## 3. Périmètre M1

**Dans le périmètre :**
- Le démon **possède des sessions `claude` détachées** (spawn, survie aux
  déconnexions, buffer + rejeu du stream à la reconnexion).
- Le démon parle le **protocole relais** comme un `/mac` (dial, autorise des phones,
  répond aux RPC conversation : `list/read/send/create/interrupt/stop` + events).
- **Bootstrap SSH** : « Ajouter un serveur » (déjà bâti) installe le démon, le
  configure (identité relais, vérifie le login Claude) et le démarre en service.
- **Compte Claude propre au serveur** (`claude` loggé sur le serveur) — fin du hack
  copie-token.

**Hors périmètre M1 (plus tard) :**
- Éditeur / git / terminal distants (SFTP, PTY SSH).
- GUI/Playwright (Xvfb), Codex.
- Onboarding « une commande `curl` servie par nous en HTTPS » (garde-fous CADRAGE) —
  M1 installe via le SSH déjà en place.
- Multi-utilisateur, chiffrement de bout en bout au-delà de ce que fait déjà le relais.

## 4. Le démon — responsabilités

- **Superviseur de sessions** : une session = un process `claude` en mode stream-json
  persistant, **détaché de tout client** ; le démon tient ses pipes, bufferise les
  events, et **rejoue depuis le dernier vu** à la reconnexion. (C'est ce que fait déjà
  le supervisor de tosse-code en local → à réutiliser/extraire.)
- **Client relais** : connexion WS sortante vers le relais avec l'identité du serveur
  (`macId`/`macToken` propres), autorise les `phoneToken`, reconnexion auto.
- **RPC conversation** : `list_conversations`, `read_conversation`, `send_message`,
  `create_conversation`, `interrupt`, `stop` + push d'events (`turn_completed`,
  `needs_attention`…), en pilotant `claude` local + lecture des transcripts `~/.claude`
  du serveur.
- **Persistance** : registre des conversations (SQLite, comme tosse-code) + transcripts
  `claude` sur le disque du serveur (source des messages).
- **Cycle de vie** : service **systemd** (démarre au boot, redémarre au crash).

## 5. Auth & sécurité

- **Claude** : compte **du serveur** (`~/.claude` local, loggé via `claude`).
- **Relais** : le démon a **son propre** `macId`/`macToken` (provisionnés par le Mac,
  stockés sur le serveur). Les `phoneToken` autorisés sont poussés par le Mac.
- **Deux niveaux de confiance conservés** : Mac = plein accès ; téléphone = liste
  d'actions « phone-safe » (comme aujourd'hui côté relais).
- **SSH** : la clé dédiée déjà bâtie sert à l'install/admin ; aucun secret SSH stocké
  sur le serveur au-delà de `authorized_keys`.

## 6. Les deux parcours d'appairage (tes journeys)

- **A — le QR donne accès à tous les serveurs liés** : appairer le téléphone (QR du
  Mac) l'autorise sur le Mac **et** sur **tous** les démons de ce Mac. Le téléphone
  découvre la liste de ses nœuds et affiche un sélecteur « Mon Mac / Serveur X ».
- **B — ajouter un serveur pousse l'accès au téléphone** : quand tu ajoutes un serveur
  depuis le Mac, le Mac installe le démon **et** pousse l'accès du téléphone via le
  relais → le nouveau serveur apparaît tout seul dans la PWA.

Les deux impliquent que **le téléphone puisse découvrir l'ensemble de ses nœuds
autorisés** → petite addition côté relais (voir §8, décision 5).

## 7. Découpage proposé (jalons)

- **M1.0 — Preuve** : agent minimal **dans le conteneur** qui possède **une** session
  `claude` persistante + répond au téléphone **en direct** via le relais. On prouve
  *détachement* (coupe le lien → la session vit → reconnexion OK) **et** *phone-direct*
  (Mac éteint), d'abord headless (mock-phone), puis ton vrai téléphone.
- **M1.1 — Le vrai démon** : service systemd, registre SQLite, RPC complets, rejou du
  stream, reconnexion relais robuste.
- **M1.2 — Orchestration Mac** : « Ajouter un serveur » installe le démon en SSH +
  provisionne son identité relais + pousse l'accès téléphone (journeys A & B).
- **M1.3 — PWA multi-cible** : sélecteur « Mon Mac / Serveur X » + découverte des
  nœuds.

## 8. Décisions à trancher (avec ma reco)

1. **Langage du démon** — *reco* : **prototyper M1.0 en Node** (réutilise le
   `mock-mac.mjs` du relais → preuve rapide), **cible M1.1 en Rust** en extrayant le
   supervisor de tosse-code (le vrai `flightdeckd`, zéro logique dupliquée à terme).
   *Alternative* : Rust direct (pas de proto jetable, mais preuve plus lente).
2. **Détachement / rejeu** — *reco* : le démon tient les pipes de `claude`, bufferise
   les events par session, rejoue depuis un curseur « dernier event vu » à la
   reconnexion. Réutiliser le modèle du supervisor tosse-code.
3. **Persistance** — *reco* : SQLite (registre convs) + transcripts `~/.claude` du
   serveur comme source des messages. Cohérent avec tosse-code.
4. **Service** — *reco* : **systemd** (Linux serveur).
5. **Additions relais** — *reco* : garder les RPC actuels (suffisent) ; **ajouter une
   seule chose** : « un téléphone découvre l'ensemble de ses nœuds autorisés »
   (multi-pairing), nécessaire aux journeys A/B et au sélecteur PWA.
6. **PWA multi-cible** — *reco* : minimal (un sélecteur + 1 serveur d'abord) pour M1.
7. **Alpha SSH** — *reco* : **merger `feat/remote-ssh` → `dev`** au passage (jalon
   propre, cas « Mac en ligne » + bootstrap du démon), documenté honnêtement (ne
   survit pas aux coupures, pas de phone-direct — c'est justement ce que M1 apporte).

## 9. Critères d'acceptation M1

- [ ] **Mac éteint**, le téléphone **liste et pilote** les conversations d'un serveur
      **en direct** (via le relais).
- [ ] Une session **survit** à une coupure réseau du client et est **retrouvée vivante**
      à la reconnexion (rejeu du stream).
- [ ] **Ajouter un serveur** depuis le Mac **installe le démon** et **donne accès au
      téléphone** (journeys A & B).
- [ ] Le serveur utilise **son propre compte Claude**.
- [ ] Le démon **redémarre au boot** et **se reconnecte** seul au relais.

## 10. Réutilisation (rien de jeté)

- **Relais Railway** : réutilisé (une petite addition, §8.5).
- **Transport SSH** (déjà bâti) : devient **l'installeur/bootstrap** du démon + tunnel
  de secours « zéro-config réseau ».
- **Supervisor tosse-code** : extrait/embarqué dans le démon (le core sans Tauri).
- **PWA + protocole relais** : réutilisés ; ajout du multi-cible.
