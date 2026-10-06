// ⌘F in an integrated terminal: the shared find bar, hanging from the terminal's own corner,
// driving xterm's search addon over the scrollback (its text is drawn on a canvas, so the DOM
// find engine cannot see it). Lives with the terminal, in its lazily-loaded chunk.
import { useEffect, useId, useState, type ReactNode, type RefObject } from "react";
import { compileFindQuery } from "../find/findQuery";
import { FindBar } from "../find/FindBar";
import { registerFindHost, useFindStore } from "../find/findStore";
import { focusTerm, searchAddonFor } from "./termManager";

/** xterm wants #RRGGBB — the same amber family as the DOM hits (find.css). */
const DECORATIONS = {
  matchBackground: "#5a4423",
  matchBorder: "#7a5c2e",
  matchOverviewRuler: "#e3a857",
  activeMatchBackground: "#f0963c",
  activeMatchBorder: "#f0963c",
  activeMatchColorOverviewRuler: "#f0963c",
};

/** Register terminal `termId`'s zone as a find host; returns its bar while open. */
export function useTerminalFind(termId: string, zoneRef: RefObject<HTMLElement | null>): ReactNode {
  const uid = useId();
  const hostId = `term:${termId}#${uid}`;
  useEffect(
    () =>
      registerFindHost({
        id: hostId,
        el: () => zoneRef.current,
        open: (seed) => {
          if (!searchAddonFor(termId)) return false;
          useFindStore.getState().openBar(hostId, seed);
          return true;
        },
      }),
    [hostId, termId, zoneRef],
  );
  useEffect(() => () => useFindStore.getState().closeBar(hostId), [hostId]);
  const nonce = useFindStore((s) => (s.active?.hostId === hostId ? s.active.nonce : null));
  if (nonce === null) return null;
  return <TerminalFindSession termId={termId} hostId={hostId} nonce={nonce} />;
}

function TerminalFindSession({ termId, hostId, nonce }: { termId: string; hostId: string; nonce: number }) {
  const query = useFindStore((s) => s.query);
  const isRegex = useFindStore((s) => s.isRegex);
  const matchCase = useFindStore((s) => s.matchCase);
  const wholeWord = useFindStore((s) => s.wholeWord);
  const setQuery = useFindStore((s) => s.setQuery);
  const setOptions = useFindStore((s) => s.setOptions);
  const closeBar = useFindStore((s) => s.closeBar);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(-1);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchOpts = { regex: isRegex, caseSensitive: matchCase, wholeWord, decorations: DECORATIONS };

  // Results come back through the addon's event (it counts while it decorates).
  useEffect(() => {
    const addon = searchAddonFor(termId);
    if (!addon) return;
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setCount(resultCount);
      // -1 with hits = past the highlight limit: the addon stops numbering them.
      setCapped(resultIndex === -1 && resultCount > 0);
      setIndex(resultIndex);
    });
    return () => {
      sub.dispose();
      addon.clearDecorations();
      // Hand the keyboard back to the shell — unless the bar closed because another one took
      // over (that one holds the focus now).
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusTerm(termId);
    };
  }, [termId]);

  // Re-search whenever the query or a toggle changes (incremental: the hit under the cursor
  // stays put while the user keeps typing).
  useEffect(() => {
    const addon = searchAddonFor(termId);
    if (!addon) return;
    const compiled = compileFindQuery(query, { isRegex, matchCase, wholeWord });
    if (!compiled || "error" in compiled) {
      addon.clearDecorations();
      setCount(0);
      setIndex(-1);
      setCapped(false);
      setError(compiled && "error" in compiled ? compiled.error : null);
      return;
    }
    setError(null);
    try {
      if (!addon.findNext(query, { ...searchOpts, incremental: true })) {
        setCount(0);
        setIndex(-1);
      }
    } catch (e) {
      // xterm compiles the pattern itself; a dialect difference surfaces here, not silently.
      setError(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, query, isRegex, matchCase, wholeWord]);

  const step = (delta: number) => {
    const addon = searchAddonFor(termId);
    if (!addon || !query || error) return;
    if (delta > 0) addon.findNext(query, searchOpts);
    else addon.findPrevious(query, searchOpts);
  };

  return (
    <FindBar
      scope={{ label: "Terminal", icon: "term" }}
      focusNonce={nonce}
      query={query}
      onQuery={setQuery}
      options={{ isRegex, matchCase, wholeWord }}
      onOptions={setOptions}
      count={count}
      index={capped ? -1 : index}
      capped={capped}
      error={error}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={() => closeBar(hostId)}
    />
  );
}
