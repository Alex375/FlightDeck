# M1 — `flightdeckd` : sessions détachées + téléphone en direct

> Livré le 26/08/2026. Répond aux deux critères d'acceptation du
> [cahier des charges](CDC-M1-DAEMON.md) §9. Le code du démon vit dans
> [`flightdeckd/`](../flightdeckd/), l'image conteneur dans
> [`m1-daemon/`](../m1-daemon/), les changements app sur la branche
> tosse-code `feat/daemon-attach`.

## Ce qui change par rapport à l'alpha SSH (M0)

Avant : le Mac lançait `claude` **dans le canal SSH** — coupure ⇒ session morte,
et le téléphone passait par le Mac. Maintenant :

```
   Téléphone (PWA) ──WS──► Relais Railway ◄──WS── flightdeckd (serveur)
                                                      │ possède les sessions
   Mac (Flight Deck) ──ssh: flightdeckd attach──────► │ claude (détaché)
```

- **`flightdeckd` possède `claude`** (process persistant, mode stream-json,
  mêmes args que le superviseur tosse-code). Les clients vont et viennent.
- **Chemin Mac** : le transport SSH exécute `flightdeckd attach --cwd … --cursor N
  -- <argv claude>`. Le démon rejoue tout ce que le client a manqué depuis son
  curseur (ring 64 Mo par session, frames `fd_attach`/`fd_detach`). Sur coupure,
  **l'acteur de session se reconnecte tout seul** (backoff 1 s → 30 s) et
  continue le même flux — notices « Connection lost / Reconnected » dans la
  conversation. Quitter l'app **détache** (la session vit) ; le bouton Stop
  envoie `fd_stop` (arrêt réel côté serveur).
- **Chemin téléphone** : le démon se présente au relais comme un nœud (macId
  propre ; à chaque connexion : re-révocation des tombstones, autorisation des
  téléphones, puis `set_label` = son label ; un téléphone ajouté/retiré à chaud
  part sur la connexion en cours), répond aux RPC du PWA (list/read/send/create/interrupt/stop/pending/
  answer/browse) et pousse `turn_completed`/`needs_attention` (⇒ Web Push). Le
  PWA étant en *pull*, une coupure téléphone se résorbe à la reconnexion.
- **Visibilité croisée** : une conversation ouverte du Mac est visible/pilotable
  du téléphone et réciproquement (`--replay-user-messages` ⇒ chaque client voit
  les tours envoyés par l'autre).

## Preuves (toutes automatisées, toutes passées le 26/08)

| Preuve | Où |
|---|---|
| Coupure ssh en plein tour → tour terminé sans client → réattache au curseur exact | `m1-daemon/tests/detach_test.py` |
| Idem au niveau de l'ACTEUR de l'app (reconnexion auto + rejeu) | tosse-code `actor_survives_ssh_cut_and_replays` (`#[ignore]`, live) |
| Transport app : handshake, tour, détache/réattache sans doublon ni trou | tosse-code `remote_transport_streams_over_ssh` (`#[ignore]`, live) |
| Téléphone crée une conversation via le relais prod, coupure immédiate, tour fini seul, reconnexion → historique complet — **Mac éteint** | `m1-daemon/tests/phone-cut-test.mjs` |
| 11 tests unitaires démon + 562 Rust app + 1536 front + tsc | `cargo test` (les deux repos), `vitest` |

## Démarrer / tester

```bash
# le conteneur M1 (sshd + flightdeckd), clés + creds injectés, lien pairing affiché
m1-daemon/scripts/up.sh                    # flightdeck-m1, ssh sur 127.0.0.1:2224

# critère Mac (headless, ssh réel)
python3 m1-daemon/tests/detach_test.py

# critère téléphone (relais de prod, Mac non impliqué)
MAC_ID=<macId du conteneur> PHONE_TOKEN=<pt> node m1-daemon/tests/phone-cut-test.mjs
# (macId/pt : docker exec -u agent flightdeck-m1 flightdeckd pairing)
```

Côté app : builder tosse-code branche `feat/daemon-attach`
(`npx tauri build --config src-tauri/dev-build.conf.json`) et ouvrir une
conversation sur un serveur apparié. Les trois conteneurs (`flightdeck-m0` :2222,
`flightdeck-test` :2223, `flightdeck-m1` :2224) tournent sur l'image M1 — les
appariements existants continuent de marcher.

**Test réel du téléphone** : ouvrir le lien pairing du conteneur (fragment
`#macId=…&pt=…`) sur le téléphone → le PWA se rattache à CE serveur (nota : le
PWA ne gère qu'un appairage à la fois pour l'instant — multi-cible = M1.3).
Éteindre le Mac : la conversation continue de répondre.

## Le démon en bref

```
flightdeckd init      # config ~/.flightdeckd/config.json + identité relais + lien pairing
flightdeckd run       # le démon (socket d'attache + client relais)
flightdeckd attach …  # pont stdio → session (ce que le Mac exécute via ssh)
flightdeckd status    # snapshot JSON des sessions
flightdeckd stop --conversation <id>   # arrêt d'une session (le Stop du Mac hors-ligne)
flightdeckd pairing   # réaffiche le lien pairing téléphone
flightdeckd add-phone --token <pt|-> [--label L]   # autorise un téléphone (config + relais, à chaud)
flightdeckd remove-phone --token <pt|->            # le révoque (idem) ; `-` = lu sur stdin
flightdeckd whoami    # {mac_id, relay_url, label} depuis la config (sans démon, sans secret)
```

`flightdeckd attach --title "…"` : le titre du client fait foi (écrase celui
du registre ; vide = ignoré). `fd_status` porte la `version` du démon qui tourne.

Le code a passé une **revue adversariale multi-agents** (31 agents, 23 findings
confirmés puis corrigés : sérialisation des spawns, écrivain stdin non bloquant,
timeouts de bout en bout, conformité des events au contrat PWA, backoff/deadline
relais, resynchronisation busy/permissions à la réattache, keepalives ssh…).

- **Config `~/.flightdeckd/config.json` : verrou inter-processus.** Plusieurs
  processus l'écrivent (le démon quand on ajoute/retire un téléphone,
  `flightdeckd init`, l'installeur du Mac via SSH). Tout écrivain prend un
  `flock(2)` exclusif sur `~/.flightdeckd/config.json.lock` pendant toute sa
  lecture-modification-écriture ; le fichier est remplacé atomiquement
  (tmp + rename, mode 0600), donc les lecteurs n'ont pas besoin du verrou.
  La CLI `flightdeckd` (dont `init`) le prend elle-même : l'installeur qui
  l'appelle n'a rien d'autre à faire. Qui écrit le fichier **directement**
  doit prendre le même verrou : `flock ~/.flightdeckd/config.json.lock -c '…'`.
  Les téléphones retirés restent en « tombstones » (`revoked_phone_tokens`,
  16 max) re-révoquées à chaque connexion au relais, qui, lui, persiste les
  autorisations. Au plus **32 téléphones autorisés** (`add-phone` au-delà :
  `ok:false`, « too many authorized phones (max 32) — remove one first »).
  La rafale de connexion est **cadencée** (lots de ≤ 20 frames, 1 s d'écart,
  `set_label` en dernier) : le relais jette en silence au-delà de 60 frames
  (recharge 30/s). Un ajout/retrait à chaud part tout de suite sur la liaison
  en cours, sans accusé ni nouvelle tentative : s'il ne peut pas partir
  (relais hors ligne, liaison en train de tomber), c'est journalisé et la
  rafale de la prochaine connexion rejoue l'état complet.
- Registre SQLite `~/.flightdeckd/registry.sqlite` (conversations) ; messages lus
  depuis les transcripts `~/.claude/projects` du serveur.
- `permission_mode` par défaut : `bypassPermissions` pour les sessions créées
  côté serveur/téléphone (pas d'UI de permission sur le serveur) ; les sessions
  lancées du Mac gardent le mode demandé par l'app (les prompts `can_use_tool`
  en attente sont ré-émis à chaque attache, et exposés au téléphone via
  `get_pending_request`/`answer_request`).
- Contrat curseur : une ligne compte si elle parse en JSON avec un `type` hors
  plan de contrôle (`control_*`, `keep_alive`) et hors `fd_*` — même prédicat
  des deux côtés (`flightdeckd/src/frames.rs` ↔ tosse-code `transport.rs`).

## Compaction du rejeu : `fd_skip` (contrat, démon ≥ 0.2.0)

Avec `--include-partial-messages`, chaque message assistant arrive **deux
fois** dans le ring : en deltas `stream_event` (message_start →
content_block_* → message_delta → message_stop) puis en lignes `assistant`
complètes (une par bloc, même `message.id`). Un client qui l'annonce peut
recevoir un rejeu sans les deltas des messages déjà complets.

- **Opt-in uniquement** : `flightdeckd attach --supports-skip` (ou
  `"supports_skip": true` dans la requête d'attache sur le socket). Sans le
  flag, rejeu intégral, **octet pour octet** identique à avant ; `fd_attach`
  inchangé. Le flag CLI n'existe pas avant 0.2.0 (clap le refuse) : le client
  doit d'abord vérifier `flightdeckd --version` ≥ 0.2.0.
- Avec le flag, `fd_attach` porte `"skip": true`, et le rejeu remplace chaque
  suite de lignes sautées par **`{"type":"fd_skip","from":F,"to":T}`** :
  les lignes rejouables de seq `F..=T` (inclusif) sont omises. À réception, le
  curseur du client vaut `F - 1` (sinon erreur de protocole) et il passe à `T`.
  `fd_skip` est une frame `fd_*` : jamais comptée elle-même (le prédicat
  `is_replayable_line` ne change pas). En fin de rejeu, le curseur du client
  est le même qu'avec un rejeu intégral (`fd_attach.seq`).
- **Ce qui est sauté** : uniquement les `stream_event` d'un message **complet
  dans le ring** = son `message_stop` ET au moins une ligne `assistant` avec
  son `message.id` y sont (le ring entier compte : un message fini avant le
  curseur fait sauter ses derniers deltas situés après). Toujours rejoués : les
  deltas d'un message en cours (pas de `message_stop`), interrompu, dont le
  `message_start` est sorti du ring, ou illisibles ; tout ce qui n'est pas un
  `stream_event`. Les flux entrelacés (sous-agents) sont suivis par
  `parent_tool_use_id`.
- Seul le **rejeu** est compacté ; le flux en direct qui suit est inchangé.
- Mesuré sur un vrai tour (texte + un appel d'outil + résumé) : 41 lignes /
  17,3 Ko en rejeu intégral → 18 lignes dont 5 `fd_skip` / 8,9 Ko.

## Limites connues (M1.1+)

- **Démon redémarré = sessions perdues** (les pipes meurent avec lui). Le
  registre survit : la conversation repart via `--resume` au prochain message.
  `systemctl stop/restart` (SIGTERM) est traité comme SIGINT : chaque session
  passe par son échelle d'arrêt (EOF stdin → SIGTERM du groupe → SIGKILL,
  ~4 s au pire, borné à 10 s en tout), chaque client attaché reçoit
  `fd_detach{exited}`, le socket est retiré, sortie 0. Unité systemd :
  garder le `KillMode` par défaut (**pas** `KillMode=process`, qui laisserait
  des `claude` orphelins aux pipes morts) et mettre **`TimeoutStopSec=20`**
  (au-dessus des 10 s de l'arrêt gracieux).
- Auth Claude du conteneur = copie du token du Mac (rotation ⇒ relancer
  `up.sh`). Un vrai serveur fera son propre `claude` login (M1.2).
- Provisioning (installer le démon depuis « Ajouter un serveur », pousser
  l'accès téléphone — journeys A/B) = M1.2 ; PWA multi-serveurs = M1.3.
- `list_models`/effort pickers : non exposés par le démon (le PWA les masque).
