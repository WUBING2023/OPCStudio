// 阶段2 · 最小价值评测 runner:同一确定性任务,单 Agent 基线(runType=quick)vs OPC 公司(runType=team),
// 同 provider/model、同时间·token 上限,各重复 N 次,机器可验成功率/成本/token/耗时/deferred/degraded/人工介入对照。
//
// 运行(必须用 tsx,因为要 import valueEval.ts 的真实聚合逻辑做活体验证):
//   apps/server/node_modules/.bin/tsx scripts/value-eval.mjs            # 默认 --dry-run(不派发,喂固定 mock 验聚合链路)
//   apps/server/node_modules/.bin/tsx scripts/value-eval.mjs --live     # 真实付费派发(需 server 3100 在跑 + 先查无在飞 run)
//
// 参数:
//   --live               真实派发(默认关;不给则 dry-run)
//   --n=2                每臂每任务重复次数(默认 2)
//   --max-runs=8         真实付费 run 总上限(默认 8;超过直接拒发,防烧钱)
//   --company=<id>       团队臂所属公司(--live 且 team 臂需要;能力闸/记忆按此公司)
//   --team-mode=economy  team 引擎策略(economy/balanced/maxQuality;默认 economy → deepseek 经济档)
//   --tasks=id1,id2      只跑指定任务(默认全部)
//   --poll-timeout-ms    单 run 轮询上限(默认 900000=15min)
//
// 红线:N 小(默认 2)只支持 Private Beta 初步证据,报告强制带"禁止宣传普遍优于单 Agent"声明。
// 机器可验成功=用 runner 侧独立断言核验团队【冻结产物】(changes.json 的 after 字节),不信任团队自带测试、
// 不用 finalState 当成功。真实派发因需付费故默认 dry-run;派发/轮询/抽取代码完整可跑。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { summarizeArm, comparisonMarkdown, opcNetBetter } from "../apps/server/src/runtime/valueEval.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// 输入 fixtures 与脚本同放 scripts/(版本控制,非运行时数据);输出报告落 .opc/(运行时产物,不入库)。
const FIX_DIR = path.join(HERE, "value-eval-fixtures");
const OUT_DIR = path.join(ROOT, ".opc", "mup-battle");
const RUNS_DIR = path.join(ROOT, ".opc", "runs");
const BASE = "http://127.0.0.1:3100/api";

// ── args ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const LIVE = flag("live");
const N = Math.max(1, parseInt(opt("n", "2"), 10) || 2);
const MAX_RUNS = Math.max(1, parseInt(opt("max-runs", "8"), 10) || 8);
const COMPANY = opt("company", undefined);
const TEAM_MODE = opt("team-mode", "economy");
const ONLY = (opt("tasks", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const POLL_TIMEOUT_MS = parseInt(opt("poll-timeout-ms", "900000"), 10) || 900000;
const POLL_INTERVAL_MS = 4000;

const ARMS = /** @type {const} */ ([
  { arm: "single-agent", runType: "quick" },
  { arm: "opc-company", runType: "team" },
]);

// ── fixtures ──
function loadTasks() {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX_DIR, "tasks.json"), "utf8"));
  let tasks = raw.tasks;
  if (ONLY.length) tasks = tasks.filter((t) => ONLY.includes(t.id));
  if (!tasks.length) throw new Error("no fixture tasks selected");
  return tasks;
}

// ── http (令五.6:变更型请求带 session token) ──
let SESSION_TOKEN = "";
async function loadToken() {
  try {
    const r = await fetch(`${BASE}/session/token`);
    const j = await r.json();
    SESSION_TOKEN = j.token || "";
  } catch { SESSION_TOKEN = ""; }
}
async function post(p, body) {
  const h = { "Content-Type": "application/json" };
  if (SESSION_TOKEN) h["x-opc-session-token"] = SESSION_TOKEN;
  const r = await fetch(BASE + p, { method: "POST", headers: h, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: j };
}
async function get(p) {
  const h = {};
  if (SESSION_TOKEN) h["x-opc-session-token"] = SESSION_TOKEN;
  const r = await fetch(BASE + p, { headers: h });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── in-flight guard(真实派发前必须查无在飞 run;铁律) ──
async function assertNoInFlight() {
  const r = await get("/runs");
  const rows = Array.isArray(r.body) ? r.body : [];
  const running = rows.filter((x) => x && (x.status === "running" || x.status === "pending"));
  if (running.length) {
    throw new Error(`有 ${running.length} 个在飞/排队 run(${running.map((x) => `${x.id}:${x.status}`).join(", ")});禁止在有在飞 run 时发起付费评测。请等其收尾后重试。`);
  }
}

// ── dispatch one arm run → runId ──
async function dispatchArm(task, runType) {
  const body = { message: task.goal, runType, teamMode: TEAM_MODE };
  if (COMPANY) body.companyId = COMPANY;
  const res = await post("/chat/task", body);
  if (res.status !== 200) {
    throw new Error(`dispatch 失败 status=${res.status} body=${JSON.stringify(res.body)?.slice(0, 240)}`);
  }
  const b = res.body || {};
  if (b.approvalRequired) {
    // L3 高风险需人工审批 —— runner 绝不自动批准(铁律:不代替人做审批决策)。诚实中止本臂。
    throw new Error(`任务被 Run Governance 判为 L3 需人工审批(runId=${b.runId});runner 不自动审批,跳过。reason=${b.governanceReason || ""}`);
  }
  if (!b.runId) throw new Error(`dispatch 未返回 runId:${JSON.stringify(b)?.slice(0, 200)}`);
  if (b.queued) {
    // 撞在飞被入队 —— 与"先查无在飞"矛盾,说明有竞态。等待其出队起跑(轮询会覆盖后续)。
    console.log(`  [queued #${b.queuePosition}] runId=${b.runId},等待出队…`);
  }
  return b.runId;
}

// ── result.json 落盘判终态 ──
function readRunResult(runId) {
  const p = path.join(RUNS_DIR, runId, "result.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function isTerminal(result) {
  if (!result) return false;
  if (result.endedAt) return true;
  return ["done", "failed", "degraded", "verified"].includes(result.status);
}

async function pollRun(runId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = readRunResult(runId);
    if (isTerminal(result)) return result;
    // 磁盘 result.json 还没落,退一步看 API 任务态(pending/running/failed)。
    const t = await get(`/runs/${encodeURIComponent(runId)}`);
    if (t.status === 200 && t.body && ["done", "failed", "degraded"].includes(t.body.status) && t.body.endedAt) {
      const r2 = readRunResult(runId);
      if (isTerminal(r2)) return r2;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`run ${runId} 轮询超时(${POLL_TIMEOUT_MS}ms)未收尾`);
}

// ── 机器可验:用 runner 侧独立断言核验团队冻结产物(changes.json 的 after 字节) ──
function loadChanges(runId) {
  const p = path.join(RUNS_DIR, runId, "changes.json");
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}
function findProduced(changes, expectedFile) {
  const want = path.basename(expectedFile).toLowerCase();
  // 优先精确 basename 命中,取最后一个(last-wins,反映最终产物)且有 after 内容的。
  const hits = changes.filter((c) => c && typeof c.path === "string" && path.basename(c.path).toLowerCase() === want && typeof c.after === "string");
  return hits.length ? hits[hits.length - 1] : null;
}
function verifyNodeAssert(content, verify) {
  // 把团队产出的实现字节写到临时 CJS 目录,配一份 runner 自带断言 harness 跑真实行为断言。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-veval-"));
  try {
    const modName = path.basename(verify.requirePath || "module.js");
    fs.writeFileSync(path.join(dir, modName), content, "utf8");
    const harness = `
const assert = require("assert");
const fn = require(${JSON.stringify(verify.requirePath)});
const cases = ${JSON.stringify(verify.cases)};
for (const c of cases) {
  if (c.throws) {
    let threw = false;
    try { fn.apply(null, c.args); } catch { threw = true; }
    assert.ok(threw, "expected throw: " + (c.desc || JSON.stringify(c.args)));
  } else {
    const got = fn.apply(null, c.args);
    assert.deepStrictEqual(got, c.equals, (c.desc || "") + " got=" + JSON.stringify(got) + " want=" + JSON.stringify(c.equals));
  }
}
console.log("VERIFY_OK");
`;
    fs.writeFileSync(path.join(dir, "_verify.cjs"), harness, "utf8");
    const out = execFileSync(process.execPath, ["_verify.cjs"], { cwd: dir, encoding: "utf8", timeout: 20000 });
    return { verified: out.includes("VERIFY_OK"), note: out.trim().slice(0, 200) };
  } catch (e) {
    return { verified: false, note: `node-assert FAIL: ${String(e.message || e).slice(0, 200)}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
function verifyContentMarkers(content, verify) {
  const missing = (verify.allOf || []).filter((m) => !content.includes(m));
  return { verified: missing.length === 0, note: missing.length ? `missing markers: ${missing.join(", ")}` : "all markers present" };
}
// 纯函数:对给定产物 changes 数组做机器核验(可单测,不碰磁盘 run 目录)。
export function verifyProducedChanges(task, changes) {
  const produced = findProduced(changes, task.expectedFile);
  if (!produced) return { verified: false, note: `expectedFile ${task.expectedFile} 未在产物 changes.json 出现(团队未产出该文件)` };
  const v = task.verify || {};
  if (v.kind === "node-assert") return verifyNodeAssert(produced.after, v);
  if (v.kind === "content-markers") return verifyContentMarkers(produced.after, v);
  return { verified: false, note: `未知 verify.kind=${v.kind}` };
}
function verifyProduced(task, runId) {
  return verifyProducedChanges(task, loadChanges(runId));
}

// ── 人工介入抽取(best-effort;当前全自动 run 期望 0;此字段用于捕捉需人工解阻的 run) ──
const HUMAN_EVENT_TYPES = new Set(["approval_granted", "approval_rejected", "human_intervention", "conflict_resolved_by_human", "human_unblock"]);
function countHumanInterventions(runId) {
  const p = path.join(RUNS_DIR, runId, "events.jsonl");
  if (!fs.existsSync(p)) return 0;
  try {
    let n = 0;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (HUMAN_EVENT_TYPES.has(e.type)) n++; } catch { /* skip */ }
    }
    return n;
  } catch { return 0; }
}

// ── 从一次真实 run 抽 ArmRunResult ──
function extractEvidence(arm, task, repeat, runId, result) {
  const startedAt = result?.startedAt ? Date.parse(result.startedAt) : NaN;
  const endedAt = result?.endedAt ? Date.parse(result.endedAt) : NaN;
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : 0;
  const { verified, note } = verifyProduced(task, runId);
  const deferred = Array.isArray(result?.deferred) ? result.deferred.length : 0;
  return {
    arm,
    taskId: task.id,
    repeat,
    runId,
    finalState: result?.finalState,
    deliveryStatus: result?.deliveryAcceptance?.status,
    verified,
    verifyNote: note,
    cost: Number(result?.totalCostUsd) || 0,
    tokens: Number(result?.totalTokens) || 0,
    durationMs,
    deferred,
    degraded: !!result?.degraded,
    humanInterventions: countHumanInterventions(runId),
  };
}

// ── dry-run:固定 mock 结果验聚合链路(含"OPC 更贵不算净优"的诚实分支) ──
function mockResultsFor(task) {
  // 确定性:node 任务 OPC 成功率更高(净优);research 任务两臂持平但 OPC 更贵(诚实:不算净优)。
  const higherWin = task.kind === "node-coding";
  const out = [];
  for (const { arm } of ARMS) {
    for (let i = 1; i <= N; i++) {
      let verified, cost;
      if (arm === "single-agent") {
        verified = higherWin ? i === 1 : true;      // node: 1/N;research: 全成功
        cost = higherWin ? 0.004 : 0.006;
      } else {
        verified = true;                              // opc 全成功
        cost = higherWin ? 0.012 : 0.030;            // research: opc 更贵
      }
      out.push({
        arm, taskId: task.id, repeat: i, runId: `dry-${task.id}-${arm}-${i}`,
        finalState: verified ? "verified" : "failed",
        deliveryStatus: verified ? "verified" : "tests_ran_unbound",
        verified, verifyNote: "(dry-run mock)",
        cost, tokens: arm === "single-agent" ? 8000 + i * 500 : 45000 + i * 2000,
        durationMs: arm === "single-agent" ? 30000 + i * 1000 : 130000 + i * 5000,
        deferred: 0, degraded: !verified, humanInterventions: 0,
      });
    }
  }
  return out;
}

// ── main ──
async function main() {
  const tasks = loadTasks();
  const mode = LIVE ? "LIVE(真实付费派发)" : "DRY-RUN(不派发,mock 验聚合)";
  console.log(`=== 价值评测 runner · ${mode} · N=${N} · tasks=[${tasks.map((t) => t.id).join(", ")}] ===`);

  /** @type {any[]} */
  const allResults = [];

  if (LIVE) {
    await loadToken();
    console.log(`session token: ${SESSION_TOKEN ? "loaded len=" + SESSION_TOKEN.length : "NONE(server 未启用/不可达)"}`);
    if (!SESSION_TOKEN) throw new Error("无 session token:server 3100 未在跑或不可达,--live 无法派发");
    if (!COMPANY) console.log("  [warn] 未传 --company:team 臂能力闸/记忆按默认公司,可能被闸拦。");
    const totalPlanned = tasks.length * ARMS.length * N;
    if (totalPlanned > MAX_RUNS) {
      throw new Error(`计划付费 run 数 ${totalPlanned} 超过 --max-runs=${MAX_RUNS};缩小 N 或 --tasks 后重试(防烧钱)。`);
    }
    await assertNoInFlight();

    let spent = 0;
    for (const task of tasks) {
      for (const { arm, runType } of ARMS) {
        for (let i = 1; i <= N; i++) {
          if (spent >= MAX_RUNS) { console.log(`  达到 --max-runs=${MAX_RUNS},停止派发。`); break; }
          spent++;
          console.log(`\n[${spent}/${totalPlanned}] task=${task.id} arm=${arm}(${runType}) repeat=${i} 派发中…`);
          const runId = await dispatchArm(task, runType);
          console.log(`  runId=${runId} 轮询收尾…`);
          const result = await pollRun(runId);
          const ev = extractEvidence(arm, task, i, runId, result);
          console.log(`  → verified=${ev.verified} cost=$${ev.cost.toFixed(5)} tokens=${ev.tokens} ${ev.durationMs}ms deliveryStatus=${ev.deliveryStatus} | ${ev.verifyNote}`);
          allResults.push(ev);
          // 串行:确保任意时刻至多 1 个在飞 run(单 run 互斥闸 + 铁律)。
        }
      }
    }
  } else {
    for (const task of tasks) allResults.push(...mockResultsFor(task));
    console.log(`  已生成 ${allResults.length} 条 mock 证据(不派发)。`);
  }

  // ── 聚合(活体验证 valueEval 真实逻辑) ──
  const groups = new Map();
  for (const r of allResults) {
    const key = `${r.taskId}::${r.arm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const summaries = [];
  for (const rows of groups.values()) summaries.push(summarizeArm(rows));

  const netBetter = [];
  for (const task of tasks) {
    const single = summaries.find((s) => s.taskId === task.id && s.arm === "single-agent");
    const opc = summaries.find((s) => s.taskId === task.id && s.arm === "opc-company");
    if (single && opc) netBetter.push({ taskId: task.id, ...opcNetBetter(single, opc) });
  }

  const md = comparisonMarkdown(summaries);
  const verdictLines = [
    "",
    "## OPC 净优判读(诚实口径:更贵更慢但不更好 ≠ 优势)",
    "",
    "| 任务 | OPC 是否净优 | 依据 |",
    "|---|---|---|",
    ...netBetter.map((v) => `| ${v.taskId} | ${v.better ? "是" : "否"} | ${v.reason} |`),
    "",
    `> 本轮 N=${N}(每臂每任务重复次数)。**仅初步证据,禁止据此宣传「OPC 普遍优于单 Agent」。**`,
    LIVE ? "> 数据来源:真实付费派发 + runner 侧独立断言核验冻结产物。" : "> 数据来源:DRY-RUN 固定 mock(仅验证聚合/判读链路是否活着,非产品证据)。",
  ];
  const fullMd = md + "\n" + verdictLines.join("\n");

  const report = {
    schemaVersion: "1",
    mode: LIVE ? "live" : "dry-run",
    generatedAt: new Date().toISOString(),
    n: N,
    teamMode: TEAM_MODE,
    company: COMPANY || null,
    tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, expectedFile: t.expectedFile, verifyKind: t.verify?.kind })),
    rawResults: allResults,
    summaries,
    netBetter,
    honesty: `N=${N} 仅 Private Beta 初步证据,禁止宣传「普遍优于单 Agent」;成功=机器可验(独立断言核验冻结产物),非 finalState。`,
  };

  const suffix = LIVE ? "live" : "dryrun";
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `value-eval-report-${suffix}.json`);
  const mdPath = path.join(OUT_DIR, `value-eval-report-${suffix}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(mdPath, fullMd, "utf8");

  console.log(`\n${fullMd}\n`);
  console.log(`写出:\n  ${jsonPath}\n  ${mdPath}`);
}

// main-guard:仅作为入口脚本直接运行时执行派发/聚合;被 import(单测核验 helper)时不自动跑。
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((e) => { console.error("VALUE-EVAL ERROR:", e?.message || e); process.exitCode = 1; });
}
