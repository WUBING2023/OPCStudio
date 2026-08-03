import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 质量复检修正波次2 · orchestrator 侧回归约束(源码契约)。orchestrator.ts 依赖面极重且其 E2E
// 冒烟被 vitest 显式排除,这些跨越整个 startRun 的不变量无法用轻量单测直接驱动——参照
// briefingPanelCeoScope.test.ts 的姿势,以源码契约把修复钉住,防止后续改动无声回退。
const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.ts"),
  "utf-8",
);

describe("#4 · emit(\"agent_message\") 只允许经 recordMessage/recordA2A 的 committed 生命周期", () => {
  it("全文件恰好 2 处 emit(\"agent_message\")(recordMessage/recordA2A 内部),无旁路裸 emit", () => {
    const occurrences = SRC.match(/emit\("agent_message"/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it("两处通道申请(a2aRequestChannel / setChannelRequestHandler)都走 recordMessage", () => {
    const calls = SRC.match(/recordMessage\(from, `（申请与 \$\{target\} 建立 \$\{k(?:ind)?\} 通道）/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});

describe("#7 · 交叉验证否决:撤销代码账目 + 残留如实披露", () => {
  it("否决分支从 allChanges 撤账并记录 vetoedResidualChanges", () => {
    expect(SRC).toMatch(/if \(!_gateResult\.passed\) \{[\s\S]{0,1600}allChanges\.splice\([\s\S]{0,900}vetoedResidualChanges\.push\(\{ agentId: w\.workerId, paths: residualPaths \}\)/);
  });

  it("占位文案/deferred.lastError 声明代码残留(不再谎称产出未进交付)", () => {
    expect(SRC).toContain("仍会随交付进入工作区");
    expect(SRC).toContain("代码改动已并入 run 分支未回滚");
  });

  it("最终报告 risks/nextSteps 带上否决残留清单", () => {
    expect(SRC).toMatch(/risks: \[[\s\S]{0,1200}vetoedResidualChanges\.slice\(0, 20\)\.map/);
    expect(SRC).toMatch(/nextSteps: \[[\s\S]{0,800}vetoedResidualChanges\.slice\(0, 20\)\.map/);
  });
});

describe("#14 · run 结束关闭 A2A 守卫窗口", () => {
  it("外层 finally 清 activeRunId,且批11的 pid 清理保持完整", () => {
    expect(SRC).toMatch(/if \(pidRegistryRunId\) clearRunPids\(pidRegistryRunId\);[\s\S]{0,1000}setPidRegistryRun\(null\);[\s\S]{0,800}activeRunId = "";[\s\S]{0,160}runInFlight = false;/);
    expect(SRC).toMatch(/clearRunContextCache\(projectRoot, finishedRunId\);[\s\S]{0,300}clearRunResourceValidationCache\(projectRoot, finishedRunId\);/);
  });
});

describe("#15 · CEO 一律按角色解析,不写死字面量 id", () => {
  it("不存在 recordMessage(\"ceo\", ...) / to: \"ceo\" / agents.some(a => a.id === \"ceo\")", () => {
    expect(SRC).not.toMatch(/recordMessage\("ceo"/);
    expect(SRC).not.toMatch(/to: "ceo"/);
    expect(SRC).not.toMatch(/a\.id === "ceo"/);
  });

  it("广播与 handoff 都按 role===\"ceo\" 解析真实 id", () => {
    const byRole = SRC.match(/agents\.find\(a => a\.role === "ceo"\)/g) ?? [];
    expect(byRole.length).toBeGreaterThanOrEqual(3); // companyCeoId + ceo 主链 + handoff
  });

  it("lead outcome 等待 DeliveryAcceptance，且只在真实投递后发 contractMessage 遥测", () => {
    expect(SRC).toMatch(/for \(const pending of pendingLeadOutcomes\)[\s\S]{0,2200}a2aBus\.commitAndDeliver[\s\S]{0,800}contractMessage: \{ id: message\.id/);
    expect(SRC).toMatch(/if \(ceoAgent\) \{[\s\S]{0,800}pendingLeadOutcomes\.push/);
    expect(SRC).not.toContain("团队工作完成");
    expect(SRC).toContain("decideLeadOutcomeA2A");
  });
});

describe("#33 · traceSub 与 eventBus 的 EPHEMERAL_TYPES 同口径过滤 chunk", () => {
  it("traceSub 过滤 EPHEMERAL_TYPES(trace.json 不再收 agent_output_chunk)", () => {
    expect(SRC).toMatch(/const traceSub = \(e: any\) => \{ if \(!EPHEMERAL_TYPES\.has\(e\.type\)\) traceEvents\.push\(e\); \};/);
    expect(SRC).toMatch(/import \{[^}]*EPHEMERAL_TYPES[^}]*\} from "\.\/eventBus\.js"/);
  });
});

describe("#36 · 契约类校验跑在裸产出上,不跑在带任务描述的复合串上", () => {
  it("fact-check programmaticVerify 与 cross_verify 的 gate 都用 latestRawContent", () => {
    expect(SRC).toMatch(/programmaticVerify\(latestRawContent\.get\(w\.workerId\) \?\? out, "fact-check"\)/);
    expect(SRC).toMatch(/runQualityGateLayers\(\{ content: latestRawContent\.get\(w\.workerId\) \?\? out, artifactContract: _acForEdge/);
  });

  it("latestRawContent 与 admission 门控同一字符串((r.content ?? \"\") + deliverableBodies)", () => {
    expect(SRC).toMatch(/latestRawContent\.set\(r\.agentId, \(r\.content \?\? ""\) \+ deliverableBodies\)/);
  });
});
