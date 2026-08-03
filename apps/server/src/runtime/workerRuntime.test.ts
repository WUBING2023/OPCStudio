// B2 · workerRuntime(执行漏斗纯函数)单测:mock WorkerRuntimeDeps 直接驱动 runEngineCore 的关键分支。
// 这是解耦带来的新能力——此前这些分支只能靠路由级/E2E 冒烟间接覆盖。
import { describe, it, expect, vi } from "vitest";
import type { AgentFramework, AgentMessage, AgentNodeConfig, ExecContext, ExecResult, ExecTask, NativeExecutionPreference } from "@opc/shared";
import type { CallRecord } from "./modelGateway.js";
import type { RouteDecision } from "./engineRouter.js";
import type { CooldownEntry } from "./rateLimitCooldown.js";
import { runEngineCore, renderInboxForPrompt, type WorkerRuntimeDeps } from "./workerRuntime.js";

function makeAgent(overrides: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "dev-1", name: "Dev One", role: "dev", childrenIds: [],
    model: "m-base", provider: "p-base", framework: "hermes",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function makeTask(overrides: Partial<ExecTask> = {}): ExecTask {
  return { taskId: "t-1", goal: "写一个函数", systemPrompt: "你是工程师", maxTokens: 4096, ...overrides };
}

function makeCtx(overrides: Partial<ExecContext> = {}): ExecContext {
  return {
    runId: "run-1", projectRoot: "/tmp/proj", workdir: "/tmp/proj",
    emit: () => {}, budget: { maxTokensPerTask: 1000 },
    ...overrides,
  };
}

function makeResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    content: "done!", fileChanges: [], tokens: { prompt: 10, completion: 20, total: 30 },
    cost: 0.5, latencyMs: 7, status: "done", ...overrides,
  };
}

interface EngineCall { node: AgentNodeConfig; task: ExecTask; ctx: ExecContext }

interface Harness {
  deps: WorkerRuntimeDeps;
  events: Array<{ type: string; agentId: string | undefined; payload: any }>;
  statuses: Array<{ id: string; status: string; task?: string }>;
  records: CallRecord[];
  usages: Array<{ tokens: number; cost: number }>;
  engineCalls: EngineCall[];
  routeCalls: Array<{ framework?: AgentFramework; role?: string; nativePreference?: NativeExecutionPreference }>;
  runWithAgentCalls: Array<{ agentId: string; role?: string }>;
}

function makeHarness(opts: {
  engineResult?: ExecResult | ((call: EngineCall) => ExecResult);
  policy?: { allowed: boolean; reason?: string };
  cooldownEntry?: CooldownEntry;
  fallback?: { framework: AgentFramework; provider: string; model: string } | null;
  resolveApiKey?: WorkerRuntimeDeps["resolveApiKey"];
  inbox?: AgentMessage[];
  teamMode?: WorkerRuntimeDeps["teamMode"];
  nativePreference?: NativeExecutionPreference;
  routeDecision?: Partial<RouteDecision>;
} = {}): Harness {
  const events: Harness["events"] = [];
  const statuses: Harness["statuses"] = [];
  const records: CallRecord[] = [];
  const usages: Harness["usages"] = [];
  const engineCalls: EngineCall[] = [];
  const routeCalls: Harness["routeCalls"] = [];
  const runWithAgentCalls: Harness["runWithAgentCalls"] = [];

  const makeRoute = (framework: AgentFramework): RouteDecision => ({
    engine: {
      framework,
      run: async (node, task, ctx) => {
        const call = { node, task, ctx };
        engineCalls.push(call);
        return typeof opts.engineResult === "function" ? opts.engineResult(call) : (opts.engineResult ?? makeResult());
      },
      probe: async () => ({ framework, installed: true, loggedIn: true, version: "test" }),
    },
    chosenProvider: framework, idealProvider: framework, riskLevel: undefined, capabilityMatch: true,
    ...opts.routeDecision,
  });

  const deps: WorkerRuntimeDeps = {
    projectRoot: "/tmp/proj",
    runId: "run-1",
    teamMode: opts.teamMode,
    emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); },
    setAgentStatus: (id, status, task) => { statuses.push({ id, status: String(status), task }); },
    buildSystemPrompt: (_agent, base, _goal, _root, _out) => `[injected]${base}`,
    drainInbox: vi.fn(() => opts.inbox ?? []),
    frameworkPolicy: () => opts.policy ?? { allowed: true },
    routeEngine: (framework, role, nativePreference) => { routeCalls.push({ framework, role, nativePreference }); return makeRoute(framework ?? "hermes"); },
    resolveNativeExecution: () => opts.nativePreference ?? { preference: "acp", fallback: "acp" },
    makeCooldownKey: (framework, provider, model) => `${framework || "hermes"}/${provider}/${model || "*"}`,
    getCooldownEntry: (key) => (opts.cooldownEntry && opts.cooldownEntry.modelKey === key ? opts.cooldownEntry : undefined),
    pickFallbackEngine: () => (opts.fallback === undefined ? null : opts.fallback),
    recordRateLimit: vi.fn((key: string) => ({ modelKey: key, rateLimitedUntil: Date.now() + 60_000, detectedAt: new Date().toISOString(), resetSource: "default-cooldown" as const })),
    resolveApiKey: opts.resolveApiKey ?? (() => undefined),
    runWithAgent: (agentId, fn, role) => { runWithAgentCalls.push({ agentId, role }); return fn(); },
    onCallRecord: (r) => { records.push(r); },
    onUsage: (tokens, cost) => { usages.push({ tokens, cost }); },
  };
  return { deps, events, statuses, records, usages, engineCalls, routeCalls, runWithAgentCalls };
}

describe("renderInboxForPrompt(纯渲染)", () => {
  const msg = (over: Partial<AgentMessage> = {}): AgentMessage => ({
    id: "m1", runId: "run-1", from: "peer-1", text: "接口字段是 userId",
    timestamp: new Date().toISOString(), visibility: { audience: "agents:dev-1" },
    ...over,
  });

  it("空 inbox → 空串", () => {
    expect(renderInboxForPrompt([], "goal")).toBe("");
  });

  it("渲染 performative/发件人/产出物引用", () => {
    const out = renderInboxForPrompt([msg({ performative: "ask", artifactRefs: ["art-9"] })], "无关目标");
    expect(out).toContain("来自团队成员的消息");
    expect(out).toContain("[ask] 来自 peer-1");
    expect(out).toContain("art-9");
  });

  it("与当前 goal 重复的消息被跳过(派活不重复注入)", () => {
    const out = renderInboxForPrompt([msg({ text: "做任务A" })], "请你 做任务A 谢谢");
    expect(out).toBe("");
  });

  it("只取最近 5 条", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => msg({ id: `m${i}`, text: `消息${i}`, from: `p${i}` }));
    const out = renderInboxForPrompt(msgs, "goal");
    expect(out).not.toContain("消息2");
    expect(out).toContain("消息3");
    expect(out).toContain("消息7");
  });
});

describe("runEngineCore native routing integration", () => {
  it("passes the resolved preference and emits an explicit degradation event", async () => {
    const preference = { preference: "codex-native", fallback: "acp" } as const;
    const h = makeHarness({
      nativePreference: preference,
      routeDecision: {
        nativeExecution: {
          requested: "codex-native",
          selected: "acp",
          failureKind: "feature_disabled",
          reason: "disabled for test",
        },
      },
    });
    await runEngineCore(makeAgent({ framework: "codex" }), makeTask(), makeCtx(), h.deps);
    expect(h.routeCalls[0]?.nativePreference).toEqual(preference);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: "info",
      payload: expect.objectContaining({
        kind: "native_adapter_degraded",
        requested: "codex-native",
        fallback: "acp",
        failureKind: "feature_disabled",
      }),
    }));
  });
});

describe("runEngineCore · 策略门", () => {
  it("CLI 框架策略拒绝 → restricted 诚实返回,引擎不被调用", async () => {
    const h = makeHarness({ policy: { allowed: false, reason: "worker 不允许用订阅 CLI" } });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.status).toBe("restricted");
    expect(r.error).toBe("worker 不允许用订阅 CLI");
    expect(h.engineCalls).toHaveLength(0);
    expect(h.records).toHaveLength(0);
    expect(h.statuses).toEqual([{ id: "dev-1", status: "restricted", task: "worker 不允许用订阅 CLI" }]);
    const err = h.events.find(e => e.type === "error");
    expect(err?.payload.restricted).toBe(true);
  });
});

describe("runEngineCore · 成功路径(引擎路由)", () => {
  it("done:注入后的 systemPrompt 进引擎、状态 working→idle、计账/用量回调、agent 用量累加", async () => {
    const h = makeHarness();
    const agent = makeAgent();
    const r = await runEngineCore(agent, makeTask(), makeCtx(), h.deps);
    expect(r.status).toBe("done");
    // 引擎收到的是注入后的 systemPrompt(buildSystemPrompt 的产物),goal 无 inbox 时保持原样
    expect(h.engineCalls).toHaveLength(1);
    expect(h.engineCalls[0].task.systemPrompt).toBe("[injected]你是工程师");
    expect(h.engineCalls[0].task.goal).toBe("写一个函数");
    // 状态机(11 态):working(领任务+上下文组装)→ thinking(引擎调用真正在飞)→ idle
    expect(h.statuses).toEqual([
      { id: "dev-1", status: "working", task: "写一个函数" },
      { id: "dev-1", status: "thinking", task: "写一个函数" },
      { id: "dev-1", status: "idle", task: undefined },
    ]);
    // 计账:CallRecord 按实际执行的 provider/model 归属
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ agentId: "dev-1", provider: "p-base", model: "m-base", totalTokens: 30, estimatedCostUsd: 0.5 });
    // run 级用量回调
    expect(h.usages).toEqual([{ tokens: 30, cost: 0.5 }]);
    // agent 对象自身用量累加(engine 路径的 token 记账仍按 agent)
    expect(agent.tokenUsage).toEqual({ prompt: 10, completion: 20, total: 30 });
    expect(agent.costUsd).toBe(0.5);
    expect(agent.lastAction).toContain("30 tokens");
    // 身份包裹:runWithAgent 收到 agent.id + role(工具/shell 拦截按角色档位)
    expect(h.runWithAgentCalls).toEqual([{ agentId: "dev-1", role: "dev" }]);
    // 事件面:model_call_started + engineRoute info
    expect(h.events.some(e => e.type === "model_call_started")).toBe(true);
    expect(h.events.some(e => e.type === "info" && e.payload.engineRoute)).toBe(true);
  });

  it("引擎失败(非 overloaded)→ setAgentStatus failed + error 事件,不记冷却", async () => {
    const h = makeHarness({ engineResult: makeResult({ status: "failed", error: "boom" }) });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.status).toBe("failed");
    expect(h.statuses[1]).toEqual({ id: "dev-1", status: "thinking", task: "写一个函数" });
    expect(h.statuses[2]).toEqual({ id: "dev-1", status: "failed", task: "boom" });
    expect(h.events.some(e => e.type === "error" && e.payload.message === "boom")).toBe(true);
    expect(h.deps.recordRateLimit).not.toHaveBeenCalled();
    // 失败调用同样计账(token 已花)
    expect(h.records).toHaveLength(1);
    expect(h.usages).toHaveLength(1);
  });

  it("引擎返回 restricted → 状态置 restricted(不是 failed)", async () => {
    const h = makeHarness({ engineResult: makeResult({ status: "restricted", error: "no key" }) });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.statuses[2]).toEqual({ id: "dev-1", status: "restricted", task: "no key" });
    const err = h.events.find(e => e.type === "error");
    expect(err?.payload.restricted).toBe(true);
  });
});

describe("runEngineCore · MUP B7 <think> 剥离统一收口", () => {
  it("引擎产出内嵌 <think> → result.content 与 CallRecord 都干净,思考以 agent_output_chunk(thinking:true) emit", async () => {
    const h = makeHarness({ engineResult: makeResult({ content: "<think>先分析一下\n再决定</think>真正交付正文" }) });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.content).toBe("真正交付正文");
    expect(h.records[0].content).toBe("真正交付正文");
    const think = h.events.find(e => e.type === "agent_output_chunk" && e.payload.thinking === true);
    expect(think?.payload.chunk).toBe("先分析一下\n再决定");
  });

  it("未闭合尾块同样不进交付文本", async () => {
    const h = makeHarness({ engineResult: makeResult({ content: "结论:可行。\n<think>其实还想再想想" }) });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.content).toBe("结论:可行。");
    expect(h.events.some(e => e.type === "agent_output_chunk" && e.payload.thinking === true)).toBe(true);
  });

  it("无标记 → content 零改动,不 emit thinking chunk", async () => {
    const h = makeHarness({ engineResult: makeResult({ content: "done!" }) });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.content).toBe("done!");
    expect(h.events.some(e => e.type === "agent_output_chunk")).toBe(false);
  });
});

describe("runEngineCore · AgentStatus 11 态(引擎调用在飞的真实状态)", () => {
  it("task.statusWhileRunning='reviewing'(交叉验证/lead 评审调用)→ working→reviewing→idle", async () => {
    const h = makeHarness();
    await runEngineCore(makeAgent(), makeTask({ statusWhileRunning: "reviewing", goal: "核查产出" }), makeCtx(), h.deps);
    expect(h.statuses.map(s => s.status)).toEqual(["working", "reviewing", "idle"]);
    expect(h.statuses[1].task).toBe("核查产出");
  });

  it("缺省(普通执行)在飞状态是 thinking——不是装饰:紧贴真实 engine.run await", async () => {
    const h = makeHarness();
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.statuses.map(s => s.status)).toEqual(["working", "thinking", "idle"]);
  });
});

describe("runEngineCore · 限流冷却 fallback", () => {
  const cooldownEntry = { modelKey: "hermes/p-base/m-base", rateLimitedUntil: Date.now() + 60_000, detectedAt: new Date().toISOString(), resetSource: "default-cooldown" as const };

  it("primary 冷却中且有备用 → 换引擎执行,计账归属备用 model,发 rate_limited(pre-call)", async () => {
    const h = makeHarness({ cooldownEntry, fallback: { framework: "hermes", provider: "fb-prov", model: "fb-model" } });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    // 实际执行的 execAgent 已被替换为备用引擎(原 agent 对象不动)
    expect(h.engineCalls[0].node.provider).toBe("fb-prov");
    expect(h.engineCalls[0].node.model).toBe("fb-model");
    // Guard 3:计账用实际执行引擎
    expect(h.records[0]).toMatchObject({ provider: "fb-prov", model: "fb-model" });
    const rl = h.events.find(e => e.type === "rate_limited");
    expect(rl?.payload.reason).toBe("pre-call cooldown routing");
    expect(rl?.payload.fallback).toBe("hermes/fb-prov/fb-model");
    // fallback 路径重新走了一次路由
    expect(h.routeCalls.length).toBe(2);
  });

  it("primary 冷却中但无备用可用 → 照跑主引擎诚实失败/成功,不发 rate_limited", async () => {
    const h = makeHarness({ cooldownEntry, fallback: null });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.engineCalls[0].node.provider).toBe("p-base");
    expect(h.events.some(e => e.type === "rate_limited")).toBe(false);
  });

  it("post-call [overloaded] → recordRateLimit + rate_limited(post-call)", async () => {
    const h = makeHarness({ engineResult: makeResult({ status: "failed", error: "[overloaded] retry later" }) });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.deps.recordRateLimit).toHaveBeenCalledWith("hermes/p-base/m-base", "[overloaded] retry later");
    const rl = h.events.find(e => e.type === "rate_limited");
    expect(rl?.payload.reason).toBe("post-call overload detected");
  });
});

describe("runEngineCore · apiKeyOverride 注入", () => {
  it("resolveApiKey 命中 → 引擎 ctx 带 apiKeyOverride,原 ctx 不被改写", async () => {
    const resolveApiKey = vi.fn(() => "sk-test-123");
    const h = makeHarness({ resolveApiKey });
    const ctx = makeCtx();
    await runEngineCore(makeAgent({ cliConfigDir: "/cfg/a" }), makeTask(), ctx, h.deps);
    expect(resolveApiKey).toHaveBeenCalledWith("hermes", "/cfg/a");
    expect(h.engineCalls[0].ctx.apiKeyOverride).toBe("sk-test-123");
    expect(ctx.apiKeyOverride).toBeUndefined(); // 只活在这一次调用的副本里
  });

  it("resolveApiKey 未命中 → ctx 原样透传(不带 override)", async () => {
    const h = makeHarness();
    const ctx = makeCtx();
    await runEngineCore(makeAgent(), makeTask(), ctx, h.deps);
    expect(h.engineCalls[0].ctx).toMatchObject(ctx);
    expect(h.engineCalls[0].ctx.capabilityManifest?.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.engineCalls[0].ctx.apiKeyOverride).toBeUndefined();
  });

  it("resolveApiKey 抛错 → best-effort 吞掉,退回无 override 路径,不影响执行", async () => {
    const h = makeHarness({ resolveApiKey: () => { throw new Error("accounts.json corrupted"); } });
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(r.status).toBe("done");
    expect(h.engineCalls[0].ctx.apiKeyOverride).toBeUndefined();
  });

  it("冷却 fallback 后按最终执行的 framework 解析 key(而非原 framework)", async () => {
    const resolveApiKey = vi.fn(() => undefined);
    const h = makeHarness({
      resolveApiKey,
      cooldownEntry: { modelKey: "codex/p-base/m-base", rateLimitedUntil: Date.now() + 60_000, detectedAt: new Date().toISOString(), resetSource: "default-cooldown" as const },
      fallback: { framework: "hermes", provider: "fb-prov", model: "fb-model" },
    });
    await runEngineCore(makeAgent({ framework: "codex", role: "ceo" }), makeTask(), makeCtx(), h.deps);
    expect(resolveApiKey).toHaveBeenCalledWith("hermes", undefined);
  });
});

describe("runEngineCore · A2A inbox 钩子", () => {
  it("drainInbox 有消息 → 注入进引擎收到的 goal;drain 按 agent.id 调用", async () => {
    const inbox: AgentMessage[] = [{
      id: "m1", runId: "run-1", from: "peer-2", text: "接口用 snake_case",
      timestamp: new Date().toISOString(), visibility: { audience: "agents:dev-1" }, performative: "inform",
    }];
    const h = makeHarness({ inbox });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.deps.drainInbox).toHaveBeenCalledWith("dev-1");
    const goal = h.engineCalls[0].task.goal;
    expect(goal.startsWith("写一个函数")).toBe(true);
    expect(goal).toContain("来自团队成员的消息");
    expect(goal).toContain("接口用 snake_case");
  });

  it("inbox 为空 → goal 原样,不加注入段", async () => {
    const h = makeHarness({ inbox: [] });
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(h.engineCalls[0].task.goal).toBe("写一个函数");
  });
});

describe("runEngineCore · Team Mode 有效引擎(run 级覆盖)", () => {
  it("economy → 引擎收到 deepseek 覆盖后的 execAgent,原 agent 配置不被持久改写", async () => {
    const h = makeHarness({ teamMode: "economy" });
    const agent = makeAgent({ framework: "claude-code", provider: "anthropic", model: "opus", role: "ceo" });
    await runEngineCore(agent, makeTask(), makeCtx(), h.deps);
    expect(h.routeCalls[0].framework).toBe("api");
    expect(h.engineCalls[0].node).toMatchObject({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
    // 原 agent 对象不动(不持久化覆盖)
    expect(agent.framework).toBe("claude-code");
    expect(agent.provider).toBe("anthropic");
    // Guard 3:计账按实际执行引擎
    expect(h.records[0]).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
    const started = h.events.find(event => event.type === "model_call_started");
    expect(started?.payload).toMatchObject({
      framework: "api",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      teamMode: "economy",
      overridden: true,
      configuredEngine: { framework: "claude-code", provider: "anthropic", model: "opus" },
    });
  });
});

describe("runEngineCore · 记忆注入事件", () => {
  it("buildSystemPrompt 写入 injectedMemoryIds/memoryPack → memory_injected + memory_pack_used 事件", async () => {
    const h = makeHarness();
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.injectedMemoryIds.push("mem-1");
      out.memoryPack = { items: [], countsByScope: { project: 1 } } as any;
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    const mi = h.events.find(e => e.type === "memory_injected");
    expect(mi?.payload.memoryIds).toEqual(["mem-1"]);
    expect(h.events.some(e => e.type === "info" && e.payload.kind === "memory_pack_used")).toBe(true);
  });

  it("B5:memory_pack_used 事件带 packHash(供 run 结束聚合进 diagnostics.memoryPackHashes)", async () => {
    const h = makeHarness();
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.memoryPack = {
        items: [], countsByScope: { project: 1 },
        packHash: "sha256:deadbeef", generatedAt: "2026-01-01T00:00:00.000Z",
      } as any;
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    const ev = h.events.find(e => e.type === "info" && e.payload.kind === "memory_pack_used");
    expect(ev?.payload.packHash).toBe("sha256:deadbeef");
    expect(ev?.payload.countsByScope).toEqual({ project: 1 });
  });

  // CEO 记忆引用溯源(诚实版):citedMemories 只来自 injectedMemories(真正拼进 prompt 的),
  // **不来自 memoryPack 审计视图**——后者含检索到但未注入的条目,拿它做引用来源就是造假。
  // 本用例刻意让两者分叉:pack 里多一条 ghost,断言引用条不认它。
  it("memory_pack_used 的 citedMemories 只列真正注入的记忆(pack 里的 ghost 不得入选)", async () => {
    const h = makeHarness();
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.injectedMemories = [
        { id: "lesson-1", kind: "lesson", title: "大文件应分块处理避免超时" },
        { id: "md-agent-dev-1", kind: "md_agent", title: "先写测试再交付" },
      ];
      out.memoryPack = {
        items: [
          { memoryId: "lesson-1", scope: "department", kind: "lesson", content: "大文件应分块处理避免超时", whySelected: "" },
          { memoryId: "md-agent-dev-1", scope: "employee", kind: "md_agent", content: "先写测试再交付", whySelected: "" },
          { memoryId: "ghost-1", scope: "workspace", kind: "committed", content: "检索到但未注入的幽灵记忆", whySelected: "" },
        ],
        countsByScope: { department: 1, employee: 1, workspace: 1 },
        packHash: "sha256:abc", generatedAt: "2026-01-01T00:00:00.000Z",
      } as any;
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    const ev = h.events.find(e => e.type === "info" && e.payload.kind === "memory_pack_used");
    expect(ev).toBeDefined();
    // 走既有 emit(committed 事件链路),不旁路
    expect(ev!.type).toBe("info");
    expect(ev!.payload.citedMemories).toEqual([
      { id: "lesson-1", title: "大文件应分块处理避免超时" },
      { id: "md-agent-dev-1", title: "先写测试再交付" },
    ]);
    expect(JSON.stringify(ev!.payload.citedMemories)).not.toContain("ghost-1");
    expect(String(ev!.payload.message)).toContain("依据经验:");
    expect(String(ev!.payload.message)).toContain("《大文件应分块处理避免超时》");
  });

  it("memoryPack 无可引用 items → payload 不带 citedMemories 字段(不塞空数组),正文无依据经验行", async () => {
    const h = makeHarness();
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.memoryPack = {
        items: [], countsByScope: { project: 1 }, packHash: "sha256:x", generatedAt: "2026-01-01T00:00:00.000Z",
      } as any;
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    const ev = h.events.find(e => e.type === "info" && e.payload.kind === "memory_pack_used");
    expect(ev!.payload.citedMemories).toBeUndefined();
    expect(String(ev!.payload.message)).not.toContain("依据经验:");
  });

  // D3 · 注入即登记回传:onInjection 把"真正拼进 prompt 的记忆清单"回调宿主(复用验证回路的数据源)。
  it("onInjection:buildSystemPrompt 登记了 injectedMemories → 以 (agentId, refs) 回调", async () => {
    const h = makeHarness();
    const calls: Array<{ agentId: string; refs: any[] }> = [];
    h.deps.onInjection = (agentId, refs) => { calls.push({ agentId, refs }); };
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.injectedMemories = [
        { id: "mem-c99af83c", kind: "committed", title: "快排结论" },
        { id: "lesson-1", kind: "lesson", title: "大文件应分块" },
      ];
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    expect(calls).toEqual([{
      agentId: "dev-1",
      refs: [
        { id: "mem-c99af83c", kind: "committed", title: "快排结论" },
        { id: "lesson-1", kind: "lesson", title: "大文件应分块" },
      ],
    }]);
  });

  it("onInjection:未注入任何记忆 → 不回调(零破坏);回调抛错不影响执行", async () => {
    const h = makeHarness();
    let called = 0;
    h.deps.onInjection = () => { called++; };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps); // 默认 buildSystemPrompt 不登记
    expect(called).toBe(0);

    const h2 = makeHarness();
    h2.deps.onInjection = () => { throw new Error("host boom"); };
    h2.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.injectedMemories = [{ id: "m1", kind: "committed", title: "t" }];
      return base;
    };
    const r = await runEngineCore(makeAgent(), makeTask(), makeCtx(), h2.deps);
    expect(r.status).toBe("done"); // additive:回调抛错被吞,执行不受影响
  });

  // C 交接 · excludedBundledSkillIds 不静默丢弃:内存态登记 → emit 进 run 事件流。
  it("excludedBundledSkillIds 非空 → emit info kind=excluded_bundled_skills;为空 → 不发", async () => {
    const h = makeHarness();
    h.deps.buildSystemPrompt = (_a, base, _g, _r, out) => {
      out.excludedBundledSkillIds = ["sk-legacy-1", "sk-legacy-2"];
      return base;
    };
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h.deps);
    const ev = h.events.find(e => e.type === "info" && e.payload.kind === "excluded_bundled_skills");
    expect(ev?.payload.skillIds).toEqual(["sk-legacy-1", "sk-legacy-2"]);
    expect(String(ev?.payload.message)).toContain("2 个打包技能");

    const h2 = makeHarness();
    await runEngineCore(makeAgent(), makeTask(), makeCtx(), h2.deps);
    expect(h2.events.some(e => e.type === "info" && e.payload.kind === "excluded_bundled_skills")).toBe(false);
  });
});
