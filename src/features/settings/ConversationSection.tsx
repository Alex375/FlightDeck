// Settings → Conversation. Picks the GLOBAL Markdown rendering mode. Layout: a left rail
// of the three modes, and a large live conversation preview on the right that renders in
// the selected mode (like the exploration mockups). Selecting a mode writes the global
// pref (display store) — it takes effect immediately everywhere: thread, sub-agent
// transcripts, and `.md` previews.
import { useEffect, useRef } from "react";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { useDisplay, type MarkdownMode } from "../../store/display";
import { ClaudeMark } from "../../ui/kit";
import { OptionCardRail, PageHead } from "./SettingsKit";

const MODES: Array<{ id: MarkdownMode; label: string; desc: string }> = [
  { id: "classic", label: "Classic", desc: "The classic boxed rendering (GitHub)." },
  { id: "warm", label: "Warm", desc: "Soft, coral accents, colored code, prominent file names." },
  { id: "minimal", label: "Minimal", desc: "Neutral, typographic, very airy." },
];

// A rich sample that exercises everything that differs between modes: headings, bold +
// inline code + a file path with a line number, a fenced code block, a blockquote, a
// table, ordered + unordered + task lists, and a link.
const USER_MSG = "Explain the session supervisor and show an example.";
const AI_MSG = [
  "## Supervisor architecture",
  "The supervisor keeps **one `claude` process per session**, driven over *bidirectional stream-json*. Unlike `claude -p`, the process **lives for the whole session**. See the [protocol spec](https://example.com).",
  "",
  "### Key components",
  "- **transport** — spawn + reader / writer / stderr",
  "- **control** — `control_request` / `control_response` channel",
  "- **assembler** — UI message normalization",
  "",
  "> Note — the `cwd` is not fixed: the agent can move it via worktrees. The UI always follows the live `cwd`.",
  "",
  "### Example",
  "```rust",
  "pub async fn spawn_session(cwd: &Path) -> Result<Session> {",
  '    let mut child = Command::new("claude")',
  '        .args(["--output-format", "stream-json", "--verbose"])',
  "        .spawn()?;",
  "    Ok(Session::new(child))",
  "}",
  "```",
  "",
  "Normalization lives in `src/features/conversation/StreamMarkdown.tsx:47`.",
  "",
  "| Mode | Persistent | Usage |",
  "| --- | --- | --- |",
  "| stream-json | yes | interactive dialogue |",
  "| one-shot `-p` | no | scripts / CI |",
  "",
  "### Lifecycle",
  "1. Lazy spawn on the first message",
  "2. `initialize` handshake",
  "3. Event loop until `result`",
  "",
  "### To do",
  "- [x] control channel",
  "- [ ] IDE tools (`openDiff`, `getDiagnostics`)",
].join("\n");

// `embedded` = rendered inside the Conversation tab's "Markdown" sub-tab, which already
// carries the tab-level PageHead, so this drops its own (mirrors the Control sub-groups).
export function ConversationSection({ embedded = false }: { embedded?: boolean }) {
  const mode = useDisplay((s) => s.markdownMode);
  const set = useDisplay((s) => s.set);
  // The preview is an illustration: make its whole subtree inert so its interactive bits
  // (the code block's copy button) aren't focusable/clickable.
  const convRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (convRef.current) convRef.current.inert = true;
  }, []);

  return (
    <div className="mdset">
      {!embedded && (
        <PageHead
          title="Conversation"
          subtitle={
            <>
              The Markdown rendering style, applied everywhere: conversations, sub-agents, and{" "}
              <code>.md</code> file previews. Pick a mode — the preview shows the result.
            </>
          }
        />
      )}
      <div className="mdset-body">
        <OptionCardRail
          className="mdset-rail"
          options={MODES}
          selected={mode}
          onSelect={(id) => set({ markdownMode: id })}
          ariaLabel="Markdown rendering mode"
        />

        <div className="mdset-stage" aria-label="Conversation preview">
          <div className="mdset-conv" ref={convRef}>
            <div className="mdset-umsg">{USER_MSG}</div>
            <div className="mdset-airow">
              <span className="mdset-avatar">
                <ClaudeMark className="sm" />
              </span>
              <div className="mdset-aibody">
                <StreamMarkdown text={AI_MSG} mode={mode} demoFilePaths />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
