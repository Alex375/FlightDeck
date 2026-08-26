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
  propre), répond aux RPC du PWA (list/read/send/create/interrupt/stop/pending/
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
```

Le code a passé une **revue adversariale multi-agents** (31 agents, 23 findings
confirmés puis corrigés : sérialisation des spawns, écrivain stdin non bloquant,
timeouts de bout en bout, conformité des events au contrat PWA, backoff/deadline
relais, resynchronisation busy/permissions à la réattache, keepalives ssh…).

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

## Limites connues (M1.1+)

- **Démon redémarré = sessions perdues** (les pipes meurent avec lui). Le
  registre survit : la conversation repart via `--resume` au prochain message.
  systemd + unit fournie plus tard (conteneur : entrypoint).
- Auth Claude du conteneur = copie du token du Mac (rotation ⇒ relancer
  `up.sh`). Un vrai serveur fera son propre `claude` login (M1.2).
- Provisioning (installer le démon depuis « Ajouter un serveur », pousser
  l'accès téléphone — journeys A/B) = M1.2 ; PWA multi-serveurs = M1.3.
- `list_models`/effort pickers : non exposés par le démon (le PWA les masque).
