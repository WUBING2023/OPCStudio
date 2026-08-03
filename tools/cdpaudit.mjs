// Comprehensive visual audit capture: launch ONE headless Chrome → walk every module
// across theme/language/interaction states → screenshot each + collect runtime console
// errors/exceptions per state. Zero deps (Node 24 globals: WebSocket + fetch).
// Output: <tmp>/opc-audit-shots/<name>.png  + prints JSON manifest line "MANIFEST <json>".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL_ = "http://localhost:3100/";
const PORT = 9231;
const OUT = path.join(os.tmpdir(), "opc-audit-shots");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-audit-"));

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1440,900", URL_,
], { stdio: "ignore" });

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const t = list.find((x) => x.type === "page" && /3100/.test(x.url));
      if (t?.webSocketDebuggerUrl) return t; } catch {}
    await sleep(400);
  }
  throw new Error("no target");
}

const manifest = [];
let curLabel = "init";
const errors = []; // {label, kind, text}

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let _id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); return;
    }
    // event capture
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
      const text = (m.params.args || []).map(a => a.value ?? a.description ?? a.unserializableValue ?? "").join(" ");
      errors.push({ label: curLabel, kind: "console." + m.params.type, text: text.slice(0, 400) });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push({ label: curLabel, kind: "exception", text: (d.exception?.description || d.text || "").slice(0, 400) });
    } else if (m.method === "Log.entryAdded" && (m.params.entry.level === "error" || m.params.entry.level === "warning")) {
      errors.push({ label: curLabel, kind: "log." + m.params.entry.level, text: (m.params.entry.text || "").slice(0, 400) });
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++_id; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await sleep(4500); // initial app render

  const setLang = async (lang) => { await evalJs(`localStorage.setItem("opc-lang", ${JSON.stringify(lang)})`); };
  const setTheme = async (t) => { await evalJs(`localStorage.setItem("opc-theme", ${JSON.stringify(t)})`); };
  const reload = async () => { await send("Page.reload", {}); await sleep(4200); };
  const clickNav = async (i) => evalJs(`(()=>{const nav=document.querySelector('nav');const b=nav?nav.querySelectorAll('button'):[];if(b[${i}]){b[${i}].click();return true;}return false;})()`);

  async function shot(name, domExpr) {
    curLabel = name;
    await sleep(1400);
    let dom = null;
    if (domExpr) { try { dom = await evalJs(domExpr); } catch (e) { dom = "domerr:" + e.message; } }
    const cap = await send("Page.captureScreenshot", { format: "png" });
    const p = path.join(OUT, name + ".png");
    fs.writeFileSync(p, Buffer.from(cap.data, "base64"));
    const bytes = fs.statSync(p).size;
    manifest.push({ name, path: p, bytes, dom });
    console.log(`SHOT ${name} ${bytes}` + (dom ? ` DOM=${typeof dom === "string" ? dom : JSON.stringify(dom)}` : ""));
  }

  const navDom = `(()=>{const n=document.querySelectorAll('.react-flow__node').length;const e=document.querySelectorAll('.react-flow__edge-path').length;const vis=Array.from(document.querySelectorAll('.react-flow__node')).every(x=>getComputedStyle(x).visibility==='visible');const dir=document.documentElement.getAttribute('dir')||'ltr';const cls=document.documentElement.className;return JSON.stringify({nodes:n,edges:e,allVisible:vis,dir,htmlClass:cls});})()`;
  const pageDom = `(()=>{const t=document.body.innerText;return JSON.stringify({len:t.length,h2:(document.querySelector('h1,h2')||{}).textContent||'',btns:document.querySelectorAll('button').length});})()`;

  // ===== default zh-CN dark: walk all 6 nav pages =====
  await shot("01-org-zh-dark", navDom);
  await clickNav(1); await shot("02-reports-zh-dark", pageDom);
  await clickNav(2); await shot("03-community-zh-dark", pageDom);
  await clickNav(3); await shot("04-skills-zh-dark", pageDom);
  await clickNav(4); await shot("05-mcp-zh-dark", pageDom);
  await clickNav(5); await shot("06-api-zh-dark", pageDom);

  // settings modal (gear) — back to org first, open settings by 设置 text
  await clickNav(0); await sleep(800);
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/设置/.test(x.getAttribute('title')||'')||/^设置$/.test(x.textContent.trim()));if(b)b.click();return !!b;})()`);
  await shot("07-settings-modal-zh", pageDom);
  // close modal
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/关闭|×|✕|Close/.test(x.textContent)||/关闭/.test(x.getAttribute('title')||''));if(b)b.click();return !!b;})()`);
  await sleep(600);

  // org focus mode: double-click a non-CEO (lead) node
  await clickNav(0); await sleep(900);
  await evalJs(`(()=>{const ns=document.querySelectorAll('.react-flow__node');if(ns.length<2)return false;const n=ns[1];const r=n.getBoundingClientRect();const cx=r.x+r.width/2,cy=r.y+r.height/2;['mousedown','mouseup','click','mousedown','mouseup','click','dblclick'].forEach(t=>n.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy})));return true;})()`);
  await shot("08-org-focus-team-zh", navDom);
  // reset focus via 返回/组织 breadcrumb if any
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/返回|组织|全局/.test(x.textContent));if(b)b.click();return !!b;})()`);
  await sleep(800);

  // terminal closed
  await clickNav(0); await sleep(600);
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/终端/.test(x.getAttribute('title')||''));if(b)b.click();return !!b;})()`);
  await shot("09-org-terminal-closed-zh", navDom);
  // reopen
  await evalJs(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/终端/.test(x.getAttribute('title')||''));if(b)b.click();return !!b;})()`);
  await sleep(500);

  // ===== light theme =====
  await setTheme("light"); await reload();
  await shot("10-org-zh-light", navDom);
  await clickNav(2); await shot("11-community-zh-light", pageDom);
  await clickNav(1); await shot("12-reports-zh-light", pageDom);
  await setTheme("dark");

  // ===== English =====
  await setLang("en"); await reload();
  await shot("13-org-en-dark", navDom);
  await clickNav(2); await shot("14-community-en-dark", pageDom);
  await clickNav(1); await shot("15-reports-en-dark", pageDom);
  await clickNav(5); await shot("16-api-en-dark", pageDom);

  // ===== Arabic RTL =====
  await setLang("ar"); await reload();
  await shot("17-org-ar-rtl", navDom);
  await clickNav(2); await shot("18-community-ar-rtl", pageDom);

  // restore zh-CN
  await setLang("zh-CN");

  const errPath = path.join(OUT, "_errors.json");
  fs.writeFileSync(errPath, JSON.stringify(errors, null, 2));
  console.log("MANIFEST " + JSON.stringify({ out: OUT, count: manifest.length, shots: manifest, errorCount: errors.length, errors }));
  ws.close(); chrome.kill(); process.exit(0);
} catch (e) {
  console.log("ERR " + e.message + "\n" + (e.stack || ""));
  try { fs.writeFileSync(path.join(OUT, "_errors.json"), JSON.stringify(errors, null, 2)); } catch {}
  try { chrome.kill(); } catch {}
  process.exit(1);
}
