// Headless CDP check for the Community page: launch Chrome → load :3100 → click 社区 nav →
// verify the shelf×type sidebar + grid render, then screenshot. Zero deps (Node 24 globals).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL_ = "http://localhost:3100/";
const SHOT = path.join(os.tmpdir(), "community-shot.png");
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-comm-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,860", URL_,
], { stdio: "ignore", detached: false });

async function findTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const t = list.find((x) => x.type === "page" && /3100/.test(x.url));
      if (t?.webSocketDebuggerUrl) return t;
    } catch {}
    await sleep(400);
  }
  throw new Error("no page target");
}

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let _id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });

  await send("Page.enable");
  await send("Runtime.enable");
  await sleep(4000); // initial app render

  // click the 社区 nav button
  const clicked = await send("Runtime.evaluate", { expression: `(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const nav = btns.find(b => b.textContent.trim() === '社区' || /社区/.test(b.getAttribute('title')||''));
    if (nav) nav.click();
    return !!nav;
  })()`, returnByValue: true });
  await sleep(1800);

  const expr = `(() => {
    const txt = b => b.textContent.replace(/\\s+/g,'');
    const btns = Array.from(document.querySelectorAll('button'));
    const has = s => btns.some(b => txt(b).includes(s));
    const typeBtns = ['公司','团队','Worker'].filter(has);
    const shelfBtns = ['市场','收藏'].filter(has);
    // cards: company/team/worker grid items
    const cards = document.querySelectorAll('main .flex-wrap > div').length;
    const favHearts = document.querySelectorAll('button[title="收藏"],button[title="取消收藏"]').length;
    const heading = (document.querySelector('h2')||{}).textContent || '';
    return JSON.stringify({ heading, shelfBtns, typeBtns, cards, favHearts });
  })()`;
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log("DOMCHECK " + res.result.value);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log("CLICKED " + clicked.result.value);
  console.log("SHOT_BYTES " + fs.statSync(SHOT).size);
  ws.close();
  chrome.kill();
  process.exit(0);
} catch (e) {
  console.log("ERR " + e.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
}
