import { describe, it, expect } from "vitest";
import { parseWorkerLines, parseReviewDecisions, classifyTaskScale, clampLeadsForScale, resolveEffectiveScale, clampTaskBudgetToRemaining, withResolvedApiKeyAccounts, shouldUseCodingPipeline, capTeamWorkers, parseCeoPlan, parseDirectAnswer, extractEvidenceTable, stripEvidenceTableBlock, fileChangesCreatedSince } from "./orchestrator.js";
import { parseCeoPlanJson } from "./planSchema.js";

// v2 分诊(决策#1):CEO 以 DIRECT_ANSWER: 开头 → 直答(短路团队);否则 null → 照常开团队。
describe("parseDirectAnswer — CEO 分诊直答", () => {
  it("以 DIRECT_ANSWER: 开头 → 提取正文", () => {
    expect(parseDirectAnswer("DIRECT_ANSWER: OPC Studio 是一个多 agent 公司框架。")).toBe("OPC Studio 是一个多 agent 公司框架。");
    expect(parseDirectAnswer("  DIRECT_ANSWER：中文冒号也行\n第二行")).toBe("中文冒号也行\n第二行");
  });
  it("普通 PLAN(无标记)→ null,照常开团队", () => {
    expect(parseDirectAnswer("## PLAN\n- 做 X\n\n## LEAD: engineering-lead\nTask: 实现 X")).toBeNull();
    expect(parseDirectAnswer("")).toBeNull();
  });
  it("DIRECT_ANSWER 不在开头 → 不误判(仍开团队)", () => {
    expect(parseDirectAnswer("## PLAN\n稍后可 DIRECT_ANSWER: ...")).toBeNull();
  });
});

// P2: CEO 只产出 `## LEAD: <id>` + 团队级 Task，不再分配 worker；解析器须接受无 Sub-tasks 的 lead 段。
describe("parseCeoPlan — CEO 计划只到 lead（P2）", () => {
  it("无 Sub-tasks 块也能解析出 lead + 团队目标，workers 为空", () => {
    const plan = parseCeoPlan(`## PLAN
- 直接实现

## LEAD: engineering-lead
Task: 实现一个待办应用的增删改查

## SUMMARY
做一个 todo app`);
    expect(plan).not.toBeNull();
    expect(plan!.leads).toHaveLength(1);
    expect(plan!.leads[0].leadId).toBe("engineering-lead");
    expect(plan!.leads[0].task).toContain("待办");
    expect(plan!.leads[0].workers).toEqual([]);
  });

  it("多 lead 段（均无 Sub-tasks）全部保留", () => {
    const plan = parseCeoPlan(`## PLAN
- 需要评审

## LEAD: engineering-lead
Task: 实现功能

## LEAD: review-lead
Task: 审查实现质量与安全

## SUMMARY
ok`);
    expect(plan!.leads.map(l => l.leadId)).toEqual(["engineering-lead", "review-lead"]);
    expect(plan!.leads.every(l => l.workers.length === 0)).toBe(true);
  });

  it("向后兼容：旧格式带 Sub-tasks 仍解析出 worker", () => {
    const plan = parseCeoPlan(`## LEAD: engineering-lead
Task: 实现
Sub-tasks:
- backend-engineer: 写 API

## SUMMARY
ok`);
    expect(plan!.leads[0].workers).toEqual([{ workerId: "backend-engineer", task: "写 API" }]);
  });
});

describe("parseCeoPlanJson — JSON 路径 workers 可空（P2）", () => {
  it("leads 不带 workers 字段也通过校验，默认空数组", () => {
    const plan = parseCeoPlanJson('```json\n{"plan":"p","leads":[{"leadId":"engineering-lead","task":"做一个功能"}],"summary":"s"}\n```');
    expect(plan).not.toBeNull();
    expect(plan!.leads[0].workers).toEqual([]);
  });
});

// v8 #3：CEO 团队数确定性收敛（不靠 LLM 遵守提示词）。
describe("classifyTaskScale — 任务规模启发式", () => {
  it("极小任务 → trivial", () => {
    expect(classifyTaskScale("新建文件 greet.py 写一个 hello")).toBe("trivial");
    expect(classifyTaskScale("create a single file")).toBe("trivial");
  });
  it("含放大信号(安全/研究/架构/重构/多组件) → expand", () => {
    expect(classifyTaskScale("做一次安全审计")).toBe("expand");
    expect(classifyTaskScale("research and migrate the architecture")).toBe("expand");
    expect(classifyTaskScale("需要代码评审")).toBe("expand");
  });
  it("普通任务 → default", () => {
    expect(classifyTaskScale("加一个登录按钮")).toBe("default");
  });
  it("英文扩编词按完整词匹配,inspect 不得误命中 spec", () => {
    expect(classifyTaskScale("independent verifier must inspect producer files")).toBe("default");
    expect(classifyTaskScale("write a deployment spec")).toBe("expand");
  });
  it("expand 优先级高于 trivial（同时命中时放行多团队）", () => {
    expect(classifyTaskScale("新建文件并做安全审计")).toBe("expand");
  });
});

describe("clampLeadsForScale — 确定性团队数收敛", () => {
  const mk = (id: string, n: number) => ({ leadId: id, task: "t", workers: Array.from({ length: n }, (_, i) => ({ workerId: `w${i}`, task: "x" })) });
  const eng = mk("engineering-lead", 3);
  const rev = mk("review-lead", 2);
  const prod = mk("product-lead", 2);

  it("default + 多团队 → 收敛到单团队(优先 engineering-lead)", () => {
    const out = clampLeadsForScale([prod, eng, rev], "加一个登录按钮");
    expect(out.map(l => l.leadId)).toEqual(["engineering-lead"]);
  });
  it("trivial → 1 团队 1 worker", () => {
    const out = clampLeadsForScale([eng, rev], "新建一个文件 greet.py");
    expect(out).toHaveLength(1);
    expect(out[0].leadId).toBe("engineering-lead");
    expect(out[0].workers).toHaveLength(1);
  });
  it("expand → 原样保留多团队", () => {
    const out = clampLeadsForScale([eng, rev, prod], "做安全审计并重构整个系统");
    expect(out.map(l => l.leadId)).toEqual(["engineering-lead", "review-lead", "product-lead"]);
  });
  it("无 engineering-lead 时保留第一个 lead，绝不清空", () => {
    const out = clampLeadsForScale([prod, rev], "加个小功能");
    expect(out.map(l => l.leadId)).toEqual(["product-lead"]);
  });
  it("单团队 default → 不动", () => {
    expect(clampLeadsForScale([eng], "加个功能")).toHaveLength(1);
  });
});

// v5 P2：lead 拆任务 / 评审 的解析器（确定性）。
describe("parseWorkerLines — lead 拆出的 worker 子任务", () => {
  const ids = ["frontend-engineer", "backend-engineer", "test-engineer"];
  it("解析 '- id: task' 行，只保留有效 id，去重", () => {
    const out = parseWorkerLines(`
- frontend-engineer: 实现待办列表 UI
- backend-engineer: 提供增删 API
- nobody: 忽略这条
- frontend-engineer: 重复应被去掉
`, ids);
    expect(out).toEqual([
      { workerId: "frontend-engineer", task: "实现待办列表 UI" },
      { workerId: "backend-engineer", task: "提供增删 API" },
    ]);
  });
  it("中文冒号也识别", () => {
    expect(parseWorkerLines("- test-engineer：写测试", ids)).toEqual([{ workerId: "test-engineer", task: "写测试" }]);
  });
});

describe("parseReviewDecisions — lead 评审决策", () => {
  const ids = ["frontend-engineer", "backend-engineer"];
  it("ACCEPT 与 REDO:feedback 正确区分", () => {
    const out = parseReviewDecisions(`
- frontend-engineer: ACCEPT
- backend-engineer: REDO: 缺少删除接口，请补上 DELETE /todos/:id
`, ids);
    expect(out).toEqual([
      { workerId: "frontend-engineer", accept: true },
      { workerId: "backend-engineer", accept: false, feedback: "缺少删除接口，请补上 DELETE /todos/:id" },
    ]);
  });
  it("中文'通过/返工'也识别", () => {
    const out = parseReviewDecisions("- frontend-engineer: 通过\n- backend-engineer: 返工: 补单元测试", ids);
    expect(out[0].accept).toBe(true);
    expect(out[1]).toEqual({ workerId: "backend-engineer", accept: false, feedback: "补单元测试" });
  });
});

// AI Research Company:证据表 best-effort 提取——合法/非法/缺失三种输入都不能抛异常,解析失败一律静默 undefined。
describe("extractEvidenceTable — 证据表 best-effort 提取", () => {
  it("合法 evidence_table 代码块 → 提取全部字段", () => {
    const text = `# 报告正文\n结论……\n\n\`\`\`evidence_table\n[{"claim":"A 优于 B","source":"官方文档","url":"https://example.com/a","confidence":"high"},{"claim":"C 是趋势","source":"行业报告","confidence":"medium"}]\n\`\`\``;
    const rows = extractEvidenceTable(text);
    expect(rows).toEqual([
      { claim: "A 优于 B", source: "官方文档", url: "https://example.com/a", confidence: "high" },
      { claim: "C 是趋势", source: "行业报告", confidence: "medium" },
    ]);
  });

  it("非法 confidence / 缺字段的条目被丢弃,不影响其余合法条目", () => {
    const text = "```evidence_table\n" + JSON.stringify([
      { claim: "缺 source 的条目", confidence: "high" }, // 缺 source → 丢弃
      { claim: "confidence 不合法", source: "x", confidence: "certain" }, // 枚举值非法 → 丢弃
      { claim: "合法条目", source: "y", confidence: "low" },
    ]) + "\n```";
    expect(extractEvidenceTable(text)).toEqual([{ claim: "合法条目", source: "y", confidence: "low" }]);
  });

  it("JSON 语法损坏 → 静默返回 undefined,不抛异常", () => {
    const text = "```evidence_table\n[{\"claim\": \"缺右括号\"\n```";
    expect(() => extractEvidenceTable(text)).not.toThrow();
    expect(extractEvidenceTable(text)).toBeUndefined();
  });

  it("完全没有 evidence_table 代码块(普通 coding 报告) → undefined", () => {
    expect(extractEvidenceTable("# 工作报告\n\n已完成需求,详见 diff。")).toBeUndefined();
    expect(extractEvidenceTable("")).toBeUndefined();
  });

  it("代码块存在但数组为空 / 全部条目非法 → undefined(不写入空数组)", () => {
    expect(extractEvidenceTable("```evidence_table\n[]\n```")).toBeUndefined();
    expect(extractEvidenceTable('```evidence_table\n[{"claim":"x"}]\n```')).toBeUndefined();
  });

  it("超过 8 条 → 截断到 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ claim: `c${i}`, source: "s", confidence: "low" }));
    const text = "```evidence_table\n" + JSON.stringify(many) + "\n```";
    expect(extractEvidenceTable(text)?.length).toBe(8);
  });
});

describe("stripEvidenceTableBlock — 从正文剔除证据表代码块", () => {
  it("剔除代码块本身,保留正文其余部分", () => {
    const text = `# 报告\n正文内容。\n\n\`\`\`evidence_table\n[{"claim":"a","source":"b","confidence":"low"}]\n\`\`\``;
    const stripped = stripEvidenceTableBlock(text);
    expect(stripped).not.toContain("evidence_table");
    expect(stripped).toContain("正文内容。");
  });

  it("没有代码块时原样返回", () => {
    expect(stripEvidenceTableBlock("# 报告\n正文内容。")).toBe("# 报告\n正文内容。");
  });
});

// ── P0(活体抓出)· selectCodingFallbackWorkers:编码 run 兜底角色化,绝不广播全队 ──
import { selectCodingFallbackWorkers } from "./orchestrator.js";
import type { AgentNodeConfig } from "@opc/shared";

function ag(id: string, role: string): AgentNodeConfig {
  return { id, name: id, role, childrenIds: [], model: "m", provider: "anthropic", framework: "claude-code", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, editable: true, deletable: true, enabled: true } as AgentNodeConfig;
}

describe("P0 · selectCodingFallbackWorkers —— 编码兜底只选可用 coder+tester,绝不派 ops/docs/security", () => {
  const team = ["architect-1", "dev-1", "dev-2", "test-1", "ops-1", "security-1", "docs-1"];
  const agents = [ag("architect-1", "architect"), ag("dev-1", "dev"), ag("dev-2", "dev"), ag("test-1", "test"), ag("ops-1", "ops"), ag("security-1", "security"), ag("docs-1", "dev")].map((a, i) => i === 6 ? ag("docs-1", "docs") : a);
  const allAvail = () => true;

  it("编码+要求测试 → 恰好 1 coder + 1 tester;ops/docs/security 绝不入选", () => {
    const r = selectCodingFallbackWorkers(team, agents, "实现 isprime.js 并写测试", { requiresTests: true, verificationEdges: [], isAvailable: allAvail });
    expect(r.failReason).toBeUndefined();
    const roles = r.workers.map((w) => agents.find((a) => a.id === w.workerId)!.role);
    expect(roles.some((x) => x === "dev" || x === "architect")).toBe(true); // 有 coder
    expect(roles).toContain("test"); // 有 tester
    expect(roles.some((x) => ["ops", "docs", "security", "pm"].includes(x))).toBe(false); // 绝不派非执行角色
    expect(r.workers.length).toBe(2);
  });

  it("要求测试=false → 只选 1 coder", () => {
    const r = selectCodingFallbackWorkers(team, agents, "实现 isprime.js", { requiresTests: false, verificationEdges: [], isAvailable: allAvail });
    expect(r.workers.length).toBe(1);
    expect(["dev", "architect"]).toContain(agents.find((a) => a.id === r.workers[0].workerId)!.role);
  });

  it("无可用 coder(coder 角色全不可用)→ failReason，启动前失败", () => {
    const onlyTesterAvail = (a: AgentNodeConfig) => a.role === "test";
    const r = selectCodingFallbackWorkers(team, agents, "实现 isprime.js", { requiresTests: true, verificationEdges: [], isAvailable: onlyTesterAvail });
    expect(r.failReason).toBe("no_available_executor");
    expect(r.workers).toEqual([]);
  });

  it("coder 不可用时退到下一个可用 coder(dev-1 不可用 → dev-2)", () => {
    const notDev1 = (a: AgentNodeConfig) => a.id !== "dev-1";
    const r = selectCodingFallbackWorkers(["dev-1", "dev-2", "test-1"], agents, "实现 x.js", { requiresTests: false, verificationEdges: [], isAvailable: notDev1 });
    expect(r.workers[0].workerId).toBe("dev-2");
  });

  it("P0(用户审计)· 要求测试却无可用【独立】tester → no_available_verifier 干净失败,绝不放行 producer 自测", () => {
    // 有可用 coder(dev),但所有 tester 角色不可用 → 不得只派 coder 让它自测冒充"已验证",必须失败。
    const onlyDevAvail = (a: AgentNodeConfig) => a.role === "dev" || a.role === "architect";
    const r = selectCodingFallbackWorkers(team, agents, "实现 isprime.js 并写测试", { requiresTests: true, verificationEdges: [], isAvailable: onlyDevAvail });
    expect(r.failReason).toBe("no_available_verifier");
    expect(r.workers).toEqual([]);
  });

  it("P0(用户审计)· 要求测试=false 且无 tester → 仍放行(不要求独立验证时 coder-only 合法)", () => {
    const onlyDevAvail = (a: AgentNodeConfig) => a.role === "dev";
    const r = selectCodingFallbackWorkers(team, agents, "实现 isprime.js", { requiresTests: false, verificationEdges: [], isAvailable: onlyDevAvail });
    expect(r.failReason).toBeUndefined();
    expect(r.workers.length).toBe(1);
  });
});

// G2 · Core 确定性组队规模决策(零 LLM):关键词分类 + 复杂度估算合成 teamScale。
describe("resolveEffectiveScale — 关键词 + 复杂度合成(渐进式动态组队)", () => {
  it("明确 expand 关键词 → expand(保留完整团队)", () => {
    expect(resolveEffectiveScale("做一次安全审计").scale).toBe("expand");
    expect(resolveEffectiveScale("research and migrate the architecture").scale).toBe("expand");
  });
  it("trivial 关键词 → trivial(单 producer)", () => {
    expect(resolveEffectiveScale("新建文件 greet.py 写一个 hello").scale).toBe("trivial");
    expect(resolveEffectiveScale("create a single file").scale).toBe("trivial");
  });
  it("an explicitly bounded two-file coding task stays minimal even when its specification is verbose", () => {
    const goal = "Create a directory named demo and exactly two files inside it: divide.js exporting a divide function, and divide.test.js using node:assert to test normal, negative, decimal, and zero-divisor behavior. Actually write both files and run node demo/divide.test.js.";
    expect(classifyTaskScale(goal)).toBe("trivial");
    expect(resolveEffectiveScale(goal).scale).toBe("trivial");
  });
  it("小编码任务(代码信号→complexity≥M)→ default(medium),下游缩编到 1 producer(+按需验证)", () => {
    // 代码信号 +2 分 → 至少 M;非 expand 关键词、非 L/XL → default(medium)。缩编逻辑让它落到 1 producer。
    expect(resolveEffectiveScale("写一个 add 函数").scale).toBe("default");
  });
  it("短的非编码小任务(complexity S)→ trivial 降级(不铺大团队)", () => {
    expect(resolveEffectiveScale("查一下今天是几号").scale).toBe("trivial"); // 无代码信号、短 → S → trivial
  });
  it("措辞普通但实则复杂(complexity L/XL)→ expand 升级(不被关键词掩盖)", () => {
    // 很长的目标(>300 字)+ 代码信号 → complexity 抬到 L/XL → expand
    const longGoal = "实现一个模块:" + "需要处理各种边界情况和错误路径,".repeat(20) + " 用 typescript 写代码并接口对齐";
    expect(resolveEffectiveScale(longGoal).scale).toBe("expand");
  });
  it("L/XL 风险优先于 trivial 关键词,复杂任务不能被单文件措辞降级", () => {
    const goal = "create a single file that implements a production dispatcher: " +
      "support concurrency, cancellation, fairness, persistence, recovery, metrics, error handling, and integration tests; ".repeat(12);
    expect(resolveEffectiveScale(goal).scale).toBe("expand");
  });
  it("reason 可解释、非空(供 Trace 观测)", () => {
    for (const g of ["加一个登录按钮", "做一次安全审计", "改个 typo"]) {
      const r = resolveEffectiveScale(g);
      expect(r.reason.length).toBeGreaterThan(0);
      expect(["trivial", "default", "expand"]).toContain(r.scale);
    }
  });
});

describe("clampLeadsForScale — scaleOverride(G2 传入 effective scale)", () => {
  const lead = (id: string, workers: string[]) => ({ leadId: id, task: "t", workers: workers.map((w) => ({ workerId: w, task: "w" })) });
  it("override=expand → 不钳(多 lead 保留),即便 goal 措辞像 trivial", () => {
    const out = clampLeadsForScale([lead("engineering-lead", ["d1"]), lead("review-lead", ["r1"])], "新建一个文件", "expand");
    expect(out.length).toBe(2);
  });
  it("override=trivial → 收敛到单 lead + 1 worker", () => {
    const out = clampLeadsForScale([lead("engineering-lead", ["d1", "d2"]), lead("product-lead", ["p1"])], "做一次安全审计", "trivial");
    expect(out.length).toBe(1);
    expect(out[0].workers.length).toBe(1);
  });
});

describe("shouldUseCodingPipeline", () => {
  it("uses the delivery contract even when the company has no verification edge", () => {
    expect(shouldUseCodingPipeline(true, false)).toBe(true);
    expect(shouldUseCodingPipeline(false, false, "create final.js and run the test")).toBe(true);
  });

  it("keeps an explicit no-code goal out of the coding pipeline", () => {
    expect(shouldUseCodingPipeline(true, true, "create final.js")).toBe(false);
    expect(shouldUseCodingPipeline(false, false, "write a report")).toBe(false);
  });
});

// G3 · 渐进缩编 dispatch 数(确定性单测):按 scale + requiresTests 收敛团队成员到最小集。
describe("withResolvedApiKeyAccounts — key directory supports the worker scheduler", () => {
  it("adds only an in-memory API capacity record without persisting the resolved secret", () => {
    const accounts = withResolvedApiKeyAccounts(
      [{ id: "openai#codex", providerId: "openai", label: "codex", apiKey: "", frameworks: ["codex"], enabled: true, maxConcurrent: 3 }],
      [{ provider: "deepseek" } as any],
      (providerId) => providerId === "deepseek" ? "secret-not-persisted" : undefined,
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({ id: "deepseek#resolved-key", providerId: "deepseek", apiKey: "", frameworks: ["api"], maxConcurrent: 1 });
  });
});
describe("clampTaskBudgetToRemaining — run budget is shared across a batch", () => {
  it("caps each concurrent worker to its equal remaining share", () => {
    expect(clampTaskBudgetToRemaining(200_000, 60_000, 20_000, 2)).toBe(20_000);
    expect(clampTaskBudgetToRemaining(200_000, 60_000, 60_000, 1)).toBe(0);
  });
});
describe("capTeamWorkers — 渐进缩编 dispatch 数", () => {
  const roles: Record<string, string> = { "pm-1": "pm", "dev-1": "dev", "dev-2": "dev", "tester-1": "test", "rev-1": "code_reviewer" };
  const roleOf = (id: string) => roles[id];
  const edges = [{ producer: "dev", verifier: "code_reviewer", method: "code-review" as const, onReject: "redo" as const, maxRounds: 1 }];
  const all = ["pm-1", "dev-1", "dev-2", "tester-1", "rev-1"];

  it("expand → 原样保留完整团队(高风险/复杂任务)", () => {
    expect(capTeamWorkers(all, { scale: "expand", isCodingRun: true, requiresTests: true, roleOf, edges }).workers).toEqual(all);
  });
  it("简单无测试编码任务 → 只 1 个 producer", () => {
    const out = capTeamWorkers(all, { scale: "trivial", isCodingRun: true, requiresTests: false, roleOf, edges }).workers;
    expect(out).toHaveLength(1);
    expect(roleOf(out[0])).not.toMatch(/test|reviewer|qa/i); // 是 producer,不是 verifier
  });
  it("简单编码+测试 → producer + 1 独立 verifier(恰 2 人)", () => {
    const out = capTeamWorkers(all, { scale: "trivial", isCodingRun: true, requiresTests: true, roleOf, edges }).workers;
    expect(out).toHaveLength(2);
    expect(out.some((id) => /test|reviewer|qa/i.test(roleOf(id) ?? ""))).toBe(true);
  });
  it("中等任务(default)+测试 → producer + tester(缩编,远小于满编)", () => {
    const out = capTeamWorkers(all, { scale: "default", isCodingRun: true, requiresTests: true, roleOf, edges }).workers;
    expect(out).toHaveLength(2);
    expect(out.length).toBeLessThan(all.length);
  });
  it("requiresTests 但无可选 verifier → 只 producer(不虚构 verifier,下游 no_available_verifier 诚实拦)", () => {
    const out = capTeamWorkers(["dev-1", "dev-2"], { scale: "default", isCodingRun: true, requiresTests: true, roleOf: () => "dev", edges }).workers;
    expect(out).toHaveLength(1);
  });
  it("非编码 run → 1 worker", () => {
    expect(capTeamWorkers(all, { scale: "default", isCodingRun: false, requiresTests: false, roleOf, edges }).workers).toHaveLength(1);
  });
});

// P1(审计修复)· capTeamWorkers 按配置的 VerificationEdge 选 verifier,不盲取第一个 verifier 角色。
describe("capTeamWorkers — 按 VerificationEdge 选 verifier", () => {
  const edge = [{ producer: "dev", verifier: "code_reviewer", method: "code-review" as const, onReject: "redo" as const, maxRounds: 1 }];
  it("边 dev→code_reviewer:留 code_reviewer,不误留 test 裁掉 reviewer", () => {
    const roles: Record<string, string> = { "dev-1": "dev", "test-1": "test", "rev-1": "code_reviewer" };
    const out = capTeamWorkers(["dev-1", "test-1", "rev-1"], { scale: "default", isCodingRun: true, requiresTests: true, roleOf: (id) => roles[id], edges: edge }).workers;
    expect(out).toContain("rev-1");       // 边要求的 verifier 被保留
    expect(out).not.toContain("test-1");  // 无关 test 不误留
    expect(out).toHaveLength(2);
  });
  it("[审计修复] 有匹配边但 code_reviewer 缺失 → 绝不用 test 顶替,producer-only + edge_verifier_missing", () => {
    const roles: Record<string, string> = { "dev-1": "dev", "test-1": "test" };
    const cap = capTeamWorkers(["dev-1", "test-1"], { scale: "default", isCodingRun: true, requiresTests: true, roleOf: (id) => roles[id], edges: edge });
    expect(cap.workers).toEqual(["dev-1"]);              // 不顶替:producer-only
    expect(cap.workers).not.toContain("test-1");         // 绝不用普通 test 冒充配置的 code-review 边
    expect(cap.verifierGovernance).toBe("edge_verifier_missing"); // 标治理降级,交下游诚实拦
  });
  it("无匹配边(producer 角色不在任何 edge.producer)→ 显式 fallback 任一 verifier", () => {
    const roles: Record<string, string> = { "dev-1": "dev", "test-1": "test" };
    // edge 的 producer 是 backend(队里无此角色)→ 无匹配边 → 允许 fallback 到 test
    const cap = capTeamWorkers(["dev-1", "test-1"], { scale: "default", isCodingRun: true, requiresTests: true, roleOf: (id) => roles[id], edges: [{ producer: "backend", verifier: "code_reviewer", method: "code-review" as const, onReject: "redo" as const, maxRounds: 1 }] });
    expect(cap.workers).toContain("test-1");              // 无匹配边 → fallback 合法
    expect(cap.verifierGovernance).toBeUndefined();
  });
});
describe("fileChangesCreatedSince", () => {
  it("keeps only files created or modified by the serial coordinator call", () => {
    const before = [
      { path: "existing.txt", changeType: "modify" as const, after: "user draft" },
      { path: "same.txt", changeType: "modify" as const, after: "unchanged" },
    ];
    const after = [
      { path: "existing.txt", changeType: "modify" as const, after: "agent revision" },
      { path: "same.txt", changeType: "modify" as const, after: "unchanged" },
      { path: "smoke.txt", changeType: "create" as const, after: "OK" },
    ];

    expect(fileChangesCreatedSince(before, after)).toEqual([
      { path: "existing.txt", changeType: "modify", after: "agent revision" },
      { path: "smoke.txt", changeType: "create", after: "OK" },
    ]);
  });

  it("normalizes path separators when excluding pre-existing changes", () => {
    expect(fileChangesCreatedSince(
      [{ path: "dir\\file.txt", changeType: "create", after: "same" }],
      [{ path: "dir/file.txt", changeType: "create", after: "same" }],
    )).toEqual([]);
  });
});