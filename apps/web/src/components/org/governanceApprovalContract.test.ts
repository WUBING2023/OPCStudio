import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// E4 · L3 审批前端入口(批11验收 medium#2)回归约束。组件无 DOM 测试基建(纯 node vitest),
// 沿用 briefingPanelCeoScope.test.ts 的源码契约做法:锁住"派发响应 approvalRequired:true 时
// 不许再报「已派发」,必须走待审批文案 + 审批卡"这一不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const BRIEFING = read("BriefingPanel.tsx");
// E3(2026-07-11)把 CEO 驾驶舱(含最近失败卡)从 BriefingPanel 抽到 common/CeoCockpit.tsx——
// 涉及驾驶舱的断言改读新文件(计划 E3 步骤5),其余仍锁 BriefingPanel。
const CEO_COCKPIT = read("../common/CeoCockpit.tsx");
const USE_TASK_CHAT = read("../../lib/useTaskChat.ts");
const LAUNCH_PAD = read("../LaunchPad.tsx");
const COCKPIT = read("../../pages/CockpitPage.tsx");
const PM_MODAL = read("../common/PostmortemModal.tsx");
const CLIENT = read("../../api/client.ts");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;

describe("L3 审批 · 派发入口不再假报「已派发」", () => {
  it("所有 chatTask 消费方都检查 approvalRequired 并用 governance.awaitingApproval 文案", () => {
    for (const [name, src] of [
      ["BriefingPanel", BRIEFING], ["useTaskChat", USE_TASK_CHAT],
      ["LaunchPad", LAUNCH_PAD], ["CockpitPage", COCKPIT], ["PostmortemModal", PM_MODAL],
    ] as const) {
      expect(src, `${name} 缺少 approvalRequired 分支`).toMatch(/\.approvalRequired\b/);
      expect(src, `${name} 缺少 governance.awaitingApproval 文案`).toContain("governance.awaitingApproval");
    }
  });

  it("BriefingPanel 之外的入口广播 governance-approval-requested,简报栏监听后刷新审批卡", () => {
    for (const src of [USE_TASK_CHAT, LAUNCH_PAD, COCKPIT, PM_MODAL]) {
      expect(src).toContain('new CustomEvent("governance-approval-requested"');
    }
    expect(BRIEFING).toContain('addEventListener("governance-approval-requested"');
  });

  it("useTaskChat/LaunchPad/CockpitPage 的「已派任务」消息都在 approvalRequired 的 else 分支", () => {
    // 结构性约束:approvalRequired 判定必须出现在"已派"文案之前(同一 try 块内先拦后报)。
    for (const [src, dispatchedMark] of [
      [USE_TASK_CHAT, "org.brief.taskDispatched"],
      [LAUNCH_PAD, "已派任务"],
      [COCKPIT, "cockpit.taskDispatched"],
      [PM_MODAL, "postmortem.retryDispatched"],
    ] as const) {
      expect(src.indexOf(".approvalRequired")).toBeGreaterThan(-1);
      expect(src.indexOf(".approvalRequired")).toBeLessThan(src.indexOf(dispatchedMark));
    }
    // BriefingPanel 执行模式:approvalRequired 分支置 awaitingApproval 态,不置 dispatched
    expect(BRIEFING).toContain('dispatchState: "awaitingApproval"');
    expect(BRIEFING.indexOf(".approvalRequired")).toBeLessThan(BRIEFING.indexOf("org.brief.mission.dispatchedRun"));
  });
});

describe("L3 审批 · 简报栏审批卡", () => {
  it("数据源 GET /api/governance/records,批准/拒绝走 approve/reject 端点", () => {
    expect(CLIENT).toContain("/governance/records");
    expect(CLIENT).toMatch(/\/governance\/runs\/\$\{encodeURIComponent\(runId\)\}\/approve/);
    expect(CLIENT).toMatch(/\/governance\/runs\/\$\{encodeURIComponent\(runId\)\}\/reject/);
    expect(BRIEFING).toContain("api.listGovernanceRecords");
    expect(BRIEFING).toContain("api.approveGovernanceRun");
    expect(BRIEFING).toContain("api.rejectGovernanceRun");
  });

  it("只显示本公司 pending 的 L3 record;卡片展示 runId 与判级理由", () => {
    expect(BRIEFING).toMatch(/r\.approvalRequired && \(r\.approval\?\.status \?\? "pending"\) === "pending"/);
    expect(BRIEFING).toContain("org.governance.pendingTitle");
    expect(BRIEFING).toContain("org.governance.reasonLabel");
    expect(BRIEFING).toContain("rec.runId.slice(0, 8)");
  });

  it("批准响应三态齐全:dispatched / retryable(稍后重试) / 仅解锁", () => {
    expect(BRIEFING).toContain("org.governance.approvedDispatched");
    expect(BRIEFING).toContain("org.governance.approvedRetryLater");
    expect(BRIEFING).toContain("org.governance.approvedNoDispatch");
    expect(BRIEFING).toContain("org.governance.rejected");
    expect(BRIEFING).toMatch(/r\.retryable/);
  });
});

describe("LaunchPad · 本地消息按本公司 CEO 隔离(同波次1 #3 规则)", () => {
  it("不存在写死的 agentId:\"ceo\",addLocalMessage 一律用 chatCeoId", () => {
    expect(LAUNCH_PAD).not.toMatch(/agentId:\s*["']ceo["']/);
    const calls = [...LAUNCH_PAD.matchAll(/addLocalMessage\(\{\s*agentId:\s*([A-Za-z_$][\w$]*)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c[1]).toBe("chatCeoId");
  });

  it("接收 ceoId prop 并以 chatCeoId = ceoId || \"ceo\" 兜底", () => {
    expect(LAUNCH_PAD).toMatch(/ceoId\?:\s*string/);
    expect(LAUNCH_PAD).toMatch(/chatCeoId = ceoId \|\| "ceo"/);
  });
});

describe("#32 · postmortem 结构化 i18n 渲染", () => {
  it("PostmortemModal:cause 按 messageKey 词典渲染(未知键/旧数据回退 message 原文)", () => {
    expect(PM_MODAL).toMatch(/c\.messageKey && CAUSE_MSG_KEYS\.has\(c\.messageKey\)/);
    expect(PM_MODAL).toContain("postmortem.cause.${c.messageKey}");
    expect(PM_MODAL).toContain(": c.message");
  });

  it("PostmortemModal:建议优先 suggestionItems 的词典键,旧数据回退 suggestions 原文", () => {
    expect(PM_MODAL).toContain("postmortem.suggestion.${s.key}");
    expect(PM_MODAL).toMatch(/:\s*postmortem\.suggestions/);
  });

  it("CEO 驾驶舱最近失败卡(E3 迁至 CeoCockpit):topCauseKey/topSuggestionKey 有则词典渲染,无则回退原文", () => {
    expect(CEO_COCKPIT).toContain("postmortem.cause.${lastFailure.topCauseKey}");
    expect(CEO_COCKPIT).toContain("postmortem.suggestion.${lastFailure.topSuggestionKey}");
    expect(CEO_COCKPIT).toContain(": lastFailure.topCause");
    expect(CEO_COCKPIT).toContain(": lastFailure.topSuggestion");
  });
});

describe("i18n · 新增键 11 语言全覆盖", () => {
  const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];
  const CAUSE_KEYS = [
    "provider_key", "provider_key_likely", "provider_unavailable", "no_account", "timeout",
    "quality_gate_failed", "budget_exhausted", "artifact_rejected", "degraded", "run_failed",
  ];
  const SUGG_KEYS = [
    "configure_key", "switch_provider", "provider_unavailable", "no_account", "timeout",
    "quality_gate_failed", "budget_exhausted", "artifact_rejected", "degraded", "run_failed",
  ];
  const GOV_KEYS = [
    "governance.awaitingApproval", "org.governance.pendingTitle", "org.governance.reasonLabel",
    "org.governance.approve", "org.governance.reject", "org.governance.approvedDispatched",
    "org.governance.approvedRetryLater", "org.governance.approvedNoDispatch",
    "org.governance.rejected", "org.governance.actionFailed", "org.brief.exec.awaitingApprovalTag",
  ];

  it("postmortem.cause.* / postmortem.suggestion.* / governance 系列键 11 语言均有非空文案", () => {
    const allKeys = [
      ...CAUSE_KEYS.map(k => `postmortem.cause.${k}`),
      ...SUGG_KEYS.map(k => `postmortem.suggestion.${k}`),
      ...GOV_KEYS,
    ];
    for (const lang of LANGS) {
      for (const key of allKeys) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("带参数的键在各语言保留占位符", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]["postmortem.cause.provider_key"]).toContain("{who}");
      expect(DICTS[lang]["postmortem.cause.provider_key"]).toContain("{provider}");
      expect(DICTS[lang]["postmortem.cause.artifact_rejected"]).toContain("{ref}");
      expect(DICTS[lang]["postmortem.suggestion.configure_key"]).toContain("{provider}");
      expect(DICTS[lang]["governance.awaitingApproval"]).toContain("{id}");
      expect(DICTS[lang]["org.governance.actionFailed"]).toContain("{message}");
    }
  });
});
