// Capture the AgentDetailsPanel (click a node) + the add-agent modal to verify model/provider/
// framework are switchable for all nodes (incl CEO) and the new framework field is present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9235;
const OUT = path.join(os.tmpdir(), "opc-audit-shots");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-panel-"));
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

  // Click the CEO node (center) to open AgentDetailsPanel — verify CEO is switchable now.
  const clicked = await evalJs(`(()=>{const ns=[...document.querySelectorAll('.react-flow__node')];
    // pick CEO node: the one whose text contains 'CEO'
    const ceo=ns.find(n=>/CEO/.test(n.textContent))||ns[0];
    if(!ceo)return 'no-node';const r=ceo.getBoundingClientRect();const cx=r.x+r.width/2,cy=r.y+r.height/2;
    ['mousedown','mouseup','click'].forEach(t=>ceo.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy})));
    return ceo.textContent.slice(0,30);})()`);
  console.log("clicked node:", clicked);
  await sleep(1500);
  const panelInfo = await evalJs(`(()=>{const t=document.body.innerText;return JSON.stringify({hasModelConfig:/模型配置/.test(t),hasFramework:/执行框架/.test(t),hasClaudeCode:/Claude Code/.test(t),selects:document.querySelectorAll('select').length});})()`);
  console.log("PANEL", panelInfo);
  await shot("M01-agent-details-panel");

  // Open add-agent modal — verify the framework field
  await evalJs(`window.dispatchEvent(new CustomEvent("org-add-agent",{detail:{parentId:"ceo"}}))`);
  await sleep(1200);
  const modalInfo = await evalJs(`(()=>{const t=document.body.innerText;return JSON.stringify({hasFrameworkField:/执行框架/.test(t),hasClaudeCodeOpt:/Claude Code（订阅）|Claude Code\\(订阅\\)/.test(t),hasOllama:/Ollama/.test(t)});})()`);
  console.log("MODAL", modalInfo);
  await shot("M02-add-agent-modal");

  ws.close(); chrome.kill(); process.exit(0);
} catch (e) { console.log("ERR " + e.message); try { chrome.kill(); } catch {} process.exit(1); }
