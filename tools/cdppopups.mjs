// Capture light-theme popups (the "添加 Agent" modal + right-click context menu) on the Org
// page to verify they no longer have hardcoded-dark residue. Also a Spanish page for i18n spot-check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9234;
const OUT = path.join(os.tmpdir(), "opc-audit-shots");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-pop-"));
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

  // light theme
  await evalJs(`localStorage.setItem("opc-theme","light")`);
  await send("Page.reload", {}); await sleep(4200);

  // open "添加 Agent" modal via the org-add-agent event (same path the FAB/context-menu use)
  await evalJs(`window.dispatchEvent(new CustomEvent("org-add-agent",{detail:{parentId:"ceo"}}))`);
  await sleep(1500);
  await shot("L01-light-add-agent-modal");
  // close (Esc / click backdrop)
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/取消|关闭|Cancel|Close/.test(x.textContent));if(b)b.click();else document.body.click();return true;})()`);
  await sleep(800);

  // right-click context menu on a non-CEO node
  await evalJs(`(()=>{const ns=document.querySelectorAll('.react-flow__node');if(ns.length<2)return false;const n=ns[1];const r=n.getBoundingClientRect();n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2,button:2}));return true;})()`);
  await sleep(1200);
  await shot("L02-light-context-menu");
  await evalJs(`document.body.click()`); await sleep(400);

  // i18n spot-check: Spanish API page (densest i18n surface)
  await evalJs(`localStorage.setItem("opc-lang","es"); localStorage.setItem("opc-theme","dark")`);
  await send("Page.reload", {}); await sleep(4200);
  await evalJs(`(()=>{const nav=document.querySelector('nav');const b=nav?nav.querySelectorAll('button'):[];if(b[5])b[5].click();return true;})()`);
  await sleep(1500);
  await shot("L03-api-es");
  // restore
  await evalJs(`localStorage.setItem("opc-lang","zh-CN")`);

  ws.close(); chrome.kill(); process.exit(0);
} catch (e) { console.log("ERR " + e.message); try { chrome.kill(); } catch {} process.exit(1); }
