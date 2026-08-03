import { describe, it, expect } from "vitest";
import { RunHistory, CONVERGED_EVENT_CAP } from "./runHistory.js";
import type { RunEvent, FailureReport } from "./runHistory.js";

// ── 测试用固定时间戳（不用 Date.now）────────────────────────────────────────────
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const T4 = "2026-01-01T00:04:00.000Z";

// ── appendEvent ───────────────────────────────────────────────────────────────

describe("RunHistory.appendEvent — 基本行为", () => {
  it("追加第一条事件后 length === 1，seq === 1", () => {
    const hist = new RunHistory();
    const ev = hist.appendEvent("run_started", T0);
    expect(hist.length).toBe(1);
    expect(ev.seq).toBe(1);
    expect(ev.type).toBe("run_started");
    expect(ev.at).toBe(T0);
  });

  it("连续追加三条事件，seq 单调递增 1/2/3", () => {
    const hist = new RunHistory();
    const e1 = hist.appendEvent("run_started",  T0);
    const e2 = hist.appendEvent("agent_deferred", T1, "worker-1");
    const e3 = hist.appendEvent("run_finished", T2);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(hist.length).toBe(3);
  });

  it("agentId 为 undefined 时事件对象不含 agentId 键", () => {
    const hist = new RunHistory();
    const ev = hist.appendEvent("run_started", T0);
    expect("agentId" in ev).toBe(false);
  });

  it("payload 为 undefined 时事件对象不含 payload 键", () => {
    const hist = new RunHistory();
    const ev = hist.appendEvent("run_started", T0, "agent-1");
    expect("payload" in ev).toBe(false);
  });

  it("传入 agentId 与 payload 时均被正确存储", () => {
    const hist = new RunHistory();
    const ev = hist.appendEvent("agent_deferred", T1, "worker-2", { reason: "timeout" });
    expect(ev.agentId).toBe("worker-2");
    expect(ev.payload).toEqual({ reason: "timeout" });
  });

  it("追加不在 KnownRunEventType 内的自定义事件类型不报错", () => {
    const hist = new RunHistory();
    expect(() => hist.appendEvent("custom_event_xyz", T0)).not.toThrow();
    expect(hist.length).toBe(1);
  });
});

describe("RunHistory.getEvents — 快照隔离", () => {
  it("返回内容与追加顺序一致", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    hist.appendEvent("run_finished", T1);
    const events = hist.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("run_started");
    expect(events[1].type).toBe("run_finished");
  });

  it("修改返回的数组不影响内部状态", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    const snapshot = hist.getEvents();
    snapshot.pop();
    expect(hist.length).toBe(1);
  });
});

// ── toJSONL / fromJSONL ────────────────────────────────────────────────────────

describe("RunHistory.toJSONL — 序列化", () => {
  it("空历史返回空字符串", () => {
    const hist = new RunHistory();
    expect(hist.toJSONL()).toBe("");
  });

  it("单条事件产出一行有效 JSON", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0, "ceo-1");
    const jsonl = hist.toJSONL();
    expect(jsonl.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(jsonl) as RunEvent;
    expect(parsed.seq).toBe(1);
    expect(parsed.type).toBe("run_started");
    expect(parsed.agentId).toBe("ceo-1");
    expect(parsed.at).toBe(T0);
  });

  it("多条事件每条一行，行数与事件数相等", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started",   T0);
    hist.appendEvent("agent_deferred", T1, "w-1");
    hist.appendEvent("run_finished",  T2);
    const lines = hist.toJSONL().split("\n");
    expect(lines).toHaveLength(3);
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it("payload 字段被正确序列化", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "worker-1", { artifactId: "art-42", reason: "missing section" });
    const parsed = JSON.parse(hist.toJSONL()) as RunEvent;
    expect(parsed.payload?.artifactId).toBe("art-42");
  });
});

describe("RunHistory.fromJSONL — 反序列化", () => {
  it("空字符串返回空历史", () => {
    const hist = RunHistory.fromJSONL("");
    expect(hist.length).toBe(0);
  });

  it("只含空行时返回空历史", () => {
    const hist = RunHistory.fromJSONL("\n\n  \n");
    expect(hist.length).toBe(0);
  });

  it("往返（to → from）后事件数量与内容一致", () => {
    const orig = new RunHistory();
    orig.appendEvent("run_started",    T0, "ceo");
    orig.appendEvent("agent_deferred", T1, "worker-3", { reason: "budget" });
    orig.appendEvent("run_finished",   T2);

    const restored = RunHistory.fromJSONL(orig.toJSONL());
    expect(restored.length).toBe(3);

    const events = restored.getEvents();
    expect(events[0].type).toBe("run_started");
    expect(events[1].agentId).toBe("worker-3");
    expect(events[1].payload?.reason).toBe("budget");
    expect(events[2].type).toBe("run_finished");
  });

  it("往返后 seq 连续性保留（值与原始一致）", () => {
    const orig = new RunHistory();
    orig.appendEvent("run_started", T0);
    orig.appendEvent("run_finished", T1);

    const restored = RunHistory.fromJSONL(orig.toJSONL());
    const [e1, e2] = restored.getEvents();
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  it("fromJSONL 后追加的事件 seq 从 max+1 开始，不从 1 重置", () => {
    const orig = new RunHistory();
    orig.appendEvent("run_started",  T0);
    orig.appendEvent("agent_deferred", T1, "w-1");

    const restored = RunHistory.fromJSONL(orig.toJSONL());
    const newEv = restored.appendEvent("run_finished", T2);
    expect(newEv.seq).toBe(3);
  });

  it("损坏的 JSON 行被跳过，有效行仍被加载（best-effort）", () => {
    const validLine = JSON.stringify({ seq: 1, type: "run_started", at: T0 });
    const corrupted = "{ not valid json :::";
    const jsonl = [validLine, corrupted].join("\n");

    const hist = RunHistory.fromJSONL(jsonl);
    expect(hist.length).toBe(1);
    expect(hist.getEvents()[0].type).toBe("run_started");
  });

  it("夹杂空行的 JSONL 正确跳过空行", () => {
    const line1 = JSON.stringify({ seq: 1, type: "run_started", at: T0 });
    const line2 = JSON.stringify({ seq: 2, type: "run_finished", at: T1 });
    const jsonl = `${line1}\n\n${line2}\n`;

    const hist = RunHistory.fromJSONL(jsonl);
    expect(hist.length).toBe(2);
  });
});

// ── deriveFailureReport ────────────────────────────────────────────────────────

describe("deriveFailureReport — degraded", () => {
  it("无任何事件时 degraded 为 false", () => {
    const hist = new RunHistory();
    expect(hist.deriveFailureReport().degraded).toBe(false);
  });

  it("存在 deliverable_degraded 事件时 degraded 为 true", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    hist.appendEvent("deliverable_degraded", T1, "lead-1");
    expect(hist.deriveFailureReport().degraded).toBe(true);
  });

  it("只有非降级事件时 degraded 仍为 false", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    hist.appendEvent("run_finished", T1);
    expect(hist.deriveFailureReport().degraded).toBe(false);
  });
});

describe("deriveFailureReport — deferred", () => {
  it("agent_deferred 事件的 agentId 进入 deferred 列表", () => {
    const hist = new RunHistory();
    hist.appendEvent("agent_deferred", T1, "worker-1");
    hist.appendEvent("agent_deferred", T2, "worker-2");
    const report = hist.deriveFailureReport();
    expect(report.deferred).toContain("worker-1");
    expect(report.deferred).toContain("worker-2");
  });

  it("重复 defer 同一 agent 时 deferred 去重", () => {
    const hist = new RunHistory();
    hist.appendEvent("agent_deferred", T1, "worker-1");
    hist.appendEvent("agent_deferred", T2, "worker-1");
    const report = hist.deriveFailureReport();
    expect(report.deferred.filter(id => id === "worker-1")).toHaveLength(1);
  });

  it("worker_timeout 也使 agentId 进入 deferred", () => {
    const hist = new RunHistory();
    hist.appendEvent("worker_timeout", T1, "worker-slow");
    expect(hist.deriveFailureReport().deferred).toContain("worker-slow");
  });

  it("workspace_quota_exceeded 也使 agentId 进入 deferred", () => {
    const hist = new RunHistory();
    hist.appendEvent("workspace_quota_exceeded", T1, "worker-fat");
    expect(hist.deriveFailureReport().deferred).toContain("worker-fat");
  });

  it("agent_deferred 事件 payload.agentId 也被加入 deferred", () => {
    const hist = new RunHistory();
    hist.appendEvent("agent_deferred", T1, undefined, { agentId: "worker-payload" });
    expect(hist.deriveFailureReport().deferred).toContain("worker-payload");
  });

  it("无 defer 类事件时 deferred 为空数组", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    expect(hist.deriveFailureReport().deferred).toEqual([]);
  });
});

describe("deriveFailureReport — rejectedArtifacts", () => {
  it("artifact_rejected 事件 payload.artifactId 进入 rejectedArtifacts", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "worker-1", { artifactId: "art-001" });
    expect(hist.deriveFailureReport().rejectedArtifacts).toContain("art-001");
  });

  it("artifact_rejected 事件 payload.artifactRef 在无 artifactId 时被使用", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "worker-1", { artifactRef: "ref-xyz" });
    expect(hist.deriveFailureReport().rejectedArtifacts).toContain("ref-xyz");
  });

  it("artifact_rejected 同时有 artifactId 和 artifactRef 时优先取 artifactId", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "w-1", {
      artifactId: "art-primary",
      artifactRef: "ref-secondary",
    });
    const report = hist.deriveFailureReport();
    expect(report.rejectedArtifacts).toContain("art-primary");
    expect(report.rejectedArtifacts).not.toContain("ref-secondary");
  });

  it("多个 artifact_rejected 事件按顺序累积（不去重，保留重复引用）", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "w-1", { artifactId: "art-001" });
    hist.appendEvent("artifact_rejected", T2, "w-2", { artifactId: "art-002" });
    hist.appendEvent("artifact_rejected", T3, "w-1", { artifactId: "art-001" });
    const report = hist.deriveFailureReport();
    expect(report.rejectedArtifacts).toEqual(["art-001", "art-002", "art-001"]);
  });

  it("artifact_rejected 无 payload 时 rejectedArtifacts 不增加条目", () => {
    const hist = new RunHistory();
    hist.appendEvent("artifact_rejected", T1, "worker-1");
    expect(hist.deriveFailureReport().rejectedArtifacts).toHaveLength(0);
  });

  it("无拒绝事件时 rejectedArtifacts 为空", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    expect(hist.deriveFailureReport().rejectedArtifacts).toEqual([]);
  });
});

describe("deriveFailureReport — stuckModules", () => {
  it("module_stuck 事件的 agentId 进入 stuckModules", () => {
    const hist = new RunHistory();
    hist.appendEvent("module_stuck", T1, "synthesizer");
    expect(hist.deriveFailureReport().stuckModules).toContain("synthesizer");
  });

  it("module_stuck 事件 payload.moduleId 也进入 stuckModules", () => {
    const hist = new RunHistory();
    hist.appendEvent("module_stuck", T1, undefined, { moduleId: "integrator-2" });
    expect(hist.deriveFailureReport().stuckModules).toContain("integrator-2");
  });

  it("worker_timeout 使 agentId 同时进 stuckModules 与 deferred", () => {
    const hist = new RunHistory();
    hist.appendEvent("worker_timeout", T1, "slow-worker");
    const report = hist.deriveFailureReport();
    expect(report.stuckModules).toContain("slow-worker");
    expect(report.deferred).toContain("slow-worker");
  });

  it("workspace_quota_exceeded 使 agentId 同时进 stuckModules 与 deferred", () => {
    const hist = new RunHistory();
    hist.appendEvent("workspace_quota_exceeded", T1, "fat-worker");
    const report = hist.deriveFailureReport();
    expect(report.stuckModules).toContain("fat-worker");
    expect(report.deferred).toContain("fat-worker");
  });

  it("stuckModules 去重（同一 agent 多次超时只出现一次）", () => {
    const hist = new RunHistory();
    hist.appendEvent("worker_timeout", T1, "flaky-worker");
    hist.appendEvent("worker_timeout", T2, "flaky-worker");
    const report = hist.deriveFailureReport();
    expect(report.stuckModules.filter(id => id === "flaky-worker")).toHaveLength(1);
  });

  it("无卡住事件时 stuckModules 为空", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0);
    expect(hist.deriveFailureReport().stuckModules).toEqual([]);
  });
});

// ── deriveFailureReport 与外部事件源 ─────────────────────────────────────────

describe("deriveFailureReport — 外部事件源（events 参数）", () => {
  it("传入外部事件数组时不使用内部事件", () => {
    const hist = new RunHistory();
    hist.appendEvent("deliverable_degraded", T0); // 内部事件

    const externalEvents: RunEvent[] = [
      { seq: 1, type: "run_started", at: T0 },
    ];
    const report = hist.deriveFailureReport(externalEvents);
    // 外部事件里没有 degraded，应为 false
    expect(report.degraded).toBe(false);
  });

  it("外部事件数组完整走派生逻辑", () => {
    const hist = new RunHistory();
    const external: RunEvent[] = [
      { seq: 1, type: "run_started", at: T0 },
      { seq: 2, type: "deliverable_degraded", at: T1, agentId: "lead-1" },
      { seq: 3, type: "agent_deferred", at: T2, agentId: "worker-ext" },
      { seq: 4, type: "artifact_rejected", at: T3, payload: { artifactId: "ext-art" } },
    ];
    const report = hist.deriveFailureReport(external);
    expect(report.degraded).toBe(true);
    expect(report.deferred).toContain("worker-ext");
    expect(report.rejectedArtifacts).toContain("ext-art");
  });
});

// ── 综合场景 ──────────────────────────────────────────────────────────────────

describe("综合场景 — 完整 run 生命周期", () => {
  it("多类失败事件组合，report 正确反映全部失败维度", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started", T0, "ceo");
    hist.appendEvent("worker_timeout",           T1, "worker-research");
    hist.appendEvent("artifact_rejected",        T2, "worker-code",  { artifactId: "code-draft-1" });
    hist.appendEvent("workspace_quota_exceeded", T3, "worker-heavy");
    hist.appendEvent("deliverable_degraded",     T4, "lead-1");

    const report: FailureReport = hist.deriveFailureReport();

    expect(report.degraded).toBe(true);

    expect(report.deferred).toContain("worker-research");
    expect(report.deferred).toContain("worker-heavy");

    expect(report.rejectedArtifacts).toEqual(["code-draft-1"]);

    expect(report.stuckModules).toContain("worker-research");
    expect(report.stuckModules).toContain("worker-heavy");
  });

  it("toJSONL → fromJSONL → deriveFailureReport 结果与原始一致", () => {
    const orig = new RunHistory();
    orig.appendEvent("run_started",       T0);
    orig.appendEvent("agent_deferred",    T1, "worker-a");
    orig.appendEvent("artifact_rejected", T2, "worker-b", { artifactId: "art-99" });
    orig.appendEvent("deliverable_degraded", T3, "lead-1");
    orig.appendEvent("run_finished",      T4);

    const restored = RunHistory.fromJSONL(orig.toJSONL());

    const origReport  = orig.deriveFailureReport();
    const restoredReport = restored.deriveFailureReport();

    expect(restoredReport.degraded).toBe(origReport.degraded);
    expect(restoredReport.deferred).toEqual(origReport.deferred);
    expect(restoredReport.rejectedArtifacts).toEqual(origReport.rejectedArtifacts);
    expect(restoredReport.stuckModules).toEqual(origReport.stuckModules);
  });

  it("全部成功的 run 派生出空 failure report", () => {
    const hist = new RunHistory();
    hist.appendEvent("run_started",  T0);
    hist.appendEvent("memory_committed", T1, "lead-1", { proposalId: "mp-1" });
    hist.appendEvent("run_finished", T2);

    const report = hist.deriveFailureReport();
    expect(report.degraded).toBe(false);
    expect(report.deferred).toEqual([]);
    expect(report.rejectedArtifacts).toEqual([]);
    expect(report.stuckModules).toEqual([]);
  });
});

// ── B5 · appendConvergedEvent（model_call_started / tool_call 收敛 + 200 上限）──

describe("B5 · RunHistory.appendConvergedEvent — 摘要级收敛", () => {
  it("model_call_started:payload 只留 model/provider,全量 messages/密钥等一律丢弃", () => {
    const hist = new RunHistory();
    const ev = hist.appendConvergedEvent("model_call_started", T0, "worker-1", {
      model: "deepseek-chat",
      provider: "deepseek",
      messages: [{ role: "user", content: "巨大的全量 payload" }],
      apiKey: "sk-should-never-land",
    });
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("model_call_started");
    expect(ev!.agentId).toBe("worker-1");
    expect(ev!.payload).toEqual({ model: "deepseek-chat", provider: "deepseek" });
  });

  it("tool_call:name + argsSummary(<=300 字),不落全量 args;超长 model 字段截断到 120", () => {
    const hist = new RunHistory();
    const ev = hist.appendConvergedEvent("tool_call", T0, "worker-1", {
      name: "Bash",
      args: { command: "x".repeat(1000) },
    });
    expect(ev!.payload!.name).toBe("Bash");
    expect(typeof ev!.payload!.argsSummary).toBe("string");
    expect((ev!.payload!.argsSummary as string).length).toBeLessThanOrEqual(300);
    expect("args" in ev!.payload!).toBe(false);

    const ev2 = hist.appendConvergedEvent("model_call_started", T1, "w", { model: "m".repeat(500) });
    expect((ev2!.payload!.model as string).length).toBe(120);
  });

  it("每类型每 run 上限 200:超出返回 null 只计数;overflow 汇总事件如实记 total/recorded", () => {
    const hist = new RunHistory();
    let recorded = 0;
    for (let i = 0; i < 205; i++) {
      if (hist.appendConvergedEvent("tool_call", T1, "w", { name: `t${i}` })) recorded++;
    }
    expect(CONVERGED_EVENT_CAP).toBe(200);
    expect(recorded).toBe(CONVERGED_EVENT_CAP);
    expect(hist.length).toBe(CONVERGED_EVENT_CAP); // history 里绝不超上限
    expect(hist.getConvergenceCounts()).toEqual({
      tool_call: { total: 205, recorded: 200 },
      model_call_started: { total: 0, recorded: 0 },
    });
    const overflow = hist.appendConvergenceOverflowSummary(T2);
    expect(overflow).not.toBeNull();
    expect(overflow!.type).toBe("converged_events_overflow");
    expect(overflow!.payload).toEqual({
      tool_call: { total: 205, recorded: 200 },
      model_call_started: { total: 0, recorded: 0 },
    });
    expect(hist.length).toBe(CONVERGED_EVENT_CAP + 1); // 只多这一条汇总
  });

  it("两类型独立限流;无超出时 overflow 汇总返回 null 且不追加事件", () => {
    const hist = new RunHistory();
    hist.appendConvergedEvent("model_call_started", T0, "w", { model: "m1" });
    hist.appendConvergedEvent("tool_call", T0, "w", { name: "Read" });
    expect(hist.getConvergenceCounts()).toEqual({
      model_call_started: { total: 1, recorded: 1 },
      tool_call: { total: 1, recorded: 1 },
    });
    expect(hist.appendConvergenceOverflowSummary(T1)).toBeNull();
    expect(hist.length).toBe(2);
  });
});
