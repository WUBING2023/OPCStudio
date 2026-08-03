import { describe, it, expect } from "vitest";
import { blankDraft, newCard, buildPayload, draftFromTemplate } from "./workshopTypes.js";

// 角色卡"框架/订阅模式"落到最终 AgentNodeConfig 的回归测试——此前 buildPayload 硬编码
// framework,角色卡永远无法产出 claude-code/codex 类型的 agent。
// E1(2026-07-11)写侧去品牌:缺省新卡写 "api";存量 "hermes" 原始值读侧兼容、不被静默改写。
describe("workshopTypes · card.framework -> AgentNodeConfig.framework", () => {
  it("缺省(未选过框架的新卡片)写侧落 'api'", () => {
    const draft = blankDraft();
    draft.title = "T";
    const { template } = buildPayload(draft);
    expect(template.agents[0].framework).toBe("api");
  });

  it("claude-code/codex 选择正确落到对应 agent 的 framework 字段", () => {
    const draft = blankDraft();
    draft.title = "T";
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "Dev", framework: "claude-code", provider: "anthropic", model: "sonnet", reportsTo: ceo.key });
    const qa = newCard({ role: "qa", name: "QA", framework: "codex", provider: "openai", model: "gpt-5.5", reportsTo: ceo.key });
    draft.cards = [ceo, dev, qa];

    const { template } = buildPayload(draft);
    expect(template.agents.find(a => a.role === "dev")?.framework).toBe("claude-code");
    expect(template.agents.find(a => a.role === "qa")?.framework).toBe("codex");
    // 缺省卡片落 "api",三个值互不干扰
    expect(template.agents.find(a => a.role === "ceo")?.framework).toBe("api");
  });

  it("读侧兼容:显式带存量 'hermes' 的旧卡片原样保留,不被静默改写(导入经 shared schema 归一)", () => {
    const draft = blankDraft();
    draft.title = "T";
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const ops = newCard({ role: "ops", name: "Ops", framework: "hermes", provider: "deepseek", model: "deepseek-v4-flash", reportsTo: ceo.key });
    draft.cards = [ceo, ops];
    const { template } = buildPayload(draft);
    expect(template.agents.find(a => a.role === "ops")?.framework).toBe("hermes");
  });

  it("draftFromTemplate 能把模板里的 framework 读回草稿(fork/公司导出场景)", () => {
    const draft = blankDraft();
    draft.title = "T";
    const ceo = newCard({ role: "ceo", name: "CEO" });
    const dev = newCard({ role: "dev", name: "Dev", framework: "claude-code", provider: "anthropic", model: "opus", reportsTo: ceo.key });
    draft.cards = [ceo, dev];
    const { template } = buildPayload(draft);

    const back = draftFromTemplate(template, "fork");
    expect(back.cards.find(c => c.role === "dev")?.framework).toBe("claude-code");
    expect(back.cards.find(c => c.role === "ceo")?.framework).toBe("api");
  });
});

// P1(审计)· 工坊无编辑保存不得用 description 覆盖独立 readme(readme !== description 时静默丢失)。
describe("workshopTypes · readme 保真(独立于 description)", () => {
  it("来源模板 readme 与 description 不同 → 反推+保存后 readme 原样保留(不被 description 覆盖)", () => {
    const d0 = blankDraft(); d0.title = "T"; d0.description = "一句话描述";
    const { template: base } = buildPayload(d0);
    const tpl = { ...base, description: "一句话描述", readme: "# 完整 README\n\n这是一整篇富文本说明,远比一句话描述丰富。" };
    const back = draftFromTemplate(tpl, "fork");
    expect(back.readme).toBe(tpl.readme);         // 反推原样捕获
    const { template: out } = buildPayload(back); // 无编辑保存
    expect(out.readme).toBe(tpl.readme);          // 原 readme 带回,不被 description 覆盖
    expect(out.description).toBe("一句话描述");
  });

  it("来源无 readme(新建草稿)→ buildPayload 回退用 description 生成(既有行为不回退)", () => {
    const d = blankDraft(); d.title = "T"; d.description = "描述文本";
    const { template } = buildPayload(d);
    expect(template.readme).toBe("描述文本");
  });
});

describe("workshopTypes recommendedConfig compatibility", () => {
  it("preserves a legacy budget object through a no-op workshop round trip", () => {
    const draft = blankDraft();
    draft.title = "Legacy";
    const { template: base } = buildPayload(draft);
    const recommendedConfig = {
      defaultModel: "legacy-model",
      budget: {
        totalUsd: 0,
        maxTokensPerTask: 123456,
        maxAttemptsPerTask: 4,
        taskTimeoutMs: 90000,
      },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false },
    };
    const source = { ...base, recommendedConfig };

    const reopened = draftFromTemplate(source, "fork");
    const { template: saved } = buildPayload(reopened);

    expect(saved.recommendedConfig).toEqual(recommendedConfig);
    expect(saved.recommendedConfig).not.toHaveProperty("maxTokensPerTask");
  });
});