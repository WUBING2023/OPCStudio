// Zero-dependency headless verification via Chrome DevTools Protocol (Node 24 has
// global WebSocket + fetch). Sidesteps the SSE network-idle hang by waiting a fixed
// delay, then evaluates DOM checks and captures a screenshot.
import fs from "node:fs";

const BASE = "http://localhost:9222";
const URL_ = process.argv[2] || "http://localhost:5173/";
const SHOT = process.argv[3] || "/tmp/orgshot.png";
const WAIT_MS = Number(process.argv[4] || 6000);
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
  throw new Error("no page target on :9222");
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let _id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++_id;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL_ });
await sleep(WAIT_MS);

const expr = `(() => {
  const nodes = document.querySelectorAll('.react-flow__node');
  const allVisible = Array.from(nodes).every(n => getComputedStyle(n).visibility === 'visible');
  const edges = document.querySelectorAll('.react-flow__edge-path').length;
  const animated = document.querySelectorAll('.react-flow__edge.animated').length;
  const handles = document.querySelectorAll('.react-flow__handle').length;
  const comm = Array.from(document.querySelectorAll('.react-flow__edge')).map(e=>e.getAttribute('data-id')||'').filter(id=>id.startsWith('comm-'));
  const sidebarToggle = !!document.querySelector('button[title="收起侧栏"],button[title="展开侧栏"]');
  const terminalToggle = !!document.querySelector('button[title="关闭终端"],button[title="打开终端"]');
  return JSON.stringify({ nodeCount: nodes.length, allVisible, edges, animated, handles, commCount: comm.length, comm, sidebarToggle, terminalToggle });
})()`;
const evalRes = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log("DOMCHECK " + evalRes.result.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
console.log("SHOT_BYTES " + fs.statSync(SHOT).size);
ws.close();
process.exit(0);
