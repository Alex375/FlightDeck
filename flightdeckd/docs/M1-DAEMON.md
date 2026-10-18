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
flightdeckd set-title --conversation <id>|--resume-session <sid> --title <t>
                      # renomme, rien d'autre (≥ 0.6.0, cap `set-title`)
flightdeckd pairing   # réaffiche le lien pairing téléphone
flightdeckd add-phone --token <pt|-> [--label L]   # autorise un téléphone (config + relais, à chaud)
flightdeckd remove-phone --token <pt|->            # le révoque (idem) ; `-` = lu sur stdin
flightdeckd remove-phone --init-minted --keep -    # révoque le token qu'un `init` simple a créé
                      # (jamais celui lu sur stdin) ; imprime {"type":"fd_init_phone_removed","ok":true,"removed":0|1}
flightdeckd add-device < device.json     # appaire un téléphone du canal scellé (≥ 0.5.0) :
                      # {device_id, label, relay_token, keys:[{generation, key, issued_at_ms, expires_at_ms}]}
                      # sur stdin uniquement (porte une clé) ; imprime {"type":"fd_device_added","ok":true,"added":bool}
flightdeckd remove-device --device <id>  # le désappaire (config + relais + sessions closes) ;
                      # imprime {"type":"fd_device_removed","ok":true,"removed":bool}
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
  pour les sessions que le démon crée lui-même (création depuis le
  téléphone). Une relance à froid d'une conversation qui a déjà tourné
  (message du téléphone) reprend son PROPRE mode — celui que claude a confirmé
  en dernier, sinon celui de son argv enregistré — jamais un bypass (voir
  « Spawns the daemon makes itself » plus bas). C'est ce qu'écrit
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
  élicitation MCP (`McpElicitation` : le démon la liste depuis 0.4.0, cap
  `pending-dialogs`, mais le téléphone ne peut pas y répondre) — gardent leur
  `updated_input`, qui est la réponse elle-même.
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

## Stream fidelity (contract, daemon ≥ 0.4.0)

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
    runs as `auto` (`own_spawn_permission_mode`, the same rule as the
    configured mode: claude RUNS a `bypassPermissions` spawn in bypass even
    without the unlock). The bypass needs the Mac's app-wide opt-in, which the daemon
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

## Link reliability (contract, daemon ≥ 0.6.0)

Additive like the 0.4.0 section: a client gates on the caps of the RUNNING
daemon — `fd_attach.caps`, and since 0.6.0 also `fd_status.caps` (the same
list) for a client that only runs one-shot verbs — never on the binary on disk.

| cap | behavior |
|---|---|
| `set-title` | `{"set_title":{"conversation"?,"resume_session"?,"title"}}` on the socket (`flightdeckd set-title --conversation <id> \| --resume-session <sid> --title <t>`) renames a conversation and does NOTHING else: no claude is started for an idle conversation, the client attached to a live one stays attached. The conversation is the one `conversation` names when this server has it, else the one running claude session `resume_session`. Reply `{"type":"fd_title_set","ok":true,"conversation":<id>}`; no such conversation or a blank title → `ok:false` + `error`. An older daemon answers `fd_detach{error}` (unknown verb). A client should rename an idle conversation with it instead of an `attach --title` (which cold-started claude and replaced the attached client). |
| `existing-only` | `attach --existing-only` (`"existing_only": true`) joins a RUNNING claude and never starts one: with none running for the conversation, the answer is `fd_detach{reason:"not_running", message}` and nothing is spawned, un-archived or recorded. For a client that decided to attach on a status snapshot (a resume pass after the Mac slept) — the process may have ended since. A client sends it only when the RUNNING daemon lists the cap (its `fd_status.caps`): an older binary refuses the flag (clap, code 2), but a newer binary in front of an older daemon still running (an update not yet restarted) passes `"existing_only": true` on the socket, where the old daemon ignores the unknown field and may cold-start claude. The Mac's resume pass reads the cap from the status answer it plans on, and ends such an attach quietly on `not_running`. |
| `attach-tasks` | `fd_attach.background`: the background tasks running NOW in that claude process, from the daemon's own task registry (which never evicts a running task) — never from the replay ring, which evicts every line. Each entry has the shape of an entry of claude's `background_tasks_changed` level — `task_id`, `task_type`, `description`, `ambient:true` when it is housekeeping — plus `kind` (`bash`/`monitor`/`agent`/`workflow`/`other`: the daemon tells a `Monitor` from a background `Bash`, both `local_bash`), `tool_use_id` and a `Bash` task's `command`; absent fields are omitted. A task registered in the foreground (`is_backgrounded:false`) or finished is not listed; `[]` when nothing runs. Why: after hours of foreground-only work, a task's `task_started` and every level naming it can leave the 64 MiB ring; a client attaching then (an app relaunch, first attach) never learned of it — no row, no Stop — while the daemon counted it at work. A client adopts the entries it does not hold as running background work at the replay's end, like a level's. |

New fields (self-describing: absent from an older daemon, so a client reads
them when present and needs no cap for them):

- `fd_status` rows carry `unanswered` (bool). `true` = the conversation has a
  live claude whose session did not answer the daemon's status query in time
  (a slow sidecar read, a backlog of lines, a slow registry write): what it is
  doing is unknown. Such a row ALSO reads `running:true` and `busy:true` (and
  `pending`/`background_tasks` 0, unknown), so a client that knows nothing of
  the field still counts it as at work — never as a conversation with no
  process (no reattach, review) nor as idle (a restart would cut it short).
  The phone's status for it is `{"kind":"running","unanswered":true}` (never
  `off`), and `get_pending_request` fails ("the session did not answer in time")
  instead of listing no prompt.
- `fd_status` rows carry `scheduled` (count): the session-only schedules that
  would wake that claude later — a `CronCreate` job not persisted to disk (what
  `/loop` sets up), a pending `ScheduleWakeup`. They live only in that claude
  process ("gone when Claude exits"): between two firings the conversation is
  idle (`busy:false`, no task, nothing pending), yet a daemon restart drops
  them. A restart guard counts `scheduled > 0` as work. Read off claude's tool
  calls and their results; it errs toward counting (a one-shot job's firing is
  not on the stream: it counts until deleted or claude exits; a wakeup until
  its delay plus 2 min; a recurring job until it expires).

Daemon-side behavior that needs no client change:

- **An attach with no claude argv** (an older Mac's `attach --title` rename
  push) that has to cold-start spawns like the daemon's own respawn: the
  conversation's recorded argv with the controls its claude last confirmed
  (never a bypass), initialized by the daemon, and those confirmations are
  KEPT — an empty argv is no statement of intent. Before, it spawned the
  configured defaults (`auto`, claude's default model), wiped the confirmed
  controls and left the process uninitialized. Nor is it anyone opening the
  conversation: one stopped or removed on purpose (below) is not started,
  un-archived nor cleared of its stop by it — `fd_detach{reason:"not_running"}`
  — and the `--title` it carried is recorded all the same (so is the title of
  any refused attach that names a conversation this server has).
- **Only the attached client writes to claude.** A line from a client that is
  no longer the attached one — replaced by another attach, its bridge still
  draining what it had read, a late TCP retransmission — is dropped (logged),
  never handed to claude: `fd_attach.delivered` stays true to its contract (a
  uuid missing from it never reached claude), and a replaced client's
  `fd_stop`, interrupt or permission answer can no longer act on the new
  client's session.
- **One claude per conversation, one per session.** An attach resuming
  session S joins the live process running S — including one started with
  `--resume S` that has not reported its session yet (claude names it in the
  first turn's `system/init`) — read off the session map, never through an
  actor status query (which could time out under the sessions lock and read as
  "no match"). A cold start whose conversation turns out to have a live
  process joins it instead of spawning a second claude over it. An actor that
  reported claude's exit can no longer be joined (it only waits to be unmapped).
- **Nothing joins a claude being stopped.** A Stop is acked (`fd_stopped`,
  the phone's `stop_stream`) as soon as claude's stdin is closed — claude may
  still take a few seconds to exit. An attach, or a phone send, that would land
  on it meanwhile waits (lock released, at most the stop ladder: ~5.5 s) for it
  to be gone, then starts a fresh claude; past the bound it fails ("the
  conversation's claude is still being stopped on the server — retry in a
  moment"). Before, it joined the dying process: every line it wrote was
  dropped (stdin closed) and the process's exit then ended its session as
  `exited`. An attach that raced the stop into the actor gets
  `fd_detach{reason:"error"}` saying so. While the daemon itself shuts down,
  attaches and starts are refused ("flightdeckd is shutting down").
- **A stop asked for holds against a client that missed it.** A stop on
  purpose — the phone's `stop_stream` or `remove_conversation`, a client's
  `fd_stop`, `flightdeckd stop` (never a daemon shutdown) — is recorded on the
  conversation (registry `stop_requested_at`). A client RE-attaching with an
  `epoch` (the Mac's actor after its link died — its `fd_detach` went down with
  the link) to such a conversation, or to an archived one, with no process left,
  is refused — `fd_detach{reason:"error"}` "This conversation was stopped
  (removed) on the server while this Mac was disconnected — send a message to
  start it again (bring it back)" — and nothing is started or un-archived.
  Before, the reattach cold-started claude and un-archived a removed
  conversation. A fresh attach (no epoch) and a phone send still start it, and
  clear the record; a crash or a daemon restart is still respawned for a
  reattaching client.
- **A cold start resumes the session the conversation runs NOW.** For a
  conversation this server knows, `--resume` is the session its registry row
  holds, never a client's `resume_session` that differs: the session moves on
  the server while a client is away (a `/clear` sent from the phone), and
  resuming the client's stale one silently undid the move — the work done
  since was referenced by nothing any more. A client's session only names the
  one to resume for a conversation the row has none for (or a new one). The
  `fd_status` rows already carry each conversation's current `session_id`: a
  client should adopt it (the Mac's resume pass does).
- **One daemon per user.** `flightdeckd run` holds an exclusive `flock(2)` on
  `~/.flightdeckd/flightdeckd.lock` for its whole life. A second `run` waits
  up to 15 s for it (the daemon a restart replaces may still be stopping its
  sessions — `pkill; sleep 1; run`), then exits with "another flightdeckd is
  already running for this user". It also refuses an attach socket another
  daemon still answers on (only a socket nobody listens on is replaced), and a
  daemon leaving removes the socket only if it is still the one it bound.
  Before, a second daemon unlinked the live socket and took every new attach
  and status — with none of the live sessions — and the leaving one could
  delete its successor's socket.

## Sealed channel (contract, daemon ≥ 0.5.0)

Spec: `docs/tarmac-sealed-channel.md` (repo root); crypto in `tarmac-e2e/`.

- **Devices** live in `config.devices` (provisioned by the Mac through
  `add_device` / `remove_device` on the socket, or the CLI above; an older
  running daemon answers the usual `fd_detach` bounce). Each holds THIS node's
  key per generation (≤ 2 kept) and the relay token authorized on its behalf
  (in every connect burst, after the legacy tokens — only while one of its
  generations is still valid; tombstoned on removal like a phone token). The key
  set an `add_device` brings is authoritative: a generation the Mac no longer
  sends (pruned once the phone used the newer one) is dropped, and every session
  on a generation gone or re-keyed ends. Caps: 32 devices, 4 push subscriptions each.
- **Relay frames handled:** `e2e_hello` (→ `e2e_accept` / `e2e_reject`,
  targeted), `e2e` (sealed app frames), `phone_left` (drops that socket's
  session), `push_gone{endpoint:<sha256 hex>, reason}` (the relay refused a
  `push_send` for it: every device's subscription with that endpoint is dropped
  from the config and live, nothing else; never answered; any `reason` prunes, a
  malformed frame is ignored). Sessions are per relay link: a reconnect starts with none, the
  phone handshakes again on `welcome`. A session counts (and the device is
  "seen") only once its first sealed frame opened; it ends when its generation
  expires (`e2e_reject{expired}`); replies are sealed for the session the request
  came in on, or dropped; a socket whose session is proven never switches device.
- **Sealed app frames:** `subscribe` → sealed `ready{label, device:{label,
  generation, expires_at_ms, renew_after_ms}, caps}`; `ping` → `pong`; `rpc` → the cleartext
  catalogue plus `forget_device` (answered BEFORE the relay revoke, then the
  device is gone), `push_register{subscription:{endpoint, keys}, prefs?}`,
  `push_prefs{prefs}`, `push_unregister{endpoint?}`.
- **Cleartext only while a legacy phone is authorized** (`phone_tokens`
  non-empty): otherwise a cleartext `rpc` gets `rpc_error "this machine only
  accepts encrypted connections — re-pair your phone"` and events are never
  sent in clear. Retiring the last legacy token closes the cleartext path.
- **Events** go sealed to every proven session (one frame each, `_cid`), and
  as `push_send{endpoint:<sha256 hex>, body:<b64url aes128gcm>, ttl, urgency}`
  to the relay for each subscription whose prefs want the state — the node
  builds, SIGNS (`data.sig`, with its own key for the device: no other node can
  pose as it) and seals the notification (RFC 8291), the relay never sees it.
  A device with no valid generation left gets none.
- `fd_status` adds `devices` (id, label, generations, live sessions,
  `last_seen_ms` since start, push count — never a key nor a relay token) and
  `legacy_phones`.

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
