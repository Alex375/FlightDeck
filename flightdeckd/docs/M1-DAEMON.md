# M1 — `flightdeckd` : sessions détachées + téléphone en direct

> Livré le 26/08/2026. Répond aux deux critères d'acceptation du
> [cahier des charges](CDC-M1-DAEMON.md) §9. Le code du démon vit dans
> [`../src/`](../src/), l'image conteneur dans
> [`../live/m1/`](../live/m1/), les changements app sur la branche
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
| Coupure ssh en plein tour → tour terminé sans client → réattache au curseur exact | `live/m1/tests/detach_test.py` |
| Idem au niveau de l'ACTEUR de l'app (reconnexion auto + rejeu) | tosse-code `actor_survives_ssh_cut_and_replays` (`#[ignore]`, live) |
| Transport app : handshake, tour, détache/réattache sans doublon ni trou | tosse-code `remote_transport_streams_over_ssh` (`#[ignore]`, live) |
| Téléphone crée une conversation via le relais prod, coupure immédiate, tour fini seul, reconnexion → historique complet — **Mac éteint** | `live/m1/tests/phone-cut-test.mjs` |
| 11 tests unitaires démon + 562 Rust app + 1536 front + tsc | `cargo test` (les deux repos), `vitest` |

## Démarrer / tester

```bash
# le conteneur M1 (sshd + claude + flightdeckd), clés + creds injectés, lien pairing affiché ;
# construit le binaire musl statique depuis les sources courantes (build-musl.sh)
# et garde les clés d'hôte SSH du conteneur précédent
flightdeckd/live/m1/scripts/up.sh          # flightdeck-m1, ssh sur 127.0.0.1:2224

# critère Mac (headless, ssh réel)
python3 flightdeckd/live/m1/tests/detach_test.py

# critère téléphone (relais de prod, Mac non impliqué)
MAC_ID=<macId du conteneur> PHONE_TOKEN=<pt> node flightdeckd/live/m1/tests/phone-cut-test.mjs
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
                      # --no-phone-token : aucun token téléphone, aucun lien ; imprime
                      # l'identité (JSON de whoami) — l'installeur du Mac autorise le sien (add-phone)
flightdeckd run       # le démon (socket d'attache + client relais)
flightdeckd attach …  # pont stdio → session (ce que le Mac exécute via ssh)
flightdeckd status    # snapshot JSON des sessions
flightdeckd stop --conversation <id>   # arrêt d'une session (le Stop du Mac hors-ligne)
flightdeckd pairing   # réaffiche le lien pairing téléphone
flightdeckd add-phone --token <pt|-> [--label L]   # autorise un téléphone (config + relais, à chaud)
flightdeckd remove-phone --token <pt|->            # le révoque (idem) ; `-` = lu sur stdin
flightdeckd remove-phone --init-minted --keep -    # révoque le token qu'un `init` simple a créé
                      # (jamais celui lu sur stdin) ; imprime {"type":"fd_init_phone_removed","ok":true,"removed":0|1}
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
  Les téléphones retirés restent en « tombstones » (`revoked_phone_tokens`)
  re-révoquées à chaque connexion au relais, qui, lui, persiste les
  autorisations. Le relais n'acquitte pas un `revoke_phone` : chaque lot de
  révocations est suivi d'un ping WebSocket numéroté, dont le pong (le relais
  traite les frames d'une socket dans l'ordre) prouve qu'elles ont été
  traitées → `delivered_phone_revocations`. Une révocation non confirmée
  n'est **jamais** évincée et part en tête de la rafale suivante ; au-delà de
  128 tombstones, seules les plus anciennes confirmées sont évincées ; les
  confirmées restantes sont ré-affirmées après les autorisations. Au plus
  **32 téléphones autorisés** (`add-phone` au-delà : `ok:false`,
  « too many authorized phones (max 32) — remove one first »).
- **Token orphelin d'`init` (≥ 0.3.0).** Un `init` simple crée un token
  téléphone (label `phone`) et imprime son lien ; l'installeur du Mac l'ignore
  et autorise le sien (`add-phone --label <nom du Mac>`) — sur les serveurs
  installés avant `--no-phone-token`, ce token reste donc autorisé sans que
  personne ne le voie. `remove-phone --init-minted --keep -` (le token de
  l'appelant sur stdin, jamais en argv) le révoque via le démon qui tourne :
  même chemin qu'un `remove-phone` (verrou de config, tombstone, révocation à
  chaud + ping de confirmation). Depuis 0.3.0, `init` **trace la provenance**
  (`init_phone_tracked: true` dans la config, `init_minted: true` sur le token
  qu'il crée) : le token visé est alors celui marqué, où qu'il soit — aucun
  après `init --no-phone-token`, même si un Mac nommé `phone` est en tête — et
  un `add-phone` de ce token le rend à son auteur (marque effacée). Sur une
  config écrite par un binaire plus ancien (sans ces champs), règle héritée :
  le **premier** token autorisé **et** encore labellisé exactement `phone` —
  `init` écrivait un seul token, en tête d'une config neuve, et la liste ne fait
  ensuite qu'ajouter en queue (`add-phone`) ou retirer en gardant l'ordre ; un
  token ajouté plus tard par `add-phone`, même labellisé `phone`, n'est donc
  pas visé tant que celui d'`init` est là, ni un token relabellisé. Le premier
  appel accepté **fixe la provenance** (`init_phone_tracked: true`, le token
  `--keep` adopté) : la règle héritée ne sert qu'une fois par config — sur un
  serveur partagé par deux Macs, le nettoyage du second ne prend jamais pour
  celui d'`init` le token d'un Mac nommé `phone` passé en tête. Seul cas non
  distinguable : le token d'`init` retiré à la main **avant** ce premier appel,
  et un Mac nommé `phone` en tête depuis. Le token `--keep` doit être autorisé
  (sinon `ok:false`) et n'est jamais retiré. Idempotent (un 2ᵉ appel retire 0).
  Un binaire < 0.3.0 ignore ces champs à la lecture et les perd s'il réécrit la
  config (retour à la règle héritée). Conséquence assumée : un
  téléphone appairé à la main avec le lien d'`init` perd l'accès. Un démon
  < 0.3.0 refuse l'option (clap, code 2 : `error: unexpected argument
  '--init-minted' found`) ; un démon qui tourne encore sur l'ancien binaire
  répond `fd_detach` sur la socket (la CLI le dit : redémarrer le démon).
  La rafale de connexion est **cadencée** (lots de ≤ 20 frames, 1 s d'écart,
  `set_label` en dernier) : le relais jette en silence au-delà de 60 frames
  (recharge 30/s). Un ajout/retrait à chaud part tout de suite sur la liaison
  en cours, sans nouvelle tentative (un retrait est suivi de son ping de
  confirmation, ci-dessus) : s'il ne peut pas partir
  (relais hors ligne, liaison en train de tomber), c'est journalisé et la
  rafale de la prochaine connexion rejoue l'état complet.
- Liaison relais : le `macToken` part dans l'en-tête `Authorization: Bearer`
  de l'upgrade (`/mac?macId=…` seul en query — une query finit dans les logs
  du proxy/edge) ; messages entrants plafonnés à 1 Mio (le relais coupe à
  256 Ko). `run` ne journalise jamais le lien pairing ni un token (macId et
  nombre de téléphones autorisés seulement) — `flightdeckd pairing` le donne.
- Registre SQLite `~/.flightdeckd/registry.sqlite` (conversations) ; messages lus
  depuis les transcripts `~/.claude/projects` du serveur.
- `permission_mode` par défaut : `auto` (le mode « Auto » du composer : le
  classifieur de sécurité de claude décide lui-même ce qui passe sans prompt)
  pour les sessions que le démon lance lui-même (création depuis le
  téléphone, relance à froid par un message du téléphone). C'est ce qu'écrit
  `init` et ce que prend une config sans le champ ; un `default`,
  `acceptEdits` ou `plan` explicite est respecté. Les prompts `can_use_tool`
  que claude lève encore sont ré-émis à chaque attache et exposés au
  téléphone via `get_pending_request`/`answer_request`. Le démon ne
  déverrouille JAMAIS le bypass pour ses propres sessions : un
  `bypassPermissions` dans la config (ce qu'écrivait un ancien `init`) tourne
  en `auto` (avertissement au démarrage). ⚠️ claude 2.1.293 lancé avec
  `--permission-mode bypassPermissions` tourne VRAIMENT en bypass, même sans
  `--allow-dangerously-skip-permissions` (`initialize` répond
  `current_permission_mode: "bypassPermissions"`). ⚠️ `auto` est une
  DEMANDE, pas une garantie (vérifié 2.1.293) : sur un modèle sans auto mode
  (`models[].supportsAutoMode` absent dans l'`initialize`), `initialize` et le
  `system/init` du 1er tour disent encore `auto`, puis claude retombe en
  `default` pendant ce tour et l'annonce par une ligne `system/status`
  (`permissionMode: "default"`) ; un `set_permission_mode auto` y est refusé
  (« Cannot set permission mode to auto: auto mode unavailable for this
  model »). Le démon relaie ces lignes telles quelles : le Mac attaché affiche
  le mode que claude rapporte, jamais celui de la config. Les sessions
  lancées du Mac gardent l'argv envoyé après `attach --` (mode demandé par
  l'app, et le flag de déverrouillage seulement si l'option « bypass » de
  l'app est activée) ; `fd_attach.bypass_available` dit si le process attaché
  peut passer en bypass.
- `answer_request` (téléphone) : même règle que le Mac (`answerRequest`,
  `src/agent/appControl.ts`). Une approbation de permission d'outil ou de plan
  (`ExitPlanMode`) exécute l'input ORIGINAL, tel qu'affiché ; un
  `updated_input` envoyé avec elle est écarté et le résultat le dit
  (`updated_input_ignored: "a remote approval runs the tool's original
  input"`). Seules les réponses à une question (`AskUserQuestion`) — et à une
  élicitation MCP (`McpElicitation`, que le démon ne remonte pas encore) —
  gardent leur `updated_input`, qui est la réponse elle-même.
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
- Coût : chaque ligne `stream_event`/`assistant` est analysée une seconde fois
  à son entrée dans le ring (pour son étiquette de rejeu), en plus de la sonde
  de routage. Assumé tant qu'aucun profil ne montre que ça compte ; sinon,
  extraire les champs (`parent_tool_use_id`, `event.type`, `message.id`) de la
  même analyse que `frames::probe` (revue du 18/09, constat #1).
- Mesuré sur un vrai tour (texte + un appel d'outil + résumé) : 41 lignes /
  17,3 Ko en rejeu intégral → 18 lignes dont 5 `fd_skip` / 8,9 Ko.

## Stream fidelity (contract, daemon ≥ 0.3.0)

Everything below is ADDITIVE on the wire: an older client ignores the new
fields, and an older daemon omits them. A client gates on `fd_attach.caps`
— what the RUNNING daemon supports — never on `flightdeckd --version`, which
reports the binary on disk (the two differ after an upgrade that has not
restarted the daemon). `fd_attach` also carries the running `version`.

| cap | behavior |
|---|---|
| `busy-from-output` | `fd_attach.busy`, `status` rows and the phone's status also reflect turns claude starts ON ITS OWN (a task-notification wake, a message queued mid-turn, `/loop` / `/goal` continuations): busy on a ROOT `stream_event` `message_start`, a root `assistant` line, or a `system/init` after a `result`; idle on `result`. A background sub-agent's stream (non-null `parent_tool_use_id`) is not a turn. |
| `pending-dialogs` | EVERY inbound `control_request` (`can_use_tool`, MCP `elicitation`, `request_user_dialog`, `mcp_message`, `hook_callback`…) is tracked until the client's `control_response` or claude's `control_cancel_request`, listed in `fd_attach.pending` and re-sent after the replay, in arrival order. An error answer to a `request_user_dialog` keeps it pending (claude discards it). |
| `phone-cancel` | When the phone answers a permission prompt, the attached client receives `{"type":"control_cancel_request","request_id":…,"fd_resolved_by":"phone"}` — control plane, never ringed. |
| `stderr-tail` | `fd_detach{reason:"exited"}` carries `stderr_tail: string[]` (claude's last ≤ 80 stderr lines, oldest first, each ≤ 2000 chars; possibly empty). |
| `launch-enrich` | A `system/task_started` of a `local_agent` whose `tool_use_id` is not its launching `Agent` call (a `SendMessage` wake, possibly in a later claude process) gains `fd_launch_tool_use_id`, read from memory or from `subagents/**/agent-<task_id>.meta.json` (`toolUseId`) under the server's claude config dir. The field is added BEFORE the line enters the ring, so a replay carries it too and the cursor contract is unchanged. |
| `delivered-uuids` | `fd_attach.delivered: string[]` lists the `uuid` of the last ≤ 64 client `user` lines handed to THIS claude process (oldest first; a new process starts empty). An unechoed message a client wrote on a link that died, missing from it, never reached claude — whatever `busy` says (with `busy-from-output`, a turn claude started on its own reads busy and would hide such a loss). |

Daemon-side behavior that needs no client change:

- **Spawns the daemon makes itself** (the lazy respawn before a phone send,
  phone `create_conversation`):
  - a conversation's own argv is recorded in the registry on every client
    attach (session flags stripped), and so are the controls its claude
    CONFIRMS later (`live_controls`: the `permissionMode` of `system/init` /
    `system/status`, claude's success ack of a client's
    `set_permission_mode` / `set_model` / effort `apply_flag_settings`) — a
    mid-session switch never reaches the argv. A respawn runs on that argv
    with the confirmed controls laid over it. A client cold-starting a new
    process from its own argv clears them (its argv is then the newer intent);
  - a conversation with no argv of its own (phone-created, never attached)
    gets the fixed prefix, the configured `permission_mode`, and only the
    `--model` / `--effort` of the latest argv recorded in its repo, else
    anywhere — never a sibling's permission mode, tool lists or extra dirs;
  - never a bypass: `--allow-dangerously-skip-permissions` /
    `--dangerously-skip-permissions` are dropped and `bypassPermissions`
    is spawned as `default` (what claude itself falls back to without the
    unlock). The bypass needs the Mac's app-wide opt-in, which the daemon
    cannot see while no Mac is attached, and turning it off must hold for a
    process that was not running at the time. An attaching Mac reads the real
    mode from claude's `system/init`, and claude's answer to its
    `set_permission_mode` tells it when a bypass cannot be granted here.
  - The daemon sends `initialize{perTaskStopAffordance:true}` (`fdd-*` id,
    answer swallowed) BEFORE any user line to every process no client will
    initialize: its own spawns, and a cold respawn for a client that
    reattaches WITH an epoch (an actor that initialized a process now gone —
    an older Mac never re-initializes; a newer one does on the epoch change,
    which takes claude's harmless re-init branch). Only the first
    `initialize` a claude process receives sets that option, so without it
    the next Stop would also kill the running background agents and
    workflows.
  - Once claude has exited, nothing more is written to it: a phone send in
    the moment the session takes to finish (stderr grace) is refused with the
    reason, never acked as delivered; its retry respawns the conversation.
- **Background tasks** (`tasks.rs`, the Mac's rules): a task is background
  work while running, not registered in the foreground
  (`is_backgrounded:false`) and not `ambient`. Each run's end emits a
  `task_finished{task_id, kind, status, label?}` event; a `SendMessage` wake
  starts a new run with a blank usage roll-up. A turn that ends SUCCESSFULLY
  while background work runs, and whose final message asks the user nothing,
  emits NO `turn_completed` (the Mac's green `backgrounding`: the agent
  resumes by itself when that work ends, and that turn pushes); an error or
  an open question always does (`turn_completed.open_question`, the Mac's
  `looksLikeQuestion`). Phone RPC: status `backgrounding{background_tasks}`,
  rows carry `background_tasks` (running count), `list_background_tasks` and
  `stop_background_task` (the Mac's shapes; the stop is
  `control_request{stop_task}` and answers with claude's own acknowledgement
  or refusal).
- **Status vocabulary** (the Mac's `statusJson`, priorities of its
  `deriveAgentStatus`): `needs_permission{tool}` for a tool permission;
  `needs_input{question}` for an `AskUserQuestion` (its questions), an MCP
  elicitation or a dialog; `running`; `needs_input{question}` again when the
  last turn ended on a question nobody acted on (its tail; cleared by the
  next turn or `acknowledge_conversation`); `backgrounding`; `idle`; `off`.
  `get_pending_request` / `answer_request` stay permission-only (an
  `AskUserQuestion` is listed as kind `questions`; answering an elicitation
  or a dialog is refused with the reason).

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
- The stderr tail of a claude that died while NO client was attached is only
  in the daemon's log: the next attach starts a new process.
