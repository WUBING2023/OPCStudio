// Verify theme="system" actually follows the OS prefers-color-scheme (init + live change).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9236; const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-theme-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--no-default-browser-check", "http://localhost:3100/"], { stdio: "ignore" });
async function tgt(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${PORT}/json`)).json(); const t=l.find(x=>x.type==="page"&&/3100/.test(x.url)); if(t?.webSocketDebuggerUrl)return t; }catch{} await sleep(400);} throw new Error("no target"); }
try{
  const target=await tgt(); const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let _id=0; const pend=new Map(); ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++_id;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evalJs=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  const cls=async()=>evalJs("document.documentElement.className");
  await send("Page.enable"); await send("Runtime.enable"); await sleep(4000);
  // theme=system
  await evalJs(`localStorage.setItem("opc-theme","system")`);
  // emulate dark BEFORE reload → init applyTheme(system) should pick dark
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
  await send("Page.reload",{}); await sleep(3500);
  console.log("system + OS=dark  → html.class =", await cls());
  // live change to light → matchMedia change listener should flip to light (no reload)
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"light"}]});
  await sleep(1200);
  console.log("system + OS=light (live change) → html.class =", await cls());
  // back to dark live
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
  await sleep(1200);
  console.log("system + OS=dark (live change)  → html.class =", await cls());
  await evalJs(`localStorage.setItem("opc-theme","dark")`);
  ws.close(); chrome.kill(); process.exit(0);
}catch(e){ console.log("ERR "+e.message); try{chrome.kill();}catch{} process.exit(1); }
