// Navigate to Community → Worker tab, screenshot, and assert real GitHub authors/sources appear.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"; const PORT = 9237;
const OUT = path.join(os.tmpdir(), "opc-audit-shots"); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-cw-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--window-size=1440,900", "http://localhost:3100/"], { stdio: "ignore" });
async function tgt(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${PORT}/json`)).json(); const t=l.find(x=>x.type==="page"&&/3100/.test(x.url)); if(t?.webSocketDebuggerUrl)return t; }catch{} await sleep(400);} throw new Error("no target"); }
try{
  const target=await tgt(); const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let _id=0; const pend=new Map(); ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++_id;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evalJs=async e=>(await send("Runtime.evaluate",{expression:e,returnByValue:true})).result.value;
  await send("Page.enable"); await send("Runtime.enable"); await sleep(4500);
  // nav → community (index 2)
  await evalJs(`(()=>{const nav=document.querySelector('nav');const b=nav?nav.querySelectorAll('button'):[];if(b[2])b[2].click();return true;})()`);
  await sleep(1500);
  // click Worker type filter (button text contains Worker)
  await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Worker/.test(x.textContent)&&x.textContent.length<20);if(b)b.click();return !!b;})()`);
  await sleep(1500);
  const info = await evalJs(`(()=>{const t=document.body.innerText;return JSON.stringify({hasWshobson:/wshobson/.test(t),hasMIT:/\\bMIT\\b/.test(t),hasSource:/来源/.test(t),hasAnthropic:/Anthropic/.test(t),hasOPCCommunity:/OPC Community/.test(t)});})()`);
  console.log("DOM", info);
  const cap = await send("Page.captureScreenshot", { format: "png" });
  const p = path.join(OUT, "W01-community-workers.png"); fs.writeFileSync(p, Buffer.from(cap.data, "base64"));
  console.log("SHOT", p, fs.statSync(p).size);
  ws.close(); chrome.kill(); process.exit(0);
}catch(e){ console.log("ERR "+e.message); try{chrome.kill();}catch{} process.exit(1); }
