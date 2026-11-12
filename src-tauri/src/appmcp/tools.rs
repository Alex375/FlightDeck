//! The tool catalogue both MCP surfaces serve. It lives in the
//! `flightdeck-agent-tools` crate (`flightdeckd/agent-tools`) because `flightdeckd`
//! serves the very same catalogue to the conversations it runs on a server — see
//! that crate's doc. Re-exported here so `appmcp::tools::*` reads as before.

pub use flightdeck_agent_tools::*;

#[cfg(test)]
mod tests {
    use super::*;

    /// The front's copy of the wait bounds (`src/agent/conversationWatch.ts`) is the one that
    /// actually ends a wait: the two must say the same numbers, or the bridge gives up before
    /// the front does. Read from the TS source, like `KEY_ONLY_REPAIRS`.
    #[test]
    fn the_front_mirrors_the_wait_bounds() {
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/agent/conversationWatch.ts"),
        )
        .expect("conversationWatch.ts is readable");
        assert!(ts.contains(&format!("export const WAIT_DEFAULT_S = {WAIT_DEFAULT_SECS};")), "WAIT_DEFAULT_S drifted");
        assert!(ts.contains(&format!("export const WAIT_MAX_S = {WAIT_MAX_SECS};")), "WAIT_MAX_S drifted");
    }
}
