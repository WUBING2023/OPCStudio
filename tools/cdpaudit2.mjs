// Supplemental: recapture org focus-mode + terminal-closed cleanly (07-settings full page
// had blocked them). Verifies focus actually reduces visible node count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9232;
const OUT = path.join(os.tmpdir(), "opc-audit-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-audit2-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1440,900", "http://localhost:3100/"], { stdio: "ignore" });

async function findTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://localhost:${PORT}/json`)).json(); const t = l.find(x => x.type === "page" && /3100/.test(x.url)); if (t?.webSocketDebuggerUrl) return t; } catch {} await sleep(400); } throw new Error("no target"); }

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let _id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.value;
  const shot = async (name) => { const c = await send("Page.captureScreenshot", { format: "png" }); const p = path.join(OUT, name + ".png"); fs.writeFileSync(p, Buffer.from(c.data, "base64")); console.log(`SHOT ${name} ${fs.statSync(p).size}`); };

  await send("Page.enable"); await send("Runtime.enable"); await sleep(4500);

  const before = await evalJs(`document.querySelectorAll('.react-flow__node').length`);
  // dblclick a lead node (index 1)
  await evalJs(`(()=>{const ns=document.querySelectorAll('.react-flow__node');if(ns.length<2)return false;const n=ns[1];const r=n.getBoundingClientRect();const cx=r.x+r.width/2,cy=r.y+r.height/2;['mousedown','mouseup','click','mousedown','mouseup','click','dblclick'].forEach(t=>n.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy})));return true;})()`);
  await sleep(1800);
  const after = await evalJs(`document.querySelectorAll('.react-flow__node').length`);
  const bc = await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button,a,div')).map(x=>x.textContent.trim()).filter(t=>/返回|组织|全局|\\//.test(t)).slice(0,6);return JSON.stringify(b);})()`);
  console.log(`FOCUS nodes before=${before} after=${after} breadcrumbHints=${bc}`);
  await shot("08-org-focus-team-zh");

  // reset focus
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/返回|组织|全局/.test(x.textContent));if(b)b.click();return !!b;})()`);
  await sleep(1200);

  // terminal closed
  const t1 = await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/终端/.test(x.getAttribute('title')||''));return b?(b.getAttribute('title')||''):'NONE';})()`);
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/终端/.test(x.getAttribute('title')||''));if(b)b.click();return !!b;})()`);
  await sleep(1200);
  const t2 = await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/终端/.test(x.getAttribute('title')||''));return b?(b.getAttribute('title')||''):'NONE';})()`);
  console.log(`TERMINAL toggle title before=${t1} after=${t2}`);
  await shot("09-org-terminal-closed-zh");

  ws.close(); chrome.kill(); process.exit(0);
} catch (e) { console.log("ERR " + e.message); try { chrome.kill(); } catch {} process.exit(1); }
