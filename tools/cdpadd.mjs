// CDP E2E: exercise the "add child agent" UI flow and confirm a new node appears.
const BASE = "http://localhost:9227";
const URL_ = "http://localhost:5173/";
const PARENT = "engineering-lead";
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(6000);
const before = await ev(`document.querySelectorAll('.react-flow__node').length`);

// 1) open the add-child modal for the parent
await ev(`window.dispatchEvent(new CustomEvent("org-add-agent",{detail:{parentId:"${PARENT}"}}))`);
await sleep(600);
const modalOpen = await ev(`!!document.body.innerText.includes('添加 Agent')`);

// 2) fill the name input
const nameSet = await ev(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('例如') || (i.placeholder||'').includes('前端'));
  if (!inp) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, 'CDP Test Child'); inp.dispatchEvent(new Event('input',{bubbles:true}));
  return inp.value;
})()`);
await sleep(300);

// 3) click the 添加 submit button
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '添加');
  if (!b) return 'NO_BTN'; b.click(); return true;
})()`);
await sleep(1800);

const after = await ev(`JSON.stringify({
  nodeCount: document.querySelectorAll('.react-flow__node').length,
  newNodePresent: [...document.querySelectorAll('.react-flow__node')].some(n => n.textContent.includes('CDP Test Child')),
  modalClosed: !document.body.innerText.includes('添加 Agent'),
})`);
console.log("BEFORE_NODES " + before);
console.log("MODAL_OPEN " + modalOpen + " NAME_SET " + nameSet + " CLICKED " + clicked);
console.log("AFTER " + after);
ws.close(); process.exit(0);
