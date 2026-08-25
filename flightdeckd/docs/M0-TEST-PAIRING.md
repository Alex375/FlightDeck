# Tester l'appairage d'un serveur distant — Mac & téléphone

Protocole de test du **plus petit bout-en-bout réel** : appairer un serveur distant
depuis Flight Deck (Mac), y ouvrir une conversation, puis faire **la même chose depuis
le téléphone** via Remote Flight Deck. Le « serveur distant » est le conteneur-mock
`flightdeck-m0` (openssh + `claude`), déjà en place.

> Code : `tosse-code` branche **`feat/remote-ssh`** (worktree isolée ; `dev` intact,
> rien poussé). Build isolé `com.tosse.desktop.dev` — **tes vraies données Flight Deck
> ne sont pas touchées**.

## 0. Lancer

```bash
cd flightdeck-server/m0-ssh-remote
./scripts/open-flightdeck-remote.sh
```

Ça : vérifie le conteneur, **rafraîchit les identifiants Claude** dedans (le token
partagé se périme — voir §4), et ouvre **Flight Deck dev build** déjà seedé avec une
conversation distante. Deux tests t'attendent.

---

## Partie 1a — Test rapide (conversation déjà branchée)

1. Ouvre la conversation **« Remote demo (flightdeck-m0) »** dans la sidebar.
2. Envoie un message : *« Lance `hostname && uname -a && pwd`. »*
3. Tu vois les **« … »** puis la réponse : `flightdeck-m0`, un noyau Linux, `/work/demo`.
   Ce `claude` tourne **dans le conteneur**, piloté en SSH.

## Partie 1b — Le vrai parcours d'appairage (ce qu'on veut valider)

Simule l'ajout d'un serveur **neuf**, en autonomie, depuis l'UI.

1. **Réglages** (⌘,) → onglet **Control** → carte **« Remote servers (SSH) »** → **`+ Add a server`**.
2. Remplis :
   - **Name** : `mock`
   - **Host or IP** : `127.0.0.1`
   - **Port** : `2222`
   - **User** : `agent`
3. Clique **`1 · Generate access key`**. Flight Deck crée une **clé dédiée à ce serveur**
   (la privée reste sur le Mac) et affiche **une commande à coller sur le serveur**.
4. **`Copy command`**, puis colle-la **sur le serveur**. Ici le serveur est le conteneur,
   donc :
   ```bash
   docker exec -i flightdeck-m0 bash -lc '<COLLE LA COMMANDE ICI>'
   ```
   (Sur un vrai serveur ce serait : `ssh toi@serveur`, puis coller la commande. La
   commande n'autorise que Flight Deck — elle ajoute sa clé publique à
   `authorized_keys`.)
5. Clique **`3 · Test & pair`**. Flight Deck se connecte en SSH avec **sa** clé, vérifie
   que `claude` est présent, et **enregistre le serveur**. Il apparaît dans la liste
   (`agent@127.0.0.1:2222`).
   - _Échec attendu si tu sautes l'étape 4_ : « Could not connect over SSH » — c'est le
     signe que la vérification est réelle.
6. Sur la ligne du serveur → **`New conversation…`** → saisis le chemin **`/work/demo`**
   → une conversation s'ouvre, branchée sur ce serveur. Envoie un message → il tourne
   dans le conteneur.

> Ce que ça prouve : le parcours « je pars d'un serveur nu, je l'appaire en 3 gestes
> depuis l'app, j'y ouvre un repo » — sans éditer un seul fichier de config SSH.

---

## Partie 2 — La même chose depuis le téléphone (Remote Flight Deck)

Architecture alpha (sans démon) : **téléphone → relais → Mac → conteneur (SSH)**. Le
téléphone pilote les conversations **du Mac** ; une conversation distante en est une
comme une autre, donc **aucun code téléphone à changer**.

1. Dans le **dev build** : Réglages → Control → **« Remote access (phone) »** → **active**.
   Il compose le relais et affiche un **QR d'appairage** (le dev build a son propre
   `mac_id`, distinct de ta prod).
2. Sur le **téléphone** : ouvre la PWA Remote Flight Deck et **appaire avec le QR du dev
   build** (scanne-le sur l'écran du Mac).
   > ⚠️ Si ton téléphone est déjà appairé à ta prod, cet appairage peut le **remplacer**
   > (la PWA garde un Mac à la fois). Tu ré-appaires ta prod après le test en re-scannant
   > son QR.
3. Sur le téléphone, la liste des conversations montre celles du dev build, dont
   **« Remote demo (flightdeck-m0) »**. Ouvre-la → **envoie un message**.
4. La réponse stream sur le téléphone. Elle a été produite par un `claude` **dans le
   conteneur**, relayée conteneur → Mac (SSH) → relais → téléphone. 🎯

> Tu peux aussi tester une conversation distante que **tu** as appairée en Partie 1b :
> elle apparaît pareil sur le téléphone.

---

## 3. Si ça marche → shipper

- Merge `feat/remote-ssh` → `dev` (puis ton flux de release habituel). C'est additif
  (migration SQLite v10 idempotente ; `NULL machine_id` = local = comportement
  inchangé), et testé (560 tests Rust + 1536 front + un test live SSH).

## 4. Note d'auth (important)

Le conteneur emprunte **ton compte Max** via le token OAuth de ton Keychain, que ton
`claude` hôte fait **tourner** → une copie se périme (« OAuth session expired »). Le
lanceur **ré-injecte un token frais** à chaque ouverture. Si un message distant échoue
sur l'auth après quelques heures, relance `./scripts/open-flightdeck-remote.sh` (ou
ré-injecte via `scripts/inject-secrets.sh`). Le fix robuste = le serveur a **son propre**
login Claude (`claude` sur le serveur) — c'est d'ailleurs ce que l'étape d'appairage
demande pour un vrai serveur ; pour le mock on prend le raccourci.

## 5. Périmètre de ce jet (rappel)

Distant : **la conversation** (spawn, envoi, « … », réponse, permissions) — Mac ET
téléphone. Restent locaux (1er jet) : éditeur / git / terminal, et le rejeu
d'historique d'une conv distante (transcript sur le serveur). Cf. `M0-APP-REMOTE.md`.
