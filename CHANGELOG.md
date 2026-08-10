# Changelog

What's new in each version, **shown in the app** when it updates.

Convention: one `## vX.Y.Z` section per version (most recent on top), with short,
**user-oriented** bullets — no internal technical details. The `/release` skill
automatically adds the new version's section from the commits; `release.yml` reads
that section and uses it as the GitHub release description, which the app displays
as-is. The install instructions block (after the `<!-- gh-only -->` marker) is added
by `release.yml` and stays **only** on the GitHub page — it does not appear in the app.

## v1.6.0

- New: zoom the whole interface — a Settings slider plus ⌘+ / ⌘− / ⌘0, working on French AZERTY keyboards too.
- New: a minimap of your own messages down the side of a conversation — hover to preview, click to jump. It follows you into the History panel and the Flight Deck modal.
- New: customize the composer bar — choose which controls it shows and in which order, so it carries what you actually use.
- New: the model menu is now built from the CLI itself instead of a hardcoded list, so a newly released Claude shows up without waiting for an app update.
- Improved: the Flight Deck reply modal now zooms out of its card and back into it, so you never lose track of which conversation you opened.
- Improved: Stop is unambiguous again — it interrupts the turn, and a queued message can be deleted straight from its own bubble instead of being silently swept along.
- Improved: in the TOSSE view, "Start" no longer throws you out of the task list, tasks in Review gained a one-click "Done", and running workflows now show their live progress.
- Changed: client logos fetched from the web are now ON by default. Clients with no logo in the CRM are marked with their website's favicon, which means asking Google for that domain — switch it off in Settings → TOSSE to stay fully local.
- Fixed: no more "done" chime when the conversation picks straight back up on its own.

## v1.5.0

- New: connect the app to your TOSSE CRM — sign in from Settings → TOSSE, and link each local folder to its TOSSE repository.
- New: a "TOSSE Tasks" view listing your projects by client and their tasks, readable and editable from the app — with a Backlog section folded by default and an "Open in TOSSE" shortcut.
- New: start working on a task straight from the TOSSE view — it opens a conversation on the right repository.
- New: a setting to unlock the "Bypass permissions" mode, for when you deliberately want the agent to run without asking.
- New: an off-by-default setting to fetch client logos from the web. Clients without a logo in the CRM show their initials; switch it on and Flight Deck asks Google for their website's favicon instead — which means telling Google their domain, so it is your call to make.
- Improved: sub-agent text now streams live. Drilling into a running sub-agent shows its prose and reasoning as it happens, instead of only its tool calls; a reconnection indicator tells you when the link is being re-established.
- Fixed: a permission request withdrawn by the CLI no longer leaves a dead card that swallows your next click.

## v1.4.0

- New: Opus 5 and Sonnet 5 in the model menu, and Sonnet 5 now offers the "Extra" reasoning effort — and with it Ultra code — which the previous Sonnet didn't accept.
- New: keep the Claude Code CLI up to date from inside the app. A banner tells you when a newer `claude` binary is published, and Settings → Updates gained a "Claude Code CLI" card: installed version, one-click update, and a switch for the CLI's own background auto-updater. The tab now shows both updaters side by side — Flight Deck, and the CLI it drives.
- New: when you set a goal with `/goal`, it now shows up in the thread as its own card instead of being sent silently — so you can see the goal you just set.
- Improved: when the agent asks you a multiple-choice question, the question and the answer you picked now appear as their own card in the thread — the exchange stays readable instead of being folded away with the intermediate work.

## v1.3.0

- New: arrange your conversations and repositories by hand — drag them anywhere (the whole row or card, no handle) in the sidebar or on the Flight Deck. A new "Reordering" settings tab lets you freeze the automatic order per view; new items still land on top and your order is kept across restarts.
- Fixed: file paths stay clickable everywhere — the "clickable file paths" setting now only controls the filename on Read/Write/Edit rows, not paths in text, file links or snippet headers.
- Fixed: any open tab — text, image or PDF — now stays in sync when an agent rewrites the file on disk.
- Fixed: content the CLI injects into a conversation no longer appears as a message you sent.

## v1.2.0

- New: the active goal (`/goal`) is now displayed — on Flight Deck cards and at the top of the conversation — so you always see what an agent is working toward.
- New: artifacts published by Claude are collected per conversation — an "Artifacts" chip in the composer lists them, and each one shows up inline in the thread.
- New: usage limits that apply to a single model (such as Fable's weekly allowance) now appear in the usage popover, next to the 5-hour and weekly limits.

## v1.1.2

- Fixed: Claude usage now shows both the 5-hour and weekly limits whenever they exist, instead of only one at a time.

## v1.1.1

- Fixed: file links Codex writes in a conversation are now reliably clickable — a click opens the file at the right line, independent of the "clickable file paths" setting.

## v1.1.0

- New anti-sleep control: keep your Mac awake while agents work, with Light and Hard modes, from a toolbar button.
- The "Thinking…" indicator now uses playful, escalating words the longer an agent thinks.
- Open files now refresh correctly when you come back to a conversation.
- Markdown file links from Codex are now clickable.
- The disabled 5-hour window no longer shows up in Claude usage.

## v1.0.0

Flight Deck reaches 1.0 — the headline is Codex.

- Codex (OpenAI) is now supported. When you create a conversation you pick the model between Claude and Codex; the conversation stays on that backend, with its background tasks, sub-agents, and History panel entries all handled just like Claude.
- The whole app is now in English.
- New on Flight Deck cards: delete a conversation straight from its card, stream controls (clean output, start/restart/stop) in the reply modal, and an importance rail that surfaces the cards needing a look.
- AI provider account management: sign in to your OpenAI and Claude accounts from the app and see each one's connection status at a glance.

## v0.28.0

- New PDF viewer built into the editor: zoom, fit-to-width, open in read-only mode.
- Web and markdown links are now clickable in the Flight Deck preview.
- In the conversation, a screenshot read by the agent shows as an image preview instead of its base64 code.
- New "clickable file paths" setting (on by default).
- The background-tasks setting has moved to the General tab of Settings.

## v0.27.0

- Turn duration shown in the conversation, with a live counter while the agent works and a per-item breakdown (model, thinking, tools).
- Interactive Flight Deck cards: task list, context, effort, and to-do stacks viewable directly.
- Plugins and slash-commands of active conversations reload automatically when you enable/disable them.
- An agent that finishes while a background task is running now turns green ("background task running") instead of a misleading "to review" state.
- Fix: sub-agents' internal prompts no longer show up as your own messages in the thread.

## v0.26.0

- More reliable sound notifications: the agent-finished chime fires again even after watching a video or changing the Mac's audio output.
- A new installer renames the bundle to **Flight Deck.app** on first launch.

## v0.25.0

- The app is now called **Flight Deck** and sports a new logo.
- New on-hover message controls: rewind the conversation from a message, or branch off into a new one (fork).
- A floating pin shows your last sent message at the top of the thread.
- Messages keep their line breaks, and the last-message preview ignores internal notifications.
- Fix: a stale usage token no longer hides the balance from the Keychain.

## v0.24.0

- Flight Deck: clickable cards with pop-ups (conversation, last message, to-do) and an enriched overview of the agent fleet.
- Alert when an agent has finished, even if it was running in the background; internal task notifications no longer clutter the thread.
- Composer "+" button: attach files and images to a message.
- Redesigned Settings page, with a keyboard-shortcuts summary (and new shortcuts).
- Confirmation before deleting a **running** conversation (inactive conversations still delete in one click, undoable with ⌘Z).
- Reworked update page: readable version highlights, and a clear warning before restart — including the number of running conversations that will be interrupted.
