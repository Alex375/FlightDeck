# Claude Code Instructions — TOSSE

## MCP TOSSE
This project is managed via TOSSE CRM.

### FUNDAMENTAL RULE: Read contexts before acting
Before any action on this project, call get_context() to read the associated contexts
(repo, project, mission, client). These contexts contain essential information
to understand the scope and intentions of the project.

### TASK-FIRST RULE: Check tasks before coding
Before starting any development work, always check if a TOSSE task already exists
for the requested work (`/list-tasks` or `get_tasks` filtered by project_id).
If a matching task exists, `/pickup` it. If no task exists, create one via MCP
before writing any code. Never start coding without an associated TOSSE task.

### SYNC RULE: Keep the CRM up to date
- Any task created/modified/completed → update the CRM via MCP
- Any new project information → enrich the context via update_context()
- Call sync_claude_md() regularly to keep this file up to date

### ANTI-REDUNDANCY RULE
CRM contexts are organized in cascade (client → mission → project → repo).
Do not replicate in this file information already present in parent contexts.
Only enrich what is specific to THIS repository.

## TOSSE Workflow — Skills & Agent

Ce projet utilise le plugin TOSSE qui fournit des skills et un agent pour gérer le workflow de développement.

### Workflow standard

```
/pickup → travail sur le code → /done → /deploy
```

### Skills disponibles

| Skill | Quand l'utiliser |
|-------|-----------------|
| `/pickup` ou `/pickup <task_id>` | Démarrer une tâche. Vérifie les blocages, lit les contextes, passe la tâche "En cours". Accepte aussi une intention libre ("je veux fixer le bug du login") — il cherche la tâche existante ou en crée une. |
| `/done` | **Lancé automatiquement** quand tu finis ton travail (code compile, tests passent, feature OK). Résume ce qui a été fait, met à jour le contexte de la tâche, passe en "Review", lance /deploy si le skill existe. Si gros changement : propose un context update via tosse-manager. |
| `/list-tasks` | Lister les tâches du projet actuel. |
| `/setup` | Créer un skill /deploy spécifique à ce projet (pose des questions : commande test, branche, hosting). |
| `/context-audit` | Auditer la cascade de contextes (redondances, infos mal placées). Délègue à tosse-manager. |

### Agent tosse-manager

Sous-agent spécialisé CRM. Invoque-le avec `@tosse-manager` pour :
- Créer des hiérarchies complètes (client + mission + projet + tâches)
- Mettre à jour les contextes après un gros changement (délégué par /done)
- Auditer la cascade de contextes (délégué par /context-audit)
- Réorganiser des tâches, créer des dépendances, gérer en masse

Il ne touche PAS au code — uniquement les données TOSSE via MCP.

### Règles de workflow

- **Démarrer une tâche** : utilise `/pickup` — il fait tout (blocages, contextes, statut "En cours")
- **Terminer une tâche** : **lance `/done` AUTOMATIQUEMENT** quand tu as fini le travail et que tout est vérifié. Ne demande PAS à l'utilisateur.
- **JAMAIS** mettre une tâche en "Fait" — seul un humain le fait après review
- **Les sous-tâches** ne vont jamais en "Review", seules les tâches parentes
- Vérifie les relations de blocage (`get_task_relations`) avant de démarrer une tâche
- Toujours filtrer par `project_id` quand tu récupères des tâches

### Guide de contexte — quoi va où

| Niveau | Ce qu'on y met | Exemples |
|--------|---------------|----------|
| **Client** | Secteur, localisation, contacts, contraintes business | "Fintech Paris, RGPD strict, CTO = Pierre" |
| **Mission** | Scope contractuel, objectifs, budget, planning | "Refonte site, livraison avril, 15k€" |
| **Projet** | Architecture, décisions techniques structurantes | "SPA React + API REST, auth JWT" |
| **Repo** | Stack, commandes dev, CI/CD, deploy, patterns code | "Next.js 15, pnpm, Vercel, middleware /auth.ts" |
| **Tâche** | Ce qui a été fait, décisions prises pendant le travail | "Choisi JWT plutôt que sessions" |

Règle d'or : une info ne doit exister qu'à UN SEUL niveau.

Task status flow: `Backlog → À faire → En cours → Review → Fait`

**MCP entity IDs for this repository:**
- repository_id: `8c509e62-30cb-4f58-9074-086bac72528d`
- project_id (Tosse Code): `ef02be22-fe30-4463-9450-ec3b20746a35`

## [GENERATED] Global Rules

- Write all comments and variable names in English
- Always create a virtual environment before installing Python packages
- Never commit secrets or API keys
- Document all public functions

## [GENERATED] Repository Context

# tosse-code — Stack & implémentation

Desktop app pour piloter Claude Code. La **vision**, le **périmètre par phases**, le **principe directeur** et les **décisions structurantes** sont au niveau du contexte projet (Tosse Code). Ici : la stack concrète et le « comment on construit ».

## Langue de l'app — ANGLAIS

Depuis juillet 2026, toute l'UI et les commentaires de code sont en **anglais** (i18n FR→EN : 166 fichiers front `src/` + back `src-tauri/`, plus `CHANGELOG.md`, la note d'install GitHub et les 3 messages TCC de `Info.plist` ; `bindings.ts` régénéré). **Tout nouveau string user-facing ou commentaire de code doit être écrit en anglais.** L'identité technique reste inchangée (nom affiché « Flight Deck », `com.tosse.desktop`, crate/package `tosse-code`, composant `TosseMark`). Quelques emplacements conservent du français VOLONTAIREMENT (à ne PAS « re-traduire ») : les fixtures de test d'accent-folding de `supervisor/history.rs`, la regex legacy `store/updater.ts` (elle doit continuer à matcher les release bodies FR déjà publiés/gelés), les fixtures simulant des prompts utilisateur ou de la sortie CLI (`codex/*`, `assembler.rs`, `ask.test.ts` « Créer le fichier », `status.test.ts`, `fs/mod.rs` « héllo »), et l'exemple de touche AZERTY « é » de `ui/shortcuts.ts`. Le `README.md` reste à traduire (tâche distincte « Rédiger un README anglais »).

## Nom affiché « Flight Deck » vs identité interne `tosse-code`

⚠️ Depuis juillet 2026, le **nom AFFICHÉ de l'app est « Flight Deck »** (productName Tauri + titre de fenêtre, menu app macOS, wordmark UI `TosseMark`, 3 messages TCC `Info.plist`, dialogues Réglages/MAJ/notifs, `releaseName`), avec un **nouveau logo** « avion cyan + souffle réacteur corail » (`public/tosse.svg`, `src/ui/TosseMark.tsx`, `src-tauri/app-icon.svg` + icônes régénérées via `pnpm tauri icon`). **C'est un rebrand DISPLAY-ONLY** : l'**identité technique reste `tosse-code`** et NE DOIT PAS changer — identifiant `com.tosse.desktop`, crate/package `tosse-code`, repo GitHub `Alex375/tosse-code`, certificat « Tosse Code Self-Signed », projet CRM « Tosse Code », et les filenames internes `public/tosse.svg` + composant `TosseMark`. **NE PAS « corriger » la divergence productName ↔ identifiant/crate** : elle est VOLONTAIRE (changer l'identifiant = nouveau dossier `~/Library/Application Support/…` = perte des conversations + re-grant TCC global). La **vue de gestion d'agents garde aussi le nom « Flight Deck »** (l'app == sa vue phare). Piège updater : les installs déjà en place restent le fichier `Tosse Code.app` (remplacement en place par l'updater) tout en affichant « Flight Deck » ; un nouvel install `.dmg` = `Flight Deck.app`.

## Stack

- **Shell desktop** : Tauri 2 (webview de l'OS, pas de Chromium embarqué).
- **Cœur** : Rust + tokio. Superviseur de process, client du protocole Claude Code, persistance.
- **UI** : React + TypeScript + Vite, rendue dans le webview Tauri.
- **Éditeur** : Monaco (npm) — lazy-loadé / code-split (chunk éditeur + workers de langage json/css/html/ts en chunks lazy séparés → démarrage non impacté).
- **PDF** : `pdfjs-dist` (pdf.js) — lazy-loadé / code-split (chunk viewer + worker `?url` séparés, hors bundle de démarrage). Rendu `<canvas>` (identique Chromium dev ↔ WKWebView prod → vérifiable en dev ; PAS d'embed natif WKWebView, jugé peu fiable). Viewer `src/features/editor/PdfViewer.tsx` : **zoom** (boutons/Ctrl-Cmd+molette/double-clic) + **fit-largeur par défaut** + **non-écrasable** (chaque page en `aspect-ratio` + taille de layout, jamais un `transform` → le scroll multi-pages marche, la page se rescale au lieu de s'aplatir). Octets lus via `read_image` (voir fs/).
- **Terminal** : `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl`. PTY natif côté Rust via `portable-pty` 0.8 ; octets PTY encodés en base64 sur le bus d'events Tauri (crate `base64` 0.22). Rendu WebGL côté front.
- **État UI** : Zustand (flotte d'agents, nourri par les events) + TanStack Query (commandes).
- **Crates clés** : `portable-pty` 0.8, `base64` 0.22, notify (watch fichiers), **rusqlite (bundled)** + SQLite (persistance — synchrone, WAL, foreign_keys ON ; sqlx écarté : nos écritures sont minuscules/rares/hors chemin chaud, pas besoin d'async + macros), serde_json, **tauri-specta** (contrat IPC typé Rust→TS auto-généré, jamais de resync manuelle), **reqwest** (`rustls-no-provider`) + **rustls** (`ring`) + provider crypto `ring` installé au runtime avant le 1er client HTTP, **uuid** (v4, remote control).
- **Plugins Tauri** : opener, dialog, updater + process (auto-update signé), notification (notifs OS agent). Permission `notification:default` dans `capabilities/default.json`.
- **git2** : option ouverte pour diff/status in-process côté Monaco — PAS utilisé pour les worktrees.

## Protocole Claude Code

Réimplémentation clean-room en Rust du client de l'extension VS Code officielle (disséquée, pas un fork) :
- Spawn du binaire `claude` avec `--output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio`, plus **`--forward-subagent-text`** (inconditionnel). Sans ce dernier le binaire FILTRE les messages de sous-agents avant de les transmettre (`if (!forwardSubagentText && type !== "tool_use" && type !== "tool_result") continue;`) — et le filtre s'applique **dès la profondeur 1**, pas seulement au nesting : on ne recevait que leurs tool_use/tool_result, jamais leur texte ni leur réflexion. C'était la cause de l'asymétrie où le drill-in d'un sous-agent était muet EN DIRECT alors que la même conversation rechargée du DISQUE affichait sa prose. ⚠️ Corollaire obligatoire : `backgroundAgentIdsIn` (front) doit rester scopé au thread PRINCIPAL (`parent_tool_use_id === null`) — un sous-agent peut lancer ses propres agents (nesting profondeur 3 par défaut depuis 2.1.219) et ces messages nous parviennent désormais ; sans ce garde, un petit-fils serait listé dans la barre d'agents de la conversation comme si l'utilisateur l'avait lancé. Le spawn passe aussi **`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`** : en mode piloté (SDK), c'est l'UNIQUE gate du file-history du binaire — sans lui, `rewind_files` répond invariablement « File rewinding is not enabled ». À NE PAS retirer par nettoyage.
- Mode **bidirectionnel persistant** (un process vit toute la session) — PAS `claude -p` (one-shot).
- Messages JSON-lines : `system`, `assistant`, `user`, `tool_use`, `tool_result`, `result`, `stream_event`.
- **Pièces jointes (images)** : le `content` d'un message `user` est un ARRAY de blocs → on y ajoute `{type:"image",source:{type:"base64",media_type,data}}` pour joindre une image. VÉRIFIÉ accepté par le binaire 2.1.187 (piloté en stdin avec un PNG → il « voit » l'image) ; **png/jpeg/gif/webp uniquement** ; le format `document`/`type:"file"` n'a PAS été retenu (non vérifié). `send_message` transporte `text` + `images: Vec<ImageAttachment>` (`transport::user_message_with_images`, texte puis blocs image, bloc texte vide omis). Bouton « + » du composeur (`composerAttachments.ts`, store en mémoire par conv, non persisté) : images → bloc base64 + vignette optimiste ; autres fichiers → mention de chemin ; collage Cmd+V → attachement (plafond 16 Mio, aligné `fs::MAX_FILE_BYTES`). Octets lus via `commands.readImage` (réutilisé du viewer). Reload : `history.rs` (`push_user`/`first_user_text`) posent un placeholder `[image]` pour un tour image-seule (vignettes NON re-rendues — le modèle de blocs normalisés ne porte pas encore l'image ; follow-up).
- Canal de contrôle : `control_request` / `control_response` (sous-types : `initialize`, `can_use_tool`, `set_permission_mode`, `interrupt`, `mcp_message`, `generate_session_title`, `remote_control`, `stop_task`, `reload_plugins`, `mcp_status`, `mcp_toggle`).
- `SessionStatePayload` contient un champ **`cwd`** capté depuis `system/init` (ré-émis à chaque tour) — source de vérité du répertoire courant. Le cwd n'est PAS figé : l'agent peut le déplacer via outils worktree.
- **Arrêt d'une tâche de fond** : wire = `control_request{subtype:"stop_task", task_id}` — le sous-type est **`stop_task`** (PAS `task_stop`, disséqué verbatim dans l'extension VS Code).
- **Remote control** : `control_request{subtype:"remote_control", enabled:bool, name?}` → `control_response{response:{session_url, connect_url}}` (doublement niché `response.response`). Bridge santé : `system/bridge_state{state:"disconnected"|"error"}` — **dégrade seulement**, "connected" ne vient QUE de la réponse au control_request. Spawn avec **`--replay-user-messages` inconditionnel** (sans lui le binaire n'émet aucune ligne `user` sur stdout) ; on estampille chaque message envoyé d'un uuid et on supprime l'écho de NOS propres tours (`assembler.sent_user_uuids`, one-shot — l'uuid est consommé quel que soit le contenu du tour, texte comme image-seule) ; tour distant (uuid inconnu) surfacé. **Distinguer live vs historique est OBLIGATOIRE** : `history.rs` n'émet pas de `turn_result` → splicer l'historique regrouperait tous les tours user en haut (régression).
- **Prompts de sous-agents ré-émis en `user`** : un prompt que Claude envoie à un sous-agent (`Task`/`Agent`) arrive en live comme une ligne `user` avec un **uuid FRAIS** (donc pas dans `sent_user_uuids`) + **`parent_tool_use_id` = le tool_use qui l'a spawné** ; `isReplay`/`isSidechain`/`isMeta` sont ABSENTS sur le wire live (champs disque-only, comme `sourceToolUseID` — la leçon du skill-body). VÉRIFIÉ contre claude 2.1.203 (probe pilotant le binaire avec les flags de prod + spawn forcé d'un sous-agent). Sans garde, il FUIT en bulle user dans la conversation principale (« comme si je l'avais envoyé ») → `assembler.ingest_user` ne surface la bulle QUE si `parent_tool_use_id.is_none()`. Contrairement à `isMeta`/`sourceToolUseID`, `parent_tool_use_id` est un champ TOP-LEVEL qui survit au stream → discriminant fiable. Les blocs `tool_result` (résultats internes du sous-agent, même parent) restent traités. Miroir de `history.rs` (skip `isSidechain:true` sur disque) + du guard context-meter de `ingest_stream_event`. Test `subagent_prompt_with_parent_is_not_surfaced_as_user_message`. [fix mergé dev — commit `fc40a4f`]
- **`reload_plugins`** (`control_request{subtype:"reload_plugins"}`) : hot-reload des plugins d'une session VIVANTE. **VÉRIFIÉ live (2.1.187)** : prend bien en compte un enable/disable écrit dans `~/.claude/settings.json` EN COURS de session (re-scanne AUSSI les SKILLS du plugin) — contredit l'ancien « prend effet au prochain (re)démarrage » : ce message rend le toggle live. Sa réponse de contrôle porte déjà la liste `commands` fraîche (même forme que `initialize` : `response.response.{commands,agents,plugins,mcpServers}`) + le CLI émet un `system/commands_changed` en push. ⚠️ Les skills fournis par un plugin y apparaissent en noms NUS (`brand-guidelines`), PAS `plugin:skill`.
- **`/goal` (feature native Claude Code, v2.1.139+)** : objectif de session — Claude enchaîne les tours jusqu'à ce qu'un petit modèle valide la condition, puis auto-clear. Son état vit dans le **transcript** en lignes `attachment.type:"goal_status"` (`sentinel`+`met` distinguent set / unmet-check / achieved / clear ; un `/goal clear` écrit aussi un `<local-command-stdout>` `Goal cleared:` / `No goal set`). **DISK-ONLY — JAMAIS sur le stdout live** (seul l'echo `<command-name>/goal</command-name>` remonte live via `--replay-user-messages` ; PAS de voie control-channel, vérifié). Interception = scan FILTRÉ du transcript ENTIER, en avant (`history.rs::load_active_goal` → IPC `load_session_goal`) : pas un tail-scan (un goal posé tôt et jamais terminé reste actif en fin de fichier), mais un pré-filtre par sous-chaîne brute (`goal_status` / `local-command-stdout`) AVANT tout parse JSON — sinon une flotte de cartes Flight Deck paierait un parse complet de plusieurs Mo chacune. Rafraîchi au load/reload, par carte Flight Deck (`seedActiveGoalOnce`, survit au quit/relaunch) et aux fronts de tour (gaté sur `goalSeen` pour ne rien coûter aux convs sans goal). Le bruit `/goal` (echo commande + stdout `Goal set/cleared`/`No goal set`) est masqué du fil (`is_goal_command_noise`, live+reload) ; les `/goal` du composer partent en **envoi silencieux** (live == reload). DISPLAY-ONLY via `goalStore` (mémoire, keyé convId) : chip du composer + icône target Flight Deck, popover partagée `GoalPopover` (condition + dernière raison + clear ; garde de clear pilotée par le cycle de vie de la mutation). Cf. mémoire `goal-feature-wire`.

## Backend Codex (app-server) — 2ᵉ producteur

Codex (OpenAI) piloté EN PARALLÈLE de Claude, avec le MÊME modèle normalisé (`ConversationItem` / `SessionEmitter` / `SessionEvent`) : un seul modèle UI, DEUX producteurs. Code dans `src-tauri/src/supervisor/codex/`. Le backend est choisi à la CRÉATION de la conversation (`conv.kind: "claude" | "codex"`, IMMUABLE, pas de switch mid-conv). Détails de protocole/mapping + audit de faisabilité en mémoire (`codex-appserver-protocol`, `codex-assembler-4-1`, `codex-controls-per-turn-overrides`, `codex-history-ops-need-resume`, `codex-usage-extensions-wire-4-4`, `codex-extensions-v2-accounts-wire`).

- **Wire** : `codex app-server` (JSON-RPC 2.0 NDJSON stdio ; le serveur OMET `jsonrpc`, router sur `id`+`method`), API **v2** `thread/*`·`turn/*`·`item/*`. Spawn du binaire natif `@openai/codex`. Auth `~/.codex/auth.json` (`chatgpt`) = plan-inclus, JAMAIS écrire ce fichier. ⚠️ **Vérifier un wire SANS live turn** : `codex app-server generate-json-schema --out DIR` dump 1 fichier JSON par type (ex. `DIR/v2/ThreadForkParams.json`) → lire au lieu de spawner un tour.
- **Fenêtre de contexte / ring** (`session.rs`, notif `thread/tokenUsage/updated`) : numérateur = `tokenUsage.last.inputTokens` (occupation COURANTE = prompt du dernier tour), PAS `total.totalTokens` (cumul À VIE qui ne fait que grimper → faux « proche du max »). Dénominateur = `tokenUsage.modelContextWindow` = fenêtre EFFECTIVE de codex (VÉRIFIÉ live via un probe d'un tour : 353 400 pour gpt-5.6-sol, 258 400 pour gpt-5.5, sur plan ChatGPT — c'est la fenêtre effective/compaction, PAS la capacité brute ~1M du modèle ; codex n'expose AUCUNE capacité brute, ni dans `model/list` ni dans les capabilities). Décision : afficher le nombre effectif de codex. Probe diagnostic `server.rs::live_probe_model_context_window` (ignoré).
- **Changements de réglage dans le fil** : Codex n'a PAS de canal de settings — les contrôles (modèle/effort/approval/sandbox/réseau/résumé/personnalité) voyagent en overrides sur `turn/start`. Notice `control_change` émise au moment BACKEND-CONFIRMÉ = branche Ok de `turn/start` (`session.rs::announce_control_changes`, tracker `applied_controls`, 1er tour = seed silencieux), JAMAIS au clic optimiste. Réutilise le rendu `control_change` de Claude (front `NoticeRow`, détail `{control,icon,from,to}`) → zéro édit front, zéro bindings. Le preset sandbox×approval est reconstruit en UNE seule ligne « Permissions » (Prudent/Standard/Auto/Accès total).
- **Rewind / fork / archive natifs par TURN ID** : `thread/fork{threadId, model?, lastTurnId?}` (fork THROUGH `lastTurnId` inclusif — tours après omis ; ⚠️ `thread/rollback` DÉPRÉCIÉ en 0.144.1, RETIRÉ ; PAS de `historyMode` sur le fork) + `archive_thread`. Le turn id est surfacé sur `ConversationItem::AssistantMessage.turn_id` : LIVE = le `turnId` PROPRE à l'item (`session.rs::on_item`, `params.turnId`), PAS `current_turn_id` (⚠️ course steer-fallthrough : un item de queue d'un tour A drainé APRÈS le démarrage d'un tour B serait mal étiqueté B → rewind à la mauvaise frontière) ; FROID = `turn_context.turn_id` du rollout (`codex/history.rs::parse_rollout_str` + `stamp_turn`). Front (`ConductorThread::codexCutTurnId`) : cible-réponse = son τ, cible-user = τ du tour PRÉCÉDENT (retire ce tour + suite), garde anti-fork-complet ; rewind = fork + swap `sessionId` (`noteSessionId`) + archive best-effort ; fork = `materializeCodexBranch`. ⚠️ Rendu Codex LIVE-only : historique à froid rebâti du rollout `$CODEX_HOME/sessions/.../rollout-*.jsonl` (`codexLoadHistory`, `codex/history.rs`) car `thread/resume` est lossy (omet les tools) ; reprise par id (`server.rs::resume_thread`).
- **Effort** : la famille **gpt-5.6** (`gpt-5.6-sol/terra/luna`, ids VÉRIFIÉS réels via `model/list`) ajoute les crans `max` + `ultra` (data-driven depuis `supportedReasoningEfforts`). `ultra` ≠ `ultracode` (tier Claude) — mais l'Ultra Codex RÉUTILISE l'animation SLIDER de l'ultracode (remplissage multicolore + pulse + glow, flag `ultraFx` dans `EffortGauge`), SANS le blast plein écran (réservé à ultracode). **Defaults Codex** : modèle `gpt-5.6-sol` (`models.ts::DEFAULT_CODEX_MODEL`), effort `xhigh` (« Extra »), preset sécurité `auto` (`codexControls.ts`).
- **Panneau Historique — les DEUX backends** : `list_disk_conversations` + `build_search_index` (`supervisor/history.rs`) scannent AUSSI les rollouts Codex via `codex/history.rs` (`list_codex_disk_conversations` / `build_codex_search_index`, cœurs `_in(sessions_dir)`) → `DiskConversation` gagne un champ `backend` ("claude"|"codex"), fusion + re-tri par mtime ; helpers partagés `pub(crate)` (`flatten_truncate`, `file_mtime_ms`, `append_capped`, `IndexedConversation::from_text`). Front : `reactivateDiskConversation` backend-aware, preview routé (`codexLoadHistory` vs `loadSessionHistory`), badge `BackendMark`. Titre None (Codex n'a pas d'ai-title) ; `session_meta.id` == queue du nom de fichier → `find_rollout` localise. ⚠️ **Filtrer les threads sous-agents/guardian** (analogue Codex du `subagents/` + `isSidechain` Claude) : discriminant VÉRIFIÉ sur disque réel = `source` OBJET `{subagent:…}` + `parent_thread_id` ; un vrai thread a `source` STRING (`vscode`/`cli`/`exec`), un fork utilisateur a `forked_from_id` mais JAMAIS `parent_thread_id` (marqueurs DISJOINTS). `is_subagent_meta` = `parent_thread_id` non-null OU `source` objet.
- **Rendu de notice d'erreur partagé (zero-silent-error)** : le rendu d'une `Notice` (ex. `history_error` d'un rollout/transcript corrompu ou illisible) est extrait dans le module PUR `noticeView.tsx` (`NoticeBlock` + `ErrorBlock` + `NOTICE_ERROR_HEADINGS` + `noticeDetailText`) — hors `ConductorThread` pour éviter un cycle d'import. `ConductorThread.NoticeRow` (live, keyé store) ET `SubAgentTranscript.toRows` (preview/drill-in à froid) rendent DÉSORMAIS les notices via ce même `NoticeBlock` → une restauration partielle/échouée n'est plus jamais avalée (le preview Historique montrait un écran blanc avant le fix). Vaut pour Claude ET Codex.
- **Tâches de fond & multi-agent (Phase 4.5)** : Codex n'a AUCUN terminal de fond (VÉRIFIÉ `generate-ts` + probe live 0.144.1 : une commande « backgroundée » `nohup … &` reste un `commandExecution` `unifiedExecStartup`/`completed` qui se termine DANS le tour ; le process OS détaché est invisible au protocole, pas de `thread/backgroundTerminals/*`) → les barres de fond Claude-only (Workflow/Monitor/Bash + WorkflowCard) sont MASQUÉES sur une conv Codex via `useIsCodex` (`ConvMark.tsx`), jamais de faux vert `backgrounding`. Le VRAI multi-agent Codex (`collabAgentToolCall` : `agentsStates {threadId→{status,message}}` + `subAgentActivity`) est promu en flotte : l'acteur (`codex/session.rs`, `ingest_collab_states`/`emit_subagent_task`, map `codex_subagents`) émet un `SessionEvent::Task` (kind Agent) par sous-agent keyé par thread id → compté dans le fleet readout + `BackgroundTaskBadge`/`AgentBar`, rendus **display-only** (sous-agent = thread SÉPARÉ non routé par le demux → pas de transcript/stop ; parent bloquant via `wait`). Décision : « flotte via agentsStates », PAS de streaming de transcripts. Détail en mémoire (`codex-background-terminals-and-multiagent-wire`).

## Tools IDE exposés à l'agent (Phase 2)

`openDiff`, `openFile` (à la bonne ligne), `getCurrentSelection`, `getDiagnostics`, `getWorkspaceFolders`, `saveDocument`… → l'agent agit dans NOTRE éditeur. Non encore implémenté.

## Structure (monorepo pnpm)

Encapsulation stricte (cf. « Patterns ») : un module = un service, swappable sans toucher IPC ni front. Détails d'implémentation dans le CODE ; ici la carte + les ⚠️ load-bearing.

- `src-tauri/` (Rust) — `supervisor/`, `git/`, `fs/`, `usage/`, `terminal/`, `power/`, `cli_update/`, `tosse/`, `appmcp/`, `voice/`, `wake/`, `store/`, `ipc/`
  - `supervisor/` : client protocole Claude. `protocol.rs` (types serde), `transport.rs` (spawn/reader/writer/stderr), `control.rs` (canal de contrôle + permissions), `model.rs` (normalisation UI + BackgroundTask/Workflow), `assembler.rs` (map `background_tasks` keyée `task_id` ; classif Bash/Monitor/Agent dès `content_block_start`), `session.rs` (acteur tokio par session), `subagents.rs` (lecteurs disque tâches de fond — **multi-slug** `session_dirs` car un cwd déplacé éclate les artefacts), `history.rs` (`parse_transcript_str(skip_sidechain)`). Sous-module `codex/` = 2ᵉ backend.
  - `store/` : `db.rs` (struct `Store` = SEUL service SQL ; `app_data_dir()/tosse.db`, WAL, `foreign_keys ON`) + `model.rs`. Migrations versionnées idempotentes (`PRAGMA user_version`, `CREATE TABLE IF NOT EXISTS`, `add_column_if_absent`). `wipe_all()` = escape hatch manuel (bouton Réglages).
  - `git/` : `git/mod.rs` = SEUL service git, enveloppe le **binaire `git` CLI** (pas git2). Porte `remote_url` (⚠️ `remote get-url`, PAS `config --get` qui lit aussi le global → faux « pas d'origin » ; codes 2=pas de remote / 128=pas un dépôt, `LC_ALL=C`), `normalize_remote_url` (LE seul juge que deux URLs = même dépôt ; **jamais par NOM**), `scan_repos` (lit `.git/config`, budget TEMPS 3 s, symlinks non suivis, `truncated`/`unreadable` pour qu'un « rien trouvé » ne passe pas pour un verdict).
  - `fs/` : `fs/mod.rs` = SEUL service filesystem éditeur. `read_dir`/`read_file` (garde >2 Mio)/`write_file`/`read_image` (base64, garde 16 Mio — **lecteur d'octets générique** réutilisé viewer image + attach composeur + PDF)/`stat_files` (stat batché taille+mtime sans octets, cf. « Fraîcheur des onglets »)/`FsWatcher` (notify, debounce 150 ms). ⚠️ `read_file`/`read_image` renvoient `mtime_ms` **échantillonnée AVANT les octets** (un écrivain concurrent → mtime plus VIEILLE que le contenu → prochaine vérif relit ; l'ordre inverse figerait un buffer périmé indétectable).
  - `usage/` : `usage/mod.rs` = SEUL service credentials OAuth + usage. `GET …/oauth/usage` (% forfait 5h/7j). ⚠️ Afficher chaque fenêtre sur PRÉSENCE de son objet (`five_hour`/`seven_day`), JAMAIS sur `is_active` (flag instable qui bascule dans le temps). Token `~/.claude/.credentials.json` → Keychain. **Lecture seule**.
  - `terminal/` : `terminal/mod.rs` = SEUL service PTY. Invariants : writer hors du lock global (anti-hang quit) ; teardown tue le GROUPE (`kill(-pid, SIGKILL)`, shell `setsid`) ; instances xterm persistantes par conv (`termManager.ts` hors React) ; lazy-load ; cleanup sur remove/wipe.
  - `power/` : `power/mod.rs` = SEUL service anti-veille macOS. `caffeinate -i -w <pid>` (`-i` inactivité batterie+secteur PAS `-d` ; `-w <pid>` auto-terminant → anti-orphelin même sur crash). `hold()` idempotent. IPC `set_awake`. Politique Light/Hard front (`CaffeinateHost`).
  - `cli_update/` : `cli_update/mod.rs` = SEUL service MAJ du binaire **piloté** `claude` (≠ `tauri-plugin-updater` = l'app). `claude --version` vs dist-tag npm `latest`, `claude update`. Best-effort (jamais d'erreur ; requête registre sautée si pas de `claude`). ⚠️ Lecture seule config SAUF le flip auto-update qui écrit `env.DISABLE_AUTOUPDATER` **via `extensions::set_claude_auto_update`** (extensions = UNIQUE écrivain de `settings.json`). 2ᵉ porte `autoUpdates:false` dans `~/.claude.json` jamais écrite → `auto_update_locked` désactive le switch en l'expliquant.
  - `tosse/` : `tosse/mod.rs` = SEUL module CRM TOSSE (OAuth + REST `/api/v1/*` en Bearer, jamais via MCP). 1er client OAuth main (RFC 8252, PKCE S256, redirect loopback, scope `tosse:app`). ⚠️ On POSSÈDE les credentials (Keychain, item `Flight Deck TOSSE` **suffixé par bundle id hors prod** — TOSSE rotate+révoque le refresh à chaque échange, sinon `invalid_grant` déconnecte les deux). ⚠️ Secret en argv (getpass tronque stdin à 128) ; chaque write relu+comparé. ⚠️ `keychain_read` `Ok(None)` SEULEMENT sur errSecItemNotFound(44) sinon `Err`. ⚠️ Seul un grant REFUSÉ (`invalid_grant`/`invalid_client`/`unauthorized_client` 400/401) efface la session (502/429/captive = transitoires) ; raison persistée. Verrous `LOGIN_FLOW → REFRESH_LOCK → KEYCHAIN_LOCK`. ⚠️ **Contrat de WORDING** : `SESSION_GONE_MARKERS` (Rust) == `src/ipc/tosseErrors.ts` — reformuler une erreur casse la détection « session morte vs panne » en silence (test `session_gone_errors_keep_the_wording_the_front_matches_on`). Ports loopback FIXES 47890→47894.
  - `voice/` + `wake/` : agent vocal Ground Control (SEUL détenteur de la clé OpenAI) + mot de réveil local — cf. « Agent vocal Ground Control ».
  - `appmcp/` : SEUL module hébergeant des serveurs MCP (pilotage de l'app PAR les agents) — cf. « MCP servers hébergés ».
  - **Surface IPC (tauri-specta)** : ~80 commandes (`spawn_session`, `send_message`, `answer_permission`, worktrees, fs, `rewind`/`fork`, `get_plan_usage`, terminal, `set_remote_control`/`set_voice_bridge`, `tosse_*`, `app_control_*`, `codex_*`…) + events (`session_state`/`message`/`permission`/`permission_resolved`/`task`, `Terminal*`, `SessionTitle`/`RemoteControl`/`Commands`, `AppControlRequest`, `Fs*`). Source de vérité = `src/ipc/bindings.ts` (généré, cf. « Bindings IPC »).

- `src/` (React) : `features/{flightdeck,conversation,editor,terminal,git,explorer,extensions,settings,tosse}`, `voice/`, `ipc/`, `store/`, `agent/`, `notifications/`, `ui/`.
  - `store/` clés : `conversationsStore` (groupement par repo), `backgroundTasksStore` (registre + `runningCountsByConv`), `workflowLive`, `planUsage` (poll 5 min), `display.ts` (prefs `tosse:display` — cleanOutput, markdownMode `warm`, fleetBanner*, showTaskNotifications OFF, messageControls, clickableFileMentions, show{Turn,Model,Thinking,Tool}Time ; + 4 prefs TOSSE rendues onglet TOSSE dont `tosseClientFavicons` OFF), `remoteControl` (live-only keyé convId), `commandsStore` (slash-commands par cwd), `updater`/`claudeCliUpdate`, `appErrors`, `permissions.ts` (`tosse:permissions`, opt-in `allowBypassPermissions`), `appControl.ts` (`tosse:appcontrol` — agentServer / agentRemoveConversations / remoteAnswers / voiceAnswers).
  - `agent/` : `status.ts` (`isActivelyRunning`, `readoutBucket`, `railState`, `backgrounding`), `fleet.ts` (ordonnancement + readout), `ask.ts`, `subagentMeta.ts`, `appControl.ts` (exécuteur app-control pur/testé).
  - `notifications/` : `notify.ts`, `sound.ts` (Web Audio), `transition.ts` (`agentEventFor` — point UNIQUE des transitions d'état agent).
  - `voice/` : agent vocal Ground Control (session hors React) — cf. « Agent vocal Ground Control ».
  - `ui/` : `kit.tsx` (ContextMeter, `Menu` mode `portal` opt-in), `ConfirmDialog`, `shortcuts.ts` (`ACTION_BINDINGS`/`matchChord`/`SHORTCUT_GROUPS`, robustesse AZERTY), `useNow.ts` (source unique des compteurs de temps live).
- `packages/ipc-types/` (types générés Rust→TS, à committer avant PR).

## Spec & fixtures

- Spec autoritaire du protocole stream-json (v2.1.178) : `docs/claude-code-protocol.md`
- Fixture de non-régression : `src-tauri/src/supervisor/fixtures/capture_text.jsonl` — re-capturer à chaque upgrade du binaire `claude`.

## Patterns établis

**Architecture générale**
- Normalisation côté Rust ; l'UI est « bête » (events déjà normalisés, ne reconstruit rien).
- Session bidirectionnelle persistante (un `claude` par session, SANS `-p`) ; acteur mono-tâche tokio par session.
- **Encapsulation** : un seul module par ressource (`store/db.rs`, `git/mod.rs`, `fs/mod.rs`, `usage/mod.rs`, `terminal/mod.rs`, `power/mod.rs`, `cli_update/mod.rs`, `tosse/mod.rs`, `appmcp/`) → swappable sans toucher IPC/front.
- **Une seule plomberie control-channel** : `SessionCommand::ControlQuery` + map `pending_query` (`session.rs`) portent TOUT sous-type requête/réponse (`get_usage`, `list_models`, `rewind_files`…) ; parsing typé par feature dans `control.rs`. ⚠️ ~55 sous-types exposés, ~15 utilisés ; enveloppe `request_id` vide écrasée par l'acteur.
- **Un réglage qu'on ne peut pas tenir ne doit pas être offert** : si une porte hors de notre contrôle peut annuler un toggle, le backend renvoie un flag de verrou et l'UI **désactive le contrôle en disant pourquoi** (réf. `auto_update_locked`). Après un write accepté, **relire le disque** (« écrit » ≠ « pris en compte »).
- **Sérialisation des écritures de config CLI (anti-race)** : ⚠️ tout écrivain de `~/.codex/config.toml` prend `CONFIG_WRITE_LOCK` ; tout écrivain de `~/.claude/settings.json` passe par `write_settings` (`SETTINGS_WRITE_LOCK`) ; login OAuth sérialisé par `LOGIN_FLOW` (deux backends). `write_atomic` empêche un fichier déchiré, le lock une édition déchirée (lost update).
- **Migrations SQLite versionnées** idempotentes. ⚠️ Migration non-additive = table-rebuild avec `foreign_keys` OFF **hors** de la transaction du runner (no-op dedans).
- Persistance : messages NON persistés (transcripts Claude) ; seules repos+conversations+sélection active en SQLite.
- **% forfait : session vivante d'abord (`get_usage`), HTTP en repli** (repli LOAD-BEARING : sessions paresseuses + `get_usage` marqué expérimental). `usage/mod.rs` = unique interprète (`plan_usage_from_control_response`).
- **Liste de modèles Claude STATIQUE — décision produit** (`CLAUDE_MODELS` curé). ⚠️ NE PAS rebrancher `list_models` sur le picker ; n'en garder que `supported_effort_levels` + `resolved_model` (suffixe `[1m]` = seul signal wire de la fenêtre 1M).

**Sessions & identité**
- **id stable** (UUID PK persistée) ≠ **handle live** (`session-N`, mémoire, non persisté) : front keyé par id stable en LECTURE, handle résolu à l'envoi.
- Spawn **paresseux** (rien au démarrage ; historique lu du transcript ; `--resume` si `sessionId`). Teardown **sans orphelins** (`process_group(0)`, `kill(-pid)`, échelle EOF→SIGTERM→SIGKILL, kill-all borné au quit).
- **Rewind / Fork** (`history.rs`) : rewind TRONQUE le transcript on-disk (destructif), fork COPIE sous nouveau `session_id`, toujours à une frontière de **prompt humain** (jamais de `tool_use` orphelin), puis re-spawn `--resume`. ⚠️ Toute mutation du transcript exige un arrêt **SYNCHRONE** (`SessionHandle::shutdown_and_wait()`, PAS `shutdown()`), sinon course contre un writer vivant → corruption. ⚠️ Tours live = id synthétique (`user_N`) absent du disque → ciblage par TEXTE (`prompt_match_key`, miroir Rust/TS) + index d'occurrence. Codex : voie native par turn id (`thread/fork{lastTurnId}`).

**Worktrees**
- Outils natifs `EnterWorktree`/`ExitWorktree` interceptés dans `useGlobalSessionEvents`. Convention `.claude/worktrees/<branche>`. cwd non figé ; association conv↔worktree par longest-prefix.
- ⚠️ **Isolation worktree (CLI 2.1.222+)** : le binaire clôture Bash + éditions dans le worktree de la session. Le verrou (`isolationRoot`) s'arme via **`EnterWorktree`** (PAS un simple cwd) → cwd hors worktree bloqué, git redirigé vers le checkout partagé bloqué. `/land` y survit via son `ExitWorktree` d'étape 3 (load-bearing). L'échappatoire `"worktree":{"bgIsolation":"none"}` NE couvre PAS ce cas ; `SpawnConfig.add_dirs` (`--add-dir`) déclaré mais peuplé par aucun appelant.
- Éditeur rooté sur `effectiveCwd` ; `liveCwd` rehydraté du transcript (`worktreeCwdFromTranscript`) — **NE PAS persister en SQLite** (`conv.cwd` reste l'ancre `--resume`).

**État éditeur & UI**
- État éditeur par conv en mémoire ; layout (`terminalOpen`/`terminalFraction`) en localStorage `tosse:editor`. Fichier ouvert : buffer propre → reload live ; sale → garde modifs + bandeau « modifié sur disque ». Autosave debounced + Cmd+S.
- **Fraîcheur des onglets ouverts (tous types)** : le watch OS est unique/incomplet → chaque `FileBuffer` porte une empreinte (`diskStamp` = taille+mtime), `resyncOpenBuffers` relit via `stat_files` batché seulement si l'empreinte bouge (`diskStampChanged`, pure, biaisée vers relire), sur le (re)point du watch ET un tick 2 s (`DISK_POLL_MS`, pause sur `document.hidden`). ⚠️ Ne JAMAIS re-sauter les onglets image/PDF (l'empreinte a levé l'objection coût). ⚠️ Cohérence stat↔read obligatoire (même taille) sinon relecture en boucle. PAS de re-stamp après save. Mémoire `single-fs-watch-stale-preview`.
- Raccourcis : chiffres via `e.code`, lettres via `e.key` (robustesse AZERTY). Registre source unique `ACTION_BINDINGS`/`matchChord` + catalogue `SHORTCUT_GROUPS` (Réglages → Raccourcis) → zéro désync doc/comportement. Globaux l'emportent sur l'éditeur.
- **Suppression de conversation** friction-free (× + ⌘Z) SAUF si `isActivelyRunning` (tour en flight ou tâches de fond) → `ConfirmDialog`.
- **Réglages** : modale à rail d'onglets, briques `SettingsKit.tsx` (`SettingsGroup`/`ToggleRow` avec `disabled`/`disabledReason`, `VersionStatus`). Onglet Updates = 2 updaters (app + CLI `claude`) qui ne s'empilent jamais (`isUpdateBannerVisible`).
- **Gestionnaire d'extensions — barre de reload au toggle plugin** : toggler écrit `settings.json` (`enabledPlugins`) ; une barre inline propose `reload_plugins` + `refetchSlashCommands(cwd)` sur les convs VIVANTES du dépôt (groupé, cwd dédupliqués, attente des écritures). Jamais `/reload-skills` en message. Résolveur pur `pluginReload.ts`.

**Sous-agents & tâches de fond**
- Classification producteur (Bash/Monitor/Agent) captée Rust dès `content_block_start`.
- **Background vs foreground** = `input.run_in_background` seul. ⚠️ ACK détaché `isDetachedAgentAck` exige **≥2 marqueurs** (fail-safe : ne jamais folder un `Agent`/`Task` non confirmé — un faux positif masquerait la carte + transcript).
- `tasks/<id>.output` en dir TEMP (`/tmp/claude-<uid>/…`) → lire par le chemin absolu `output_file`. Artefacts **multi-slug** (`subagents.rs` scanne tous les `session_dirs`). Manifeste workflow `wf_<id>.json` écrit à la FIN ; live via `task_progress` + `journal.jsonl` + `meta.phases` (comptes par étape approximatifs jusqu'à la fin).

**Rendu & affichage** (features livrées — détail dans le code ; ici les invariants)
- **Surfaçage d'erreur unifié** : `ConversationItem::Notice` + `addErrorTurn`, subtypes normalisés (`control_error`/`process_exited`/`send_failed`/`protocol_error`/`permission_error`/`history_error`/`error`).
- **Transitions d'état agent** : point UNIQUE `agentEventFor` (`transition.ts`, pur) — `awaiting_permission` false→true = attention ; `busy` true→false vivant = terminé. ⚠️ Ne PAS dupliquer. Le ping « terminé » est supprimé quand le statut dérivé est `backgrounding`.
- **Tour fini + tâche de fond = état VERT `backgrounding`** (jamais `review` bleu) : route INCONDITIONNELLE (l'agent reprend seul via `<task-notification>`), point vert statique + bannière verte non-dismissable ; le bleu `review` ne revient qu'à bg→0. Pref `alertOnBackgroundWait` RETIRÉE. Accent violet « N en fond » réservé aux erreurs/questions (`backgroundCount` sur needInput/error).
- **Fleet readout** (`FleetReadout.tsx`) : compteurs d'agents par stage, zéros masqués, portée = toute la flotte ; 2 placements (bandeau Flight Deck + encadré sidebar), 2 toggles `fleetBanner*`.
- **Flight Deck — cartes interactives** (`StreamCard`) : effort + contexte cliquables (`CardEffort`/`CardContext` via `Menu` mode `portal` — indispensable car la carte vit dans `.ag-grid` `overflow:hidden`). Suppression de carte (× survol, `ConfirmDialog` si busy, réutilise `removeConversation`+⌘Z), contrôles de stream en modale, **rampe d'importance** `railState()` (`status.ts`) — **FLIGHT DECK UNIQUEMENT** (⚠️ sidebar/conversation interdites, exigence explicite), STATIQUE sans animation, tokens sémantiques EXISTANTS, axe = IMPORTANCE (« mérite un regard ») PAS allumé/éteint.
- **Durées & temps** (4 prefs `tosse:display` ON, groupe « Durées & temps ») : `showTurnDuration` (`result.duration_ms`, live >40 s ; `turnStartedAt` EDGE-gaté dans le store), `showModelTime` (`duration_api_ms`), `showThinkingTime` (keyé par TEXTE de bloc), `showToolTime` (keyé tool_use_id). Mesurés côté front (approx) ; compteurs live via `useNow.ts`. ⚠️ Dette `fmtDuration` (`subagentMeta.ts`) peut rendre « Xm 60s ».
- **Clean output** (`cleanOutput`) : repli du travail intermédiaire par round ; liveness via `atomStillRunning` (⚠️ ne PAS keyer la complétion d'un sous-agent sur le seul `tool_result`).
- **Garde `<task-notification>`** : parser déclenché SEULEMENT si le texte trimmé OUVRE sur le tag ; rendu MASQUÉ par défaut (`showTaskNotifications` OFF), gate unique dans `SpecialMessageCard`.
- **Pin « dernier message »** (`LastMessagePin`) : résumé Haiku live sinon troncature ; clic → scroll scopé au `paneRef`. Pref `showLastMessagePreview`.
- **Liens cliquables** : URLs brutes + `[label](url)` cliquables dans les aperçus (`LinkText`) ; dans le thread, un lien Markdown vers un **chemin fichier** → éditeur (`MentionLink` + `preservePathUrls`), les URLs web via le listener global du plugin opener. ⚠️ NE PAS `stopPropagation` un conteneur d'`<a>` (sinon lien mort — bug reply modal corrigé).
- **Aperçu d'image dans les tool_result** (`ToolResultBody`, `imageBlocksFromContent`) : blocs `image` base64 → `<img>` (front-only, renderer unique, couvre live/reload/sous-agents).
- **Skill/slash-command** : expansé en `role:user` ; body SKILL.md droppé (reload via `isMeta`, live via prefix `Base directory for this skill:` + flag `skill_invocation_pending`). Skill model-invoqué → `SkillChip`. Wire §3.7.1.
- **Catalogue slash-commands** (`commandsStore`, cache par cwd) : 3 déclencheurs (prefetch `fetch_slash_commands` / event `SessionCommandsEvent` / `refetchSlashCommands`).
- **Rendu Markdown** : 3 modes (`data-md-mode`, défaut warm), `StreamMarkdown` réutilisable, `highlight.js` lazy (langages taggés+connus, pas d'auto). ⚠️ Chip de chemin (`FileMention`) : pref `clickableFileMentions` ne gate QUE le nom de fichier de la ligne de step (`ToolStepRow`) ; ne PAS la replier dans `inert` du provider (régression). ⚠️ Piège test : un flip de pref exige `react-dom/client` (SSR zustand voit l'état initial).
- **Bindings IPC** : ⚠️ toujours regénérer + committer avant PR (`cargo test --lib export_bindings_regenerates_ts_client`).
- **Reply modal Flight Deck** (`FlightDeckReplyModal`) : `ConversationPane` réutilisé sans `SidePanel`, gated sur la vue flightdeck. `FileMentionProvider.inert` (chemins = texte), `disableMessageControls` (pas de rewind/fork). ⚠️ Scrim ferme sur clic du scrim seul ; le panneau NE `stopPropagation` PAS (sinon liens `<a>` morts).
- **Échap : garde plein écran** : `preventDefault(Échap)` en phase **CAPTURE** `window` (sauf Monaco/xterm) = seule autorité empêchant macOS de sortir du plein écran natif. ⚠️ Phase BUBBLE insuffisante en WKWebView ; à reconfirmer sur build. Popovers drill-in font `stopPropagation` → « une touche = une couche ».

## Commandes dev

Rust (dans `src-tauri/`, cargo dans `~/.cargo/bin`) :
- Tests unitaires : `cargo test --lib`
- Tests live (spawn réel de `claude`/`codex`, ignorés par défaut) : `cargo test --lib -- --ignored --nocapture`

Front TypeScript :
- Typecheck : `node_modules/.bin/tsc --noEmit`
- Build : `pnpm build`
- Tests unitaires front : `pnpm test` (= `vitest run`, tests co-localisés `*.test.ts`)

CI (`.github/workflows/ci.yml`) : vitest + cargo test + build front. Ne tourne qu'à la PR vers `main`.

## Builds de test locaux (dev)

Alexandre **dogfoode** l'app de production (`/Applications/Tosse Code.app`, identifiant `com.tosse.desktop`) — ses vraies conversations y vivent. (Nom de fichier `Tosse Code.app` conservé sur les installs existantes malgré le rebrand « Flight Deck » — cf. section « Nom affiché » en tête.)

⚠️ **Piège** : `tauri dev` ET `tauri build` réutilisent le MÊME identifiant → même base SQLite (`~/Library/Application Support/com.tosse.desktop/`). Un build de test lancé tel quel **écrase les données de prod**.

**Règle** : donner un nom + identifiant DISTINCTS à tout build de test.
- Override au build : `tauri build --config` (overlay JSON `productName`/`identifier`), SANS modifier `tauri.conf.json` committé (qui reste la config prod).
- Fichier de référence : `src-tauri/dev-build.conf.json` (`productName` "Tosse Code dev build", `identifier` `com.tosse.desktop.dev`).
- ⚠️ `open` sur une app DÉJÀ lancée ne recharge PAS le nouveau binaire (il ne fait que la ramener au premier plan) → après un rebuild, tuer l'instance en cours (`pkill -f "<productName>"`) puis `open -n` pour charger le binaire fraîchement buildé.
- Skills `/build-app` (feature en worktree, identifiant `com.tosse.desktop.<slug>`) et `/build-dev` (worktree principal sur dev, identité fixe `com.tosse.desktop.dev`) automatisent ça ; `/land` purge l'identité `com.tosse.desktop.<slug>` du build de feature.

## Branches & gouvernance

- **`main`** : protégée. Tout passe par PR. PR doit : (1) check `test` vert (CI), (2) approuvée par `@Alex375` (code owner — `.github/CODEOWNERS`), (3) conversations résolues. Force-push & suppression interdits.
- **`dev`** : branche de travail. Push libre. Pas de CI sur push dev.

Flux : feature branch → `dev` → PR `dev → main` → CI → Alexandre approuve + merge.

`enforce_admins=false` : Alexandre (admin) peut merger ses propres PR. Tout autre collaborateur gated derrière son approbation.

Accès : `Alex375` (admin), `clousty8`/Armand (write — push dev + ouvrir PR ; ne peut PAS merger dans main sans approbation d'Alexandre ni produire de release).

⚠️ Agents : **ne jamais `git push origin main` en direct** — committer sur `dev` ou une branche de feature et ouvrir une PR.

## Versioning & releases

SemVer `MAJEUR.MINEUR.CORRECTIF` (en `0.y.z` : MINEUR = nouveauté, CORRECTIF = fix). **3 fichiers synchro** : `src-tauri/tauri.conf.json` (vérité runtime), `package.json`, `src-tauri/Cargo.toml` + `Cargo.lock`. Bumper via `pnpm bump <patch|minor|major|X.Y.Z>` — jamais à la main.

**Release** : workflow `.github/workflows/release.yml`, 100 % manuel (`workflow_dispatch`) depuis `main`. Bundle macOS universel (Apple Silicon + Intel), publication directe (`releaseDraft:false`). Seul `Alex375` déclenche (job `authorize`) ; refus si version déjà releasée. Notes = section `## vX.Y.Z` de `CHANGELOG.md` (remplie par le skill `/release` au bump) + `<!-- gh-only -->` + note d'install Gatekeeper ; l'app n'affiche QUE la partie avant le marqueur (`inAppReleaseNotes`, `store/updater.ts`).

**Signature macOS (self-signed)** — but : DR stable (`identifier + certificate leaf`) → TCC conserve les autorisations de dossier entre versions.
- ⚠️ **DR-CRITIQUE : ne JAMAIS réémettre le certificat « Tosse Code Self-Signed »** (~20 ans, backup `~/TosseCodeSigning.p12`) — expiration / CN différent / nouvelle clé = nouvelle DR = re-grant TCC global pour tous les utilisateurs.
- Secrets repo : `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`. `release.yml` fait `security add-trusted-cert` (Tauri refuse un self-signed non trusté) ; l'étape build ne reçoit QUE `APPLE_SIGNING_IDENTITY`. `bundle.macOS.hardenedRuntime:false` (le défaut casse le WebView ; pas de notarisation).

**Auto-update** (`tauri-plugin-updater` + `-process`) : check au lancement + toutes les 2 h → download → vérif signature → `relaunch()`. ⚠️ Clé privée `TAURI_SIGNING_PRIVATE_KEY` + backup `~/.tauri/tosse-code-updater.key` — **NE PAS la perdre** (sinon plus aucune MAJ signable). `createUpdaterArtifacts:true` ; données (SQLite + transcripts) hors bundle, préservées. « Mettre à jour et redémarrer » → TOUJOURS `ConfirmDialog` (redémarrage interrompt les sessions live).

## IDs MCP (entités TOSSE associées à ce repo)

- `repository_id` : `8c509e62-30cb-4f58-9074-086bac72528d`
- `project_id` (Tosse Code) : `ef02be22-fe30-4463-9450-ec3b20746a35`

## Artefacts (gestion + aperçu) — LIVRÉ

Gestion + aperçu des pages produites par l'outil **`Artifact`** de Claude (HTML/MD hébergées `claude.ai/code/artifact/<uuid>`, privées par défaut). Contrat wire : `tool_use{name:"Artifact"}` porte `file_path` (dir TEMP éphémère), `description`, `favicon`, `label` ; le `tool_result` texte porte l'URL canonique ; republier le même `file_path` garde l'URL + ajoute une version.
- **Dérivation FRONT pure** (`features/conversation/artifacts.ts`, zéro Rust/IPC/SQLite) : scan des `tool_use{name:"Artifact"}` joints à leur `tool_result`, **main-thread only** (`parentToolUseId===null`), **groupé par `file_path`**, header last-known-good, exclut les publications entièrement en échec, **strictement read-only** vers claude.ai. Survit au reload gratuitement.
- **Surfaces** : `ArtifactCard` inline (états pending/failed/degraded, zéro-erreur-silencieuse), chip composer « Artefacts (N) », `ArtifactRefCard` (URL en prose → pilule), segment `artifact` dans `toolGroup.ts`.
- **Aperçu `ArtifactViewer`** (panneau droit) : HTML en `<iframe srcDoc sandbox="allow-scripts allow-popups">` (⚠️ possible car la CSP de l'app = `null` — fait réutilisable pour tout rendu web embarqué), Markdown via `StreamMarkdown`, fallback navigateur si le fichier temp a disparu ; région `artifactView` en mémoire (non persistée). Détail : mémoires `artifact-tool-wire-contract`, `artifacts-panel-audit`.

## Ordre manuel (drag-and-drop) des conversations/repos — LIVRÉ

Réordonnancement manuel sidebar ET Flight Deck, avec option de figer le tri auto (récence côté sidebar, statut-puis-récence côté Flight Deck). Onglet Réglages **« Reordering »**, **5 prefs `tosse:display`** (`autoOrderSidebarConvs/Repos`, `autoOrderFleetConvs/Repos`, `sharedManualOrder`, défaut `true` = historique).
- **Lib @dnd-kit** (~15 kb) ; **TOUTE la carte/ligne est la surface de drag** (pas de poignée — exigence Alexandre), seuil 6px (`PointerSensor`), clic post-drag avalé (`guardReorderClick`). DragOverlay portalé côté Flight Deck (clip `.ag-grid`).
- **Persistance localStorage `tosse:manualorder`, PAS SQLite** (décision structurante : partagé/indépendant impose 2 ordres qu'une colonne `sort_index` ne peut porter → blob `{shared,sidebar,flightdeck}`) → zéro Rust/migration/bindings. Mode manuel = ordre FIGÉ, nouveaux éléments en tête ; drag en mode récence = éphémère.
- Modules `store/manualOrder.ts` (helpers purs `manualComparator`/`manualIndex`) + `ui/orderDnd.ts` (`useSurfaceOrderDnd`, `orderCollisionDetection` confine les convs à leur repo). Mémoire `manual-order-dnd-feature`.

## Connexion TOSSE (CRM) + vue Tâches — LIVRÉ

Le CRM TOSSE = **3ᵉ connexion** de l'app (authentifie l'HUMAIN à ses données, pas un agent à un modèle). **App entièrement utilisable sans elle** — déconnecté, l'onglet TOSSE n'existe pas et rien n'est fetché. Mécanique OAuth/Keychain/erreurs : module `tosse/` (cf. « Structure »).
- **Association dossier ↔ dépôt CRM** : un pin MANUEL gagne, sinon le remote `origin` est comparé aux urls CRM via `normalize_remote_url`. ⚠️ **Jamais par NOM** (données réelles : `CRM_max` s'appelle « TOSSE » au CRM). ⚠️ `resolve_links` PUR, prend `Option<&[…]>` : **`None` = « on n'a pas pu regarder », AUCUN verdict** (≠ `Some(&[])` = « regardé, CRM vide ») — sinon on annonce à l'utilisateur que SON dépôt a été supprimé pendant une panne, bouton destructif pour seule issue. Un pin cassé est surfacé, jamais replié en silence sur la devinette du remote. 3 issues ordinaires (`RemoteLookup`) : url / pas de remote / pas un dépôt (Flight Deck ouvre des dossiers, pas que des clones).
- **Où travaille un projet** : clé = le PROJET (table `tosse_project_repos`, migration **v8**, `ON DELETE CASCADE`). Rien ne résout → `scan_local_git_repos` propose les clones du Mac. Migrations **v6** `repos.tosse_repository_id` (pin), **v7** `conversations.tosse_task_id/_title/_status`. ⚠️ **Aucune n'est une FK** (ids du CRM ; une entité supprimée serveur doit DÉGRADER, pas corrompre la ligne). ⚠️ `tosse_repository_id` écrit UNIQUEMENT par `set_repo_tosse_link` et HORS de `RepoRecord` (sinon `upsert_repo`/ses appelants l'effacent).
- **Conversation ↔ tâche** : « Start » passe par le skill **`/pickup`** du dépôt (l'app n'écrit jamais le statut — c'est le skill qui met « En cours »). ⚠️ Le nom du skill n'est **jamais deviné** : un skill de plugin est qualifié (`tosse-workflow:pickup`), un skill de projet est nu → sans catalogue on envoie des instructions rédigées. « Discuss » colle la tâche dans le prompt. Lien écrit AVANT l'envoi ; titre/statut **dénormalisés** sur la conversation (re-stampés par `refreshLinkedTaskMeta`, depuis le fetch).
- **Écritures** (statut tâche/projet, création) OPTIMISTES avec rollback complet (`cancelQueries` d'abord). ⚠️ La création refetch sur **`onSettled` PAS `onSuccess`** (une création peut échouer AU RETOUR alors que la tâche existe → refetch onSuccess la rendait invisible → double dépôt). Le reste (titre/priorité/assignation/échéance/suppression) renvoyé au CRM en navigateur (origine dérivée de l'`authorization_endpoint`).
- **Confidentialité — logos clients** : opt-in **`tosseClientFavicons`, OFF par défaut** (activer envoie à Google le domaine de chaque client affiché + l'IP). ⚠️ Distinction à garder : un favicon de résultat de recherche web (déjà résolu sans opt-in) est un site public que le modèle vient de consulter ; les clients TOSSE ne le sont pas. OFF → cascade logo → initiales, 100 % locale.

## Mode « Bypass permissions » (opt-in) — LIVRÉ

`bypassPermissions` ne **tient** que si le process est spawné avec `--allow-dangerously-skip-permissions` (sinon le binaire rétrograde silencieusement en `default`) → opt-in app-wide (`permissions.ts`, localStorage, **OFF par défaut**) → `SpawnConfig.allow_bypass_permissions` → flag au spawn.
- ⚠️ **`--allow-dangerously-skip-permissions` (avec `--allow-`) DÉVERROUILLE le mode sans l'activer** — à ne pas confondre avec `--dangerously-skip-permissions` (qui l'allume d'office).
- Rétrogradation appliquée **EN AMONT** (`control::permission_mode_for_spawn`) → mode spawné, ré-assertion post-init et vue CLI cohérents. Déverrouillage **au SPAWN seulement** : `conv.bypassAllowed`/`bypassBlockedReason` distinguent « activez-le dans les Réglages » vs « redémarrez cette conversation ».
- Éteindre l'option = immédiat et total (`demoteBypassConversations()` repasse tout en `default`, sessions vivantes comprises). ⇧Tab ne cycle **jamais** sur bypass (choix explicite au menu, comme le terminal Claude Code).

## MCP servers hébergés — pilotage de l'app par les agents — LIVRÉ

L'app HÉBERGE deux serveurs MCP. Module `src-tauri/src/appmcp/` (hub, router JSON-RPC, catalogue, journal, transport HTTP voix) — UN registre de tools, DEUX transports :
- **In-process `"flightdeck"`** (agents DANS l'app, Claude-only — Codex n'a pas de canal SDK) : annoncé par session via `initialize.sdkMcpServers` (array de NOMS, binaire 2.1.233) quand spawnée avec le hub (pref `agentServer`, ON, lue au spawn). Handshake via `control_request{subtype:"mcp_message"}` → `router.rs` → `{mcp_response:<JSON-RPC>}` (notification → ack). Sender outbound FAIBLE (`downgrade()` — un fort défaisait l'EOF-gracieux du teardown), sur `tokio::spawn`. ⚠️ VÉRIFIÉ live : les tools SDK-MCP passent par `can_use_tool` (`mcp__flightdeck__<tool>`) → gatés par les permissions existantes.
- **Voice bridge HTTP** (client EXTERNE, ex. agent vocal) : streamable HTTP fait main (`TcpListener`), `POST /mcp` (simple/batch), **loopback UNIQUEMENT + Bearer constant-time** + garde Origin, deadline 90 s, coupure des connexions en vol au stop, `apply_voice` attend l'ancienne accept-loop avant de re-binder (anti-EADDRINUSE). Config Rust-owned SQLite `meta` (port 7068, token uuid4).

**Exécution 100 % FRONT** (`AppControlRequestEvent` → exécuteur `src/agent/appControl.ts` pur/testé + host `AppControlHost` → `app_control_respond`, timeout 30 s), bâtie SUR les actions existantes. Catalogue : `list_conversations`/`read_conversation`/`send_message`/`create_conversation`/`focus`/`rename`, in-app `whoami`/`add_repo`/`open_file`/`open_view`/`open_panel`/`notify_user`, voix `wait_for_events` (long-poll journal, ⚠️ retour vide = curseur de l'appelant INCHANGÉ). ⚠️ **Liste noire testée** : jamais permission mode / remote control / delete / wipe / rewind / fork / écriture terminal. Détail : mémoire `appmcp-hosted-servers-wire`. Le **relais mobile** (phone PWA) réutilise ce socle — cf. mémoire `flightdeck-remote-wire`.

## Agent vocal « Ground Control » (OpenAI Realtime) + wake word — LIVRÉ (sur `dev`)

Agent vocal in-app + déclenchement mains-libres, 100 % local pour le réveil. **OpenAI strictement optionnel** : sans clé l'app marche, la clé ne déverrouille que le vocal. Front `src/voice/` + Rust `src-tauri/src/voice/` (SEUL détenteur de la clé OpenAI) + `src-tauri/src/wake/` (wake word local).
- **Voix (OpenAI Realtime, WebRTC/GA)** : `voice/realtime.ts` = session hors React (comme `termManager` : les composants rendent l'état de `voiceStore`, ne possèdent pas la connexion). Modèle 2 couches : **mode armé** (session ouverte, micro FERMÉ, exchange nul → reste up pendant le travail) ↔ **micro** ouvert/fermé DANS la session. Rust forge des **secrets éphémères** (`/v1/realtime/client_secrets`) → le webview ne voit jamais la clé (Keychain « Flight Deck OpenAI » suffixé par identité de build). Outils = sous-ensemble du catalogue appmcp (`VOICE_TOOL_NAMES`, dont `get_pending_request`/`answer_request` pour répondre aux questions/permissions par la voix) + `end_call`. **Annonces proactives** = mêmes events settled que les notifs OS (`announce.ts`, file plafonnée, drain séquentiel, jamais par-dessus une réponse active). Garde coût : auto-close sur silence RÉEL (réarmé sur l'activité vocale VAD, jamais mid-monologue). Un refus micro sur une annonce dégrade en « speak-only » (ne détruit pas la session). Réglages → Control carte **« Ground Control »** : clé, annonces, PTT (⌘ droit / ⌘⇧V), seuil VAD, « Answer by voice » (opt-in ON), wake word.
- **Wake word** (`wake/`, openWakeWord + Silero VAD via `ort`/ONNX statique, modèles bundlés `include_bytes!`) : phrases `alexa`/`hey_jarvis` (pré-entraînées, défaut) + **« Ground Control »** (custom, entraîné LOCALEMENT via macOS `say`, sans cloud). Pipeline en détection continue → `WakeWordEvent` → `VoiceHost` ouvre le micro.
- ⚠️ Verrous release V2 encore ouverts : `getUserMedia` en WKWebView à confirmer ; robustesse du wake sur voix humaine réelle (accent FR) non prouvée ; follow-ups CPU (re-gate duty-cycle) / faux positifs du wake. Détail complet : mémoire `voice-agent-realtime-design` (+ `wake-word-custom-phrase-training`, `flightdeck-v2-crm-structure`).

## [GENERATED] Associated Project Contexts

---
**Project: Tosse Code**
# Tosse Code — Desktop app pour piloter Claude Code

## Vision
Logiciel desktop interne pour utiliser Claude Code de manière optimisée pour notre workflow. Aujourd'hui on a (a) Claude Code en terminal et (b) l'app Claude Code, mais aucun n'est bien optimisé pour notre usage. Objectif : un seul outil qui combine une vue propre du code + une conversation propre + (surtout) la gestion de plusieurs agents Claude Code en parallèle, le tout pilotable par Claude lui-même.

## Principe directeur : performance
Le logiciel doit être **rapide et très optimisé** — c'est une exigence cœur, non négociable. Tous les arbitrages techniques se tranchent en faveur de la perf (cœur natif, pas de surcouche lourde). C'est la raison d'être des choix de stack ci-dessous.

## Principe directeur : réversibilité & contrôle utilisateur (options/réglages)
Dès qu'on **ajoute une fonctionnalité** ou qu'on **change une fonctionnalité existante d'une manière qui altère vraiment l'expérience utilisateur**, on laisse à l'utilisateur le moyen de **l'activer / le désactiver**, donc de **revenir au comportement précédent**. Par défaut, dès qu'on peut exposer un réglage utile sur ce qu'on fabrique, **on le fait**.

⚠️ **La distinction est essentielle** : ce principe vise les **vraies features / vrais changements de comportement voulus**, **PAS les corrections de bugs** ni les petits ajustements qui *règlent* un problème. Un bugfix (un rendu qui affichait mal, un parsing qui tronquait, une carte au lieu d'une ligne illisible…) ne mérite **pas** de toggle — on corrige, point. On n'ajoute un réglage que quand le changement modifie **délibérément ce que vit l'utilisateur**, pas quand il répare ce qui était cassé ou améliore à la marge.

Règle de décision quand on hésite : **ne pas trancher seul**. Si on ne sait pas si un changement relève de la feature (→ toggle) ou du bugfix (→ pas de toggle), où placer l'option, ou quel doit être son défaut, on **le demande ou le suggère explicitement à l'utilisateur** avant de figer le comportement.

Le *mécanisme concret* (page Réglages à onglets, préférences `tosse:display` en localStorage, briques `ToggleRow`/`SettingsGroup`) vit au niveau du contexte **repo** : ce principe dit *qu'il faut* une option ; le repo dit *comment* la câbler.

## Structure générale de l'UI (grandes lignes)
Deux vues principales :
1. **Vue Gestion d'agents** — l'aperçu de tous les agents en cours.
2. **Vue Conversation** — la discussion avec un Claude Code. Depuis cette vue, on peut **ouvrir un panneau latéral (à droite)** qui contient l'arborescence des fichiers / l'architecture du projet, le fichier ouvert, et un terminal.

## Stack technique (décisions structurantes)
- **Shell desktop : Tauri 2** (webview de l'OS, pas de Chromium embarqué) — choisi pour la perf/légèreté vs Electron. Validé avec Alexandre (à l'aise en Rust).
- **Cœur en Rust** (superviseur, conversation, persistance) ; **UI en React/TS** dans le webview. Architecture en 3 couches : UI React ↔ cœur Rust ↔ binaire `claude` (×N).
- **Pilotage de Claude Code via le protocole stream-json persistant** — pas `claude -p` (one-shot), pas l'API HTTP. C'est le binaire CLI piloté en stdio structuré → « par terminal » respecté, abo Max conservé.
- **Ne PAS forker** VS Code ni l'extension : on réimplémente *clean-room* en Rust le client du protocole de l'extension officielle (disséquée). On réutilise le substrat de rendu (Monaco = éditeur, xterm.js = terminal), mais on écrit le **cœur** nous-mêmes.
- Détails de stack, crates et protocole : voir le contexte **repo** (tosse-code).

## Frontière build vs réutilisation
- **On écrit nous-mêmes (c'est le produit)** : superviseur de flotte, client du protocole stream-json + canal de contrôle, machine à états des agents, orchestration des git worktrees, persistance, intégration TOSSE.
- **On réutilise (substrat de rendu, zéro différenciation produit)** : Monaco, xterm.js, le rendu markdown/diff/code en React.
- **On ne réimplémente PAS** le moteur d'agent de Claude : le binaire `claude` reste une boîte noire pilotée par son protocole stdio ; on construit tout autour. Le réécrire = perdre l'abo Max et toutes les améliorations futures du CLI.

---

## MVP (Phase 1) — état d'avancement

### [LIVRÉ] Stream / Conversation Claude Code
Protocole stream-json implémenté en Rust (clean-room). Session bidirectionnelle persistante, canal de contrôle, normalisation des messages, rendu React propre inspiré VS Code.

### [LIVRÉ] Éditeur de texte léger
Panneau latéral avec arborescence des fichiers + éditeur Monaco, lazy-loadé (code-split). Watch fs live, rooté sur le cwd courant (suit les worktrees).

### [LIVRÉ] Terminal
Terminal PTY intégré dans le panneau latéral via xterm.js + WebGL. Service Rust `terminal/` encapsulé (portable-pty), commandes IPC `terminal_open/write/resize/close`. Instances xterm persistantes par conversation (survivent au switch de panneau). Lazy-loadé (code-split, hors bundle de démarrage).

### [LIVRÉ] Vue Gestion d'agents (Flight Deck)
Swimlanes par dépôt, scroll vertical/horizontal, état live de chaque agent (busy/attention/idle), AttentionBar, notifs OS + son + rebond Dock.

---

## Phase 2

- **MCP server qui contrôle l'IDE** : Claude peut piloter l'app via un MCP server (cf. cas d'usage ci-dessous).
- **Explorateurs Skills / Plugins / MCP** actifs dans le projet et par scope : vision générale des skills + vision pour le repo, quelque chose de propre.
- **[LIVRÉ] Client Git** (amélioration) : indicateur worktree actif, badge sidebar, gestionnaire modale des worktrees.
- **[LIVRÉ] Éditeur de texte enrichi** : coloration syntaxique via highlight.js (lazy), rendu Markdown en 3 modes (Classic / Warm / Minimal), chip de chemin de fichier segmenté, tableaux stylés.
- **Visualisation d'images** : pouvoir ouvrir des images.
- **Association des conversations à TOSSE** : chaque conversation est associée à une tâche TOSSE et à un projet.
- **[LIVRÉ] Remote control natif** : activation d'un bridge vers claude.ai/code + app mobile via le canal de contrôle stream-json (`control_request{remote_control}`).
- **[LIVRÉ] Mode Clean output** : repli du travail intermédiaire de Claude par round derrière un bloc dépliable, avec état mémorisé par conversation (localStorage).
- **[LIVRÉ] Barres de tâches de fond** : BashBar, MonitorBar, WorkflowBar — barres épinglées au-dessus du composer pour les tâches run_in_background, avec stop, tail live et vue workflow détaillée.
- **[LIVRÉ] Menu slash-commands** : catalogue des commandes `/` du composer issu du `initialize` control_response, groupé par scope (projet / builtin / plugin), rafraîchi après `/reload-skills`.

### Cas d'usage du pilotage par Claude (MCP server)
Tout le logiciel doit être pilotable par les agents via un MCP server exposant les actions de l'UI comme tools. Exemples :
- « Ouvre-moi la page Git » → l'agent ouvre la vue Git.
- « Ouvre-moi le commit dont tu parles » → l'agent ouvre ce commit.
- « Ouvre-moi le fichier que tu viens d'écrire » → l'agent ouvre le fichier **à la bonne ligne**.
- … navigation entre vues, ouverture de diff, focus sur un agent, lancement de tâche, etc.
Principe : chaque action significative de l'UI a un équivalent appelable par un agent.

---

## Phase 3 (plus complexe)

- **Intégration TOSSE complète** : liste des projets et des tâches dans l'app ; on clique sur une tâche → **ça démarre directement un agent Claude Code dessus** (comme une conversation classique).

---

## Points ouverts / à cadrer
- Designs Claude Design (gestion d'agents) : à intégrer plus tard, Alexandre les fournira.
- Périmètre exact des actions exposées par le MCP server de pilotage : à lister (Phase 2).

## Organisation
- Phase 1 **complète** — les 4 livrables (Conversation, Éditeur, Terminal, Vue Gestion d'agents) sont implémentés et mergés sur dev.

---
**Active Mission: Développement TOSSE** (En cours, assigned to Les deux)
Développement complet des outils internes pour Alexandre et Armand (freelancers) :
- **CRM TOSSE** : backend API, frontend web, serveur MCP, plugin Claude Code, déploiement cloud.
- **App desktop tosse-code** : application desktop pour piloter Claude Code de manière optimisée (plusieurs agents en parallèle, éditeur intégré, terminal, Flight Deck).

Spec de référence CRM : `Cahier_des_charges.md` (v1.3, mars 2026) — document autoritatif pour toutes les fonctionnalités et comportements attendus.

---
**Client: Interne**
Alexandre Josien et Armand Mounsi, deux ingénieurs informatique freelances travaillant en binôme.

## Services proposés
- **Développement logiciel** : prototypage rapide / MVP, développement IA / algorithmes complexes, architecture technique
- **Conseil** : automatisation, architecture, audit technique
- **Formation** : intelligence artificielle, Claude Code, outils IA pour développeurs

## Domaines de prédilection
1. Prototypage rapide — résultats très vite, très bien, pas cher
2. Développement nécessitant un vrai ingénieur (IA, algorithmes complexes, architecture)
3. Formation IA (notamment Claude Code)
4. Conseil en automatisation

## Modèle de travail
- Flexibilité : plusieurs contrats en parallèle
- Binôme complémentaire, livraison rapide et efficace
- Préfèrent le distanciel, acceptent le présentiel ponctuel (1-3 semaines)
- Refusent les contrats longs sur site (incompatible avec le modèle multi-contrats)

## Ressources techniques
- Abonnement Max Claude Code
- Clé API OpenAI
- Hébergement Railway
