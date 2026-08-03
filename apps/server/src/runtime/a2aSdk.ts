import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSessionToken } from "../security/sessionToken.js";

// Phase 4(方案B / code-execution 面):把 OPC 的 A2A 能力做成一个小 Node CLI(.cjs),写到系统临时目录
// (不进 worker 的 git worktree → 不污染产出 diff),worker 用自带的 shell/代码执行能力调用它。
// 研究背书:claude-code/codex 本就是代码 agent,顺势给 `node <sdk> <cmd>` 比塞 JSON 工具更省 token、
// 且天然绕开"引擎调不到 OPC 工具"的死结。身份与跨进程关联经环境变量传入(OPC_RUN_ID/OPC_AGENT_ID)。

// SDK 源码:纯 ES5 风格(无反引号/无模板串),便于安全内嵌在本 TS 模板串里。用 Node 全局 fetch(Node18+)。
const SDK_SOURCE = [
  '#!/usr/bin/env node',
  '"use strict";',
  'var API = process.env.OPC_A2A_API || "http://localhost:3100";',
  'var RUN = process.env.OPC_RUN_ID || "";',
  'var ME = process.env.OPC_AGENT_ID || "";',
  'var TOKEN = process.env.OPC_SESSION_TOKEN || "";', // 令五.6:本机 API session token,变更型 POST 必带
  'var argv = process.argv.slice(2); var cmd = argv[0]; var rest = argv.slice(1);',
  'function jpost(p, body){ var h = { "content-type":"application/json" }; if (TOKEN) h["x-opc-session-token"] = TOKEN; return fetch(API + p, { method:"POST", headers:h, body: JSON.stringify(body) }).then(function(r){ return r.json(); }); }',
  'function jget(p){ var h = {}; if (TOKEN) h["x-opc-session-token"] = TOKEN; return fetch(API + p, { headers:h }).then(function(r){ return r.json(); }); }',
  '(async function(){',
  '  try {',
  '    var out;',
  '    if (cmd === "discover") out = await jpost("/api/a2a/discover", { runId: RUN, from: ME, role: rest[0] });',
  '    else if (cmd === "request-channel") out = await jpost("/api/a2a/request-channel", { runId: RUN, from: ME, target: rest[0], reason: rest.slice(1).join(" ") });',
  '    else if (cmd === "send") out = await jpost("/api/a2a/send", { runId: RUN, from: ME, target: rest[0], text: rest.slice(1).join(" ") });',
  '    else if (cmd === "ask") out = await jpost("/api/a2a/ask", { runId: RUN, from: ME, target: rest[0], question: rest.slice(1).join(" ") });',
  '    else if (cmd === "inbox") out = await jget("/api/a2a/inbox?runId=" + encodeURIComponent(RUN) + "&agentId=" + encodeURIComponent(ME));',
  '    else if (cmd === "search") out = await jget("/api/web/search?q=" + encodeURIComponent(rest.join(" ")));',
  '    else if (cmd === "schedule-goal") out = await jpost("/api/a2a/schedule-goal", { runId: RUN, from: ME, goal: rest.join(" ") });',
  '    else if (cmd === "schedule-loop") out = await jpost("/api/a2a/schedule-loop", { runId: RUN, from: ME, prompt: rest.join(" ") });',
  '    else if (cmd === "skills") out = await jget("/api/a2a/skills");',
  '    else if (cmd === "skill") out = await jget("/api/a2a/skills/" + encodeURIComponent(rest.join(" ")));',
  '    else { console.log("usage: node a2a.cjs <search|discover|request-channel|send|ask|inbox|schedule-goal|schedule-loop|skills|skill> ..."); process.exit(2); return; }',
  '    console.log(JSON.stringify(out));',
  '  } catch (e) { console.log(JSON.stringify({ error: String((e && e.message) || e) })); process.exit(1); }',
  '})();',
  '',
].join("\n");

let sdkAbsPath = "";

// 启动时写一次(进程内静态文件)。失败则 A2A SDK 不可用(a2aSpawnEnv/a2aPromptNote 返回空,优雅降级)。
export function initA2ASdk(): void {
  try {
    const dir = path.join(os.tmpdir(), "opc-a2a-sdk");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "a2a.cjs");
    fs.writeFileSync(p, SDK_SOURCE, "utf-8");
    sdkAbsPath = p;
  } catch {
    sdkAbsPath = "";
  }
}

export function a2aSdkReady(): boolean { return !!sdkAbsPath; }

// 用 127.0.0.1(IPv4)而非 localhost:Hermes 子进程走 IPv4,服务器已绑 0.0.0.0。
function apiBase(): string { return `http://127.0.0.1:${process.env.PORT || "3100"}`; }

// spawn worker 时注入的环境变量:SDK 据此知道 OPC API 地址 + 自己是谁(跨进程会话关联)。
// 令五.6:注入本机 API session token —— worker 子进程经 A2A SDK 回调本机变更型 API(discover/send/
// ask/schedule-*)会被 sessionAuthMiddleware 强校验,不带 token 则 401 → 活体多 agent 协作断裂。
export function a2aSpawnEnv(runId: string, agentId: string): NodeJS.ProcessEnv {
  if (!sdkAbsPath) return {};
  const env: NodeJS.ProcessEnv = { OPC_A2A_API: apiBase(), OPC_RUN_ID: runId, OPC_AGENT_ID: agentId };
  const token = getSessionToken();
  if (token) env.OPC_SESSION_TOKEN = token;
  return env;
}

// 注入 worker 提示词的 A2A 使用说明(带 SDK 的绝对路径,LLM 可直接照抄运行)。
export function a2aPromptNote(): string {
  if (!sdkAbsPath) return "";
  const base = apiBase(); // http://127.0.0.1:<port>
  return `\n\n## 联网搜索(重要 — 在你的终端用 curl 运行)\n` +
    `需要事实、数据、最新信息时**主动联网搜索**(可多换关键词搜几次):\n` +
    `\`curl -s --get --data-urlencode "q=英文关键词" ${base}/api/web/search\`\n` +
    `返回 JSON:{results:[{title,url,snippet}]}。请基于真实 snippet 写结论,并在文中标注来源 URL;确实搜不到再用已有知识。\n` +
    `(注:你 agent 自带的 web/browser 工具在本机不可用、会卡死/报错,务必改用上面的 curl。)\n\n` +
    `## 与同事异步协作(可选,仅在确实缺同事信息时用)\n` +
    `(注:变更型 POST 需带本机 token 头 \`-H "x-opc-session-token: $OPC_SESSION_TOKEN"\`,已在下方示例内。)\n` +
    `- 发现可协作的同事:\`curl -s -X POST -H "content-type:application/json" -H "x-opc-session-token: $OPC_SESSION_TOKEN" -d "{\\"runId\\":\\"$OPC_RUN_ID\\",\\"from\\":\\"$OPC_AGENT_ID\\"}" ${base}/api/a2a/discover\`\n` +
    `- 查看收件箱:\`curl -s "${base}/api/a2a/inbox?runId=$OPC_RUN_ID&agentId=$OPC_AGENT_ID"\`\n\n` +
    `## 公司级工具(技能库 / 排自动化,按需使用)\n` +
    `- 列出技能库:\`curl -s ${base}/api/a2a/skills\`;取某技能全文照做:\`curl -s "${base}/api/a2a/skills/<名字>"\`\n` +
    `- 发现"完成本任务后还应持续推进的后续工作"时,可为公司排一个自动化(当前任务结束后自动开跑,不会打断现在的工作):\n` +
    `  目标式(有明确验收标准):\`curl -s -X POST -H "content-type:application/json" -H "x-opc-session-token: $OPC_SESSION_TOKEN" -d "{\\"runId\\":\\"$OPC_RUN_ID\\",\\"from\\":\\"$OPC_AGENT_ID\\",\\"goal\\":\\"<目标>\\"}" ${base}/api/a2a/schedule-goal\`\n` +
    `  持续改进式:同上但端点 /api/a2a/schedule-loop、字段 prompt。别滥用:只排真正值得的后续,一次任务至多排 1 个。`;
}
