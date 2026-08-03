import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// E2 · i18n 清尾回归约束(2026-07-11):
// ① AgentDetailsPanel「模型配置」区的用户可见文案全走词典(agent.exec.* / agent.model.*),硬编码中文清零;
// ② framework.ts Tier1Option 改 labelKey/blurbKey/warningKey(框架文件零中文,由消费组件 t() 渲染);
// ③ 键名去品牌:settings.hermes.* / setup.hermes.* 死键删净,org.executionModeHermes* 改名 Api*;
// ④ 本波新增键 11 语言齐全(存量键覆盖不齐是历史遗留,只锁新增键)。
// 组件无 DOM 测试基建(纯 node vitest),沿用 appShellI18n.test.ts 的源码契约做法。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

// 中文注释是允许的(全库惯例)——先剥注释再断言,只锁"用户可见"的硬编码文案。
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const PANEL_RAW = read("AgentDetailsPanel.tsx");
const PANEL = stripComments(PANEL_RAW);
const FRAMEWORK = stripComments(read("../lib/framework.ts"));
const ADD_MODAL = stripComments(read("org/AddAgentModal.tsx")); // 注释里允许提及旧键名(改名说明)
const DICTS = JSON.parse(read("../i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

const NEW_KEYS = [
  "agent.exec.section", "agent.exec.name", "agent.exec.mode",
  "agent.exec.subscription", "agent.exec.api", "agent.exec.legacyRetired",
  "agent.exec.installedNotLoggedIn", "agent.exec.notInstalled",
  "agent.exec.provider", "agent.exec.configuredSuffix",
  "agent.exec.providerHintApi", "agent.exec.providerHintOther",
  "agent.model.label", "agent.model.cliAliasLabel", "agent.model.custom",
  "agent.model.cliCustomPlaceholder", "agent.model.customPlaceholder", "agent.model.cliCatalogHint",
  "org.executionModeApiLabel", "org.executionModeApiBlurb",
  "org.executionModeClaudeCodeLabel", "org.executionModeClaudeCodeBlurb",
  "org.executionModeCodexLabel", "org.executionModeCodexBlurb",
  "org.executionModeGeminiCliLabel", "org.executionModeGeminiCliBlurb",
  "org.executionModeGeminiCliWarning", "org.executionModeWorkerCliRisk",
];

describe("E2 · AgentDetailsPanel 模型配置区文案全走 i18n", () => {
  it("原硬编码中文文案已清除(中文注释除外)", () => {
    for (const s of [
      ">模型配置<", ">名称</label>", ">执行方式</label>", '["sub", "订阅"]',
      "建议改选上方", "已安装，未登录",
      ">模型（订阅 CLI 别名）</label>", ">模型</label>", ">供应商</label>",
      ">自定义…<", "留空=CLI 默认", "输入模型名称",
      "订阅模型列表来自目录探测", "✓ 已配置", "✓=已配置", "worker 走订阅",
    ]) {
      expect(PANEL, `AgentDetailsPanel.tsx 残留硬编码文案: ${s}`).not.toContain(s);
    }
  });

  it("新词典键在面板中被引用", () => {
    // 注:2026-07 ChatGPT 风格精简后主动移除了若干"解释型"小字(providerHint*/cliCatalogHint/
    // executionModeWorkerCliRisk 的面板引用),对应词典键仍保留(读侧兼容),故不再断言其被面板引用。
    for (const k of [
      "agent.exec.section", "agent.exec.name", "agent.exec.mode",
      "agent.exec.subscription", "agent.exec.api",
      "agent.exec.installedNotLoggedIn", "agent.exec.notInstalled",
      "agent.exec.provider", "agent.exec.configuredSuffix",
      "agent.model.label", "agent.model.cliAliasLabel", "agent.model.custom",
      "agent.model.cliCustomPlaceholder", "agent.model.customPlaceholder",
      "agent.account.label", "agent.account.auto",
    ]) {
      expect(PANEL_RAW, `AgentDetailsPanel.tsx 未使用键 ${k}`).toContain(`'${k}'`);
    }
    // 带参数的键
    expect(PANEL_RAW).toMatch(/t\('agent\.exec\.legacyRetired',\s*\{\s*fw:/);
  });
});

describe("E2 · framework.ts Tier1Option 走 labelKey/blurbKey/warningKey", () => {
  it("剥掉注释后不再含任何中文(label/blurb/warning 硬编码清零)", () => {
    expect(FRAMEWORK).not.toMatch(/[一-鿿]/);
  });

  it("四个第一级选项引用词典键(含 gemini warning)", () => {
    for (const k of [
      "org.executionModeClaudeCodeLabel", "org.executionModeCodexLabel",
      "org.executionModeGeminiCliLabel", "org.executionModeGeminiCliWarning",
      "org.executionModeApiLabel", "org.executionModeApiBlurb",
    ]) {
      expect(FRAMEWORK, `framework.ts 缺键引用 ${k}`).toContain(`"${k}"`);
    }
    expect(FRAMEWORK).toContain("labelKey");
    expect(FRAMEWORK).toContain("blurbKey");
    expect(FRAMEWORK).toContain("warningKey");
  });
});

describe("E2 · hermes 键名清零(死键删净 + 改名同步)", () => {
  it("词典所有语言无 settings.hermes.* / setup.hermes.* / org.executionModeHermes* 残留", () => {
    for (const lang of LANGS) {
      const residue = Object.keys(DICTS[lang] ?? {}).filter(k =>
        k.startsWith("settings.hermes.") || k.startsWith("setup.hermes.") || k.startsWith("org.executionModeHermes"));
      expect(residue, `${lang} hermes 键残留: ${residue.join(",")}`).toEqual([]);
    }
  });

  it("AddAgentModal 改用 org.executionModeApi*(hermes 读侧兼容条目也指向 Api 键)", () => {
    expect(ADD_MODAL).not.toContain("org.executionModeHermes");
    expect(ADD_MODAL).toContain('"org.executionModeApiLabel"');
    expect(ADD_MODAL).toContain('"org.executionModeApiBlurb"');
  });
});

describe("E2 · 新增键 11 语言齐全", () => {
  it("28 个新增/补齐键各语言非空", () => {
    for (const lang of LANGS) {
      for (const k of NEW_KEYS) {
        expect(DICTS[lang]?.[k], `${lang} 缺 ${k}`).toBeTruthy();
      }
    }
  });

  it("带参数的键在各语言保留占位符", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]["agent.exec.legacyRetired"], `${lang} legacyRetired`).toContain("{fw}");
      expect(DICTS[lang]["agent.exec.providerHintOther"], `${lang} providerHintOther`).toContain("{fw}");
      for (const ph of ["{engine}", "{aliases}", "{provider}"]) {
        expect(DICTS[lang]["agent.model.cliCatalogHint"], `${lang} cliCatalogHint 缺 ${ph}`).toContain(ph);
      }
    }
  });
});

describe("E2 · 术语统一(值层)", () => {
  it("ic.trust.untrusted 显示值改为「未知来源/Unknown source」(键与后端枚举不动)", () => {
    expect(DICTS["en"]["ic.trust.untrusted"]).toBe("Unknown source");
    expect(DICTS["zh-CN"]["ic.trust.untrusted"]).toBe("未知来源");
  });

  it("zh 口径:公司/经验/员工/任务(抽查代表键)", () => {
    expect(DICTS["zh-CN"]["org.addAgent"]).toBe("添加员工");
    expect(DICTS["zh-CN"]["memory.title"]).toBe("经验");
    expect(DICTS["zh-CN"]["c.installToOrg"]).toBe("安装到公司");
    expect(DICTS["zh-CN"]["org.memberCount"]).toContain("员工");
    expect(DICTS["zh-CN"]["cost.budget.perRunLimit"]).toContain("单次运行 Token 上限");
  });
});
