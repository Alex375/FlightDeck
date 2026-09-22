// The Settings search index and its matcher.
//
// The panel now spans a dozen tabs, several of them split into sub-tabs, so
// "where was that switch again?" had become a hunt. This module is the answer:
// a flat list of what the panel offers, and a pure scorer over it.
//
// ⚠️ `title` is not decoration — it is the KEY the highlight matches on
// (`SettingsKit.useSearchHighlight` compares it to the row's visible title). An
// entry whose title drifts from its row degrades gracefully: the search still
// takes you to the right tab, it just doesn't flash the row. `section` and `sub`
// ARE checked by a unit test, because landing on a tab that doesn't exist would
// leave the user staring at an empty page.
//
// Keywords carry the words people actually type, including French ones — the UI
// is English, the users are not.
import type { SettingsSection } from "../../store/settingsUi";

export interface SettingEntry {
  /** The visible row (or card) title, verbatim — also the highlight key. */
  title: string;
  /** The rendered row/card title to flash instead of `title`, for a result that names a
   *  control with no titled row of its own (a label inside a card). */
  flash?: string;
  /** The tab it lives in. */
  section: SettingsSection;
  /** Its sub-tab, for the sections that have them. */
  sub?: string;
  /** The card it sits in — shown as the result's breadcrumb. */
  group: string;
  /** Extra words to match on: synonyms, French, related jargon. */
  keywords?: string;
}

/** The sub-tabs of the sections that split their cards (kept here so the search
 *  and the panel agree on the ids — the test cross-checks the index against it). */
export const SETTINGS_SUBS: Partial<Record<SettingsSection, readonly string[]>> = {
  general: ["accounts", "system"],
  display: ["appearance", "thread", "timing", "composer", "models", "ide", "order"],
  claudeCode: ["instructions", "behavior", "helpers"],
  control: ["agents", "voice", "remote", "bridge"],
  notifications: ["channels", "fleet", "background"],
};

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // ---- Display (Appearance / Thread / Durations / Composer / Models / IDE / Order) ----
  { title: "Interface zoom", section: "display", sub: "appearance", group: "Appearance", keywords: "scale text size bigger smaller zoom police taille display affichage" },
  { title: "Clean output (default)", section: "display", sub: "thread", group: "Thread", keywords: "fold work block hide tools sortie propre repli display affichage" },
  { title: "Background task notifications", section: "display", sub: "thread", group: "Thread", keywords: "task-notification messages thread display affichage" },
  { title: "Preview of the last sent message", section: "display", sub: "thread", group: "Thread", keywords: "pin last message apercu dernier message display affichage" },
  { title: "Conversation side panel", section: "display", sub: "thread", group: "Thread", keywords: "sidebar panneau lateral droite todo goal artifacts artefacts tosse task tache worktree stream header display affichage" },
  { title: "Message minimap", section: "display", sub: "thread", group: "Thread", keywords: "scrollbar map jump navigation display affichage" },
  { title: "Live workflow on the Flight Deck card", section: "display", sub: "appearance", group: "Appearance", keywords: "workflow card phases display affichage" },
  { title: "Per-agent detail in the workflow view", section: "display", sub: "appearance", group: "Appearance", keywords: "workflow agents phase live detail agents display affichage" },
  { title: "Zoom when opening a card", section: "display", sub: "appearance", group: "Motion", keywords: "animation motion modal flight deck display affichage mouvement" },
  { title: "Slide side panels open", section: "display", sub: "appearance", group: "Motion", keywords: "animation motion panel editor terminal display affichage mouvement" },
  { title: "Animate the conversation", section: "display", sub: "appearance", group: "Motion", keywords: "animation motion thread display affichage mouvement" },
  { title: "Message controls", section: "display", sub: "thread", group: "Thread", keywords: "rewind fork hover controls rembobiner display affichage" },
  { title: "Clickable filename on Read/Write rows", section: "display", sub: "thread", group: "Thread", keywords: "file mention path link chemin cliquable display affichage" },
  { title: "Show hosted artifacts in Flight Deck", section: "display", sub: "thread", group: "Thread", keywords: "artifact artefact claude design canvas claude.ai webview browser navigateur panel panneau" },
  { title: "Time on sidebar rows", section: "display", sub: "timing", group: "Durations & timing", keywords: "sidebar row timer counter chrono temps ligne conversation barre laterale" },
  { title: "Turn duration", section: "display", sub: "timing", group: "Durations & timing", keywords: "time elapsed seconds duree tour" },
  { title: "Model time", section: "display", sub: "timing", group: "Durations & timing", keywords: "api duration breakdown" },
  { title: "Thinking time", section: "display", sub: "timing", group: "Durations & timing", keywords: "reasoning reflexion duration" },
  { title: "Tool time", section: "display", sub: "timing", group: "Durations & timing", keywords: "bash read edit duration outils" },
  { title: "Allow Bypass permissions mode", section: "claudeCode", sub: "behavior", group: "Permissions", keywords: "dangerously skip permissions bypass yolo" },
  { title: "Output style", section: "claudeCode", sub: "behavior", group: "Output style", keywords: "writing tone concise explanatory style sortie ton" },
  { title: "Keep the Mac awake", section: "general", sub: "system", group: "Caffeinate", keywords: "sleep veille caffeinate energy" },

  // ---- General (Accounts / System) + TOSSE --------------------------------
  { title: "Accounts", section: "general", sub: "accounts", group: "Accounts", keywords: "claude codex openai login sign in connexion compte" },
  // Multiple Claude accounts: a grid of account tiles (each with its own rate-limit rings),
  // then the Switching group. Tiles are not rows, so the tile entries only land on the right
  // tab; the threshold steppers are labels inside the Switching card, so they flash the card.
  { title: "Claude accounts", section: "general", sub: "accounts", group: "Claude accounts", keywords: "multiple accounts several rate limits usage quota 5h 7d weekly rings plusieurs comptes limites utilisation forfait" },
  { title: "Add another Claude account", section: "general", sub: "accounts", group: "Claude accounts", keywords: "new second account sign in ajouter compte" },
  { title: "Switching", section: "general", sub: "accounts", group: "Switching", keywords: "switch accounts default auto bascule changement compte" },
  { title: "Default account for new conversations", section: "general", sub: "accounts", group: "Switching", keywords: "default account compte par defaut nouvelle conversation" },
  { title: "Auto-switch account near usage limit", section: "general", sub: "accounts", group: "Switching", keywords: "auto switch rotate failover quota limit bascule automatique changement compte limite" },
  { title: "Switch at", flash: "Switching", section: "general", sub: "accounts", group: "Switching", keywords: "threshold trigger percent seuil declenchement pourcentage auto-switch" },
  { title: "Target below", flash: "Switching", section: "general", sub: "accounts", group: "Switching", keywords: "ceiling hysteresis target oscillation plafond cible auto-switch" },
  { title: "TOSSE actions in the conversation", section: "tosse", group: "In the app", keywords: "mcp thread fil carte card task tache statut status contexte context lecture read logo rose crm" },
  { title: "TOSSE mark on repositories", section: "tosse", group: "In the app", keywords: "badge repo crm" },
  { title: "TOSSE tasks view", section: "tosse", group: "In the app", keywords: "tasks board kanban taches" },
  { title: "Stay on the tasks view when you press Start", section: "tosse", group: "In the app", keywords: "pickup start navigation" },
  { title: "Warn before deleting a linked conversation", section: "tosse", group: "In the app", keywords: "delete confirm task suppression" },
  { title: "Client logos from the web", section: "tosse", group: "In the app", keywords: "favicon google privacy logo client" },

  // ---- Claude Code (Instructions / Behavior / Helpers) --------------------
  // Its own tab, shown only while a Claude account is connected — so are the two
  // Behavior entries above, which is why they are Claude-only settings.
  { title: "Helpers", section: "claudeCode", sub: "helpers", group: "Helpers", keywords: "subagent routing model helper sous-agent routage claude code" },
  { title: "What the helpers cost", section: "claudeCode", sub: "helpers", group: "What the helpers cost", keywords: "spend cost tokens dashboard depense cout" },
  { title: "Instructions for Claude", section: "claudeCode", sub: "instructions", group: "Instructions for Claude", keywords: "claude md instructions file memoire" },

  // ---- Display, continued: the conversation surfaces ----------------------
  { title: "Markdown rendering", section: "display", sub: "thread", group: "Markdown", keywords: "markdown mode warm classic minimal thread rendering conversation rendu" },
  { title: "Shown in the picker", section: "display", sub: "models", group: "The picker", keywords: "model list claude codex modele" },
  { title: "New conversations", section: "display", sub: "models", group: "New conversations", keywords: "default model effort defaut" },
  { title: "The bar", section: "display", sub: "composer", group: "The bar", keywords: "composer controls layout barre" },
  { title: "Your buttons", section: "display", sub: "composer", group: "Your buttons", keywords: "custom button prompt bouton" },

  // ---- Display, continued: IDE ---------------------------------------------
  // The IDE card's own title is indexed too (like "Switching" below): on its own it's a
  // second way to land on the card, and it's the flash target for "Panel position",
  // which has no titled row of its own to flash instead.
  { title: "IDE", section: "display", sub: "ide", group: "IDE", keywords: "ide view editor explorer files folder workspace terminals dock panel conversations vue ide" },
  { title: "IDE view", section: "display", sub: "ide", group: "IDE", keywords: "ide editor explorer files folder workspace terminals dock tab onglet dossier fichiers vs code" },
  { title: "Panel position", flash: "IDE", section: "display", sub: "ide", group: "IDE", keywords: "panneau position droite bas marge pied de page dock terminal conversations" },
  { title: "Dim hidden files in the explorer", section: "display", sub: "ide", group: "IDE", keywords: "fichiers cachés dotfiles estomper explorateur git" },

  // ---- Shortcuts + Display → Order ----------------------------------------
  { title: "Keyboard shortcuts", section: "shortcuts", group: "Keyboard shortcuts", keywords: "keys chords raccourcis clavier" },
  { title: "Conversations", section: "display", sub: "order", group: "Conversation order", keywords: "drag drop manual order tri ordre" },
  { title: "Repositories", section: "display", sub: "order", group: "Conversation order", keywords: "drag drop manual order depots" },
  { title: "Share order between the two views", section: "display", sub: "order", group: "Shared order", keywords: "sidebar flight deck sync" },

  // ---- Control ------------------------------------------------------------
  { title: "Let agents pilot the app", section: "control", sub: "agents", group: "Agent control of the app", keywords: "mcp flightdeck server in-process tools" },
  { title: "Let agents remove conversations from the list", section: "control", sub: "agents", group: "Agent control of the app", keywords: "remove_conversation policy delete" },
  { title: "OpenAI API key", section: "control", sub: "voice", group: "Voice agent", keywords: "openai key realtime cle voix vocal" },
  { title: "Voice", section: "control", sub: "voice", group: "Voice agent", keywords: "marin cedar alloy timbre voix openai realtime" },
  { title: "What the agent is told", section: "control", sub: "voice", group: "Voice agent", keywords: "system prompt instructions brief personality style verbose prompt voix" },
  { title: "Voice session & announcements", section: "control", sub: "voice", group: "Voice agent", keywords: "announce fleet events spoken" },
  { title: "Push-to-talk key", section: "control", sub: "voice", group: "Microphone", keywords: "ptt shortcut mic key micro raccourci" },
  { title: "Close the mic after silence", section: "control", sub: "voice", group: "Microphone", keywords: "auto close silence timeout micro" },
  { title: "Cutting the agent off", section: "control", sub: "voice", group: "Microphone", keywords: "interrupt barge-in stop mid-sentence wake word interruption couper interrompre" },
  { title: "How it knows you have stopped", section: "control", sub: "voice", group: "Microphone", keywords: "vad turn detection semantic loudness threshold interruption seuil bruit coupure" },
  { title: "How soon it decides you are done", section: "control", sub: "voice", group: "Microphone", keywords: "eagerness patient quick pause vad semantic" },
  { title: "Loudness threshold", section: "control", sub: "voice", group: "Microphone", keywords: "vad sensitivity noise seuil bruit amplitude" },
  { title: "Microphone check", section: "control", sub: "voice", group: "Microphone", keywords: "level meter test mic niveau micro jauge" },
  { title: "Wake word", section: "control", sub: "voice", group: "Wake word", keywords: "alexa jarvis hands-free mot de reveil" },
  { title: "Wake phrase", section: "control", sub: "voice", group: "Wake word", keywords: "alexa jarvis phrase" },
  { title: "Sensitivity", section: "control", sub: "voice", group: "Wake word", keywords: "wake false trigger sensibilite" },
  { title: "Remote servers (SSH)", section: "control", sub: "remote", group: "Remote servers (SSH)", keywords: "ssh host machine distant serveur" },
  { title: "Reach your agents from your phone", section: "control", sub: "remote", group: "Remote access (phone)", keywords: "relay pairing mobile telephone" },
  { title: "Answer permission requests remotely", section: "control", sub: "remote", group: "Remote access (phone)", keywords: "permission phone relay" },
  { title: "This Mac's name", section: "control", sub: "remote", group: "Remote access (phone)", keywords: "label node name mac relay nom" },
  { title: "Local MCP server for an external agent", section: "control", sub: "bridge", group: "Voice bridge", keywords: "http bridge token port externe" },
  { title: "Port", section: "control", sub: "bridge", group: "Voice bridge", keywords: "http bridge listen" },
  { title: "Access token", section: "control", sub: "bridge", group: "Voice bridge", keywords: "bearer secret bridge jeton" },

  // ---- Notifications / Updates / Data -------------------------------------
  { title: "System notification", section: "notifications", sub: "channels", group: "Channels", keywords: "os notification banner alerte" },
  { title: "Sound", section: "notifications", sub: "channels", group: "Channels", keywords: "chime audio son" },
  { title: "Dock bounce", section: "notifications", sub: "channels", group: "Channels", keywords: "dock icon attention rebond" },
  { title: "Toast when agents message each other", section: "notifications", sub: "channels", group: "Agent messages", keywords: "agent message send_message conversation toast messagerie inter-conversation expéditeur destinataire" },
  { title: "Toast when an agent creates a conversation", section: "notifications", sub: "channels", group: "Agent messages", keywords: "agent create_conversation new conversation created toast création nouvelle conversation" },
  { title: "Show in the Flight Deck", section: "notifications", sub: "fleet", group: "Fleet banner", keywords: "fleet readout counters banner alerts alertes" },
  { title: "Show in the Conversation", section: "notifications", sub: "fleet", group: "Fleet banner", keywords: "fleet readout sidebar counters alerts alertes" },
  { title: "Alert for background shell commands", section: "notifications", sub: "background", group: "Background tasks", keywords: "bash monitor background notification alerts alertes" },
  { title: "Flight Deck", section: "updates", group: "Flight Deck", keywords: "app update version mise a jour" },
  { title: "Claude Code CLI", section: "updates", group: "Claude Code CLI", keywords: "binary update version cli" },
  { title: "Automatic updates", section: "updates", group: "Claude Code CLI", keywords: "auto update cli" },
  { title: "Data", section: "data", group: "Data", keywords: "wipe delete all database donnees supprimer" },
];

/** Lowercase + strip accents, so "réglage" matches "reglage" and vice versa. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Rank the index against a query. Every whitespace-separated term must match
 * SOMETHING (AND semantics — typing two words narrows, it doesn't widen), and the
 * score prefers a title hit over a card hit over a keyword hit.
 */
export function searchSettings(
  query: string,
  index: readonly SettingEntry[] = SETTINGS_INDEX,
  limit = 12,
): SettingEntry[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: Array<{ entry: SettingEntry; score: number }> = [];
  for (const entry of index) {
    const title = fold(entry.title);
    const group = fold(entry.group);
    const keywords = fold(entry.keywords ?? "");
    let score = 0;
    let everyTermMatched = true;
    for (const term of terms) {
      if (title.startsWith(term)) score += 4;
      else if (title.includes(term)) score += 3;
      else if (group.includes(term)) score += 2;
      else if (keywords.includes(term)) score += 1;
      else {
        everyTermMatched = false;
        break;
      }
    }
    if (everyTermMatched) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit)
    .map((s) => s.entry);
}
