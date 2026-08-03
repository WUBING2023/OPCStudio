// CDP check: open the Worker import → ImportToOrgDialog (parent selector + org-copy-graph preview).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT = path.join(os.tmpdir(), "import-shot.png");
const PORT = 9224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-imp-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,860", "http://localhost:3100/"], { stdio: "ignore" });

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
  const clickByText = (txt) => send("Runtime.evaluate", { expression: `(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(txt)}));if(b)b.click();return !!b;})()`, returnByValue: true });

  await send("Page.enable"); await send("Runtime.enable"); await sleep(4000);
  await clickByText("社区"); await sleep(1500);
  await clickByText("Worker"); await sleep(1200);   // switch to worker type
  const imp = await clickByText("导入"); await sleep(1200); // first card's import button
  console.log("CLICKED_IMPORT " + imp.result.value);

  const check = await send("Runtime.evaluate", { expression: `(()=>{
    const txt = document.body.innerText;
    return JSON.stringify({
      dialog: /导入到组织|接入到/.test(txt),
      hasSelect: !!document.querySelector('select'),
      previewLabel: /将复制的结构/.test(txt),
    });
  })()`, returnByValue: true });
  console.log("DOMCHECK " + check.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log("SHOT_BYTES " + fs.statSync(SHOT).size + " " + SHOT);
  ws.close(); chrome.kill(); process.exit(0);
} catch (e) { console.log("ERR " + e.message); try { chrome.kill(); } catch {} process.exit(1); }
