import { describe, it, expect } from "vitest";
import type { AgentNodeConfig } from "@opc/shared";
import { resolveDecomposer, parseDecomposeReply } from "./taskDecomposer.js";

function agent(overrides: Partial<AgentNodeConfig> & { id: string; name: string; role: string }): AgentNodeConfig {
  return {
    parentId: undefined, childrenIds: [], model: "deepseek-chat", provider: "deepseek",
    framework: "hermes", companyId: "co1", status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function resetRoster(): AgentNodeConfig[] {
  return [
    agent({ id: "ceo-1", name: "CEO", role: "ceo", childrenIds: ["lead-1"] }),
    agent({ id: "lead-1", name: "Lead B", role: "lead", parentId: "ceo-1", childrenIds: ["dev-1"] }),
    agent({ id: "dev-1", name: "Dev A", role: "dev", parentId: "lead-1" }),
  ];
}

// resolveDecomposer 本从架构助手(resolveArchitectDecomposer)挪过来、去掉架构语义化——这里迁移
// 那批测试用例,验证"谁来拆解"这个组织判断和领域(架构/任务)无关。
describe("resolveDecomposer", () => {
  it("有 Leader → 用 Leader,fallbackToCeo:false", () => {
    const r = resolveDecomposer(resetRoster());
    expect(r?.role).toBe("lead");
    expect(r?.agent.name).toBe("Lead B");
    expect(r?.fallbackToCeo).toBe(false);
  });

  it("没有 Leader → 用 CEO 兜底,fallbackToCeo:true", () => {
    const roster = resetRoster();
    roster.splice(roster.findIndex(a => a.role === "lead"), 1);
    const r = resolveDecomposer(roster);
    expect(r?.role).toBe("ceo");
    expect(r?.agent.name).toBe("CEO");
    expect(r?.fallbackToCeo).toBe(true);
  });

  it("Leader 被停用(enabled:false)→ 视同没有 Leader,落到 CEO 兜底", () => {
    const roster = resetRoster();
    roster.find(a => a.role === "lead")!.enabled = false;
    const r = resolveDecomposer(roster);
    expect(r?.role).toBe("ceo");
    expect(r?.fallbackToCeo).toBe(true);
  });

  it("既没有 Leader 也没有 CEO(或都被停用)→ undefined", () => {
    const roster = [agent({ id: "dev-1", name: "Dev A", role: "dev" })];
    expect(resolveDecomposer(roster)).toBeUndefined();
  });
});

// parseDecomposeReply 的领域无关性:用一个简单的"最终产出是字符串"场景验证,和架构场景(最终产出是
// action[])共用同一套 needsChoice 分支 + JSON 信封解析,只是 extractResult/emptyResult 不同。
describe("parseDecomposeReply", () => {
  const extractText = (p: any) => (typeof p?.finalTask === "string" ? p.finalTask : "");

  it("情况A·需要选择:needsChoice=true,questions 解析出来,result 强制为 emptyResult(即便模型给了产出也丢弃)", () => {
    const raw = `\`\`\`json
{"summary":"给团队分配一个日常任务","needsChoice":true,"questions":[{"question":"优先做哪部分?","options":["A. 先做前端","B. 先做后端"]}],"finalTask":"不该出现的产出"}
\`\`\``;
    const r = parseDecomposeReply(raw, extractText, "");
    expect(r.summary).toBe("给团队分配一个日常任务");
    expect(r.needsChoice).toBe(true);
    expect(r.questions).toEqual([{ question: "优先做哪部分?", options: ["A. 先做前端", "B. 先做后端"] }]);
    expect(r.result).toBe(""); // 情况A 这一轮不该给出最终产出,即便模型违规给了也强制清空
  });

  it("情况B·需求明确:needsChoice=false,result 用 extractResult 从 parsed 里取出,questions 强制清空", () => {
    const raw = `\`\`\`json
{"summary":"直接执行","needsChoice":false,"questions":[],"finalTask":"把首页文案改成中文"}
\`\`\``;
    const r = parseDecomposeReply(raw, extractText, "");
    expect(r.needsChoice).toBe(false);
    expect(r.questions).toEqual([]);
    expect(r.result).toBe("把首页文案改成中文");
  });

  it("needsChoice:true 但 questions 是空数组/格式不对 → 降级为 needsChoice:false,改用 extractResult(不卡在空白选择题)", () => {
    const raw = `\`\`\`json
{"summary":"处理需求","needsChoice":true,"questions":[],"finalTask":"直接执行这个任务"}
\`\`\``;
    const r = parseDecomposeReply(raw, extractText, "");
    expect(r.needsChoice).toBe(false);
    expect(r.result).toBe("直接执行这个任务");
  });

  it("缺少 summary → 抛错(诚实失败,不编造兜底数据)", () => {
    const raw = `{"needsChoice":false,"finalTask":"x"}`;
    expect(() => parseDecomposeReply(raw, extractText, "")).toThrow(/summary/);
  });

  it("完全不是 JSON → 抛错", () => {
    expect(() => parseDecomposeReply("这不是 JSON 也没有代码块", extractText, "")).toThrow();
  });

  it("JSON 解析失败(代码块内容损坏)→ 抛错", () => {
    const raw = "```json\n{ this is not valid json\n```";
    expect(() => parseDecomposeReply(raw, extractText, "")).toThrow();
  });

  it("带 DIRECT_ANSWER 协议头前缀:剥离后仍能正常解析", () => {
    const raw = `DIRECT_ANSWER: {"summary":"处理这个任务","needsChoice":false,"finalTask":"去做这件事"}`;
    const r = parseDecomposeReply(raw, extractText, "");
    expect(r.summary).toBe("处理这个任务");
    expect(r.result).toBe("去做这件事");
  });

  it("questions 超过3条硬截断为3条,每条 options 超过6个硬截断为6个", () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({ question: `问题${i}`, options: Array.from({ length: 8 }, (_, j) => `选项${j}`) }));
    const raw = JSON.stringify({ summary: "多个问题", needsChoice: true, questions });
    const r = parseDecomposeReply(raw, extractText, "");
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0].options).toHaveLength(6);
  });

  // ↓ 规整/修复管道(2026-07 用户实测报错:模型在字符串值里写了没转义的裸双引号,JSON.parse 直接碎)
  describe("字符串内裸双引号修复 + 弯引号规整", () => {
    // 用户这条真实报错串(补全为完整 JSON):options 里的选项值内部写了没转义的直双引号,并且引号之间
    // 还夹着逗号——最能考验状态机对"闭合引号 vs 裸内引号"的判定。必须修复成功解析。
    it("真实报错:选项值内部的裸双引号(含逗号歧义)被修复,解析成功", () => {
      const raw = `{"summary":"构建一个 Android 自动调音 APK","needsChoice":true,"questions":[{"question":"自动调音的策略是什么?","options":["A. 用户设定一个"目标听感响度",系统据此自动调整","B. 全自动:系统分析后直接给出结果"]}],"finalTask":""}`;
      const r = parseDecomposeReply(raw, extractText, "");
      expect(r.summary).toBe("构建一个 Android 自动调音 APK");
      expect(r.needsChoice).toBe(true);
      expect(r.questions).toHaveLength(1);
      // 直双引号修复是"转义"而非"替换成「」":内容原样保留(仍是 "),只是变成合法 JSON;
      // 逗号在字符串内部被正确并入内容,数组只解析出 A/B 两个选项而不是被逗号切碎。
      expect(r.questions[0].options).toEqual([
        'A. 用户设定一个"目标听感响度",系统据此自动调整',
        "B. 全自动:系统分析后直接给出结果",
      ]);
    });

    it("finalTask 值内部的裸双引号被修复(转义保留原字符)", () => {
      const raw = `{"summary":"直接执行","needsChoice":false,"finalTask":"把按钮文案改成"立即开始"这四个字"}`;
      const r = parseDecomposeReply(raw, extractText, "");
      expect(r.result).toBe('把按钮文案改成"立即开始"这四个字');
    });

    it("中文弯引号“”被规整为「」(即便本就能解析)", () => {
      const raw = `{"summary":"改文案","needsChoice":false,"finalTask":"把首页标题改成“欢迎光临”这四个字"}`;
      const r = parseDecomposeReply(raw, extractText, "");
      expect(r.result).toBe("把首页标题改成「欢迎光临」这四个字");
      expect(r.result).not.toContain("“");
      expect(r.result).not.toContain("”");
    });

    it("正常合法 JSON 不被误伤:已转义的双引号原样保留,不进修复路径", () => {
      const raw = `{"summary":"报告","needsChoice":false,"finalTask":"他说 \\"你好\\" 然后离开"}`;
      const r = parseDecomposeReply(raw, extractText, "");
      expect(r.result).toBe('他说 "你好" 然后离开');
    });

    it("裸双引号出现在数组多个元素里,逐个修复", () => {
      const raw = `{"summary":"多选项","needsChoice":true,"questions":[{"question":"选哪种?","options":["A. 走"快速"通道","B. 走"稳妥"通道"]}]}`;
      const r = parseDecomposeReply(raw, extractText, "");
      expect(r.questions[0].options).toEqual(['A. 走"快速"通道', 'B. 走"稳妥"通道']);
    });

    it("真坏 JSON(缺分隔符/结构损坏)修复也救不回来 → 仍抛错,且错误信息标注已尝试修复", () => {
      const raw = `{"summary":"x" "needsChoice" false finalTask }`;
      expect(() => parseDecomposeReply(raw, extractText, "")).toThrow(/已尝试.*修复/);
    });
  });
});
