import { describe, it, expect } from "vitest";
import { blankDraft, newCard } from "./workshopTypes.js";
import { draftToEditTarget, applyEditTargetToDraft } from "./aiEditBridge.js";

describe("aiEditBridge · draftToEditTarget", () => {
  it("卡片 key 直接当 agentId,汇报关系/childrenIds 正确换算", () => {
    const draft = blankDraft();
    draft.title = "测试公司";
    draft.description = "描述";
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "小明", provider: "deepseek", model: "deepseek-chat", reportsTo: ceo.key });
    draft.cards = [ceo, dev];

    const target = draftToEditTarget(draft);
    expect(target.id).toBe(draft.id);
    expect(target.title).toBe("测试公司");
    expect(target.description).toBe("描述");
    expect(target.agents).toHaveLength(2);
    const ta = target.agents.find(a => a.id === dev.key)!;
    expect(ta.name).toBe("小明");
    expect(ta.parentId).toBe(ceo.key);
    const tceo = target.agents.find(a => a.id === ceo.key)!;
    expect(tceo.childrenIds).toContain(dev.key);
  });

  it("a2aChannels 换算:from/to 直接是卡片 key", () => {
    const draft = blankDraft();
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "Dev", reportsTo: ceo.key });
    draft.cards = [ceo, dev];
    draft.a2aChannels = [{ key: "c1", from: ceo.key, to: dev.key, purpose: "交接" }];

    const target = draftToEditTarget(draft);
    expect(target.a2aChannels).toEqual([{ from: ceo.key, to: dev.key, purpose: "交接" }]);
  });
});

describe("aiEditBridge · applyEditTargetToDraft", () => {
  it("已有卡片:保留 systemPrompt,其余字段按 target 更新;新出现的 agentId 变成新卡片", () => {
    const draft = blankDraft();
    const ceo = newCard({ role: "ceo", name: "CEO", systemPrompt: "你是CEO" });
    draft.cards = [ceo];
    draft.title = "旧名字";

    const target = draftToEditTarget(draft);
    target.title = "新名字";
    target.agents.push({
      id: "growth-lead", name: "增长主管", role: "growth-lead", parentId: ceo.key, childrenIds: [],
      model: "", provider: "", framework: "hermes", status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, editable: true, deletable: true, enabled: true,
    });

    const next = applyEditTargetToDraft(target, draft);
    expect(next.title).toBe("新名字");
    expect(next.cards).toHaveLength(2);
    const keptCeo = next.cards.find(c => c.key === ceo.key)!;
    expect(keptCeo.systemPrompt).toBe("你是CEO"); // target 里没有这个字段,必须从旧草稿保留下来
    const newCardEntry = next.cards.find(c => c.key === "growth-lead")!;
    expect(newCardEntry.name).toBe("增长主管");
    expect(newCardEntry.reportsTo).toBe(ceo.key);
    expect(newCardEntry.framework).toBe("hermes"); // 存量 "hermes" 原始值读侧原样保留(E1 读侧兼容回归)
  });

  it("target 里已删除的 agent 不再出现在新草稿的 cards 里", () => {
    const draft = blankDraft();
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "Dev", reportsTo: ceo.key });
    draft.cards = [ceo, dev];

    const target = draftToEditTarget(draft);
    target.agents = target.agents.filter(a => a.id !== dev.key); // 模拟 remove_agent 生效后的结果

    const next = applyEditTargetToDraft(target, draft);
    expect(next.cards).toHaveLength(1);
    expect(next.cards.find(c => c.key === dev.key)).toBeUndefined();
  });

  it("a2aChannels 换算回草稿:已有通道保留原 key,新通道分配新 key", () => {
    // 注:from/to 视为无向(同 companyArchitect.ts update_a2a_policy 的双向去重语义——{a,b} 与 {b,a}
    // 是同一条通道,服务端 apply 逻辑本就不可能让 target.a2aChannels 同时出现这两条),这里验证的是
    // "已有通道原样保留 key" + "全新的一对成员之间新增通道会分配新 key" 两种真实会发生的场景。
    const draft = blankDraft();
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "Dev", reportsTo: ceo.key });
    const qa = newCard({ role: "qa", name: "QA", reportsTo: ceo.key });
    draft.cards = [ceo, dev, qa];
    draft.a2aChannels = [{ key: "existing-key", from: ceo.key, to: dev.key, purpose: "旧用途" }];

    const target = draftToEditTarget(draft);
    target.a2aChannels = [
      { from: ceo.key, to: dev.key, purpose: "旧用途" },   // 未变
      { from: ceo.key, to: qa.key, purpose: "新通道" },     // 全新的一对成员之间新增
    ];

    const next = applyEditTargetToDraft(target, draft);
    expect(next.a2aChannels).toHaveLength(2);
    const kept = next.a2aChannels.find(c => c.from === ceo.key && c.to === dev.key)!;
    expect(kept.key).toBe("existing-key");
    const created = next.a2aChannels.find(c => c.from === ceo.key && c.to === qa.key)!;
    expect(created.key).not.toBe("existing-key");
    expect(created.key).toBeTruthy();
  });

  it("target.agents 为空 → 兜底回退到一张 CEO 空卡片(不产出零成员的非法草稿)", () => {
    const draft = blankDraft();
    const target = draftToEditTarget(draft);
    target.agents = [];
    const next = applyEditTargetToDraft(target, draft);
    expect(next.cards).toHaveLength(1);
    expect(next.cards[0].role).toBe("ceo");
  });
});

describe("aiEditBridge recommendedConfig compatibility", () => {
  it("preserves legacy compatibility fields through the Architect target", () => {
    const draft = blankDraft();
    draft.recommendedConfigEnabled = true;
    draft.recommendedDefaultModel = "legacy-model";
    draft.recommendedMaxTokensPerTask = "654321";
    draft.recommendedLegacyBudget = {
      totalUsd: 0,
      maxTokensPerTask: 654321,
      maxAttemptsPerTask: 3,
      maxTokensPerRun: 900000,
    };

    const target = draftToEditTarget(draft);
    expect(target.recommendedConfig?.budget).toEqual(draft.recommendedLegacyBudget);
    expect(target.recommendedConfig).not.toHaveProperty("maxTokensPerTask");

    const restored = applyEditTargetToDraft(target, draft);
    expect(restored.recommendedLegacyBudget).toEqual(draft.recommendedLegacyBudget);
    expect(restored.recommendedMaxTokensPerTask).toBe("654321");
  });
});