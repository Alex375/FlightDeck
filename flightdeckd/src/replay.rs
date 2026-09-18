//! Replay planning for a (re)attaching client: which ring lines it gets, and —
//! for a client that announced `supports_skip` — which it can do without.
//!
//! With `--include-partial-messages`, every assistant message reaches the ring
//! TWICE: as `stream_event` deltas (message_start → content_block_* →
//! message_delta → message_stop) and as complete `assistant` lines, one per
//! content block, carrying the same `message.id`. Observed order (claude
//! stream-json, 18/09/2026): the `assistant` line of a block lands right before
//! that block's `content_block_stop`, all of them before `message_stop`.
//!
//! Compaction drops the deltas of messages that are COMPLETE in the ring
//! (`message_stop` seen AND at least one `assistant` line with that id) and
//! reports each dropped run as `fd_skip{from,to}` so the client's cursor still
//! advances line for line. Anything uncertain is replayed: deltas of a message
//! still streaming (or interrupted — no `message_stop`), of a message whose
//! `message_start` fell off the ring, or that fail to parse.

use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};

/// One replayable line in a session's ring.
#[derive(Debug, Clone)]
pub struct RingEntry {
    pub seq: u64,
    pub line: String,
    pub tag: ReplayTag,
}

/// What compaction needs to know about a ring line, computed once at push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayTag {
    Other,
    /// A partial-message `stream_event`. Streams of different
    /// `parent_tool_use_id`s (the main thread, each sub-agent) can interleave;
    /// within one they are sequential.
    Stream { parent: Option<String>, start: Option<String>, stop: bool },
    /// A complete `assistant` line (one content block of message `id`).
    Assistant { id: String },
}

#[derive(Deserialize)]
struct TagProbe {
    parent_tool_use_id: Option<String>,
    event: Option<TagEvent>,
    message: Option<TagMessage>,
}

#[derive(Deserialize)]
struct TagEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<TagMessage>,
}

#[derive(Deserialize)]
struct TagMessage {
    id: Option<String>,
}

/// Tag a replayable line of type `kind`. A line that does not parse as
/// expected is `Other` — never skipped.
pub fn tag(kind: &str, line: &str) -> ReplayTag {
    if kind != "stream_event" && kind != "assistant" {
        return ReplayTag::Other;
    }
    let Ok(p) = serde_json::from_str::<TagProbe>(line) else { return ReplayTag::Other };
    if kind == "assistant" {
        return match p.message.and_then(|m| m.id) {
            Some(id) => ReplayTag::Assistant { id },
            None => ReplayTag::Other,
        };
    }
    let Some(ev) = p.event else { return ReplayTag::Other };
    let ev_kind = ev.kind.unwrap_or_default();
    ReplayTag::Stream {
        parent: p.parent_tool_use_id,
        start: if ev_kind == "message_start" { ev.message.and_then(|m| m.id) } else { None },
        stop: ev_kind == "message_stop",
    }
}

/// One step of a replay.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplayItem<'a> {
    Line(&'a str),
    /// Replayable lines `from..=to` omitted (see `frames::fd_skip`).
    Skip { from: u64, to: u64 },
}

/// The replay of every ring line after `from`. Without `compact` it is exactly
/// those lines, in order; with it, the deltas of complete messages collapse
/// into `Skip` runs.
pub fn plan(ring: &VecDeque<RingEntry>, from: u64, compact: bool) -> Vec<ReplayItem<'_>> {
    let skippable = if compact { skippable(ring) } else { Vec::new() };
    let mut out = Vec::new();
    let mut run: Option<(u64, u64)> = None;
    for (i, e) in ring.iter().enumerate() {
        if e.seq <= from {
            continue;
        }
        if compact && skippable[i] {
            run = Some(match run {
                Some((f, _)) => (f, e.seq),
                None => (e.seq, e.seq),
            });
            continue;
        }
        if let Some((from, to)) = run.take() {
            out.push(ReplayItem::Skip { from, to });
        }
        out.push(ReplayItem::Line(&e.line));
    }
    if let Some((from, to)) = run {
        out.push(ReplayItem::Skip { from, to });
    }
    out
}

/// Per ring entry: is it a delta of a message that is complete in the ring?
/// Looks at the WHOLE ring — a message may have been completed before the
/// client's cursor while some of its deltas lie after it.
fn skippable(ring: &VecDeque<RingEntry>) -> Vec<bool> {
    let mut open: HashMap<Option<String>, String> = HashMap::new();
    let mut member: Vec<Option<String>> = Vec::with_capacity(ring.len());
    let mut stopped: HashSet<String> = HashSet::new();
    let mut assembled: HashSet<String> = HashSet::new();
    for e in ring {
        match &e.tag {
            ReplayTag::Stream { parent, start, stop } => {
                if let Some(id) = start {
                    // A new message_start supersedes an unfinished one (whose
                    // deltas then never count as complete).
                    open.insert(parent.clone(), id.clone());
                }
                let m = open.get(parent).cloned();
                if *stop {
                    if let Some(id) = &m {
                        stopped.insert(id.clone());
                    }
                    open.remove(parent);
                }
                member.push(m);
            }
            ReplayTag::Assistant { id } => {
                assembled.insert(id.clone());
                member.push(None);
            }
            ReplayTag::Other => member.push(None),
        }
    }
    member
        .into_iter()
        .map(|m| m.is_some_and(|id| stopped.contains(&id) && assembled.contains(&id)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames;
    use crate::testutil::stream::*;

    fn ring_of(lines: &[String]) -> VecDeque<RingEntry> {
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let kind = frames::probe(l).and_then(|p| p.kind).unwrap();
                RingEntry { seq: i as u64 + 1, line: l.clone(), tag: tag(&kind, l) }
            })
            .collect()
    }

    /// Replays `plan` like a skip-capable client: counts replayable lines,
    /// applies fd_skip jumps (checking they are gapless), returns the cursor
    /// and the lines it received.
    fn client(items: &[ReplayItem<'_>], mut cursor: u64) -> (u64, Vec<String>) {
        let mut got = Vec::new();
        for it in items {
            match it {
                ReplayItem::Line(l) => {
                    assert!(frames::is_replayable_line(l));
                    cursor += 1;
                    got.push(l.to_string());
                }
                ReplayItem::Skip { from, to } => {
                    assert_eq!(*from, cursor + 1, "fd_skip leaves a cursor gap");
                    assert!(to >= from);
                    cursor = *to;
                }
            }
        }
        (cursor, got)
    }

    #[test]
    fn complete_messages_replay_without_their_deltas_and_the_cursor_ends_equal() {
        let lines = turn();
        let ring = ring_of(&lines);
        let items = plan(&ring, 0, true);
        let (cursor, got) = client(&items, 0);
        assert_eq!(cursor, lines.len() as u64, "compaction must end on the same cursor");
        assert!(got.iter().all(|l| !l.contains("\"stream_event\"")), "a complete message's delta was replayed");
        let expected: Vec<String> = lines.iter().filter(|l| !l.contains("\"stream_event\"")).cloned().collect();
        assert_eq!(got, expected);
        // Each message's deltas collapse into two runs around its assistant line.
        assert_eq!(
            items.iter().filter(|i| matches!(i, ReplayItem::Skip { .. })).count(),
            4
        );
        assert_eq!(items[2], ReplayItem::Skip { from: 3, to: 6 });
        assert_eq!(items[4], ReplayItem::Skip { from: 8, to: 10 });
    }

    #[test]
    fn a_client_without_the_flag_gets_the_full_replay_byte_identical() {
        let lines = turn();
        let ring = ring_of(&lines);
        for from in [0, 5, 12] {
            let items = plan(&ring, from, false);
            let got: Vec<&str> = items
                .iter()
                .map(|i| match i {
                    ReplayItem::Line(l) => *l,
                    ReplayItem::Skip { .. } => panic!("fd_skip sent to a client that did not ask"),
                })
                .collect();
            let expected: Vec<&str> = lines[from as usize..].iter().map(String::as_str).collect();
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn deltas_of_a_message_still_streaming_are_always_replayed() {
        let mut lines = turn();
        // msg_3 is mid-stream: started, one block already assembled, no message_stop.
        lines.extend(vec![
            start(None, "msg_3"),
            ev(None, "content_block_start"),
            delta(None, "par"),
            assistant(None, "msg_3", "partial block"),
            ev(None, "content_block_stop"),
            ev(None, "content_block_start"),
            delta(None, "still typing"),
        ]);
        let ring = ring_of(&lines);
        let open_from = turn().len();
        let items = plan(&ring, open_from as u64, true);
        let (cursor, got) = client(&items, open_from as u64);
        assert_eq!(cursor, lines.len() as u64);
        assert_eq!(got, lines[open_from..].to_vec(), "an unfinished message lost a delta");
    }

    #[test]
    fn a_message_stopped_without_an_assistant_line_is_replayed() {
        // e.g. an interrupted or empty stream: nothing complete to stand in.
        let lines = vec![start(None, "m"), delta(None, "x"), ev(None, "message_stop"), other("result")];
        let ring = ring_of(&lines);
        let (_, got) = client(&plan(&ring, 0, true), 0);
        assert_eq!(got, lines);
    }

    #[test]
    fn a_cursor_inside_a_complete_message_skips_its_remaining_deltas() {
        let lines = turn();
        let ring = ring_of(&lines);
        // cursor 7 = the client got msg_1 up to its assistant line
        let items = plan(&ring, 7, true);
        assert_eq!(items[0], ReplayItem::Skip { from: 8, to: 10 });
        let (cursor, _) = client(&items, 7);
        assert_eq!(cursor, lines.len() as u64);
    }

    #[test]
    fn deltas_whose_message_start_left_the_ring_are_replayed() {
        let lines = turn();
        let mut ring = ring_of(&lines);
        ring.drain(..3); // system, user, msg_1's message_start trimmed off
        let (cursor, got) = client(&plan(&ring, 3, true), 3);
        assert_eq!(cursor, lines.len() as u64);
        assert!(got.contains(&delta(None, "Hel")), "an orphan delta was skipped");
        assert!(!got.iter().any(|l| l.contains("msg_2") && l.contains("message_start")));
    }

    #[test]
    fn interleaved_sub_agent_streams_are_tracked_per_parent() {
        // Sub-agent message "sub" streams across the main thread's msg_m; the
        // main message completes, the sub-agent's does not.
        let p = Some("toolu_1");
        let lines = vec![
            start(p, "sub"),
            start(None, "msg_m"),
            delta(p, "sub-1"),
            delta(None, "main-1"),
            assistant(None, "msg_m", "main"),
            ev(None, "message_stop"),
            delta(p, "sub-2"),
        ];
        let ring = ring_of(&lines);
        let (cursor, got) = client(&plan(&ring, 0, true), 0);
        assert_eq!(cursor, lines.len() as u64);
        assert_eq!(got, vec![lines[0].clone(), lines[2].clone(), lines[4].clone(), lines[6].clone()]);
    }

    #[test]
    fn tags_are_read_from_real_shapes_and_never_guessed() {
        assert_eq!(tag("assistant", &assistant(None, "msg_x", "t")), ReplayTag::Assistant { id: "msg_x".into() });
        assert_eq!(
            tag("stream_event", &start(Some("toolu_9"), "msg_y")),
            ReplayTag::Stream { parent: Some("toolu_9".into()), start: Some("msg_y".into()), stop: false }
        );
        assert_eq!(
            tag("stream_event", &ev(None, "message_stop")),
            ReplayTag::Stream { parent: None, start: None, stop: true }
        );
        assert_eq!(tag("stream_event", r#"{"type":"stream_event","event":"weird"}"#), ReplayTag::Other);
        assert_eq!(tag("assistant", r#"{"type":"assistant","message":{}}"#), ReplayTag::Other);
        assert_eq!(tag("user", &other("user")), ReplayTag::Other);
    }
}
