import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 订阅推理档位四档按钮(AgentDetailsPanel)源码契约 —— 组件无 DOM 测试基建(纯 node vitest),以源码 + 词典
// 契约锁住不变量:四档渲染 / codex·claude-code 可选、gemini 禁用带原因 / 写落 reasoningEffort / i18n en+zh。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const SRC = read("AgentDetailsPanel.tsx");
const DICTS = JSON.parse(read("../i18n.dict.json")) as Record<string, Record<string, string>>;

describe("推理档位 · 四档渲染", () => {
  it("四档 = low/medium/high/xhigh,顺序由浅到深", () => {
    expect(SRC).toMatch(/const REASONING_EFFORTS:\s*ReasoningEffort\[\]\s*=\s*\["low",\s*"medium",\s*"high",\s*"xhigh"\]/);
  });

  it("按钮 map 渲染四档并用 i18n 键 agent.effort.<value> 出标签", () => {
    expect(SRC).toMatch(/REASONING_EFFORTS\.map\(/);
    expect(SRC).toContain("t(`agent.effort.${e}`)");
    expect(SRC).toContain("t('agent.effort.label')");
  });

  it("点击写落 agent.reasoningEffort(update patch)", () => {
    expect(SRC).toContain("update(agent.id, { reasoningEffort: e })");
  });

  it("只在订阅分支(isCli)出现", () => {
    // effort 块位于 isCli && (() => {...}) 内
    expect(SRC).toMatch(/isCli && \(\(\) => \{\s*const effortSupported = frameworkSupportsEffort\(currentFramework\)/);
  });
});

describe("推理档位 · 支持矩阵与禁用态", () => {
  it("codex + claude-code 支持;gemini 不假装", () => {
    expect(SRC).toMatch(/function frameworkSupportsEffort\([^)]*\)\s*:\s*boolean\s*\{\s*return fw === "codex" \|\| fw === "claude-code";/);
  });

  it("不支持时按钮禁用 + 给出原因(agent.effort.unsupported,带 engine 占位)", () => {
    expect(SRC).toContain("const disabled = readOnly || !effortSupported");
    expect(SRC).toContain("disabled={disabled}");
    expect(SRC).toContain("t('agent.effort.unsupported', { engine: currentFramework })");
    // 禁用态视觉:cursor-not-allowed
    expect(SRC).toContain("cursor-not-allowed");
  });
});

describe("推理档位 · i18n(en + zh 覆盖,带参数键保留占位符)", () => {
  const KEYS = [
    "agent.effort.label", "agent.effort.low", "agent.effort.medium",
    "agent.effort.high", "agent.effort.xhigh", "agent.effort.hint", "agent.effort.unsupported",
  ];
  // en 为回退基准;zh-CN/zh-TW 为任务要求的中文覆盖(其余语言经 i18n 回退英文,不出乱码)。
  const REQUIRED_LANGS = ["en", "zh-CN", "zh-TW"];

  it("en/zh-CN/zh-TW 均有非空文案", () => {
    for (const lang of REQUIRED_LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("agent.effort.unsupported 各语言保留 {engine} 占位符", () => {
    for (const lang of REQUIRED_LANGS) {
      expect(DICTS[lang]["agent.effort.unsupported"], `${lang} unsupported`).toContain("{engine}");
    }
  });
});
