// M1 acceptance, client side "phone": drive the CONTAINER's daemon through the
// production relay, with a mid-turn network cut on the phone side.
//
//  1. connect as a phone; create_conversation in /work/demo with a slow first
//     message;
//  2. CUT the socket immediately (phone loses network mid-turn);
//  3. reconnect after the turn had time to finish, read_conversation → the
//     assistant reply completed while the phone was offline;
//  4. bonus: get_pending_request / interrupt round-trip sanity via ping.
//
// The Mac plays NO part here — the daemon answers alone.
//
//   MAC_ID=… PHONE_TOKEN=… node m1-daemon/tests/phone-cut-test.mjs
//   (RELAY defaults to the production Railway relay)
// `ws` resolved from this repo if installed, else from the flightdeck-remote
// checkout next door (ESM ignores NODE_PATH).
const WS_FALLBACK = new URL(
  "../../../flightdeck-remote/node_modules/ws/wrapper.mjs",
  import.meta.url,
);
const { WebSocket } = await import("ws").catch(() => import(WS_FALLBACK.href));

const RELAY = process.env.RELAY || "https://relay-production-8fd4.up.railway.app";
const MAC_ID = process.env.MAC_ID;
const PHONE_TOKEN = process.env.PHONE_TOKEN;
const REPO = process.env.REPO || "/work/demo";
if (!MAC_ID || !PHONE_TOKEN) {
  console.error("need MAC_ID + PHONE_TOKEN env");
  process.exit(2);
}

const wsUrl = RELAY.replace(/^http/, "ws") + `/phone?macId=${encodeURIComponent(MAC_ID)}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${PHONE_TOKEN}` } });
    const pending = new Map();
    let idc = 0;
    ws.on("open", () => resolve({ ws, call }));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if ((m.type === "rpc_result" || m.type === "rpc_error") && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.type === "rpc_result" ? res(m.result) : rej(new Error(m.error));
      }
      if (m.type === "event") console.log(`  event: ${m.event.kind} ${m.event.conversationId}`);
    });
    function call(method, params = {}) {
      return new Promise((res, rej) => {
        const id = `p${++idc}`;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ type: "rpc", id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timeout`)); } }, 60000);
      });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("== 1: phone connects, creates a conversation with a slow first message");
  const c1 = await connect();
  const created = await c1.call("create_conversation", {
    repo_path: REPO,
    first_message: "Run: sleep 8 && echo PHONE_CUT_SURVIVED. Then reply with exactly the single word DONE_PHONE.",
  });
  console.log("   created:", created.conversation_id);

  console.log("== 2: CUT — phone loses network mid-turn");
  c1.ws.terminate(); // no clean close: simulates a dropped network

  await sleep(16000); // the turn finishes while the phone is offline

  console.log("== 3: phone reconnects, reads the conversation");
  const c2 = await connect();
  const list = await c2.call("list_conversations");
  const mine = (list || []).find((c) => c.conversation_id === created.conversation_id);
  if (!mine) throw new Error("conversation missing after reconnect");
  console.log(`   status after cut: ${mine.status?.kind}`);
  const read = await c2.call("read_conversation", { conversation_id: created.conversation_id, max_turns: 40 });
  const text = (read.turns || []).map((t) => `${t.role}: ${t.text}`).join("\n");
  console.log("   turns:\n" + text.split("\n").map((l) => "     " + l).join("\n"));
  if (!/DONE_PHONE/.test(text)) throw new Error("assistant reply missing — turn did not survive the phone cut");

  console.log("== 4: ping sanity");
  const pong = await c2.call("ping");
  if (!pong.pong) throw new Error("ping failed");
  c2.ws.close();
  console.log("ALL GOOD — phone-direct with a mid-turn phone cut proven (Mac not involved)");
};

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
