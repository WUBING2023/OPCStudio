// Generic: launch Chrome → :3100 → click a nav button by text → DOM-check + screenshot.
// usage: node tools/cdpshot.mjs <navLabel> <shotName> <checkRegexCSV>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const NAV = process.argv[2] || "MCP";
const SHOT = path.join(os.tmpdir(), (process.argv[3] || "page") + ".png");
const CHECKS = (process.argv[4] || "").split(",").filter(Boolean);
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-shot-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "http://localhost:3100/"], { stdio: "ignore" });

async function findTarget() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://localhost:${PORT}/json`)).json(); const t = list.find((x) => x.type === "page" && /3100/.test(x.url)); if (t?.webSocketDebuggerUrl) return t; } catch {}
    await sleep(400);
  }
  throw new Error("no target");
}
try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let _id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });

  await send("Page.enable"); await send("Runtime.enable"); await sleep(4000);
  const clicked = await send("Runtime.evaluate", { expression: `(()=>{const N=${JSON.stringify(NAV)};const b=Array.from(document.querySelectorAll('button')).find(x=>(x.getAttribute('title')||'')===N||x.textContent.replace(/\\s+/g,'').includes(N));if(b)b.click();return !!b;})()`, returnByValue: true });
  console.log("CLICKED " + clicked.result.value);
  await sleep(1800);

  const checkExpr = `(()=>{const t=document.body.innerText;return JSON.stringify({${CHECKS.map((c, i) => `c${i}:/${c}/.test(t)`).join(",")}});})()`;
  const res = await send("Runtime.evaluate", { expression: CHECKS.length ? checkExpr : `JSON.stringify({len:document.body.innerText.length})`, returnByValue: true });
  console.log("DOMCHECK " + res.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log("SHOT " + SHOT + " " + fs.statSync(SHOT).size);
  ws.close(); chrome.kill(); process.exit(0);
} catch (e) { console.log("ERR " + e.message); try { chrome.kill(); } catch {} process.exit(1); }
