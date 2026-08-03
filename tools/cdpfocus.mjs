// CDP interaction check: click a node, then read node + comm-edge opacities to verify
// comm-aware focus/dim (selected + its parent/children/comm-partners bright, rest dim).
import process from "node:process";
const BASE = "http://localhost:9222";
const URL_ = process.argv[2] || "http://localhost:5173/";
const CLICK_ID = process.argv[3] || "code-reviewer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(BASE + "/json")).json();
      const t = list.find((x) => x.type === "page" && /5173/.test(x.url));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch {}
    await sleep(400);
  }
  throw new Error("no page target");
}
const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let _id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(6000);

const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

// click the node circle
await ev(`(() => { const c = document.querySelector('.react-flow__node[data-id="${CLICK_ID}"] .rounded-full'); if (c) c.click(); return !!c; })()`);
await sleep(600);

const report = await ev(`(() => {
  const op = id => { const n = document.querySelector('.react-flow__node[data-id="'+id+'"] > div'); return n ? +getComputedStyle(n).opacity : null; };
  const nodes = {};
  document.querySelectorAll('.react-flow__node').forEach(n => { nodes[n.getAttribute('data-id')] = op(n.getAttribute('data-id')); });
  const commEdges = {};
  document.querySelectorAll('.react-flow__edge.animated .react-flow__edge-path').forEach(p => {
    const wrap = p.closest('.react-flow__edge'); const id = wrap && wrap.getAttribute('data-id');
    commEdges[id||'?'] = +(p.style.opacity || getComputedStyle(p).opacity);
  });
  const selected = document.querySelector('.react-flow__node.selected')?.getAttribute('data-id') || null;
  return JSON.stringify({ clicked: '${CLICK_ID}', nodes, commEdges });
})()`);
console.log("FOCUS " + report);
ws.close();
process.exit(0);
