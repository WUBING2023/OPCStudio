import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { derivePostmortem, buildPostmortem, type Postmortem } from "./failurePostmortem.js";
import type { DeferredTask, Run } from "@opc/shared";

const RUN_ID = "run-postmortem-0001";

function taskBase(over: Record<string, unknown> = {}): Partial<Run> & Record<string, unknown> {
  return {
    id: RUN_ID,
    userGoal: "写一份行业调研报告",
    companyId: "company-1",
    status: "done",
    startedAt: "2026-07-06T00:00:00.000Z",
    totalTokens: 100,
    participatingAgents: [],
    ...over,
  } as Partial<Run> & Record<string, unknown>;
}

describe("derivePostmortem", () => {
  it("provider key 失败(DeepSeek 验收样例):cause 点名 provider,suggestions 给「配置 Key」「切换模型」两条", () => {
    const deferred: DeferredTask[] = [{
      taskId: "t1",
      agentId: "dev-1",
      goal: "sub task",
      reason: "provider_unavailable",
      attempts: 1,
      lastError: "Provider unavailable: deepseek — no handler registered — missing API key or unknown provider",
    }];
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred, nameOf: (id) => (id === "dev-1" ? "小李" : undefined) });

    expect(pm.available).toBe(true);
    expect(pm.causes).toHaveLength(1);
    expect(pm.causes[0].kind).toBe("provider_key");
    expect(pm.causes[0].message).toContain("DeepSeek");
    expect(pm.causes[0].message).toContain("小李");
    expect(pm.suggestions.some((s) => s.includes("DeepSeek") && s.includes("API Key"))).toBe(true);
    expect(pm.suggestions.some((s) => s.includes("切换"))).toBe(true);
    expect(pm.actions.map((a) => a.id)).toEqual(["retry", "replan", "save_lesson", "view_logs"]);
    expect(pm.goal).toBe("写一份行业调研报告");
    expect(pm.companyId).toBe("company-1");
  });

  it("reason 是 retry_budget_exhausted 但 lastError 是 key 错误 → 仍归为 provider_key(以 lastError 文本为主)", () => {
    const deferred: DeferredTask[] = [{
      taskId: "t1", agentId: "dev-2", goal: "g", reason: "retry_budget_exhausted", attempts: 3,
      lastError: "openai 调用失败: 401 Unauthorized — invalid api key",
    }];
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred });
    expect(pm.causes[0].kind).toBe("provider_key");
    expect(pm.causes[0].message).toContain("OpenAI");
  });

  it("超时 deferred → cause kind=timeout + 拆小任务类建议", () => {
    const deferred: DeferredTask[] = [{
      taskId: "t1", agentId: "worker-1", goal: "g", reason: "timeout", attempts: 2,
      lastError: "worker timed out after 600000 ms",
    }];
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred });
    expect(pm.available).toBe(true);
    expect(pm.causes[0].kind).toBe("timeout");
    expect(pm.suggestions.some((s) => s.includes("拆小"))).toBe(true);
    expect(pm.title).toContain("延后");
  });

  it("artifact 被拒(failure-report.json 的 rejectedArtifacts)→ cause kind=artifact_rejected 并点名产物", () => {
    const pm = derivePostmortem({
      runId: RUN_ID,
      task: taskBase(),
      failureReport: { degraded: false, deferred: [], rejectedArtifacts: ["report.md"], stuckModules: [] },
    });
    expect(pm.available).toBe(true);
    expect(pm.causes[0].kind).toBe("artifact_rejected");
    expect(pm.causes[0].message).toContain("report.md");
  });

  it("degraded run → cause kind=degraded,evidence 带 degradedReason", () => {
    const pm = derivePostmortem({
      runId: RUN_ID,
      task: taskBase({ degraded: true, degradedReason: "协调者不可用,直接拼接 worker 产出" }),
    });
    expect(pm.available).toBe(true);
    expect(pm.title).toContain("降级");
    const c = pm.causes.find((x) => x.kind === "degraded");
    expect(c).toBeDefined();
    expect(c?.evidence).toContain("协调者不可用");
  });

  it("failed run 且无更具体信号 → 兜底 cause kind=run_failed", () => {
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase({ status: "failed" }) });
    expect(pm.available).toBe(true);
    expect(pm.title).toBe("任务执行失败");
    expect(pm.causes[0].kind).toBe("run_failed");
  });

  it("成功 run(done、无 deferred、无降级)→ available:false 且不给 causes/actions", () => {
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred: [] });
    expect(pm.available).toBe(false);
    expect(pm.causes).toEqual([]);
    expect(pm.suggestions).toEqual([]);
    expect(pm.actions).toEqual([]);
  });

  it("evidence 已脱敏:lastError 里的 api_key=xxx 不外泄", () => {
    const deferred: DeferredTask[] = [{
      taskId: "t1", agentId: "dev-1", goal: "g", reason: "provider_unavailable", attempts: 1,
      lastError: "Provider unavailable: deepseek — missing API key; tried api_key=sk-verysecret1234567890",
    }];
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred });
    expect(pm.causes[0].evidence).not.toContain("sk-verysecret1234567890");
    expect(pm.causes[0].evidence).toContain("[REDACTED]");
  });

  it("同类同文案的 deferred 去重,只出一条 cause", () => {
    const one: DeferredTask = { taskId: "t1", agentId: "dev-1", goal: "g", reason: "timeout", attempts: 1, lastError: "timed out" };
    const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred: [one, { ...one, taskId: "t2" }] });
    expect(pm.causes).toHaveLength(1);
  });

  // #32 · 结构化 i18n:cause 带 messageKey/params(供前端 postmortem.cause.* 词典渲染),
  // suggestionItems 与 suggestions 同序同文(前端优先 postmortem.suggestion.* 词典,旧数据回退原文)。
  describe("#32 结构化 kind+参数", () => {
    it("provider_key(key 错误明确):messageKey=provider_key + {who, provider};建议给 configure_key/switch_provider", () => {
      const deferred: DeferredTask[] = [{
        taskId: "t1", agentId: "dev-1", goal: "g", reason: "provider_unavailable", attempts: 1,
        lastError: "Provider unavailable: deepseek — missing API key",
      }];
      const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred, nameOf: (id) => (id === "dev-1" ? "小李" : undefined) });
      expect(pm.causes[0].messageKey).toBe("provider_key");
      expect(pm.causes[0].params).toEqual({ who: "小李", provider: "DeepSeek" });
      expect(pm.suggestionItems?.map((s) => s.key)).toEqual(["configure_key", "switch_provider"]);
      expect(pm.suggestionItems?.[0].params).toEqual({ provider: "DeepSeek" });
      expect(pm.suggestionItems?.map((s) => s.text)).toEqual(pm.suggestions);
    });

    it("provider 检出但无 key 标志:messageKey=provider_key_likely(同 kind 两种文案要分键)", () => {
      const deferred: DeferredTask[] = [{
        taskId: "t1", agentId: "dev-1", goal: "g", reason: "provider_unavailable", attempts: 1,
        lastError: "Provider unavailable: ollama connection refused",
      }];
      const pm = derivePostmortem({ runId: RUN_ID, task: taskBase(), deferred });
      expect(pm.causes[0].kind).toBe("provider_key");
      expect(pm.causes[0].messageKey).toBe("provider_key_likely");
      expect(pm.causes[0].params).toEqual({ who: "dev-1", provider: "Ollama" });
    });

    it("artifact_rejected 带 {ref};degraded/run_failed 有 messageKey 无 params", () => {
      const pm = derivePostmortem({
        runId: RUN_ID,
        task: taskBase({ status: "failed", degraded: true }),
        failureReport: { degraded: true, deferred: [], rejectedArtifacts: ["report.md"], stuckModules: [] },
      });
      const rejected = pm.causes.find((c) => c.kind === "artifact_rejected");
      expect(rejected?.messageKey).toBe("artifact_rejected");
      expect(rejected?.params).toEqual({ ref: "report.md" });
      const degraded = pm.causes.find((c) => c.kind === "degraded");
      expect(degraded?.messageKey).toBe("degraded");
      expect(degraded?.params).toBeUndefined();
    });

    it("run_failed 兜底:messageKey=run_failed;suggestionItems 键与 kind 对齐", () => {
      const pm = derivePostmortem({ runId: RUN_ID, task: taskBase({ status: "failed" }) });
      expect(pm.causes[0].messageKey).toBe("run_failed");
      expect(pm.suggestionItems?.map((s) => s.key)).toEqual(["run_failed"]);
    });
  });
});

describe("buildPostmortem (disk wrapper)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup(files: Record<string, unknown>): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "postmortem-"));
    const dir = path.join(root, ".opc", "runs", RUN_ID);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data), "utf-8");
    }
    return root;
  }

  it("task.json 缺失 → null(路由层 404)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "postmortem-"));
    expect(buildPostmortem(root, RUN_ID)).toBeNull();
  });

  it("从落盘证据文件组装:task.json + deferred.json → provider_key 复盘卡", () => {
    const r = setup({
      "task.json": taskBase(),
      "deferred.json": [{
        taskId: "t1", agentId: "dev-1", goal: "g", reason: "provider_unavailable", attempts: 1,
        lastError: "Provider unavailable: deepseek — missing API key",
      }],
    });
    const pm = buildPostmortem(r, RUN_ID) as Postmortem;
    expect(pm.available).toBe(true);
    expect(pm.causes[0].kind).toBe("provider_key");
    expect(pm.causes[0].message).toContain("DeepSeek");
  });

  it("成功 run 落盘(无 deferred/降级)→ available:false", () => {
    const r = setup({ "task.json": taskBase(), "deferred.json": [] });
    const pm = buildPostmortem(r, RUN_ID) as Postmortem;
    expect(pm.available).toBe(false);
  });
});
