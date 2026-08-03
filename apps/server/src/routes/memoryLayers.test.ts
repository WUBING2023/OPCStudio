// GET /api/memory/layers · 记忆层级真实注入资格聚合 + 与 contextBuilder 注入事实对齐(防止 UI 说谎)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";

// register() 从 orchestrator 读 getAgents——mock 成空数组,避免 import 整个 orchestrator(与 memoryRoutes.test.ts 同一做法)。
vi.mock("../runtime/orchestrator.js", () => ({ getAgents: () => [] }));

import { register, buildMemoryLayers, type MemoryLayersResult } from "./memoryRoutes.js";
import { commitLesson, type FailureMode } from "../storage/reflectionStore.js";
import { buildSystemPrompt, setInjectionEnabled } from "../runtime/contextBuilder.js";

const NOW = "2026-07-09T00:00:00.000Z";

let root: string;
let server: Server;
let baseUrl: string;

async function startServer(r: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, r);
  const srv = createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server: srv, baseUrl: `http://127.0.0.1:${port}` };
}

function writeFile(rel: string, content: string) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, "utf-8");
}

function seedRegistry() {
  const lines = [
    { id: "c1", kind: "conclusion_summary", runId: "r", goalSlug: "g", points: ["p1"], tags: [], createdAt: NOW, status: "approved" },
    { id: "c2", kind: "conclusion_summary", runId: "r", goalSlug: "g", points: ["p2"], tags: [], createdAt: NOW, status: "pending" },
    { id: "s1", kind: "procedural_skill", role: "dev", successfulSequence: ["a", "b"], support: 3, successRate: 0.9, sourceRuns: ["r"], status: "verified", createdAt: NOW, updatedAt: NOW },
    { id: "s2", kind: "procedural_skill", role: "dev", successfulSequence: ["a"], support: 1, successRate: 0.5, sourceRuns: [], status: "candidate", createdAt: NOW, updatedAt: NOW },
    { id: "p1", kind: "plan_template", taskType: "general", goalSlug: "g", split: ["s"], workerCount: 2, sourceRun: "r", support: 1, createdAt: NOW, updatedAt: NOW },
  ];
  writeFile(path.join(".opc", "memory", "registry.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// 干净成功 run 的 task.json(done/verified):fail-closed 硬化后,缺 task.json 的 run 目录会被检索侧整体排除
// (committedMemoryRetriever/isFromExcludedRun),导致跨 run committed 记忆算不进 eligibleCount / 不进 prompt。
// 这些测试的种子记忆本就来自成功 run,补上 task.json 让它们如实计为可注入。
function seedCleanRun(runId: string) {
  writeFile(path.join(".opc", "runs", runId, "task.json"), JSON.stringify({ id: runId, status: "done", finalState: "verified" }));
}

function seedCommitted(runId: string, count: number) {
  const arr = Array.from({ length: count }, (_, i) => ({
    memoryId: `m${i}`, version: 1, parentVersion: 0, scope: "project", type: "run_conclusion",
    content: `跨 run 结论 ${i}`, sourceArtifactRefs: [], approvedBy: "human", confidence: 0.8, revocable: true, createdAt: NOW,
  }));
  writeFile(path.join(".opc", "runs", runId, "committed-memories.json"), JSON.stringify(arr));
}

const committedLesson = (): Parameters<typeof commitLesson>[1] => ({
  kind: "failure_lesson" as const, // 低风险 → 自动 committed
  scope: { role: "dev", taskType: "general" },
  trigger: { eventTypes: [], failureMode: "timeout" as FailureMode, conditionText: "多来源核查一次调用超时" },
  diagnosis: "核查任务一次吃下全部来源导致超时",
  lesson: "多来源核查应按来源拆分为子任务",
  recommendedChange: "每子任务限单来源并提前写盘",
  injection: { strength: "warning" as const, promptText: "上次核查超时这次按来源拆小步" },
  evidence: { runId: "r", agentId: "w1" },
  confidence: 0.7,
});
// 高风险(risk_warning + 内容关键词)→ 停 proposed(不可注入);diagnosis 不同 → dedupeKey 不同,不与上条合并。
const proposedLesson = (): Parameters<typeof commitLesson>[1] => ({
  kind: "risk_warning" as const,
  scope: { role: "dev", taskType: "general" },
  trigger: { eventTypes: [], failureMode: "degraded" as FailureMode, conditionText: "改线上权限前未在预发验证" },
  diagnosis: "部署脚本直接改线上权限未先预发验证",
  lesson: "改线上权限前先在预发环境验证",
  recommendedChange: "预发验证通过后再灰度发布",
  injection: { strength: "warning" as const, promptText: "改权限前先预发验证再灰度发布" },
  evidence: { runId: "r", agentId: "w1" },
  confidence: 0.7,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memlayers-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  setInjectionEnabled(true);
  ({ server, baseUrl } = await startServer(root));
});
afterEach(() => { server.close(); setInjectionEnabled(true); });

function layerMap(r: MemoryLayersResult): Record<string, { count: number; eligibleCount: number; eligibleForPrompt: boolean }> {
  const m: Record<string, { count: number; eligibleCount: number; eligibleForPrompt: boolean }> = {};
  for (const l of r.layers) m[l.key] = { count: l.count, eligibleCount: l.eligibleCount, eligibleForPrompt: l.eligibleForPrompt };
  return m;
}

describe("GET /api/memory/layers · 聚合正确性", () => {
  it("空项目:所有层 count=0,注入资格仍如实标注(plan_template=false,含 committed 在内其余=true)", async () => {
    const res = await fetch(`${baseUrl}/api/memory/layers`);
    expect(res.status).toBe(200);
    const body = await res.json() as MemoryLayersResult;
    const m = layerMap(body);
    // committed 自 P0 修复起真的进 prompt("## 已审批的经验(跨 run 复用)"段),记忆页必须跟着说真话。
    const injected = ["md_company", "md_team", "md_project", "md_agent", "skill", "memory_entry", "lesson", "conclusion", "procedural_skill", "committed"];
    for (const k of injected) expect(m[k]?.eligibleForPrompt, k).toBe(true);
    expect(m.plan_template.eligibleForPrompt).toBe(false);
    // skill 是全局(用户级)技能池,不随 projectRoot 归零(skillStore.skillsDir 忽略 projectRoot);其余层项目级 → 0。
    for (const l of body.layers) { if (l.key === "skill") continue; expect(l.count, l.key).toBe(0); }
    expect(m.skill.eligibleForPrompt).toBe(true);
    expect(body.lastContextBuild).toBeNull();
  });

  it("有数据:count 与 eligibleCount 与各 store 事实一致", async () => {
    seedRegistry();
    seedCommitted("run-committed", 2);
    seedCleanRun("run-committed"); // 跨 run committed 来自成功 run → eligibleCount 计数需 task.json 证明干净收尾
    commitLesson(root, committedLesson(), NOW); // committed
    commitLesson(root, proposedLesson(), NOW);  // proposed(不可注入)
    writeFile(path.join(".opc", "knowledge", "company.md"), "co");
    writeFile(path.join(".opc", "knowledge", "teams", "lead1.md"), "t");
    writeFile(path.join(".opc", "knowledge", "projects", "lead1.md"), "pj");
    writeFile(path.join(".opc", "knowledge", "agents", "a1.md"), "me");

    const m = layerMap(buildMemoryLayers(root));
    // md:各 1 份
    expect(m.md_company).toMatchObject({ count: 1, eligibleCount: 1, eligibleForPrompt: true });
    expect(m.md_team).toMatchObject({ count: 1, eligibleForPrompt: true });
    expect(m.md_project).toMatchObject({ count: 1, eligibleForPrompt: true });
    expect(m.md_agent).toMatchObject({ count: 1, eligibleForPrompt: true });
    // lessons:2 条,仅 committed 那条可注入
    expect(m.lesson).toMatchObject({ count: 2, eligibleCount: 1, eligibleForPrompt: true });
    // 结论:2 条,pending 不算可注入
    expect(m.conclusion).toMatchObject({ count: 2, eligibleCount: 1, eligibleForPrompt: true });
    // 推荐工作流:2 条,仅 verified+序列≥2 可注入
    expect(m.procedural_skill).toMatchObject({ count: 2, eligibleCount: 1, eligibleForPrompt: true });
    // 计划模板:1 条,永不进 prompt
    expect(m.plan_template).toMatchObject({ count: 1, eligibleCount: 0, eligibleForPrompt: false });
    // 跨 run committed:2 条,来自成功 run → 全部可注入(失败/降级 run 来源会被检索侧隔离,见 memoryHonesty.test.ts)
    expect(m.committed).toMatchObject({ count: 2, eligibleCount: 2, eligibleForPrompt: true });
  });

  it("lastContextBuild:取含 memory_pack_used 事件的最近 run", async () => {
    writeFile(
      path.join(".opc", "runs", "run-evt", "events.jsonl"),
      JSON.stringify({ type: "info", agentId: "w1", timestamp: "2026-07-09T10:00:00.000Z", payload: { kind: "memory_pack_used", countsByScope: {} } }) + "\n",
    );
    const r = buildMemoryLayers(root);
    expect(r.lastContextBuild).toEqual({ runId: "run-evt", at: "2026-07-09T10:00:00.000Z" });
  });
});

// 防止 UI 说谎(正反都不许):eligibleForPrompt=false 的层(plan_template)必须真的不出现在 prompt 里;
// =true 的层(company.md、已审批的 committed)必须真的出现——用 contextBuilder.buildSystemPrompt 实证。
describe("记忆层级注入资格 ↔ contextBuilder 实际注入 对齐", () => {
  it("committed 与 company.md 进 prompt;plan_template 不进", () => {
    writeFile(path.join(".opc", "knowledge", "company.md"), "COMPANY_MARKER_XYZ");
    seedCommitted("run-past", 1); // content 里没有 marker;下面单独塞一个带 marker 的
    seedCleanRun("run-past"); // 成功 run,contextBuilder 检索才注入其 committed 记忆(缺 task.json 会被 fail-closed 排除)
    writeFile(
      path.join(".opc", "runs", "run-past", "committed-memories.json"),
      JSON.stringify([{ memoryId: "mm", version: 1, parentVersion: 0, scope: "project", type: "run_conclusion", content: "COMMITTED_MARKER_XYZ 爬虫 数据", sourceArtifactRefs: [], approvedBy: "human", confidence: 0.9, revocable: true, createdAt: NOW, companyId: "co1" }]),
    );
    writeFile(
      path.join(".opc", "memory", "registry.jsonl"),
      JSON.stringify({ id: "pt", kind: "plan_template", taskType: "general", goalSlug: "g", split: ["PLAN_MARKER_XYZ 子任务"], workerCount: 2, sourceRun: "r", support: 1, createdAt: NOW, updatedAt: NOW }) + "\n",
    );

    const agent = { id: "a1", role: "dev", companyId: "co1", parentId: "lead1" } as unknown as AgentNodeConfig;
    const out = { projectRoot: root, runId: "run-cur", injectedSkillIds: [], injectedMemoryIds: [] };
    const prompt = buildSystemPrompt(agent, "BASE_ROLE_PROMPT", "写一个爬虫抓取数据", root, out);

    expect(prompt).toContain("COMPANY_MARKER_XYZ");   // md_company eligibleForPrompt=true 属实
    expect(prompt).toContain("COMMITTED_MARKER_XYZ"); // committed eligibleForPrompt=true 属实(P0 修复后真的注入)
    expect(prompt).toContain("## Legacy memory compatibility fallback");
    expect(prompt).not.toContain("PLAN_MARKER_XYZ");  // plan_template eligibleForPrompt=false 属实
    // 引用条只列真注入的:committed 已进 prompt → 必然在 injectedMemoryIds 里
    expect(out.injectedMemoryIds).toContain("mm");
  });
});
