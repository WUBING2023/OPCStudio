// CDP probe: REAL mouse double-click on a manager card → verify team-focus view.
const BASE = "http://localhost:9226";
const URL_ = "http://localhost:5173/";
const MANAGER = process.argv[2] || "engineering-lead";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(BASE + "/json")).json(); const t = list.find((x) => x.type === "page" && /5173/.test(x.url)); if (t?.webSocketDebuggerUrl) return t; } catch {}
    await sleep(400);
  }
  throw new Error("no target");
}
const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let _id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(6000);
const before = await ev(`document.querySelectorAll('.react-flow__node').length`);
const rect = await ev(`(() => { const el = document.querySelector('.react-flow__node[data-id="${MANAGER}"] .rounded-lg'); if(!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`);
const { x, y } = JSON.parse(rect);
for (const clickCount of [1, 2]) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
  await sleep(40);
}
await sleep(1500);
const after = await ev(`JSON.stringify({
  nodeCount: document.querySelectorAll('.react-flow__node').length,
  ids: Array.from(document.querySelectorAll('.react-flow__node')).map(n=>n.getAttribute('data-id')),
  hasBreadcrumb: !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='组织'),
})`);
console.log("BEFORE_NODES " + before);
console.log("AFTER " + after);
const shot = await send("Page.captureScreenshot", { format: "png" });
(await import("node:fs")).writeFileSync((await import("node:os")).tmpdir() + "/teamview.png", Buffer.from(shot.data, "base64"));
console.log("SHOT saved");
ws.close(); process.exit(0);
