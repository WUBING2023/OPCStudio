import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CEO 记忆引用溯源 · 项目群消息卡引用条(web)。组件无 DOM 测试基建(纯 node vitest),沿用
// memoryLessonsContract.test.ts 的源码契约做法锁住渲染不变量;引用条数据的纯函数逻辑另在
// lib/cockpitGroups.test.ts 的 readCitedMemories 用真实断言覆盖。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const CHAT = read("ChatThread.tsx");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];
const KEYS = ["cockpit.citedMemories.label", "cockpit.citedMemories.viewHint"];

describe("ChatThread · 引用条从 committed 事件 payload 渲染,不硬编码文案", () => {
  it("从 cockpitGroups.readCitedMemories 读 payload.citedMemories(纯读取,不旁路数据源)", () => {
    expect(CHAT).toMatch(/import \{[^}]*\breadCitedMemories\b[^}]*\} from "\.\.\/\.\.\/lib\/cockpitGroups\.js"/);
    expect(CHAT).toContain("readCitedMemories(p)");
  });

  it("引用条标签/提示走 i18n(tr 引用两键),不硬编码为 JSX 文案", () => {
    for (const k of KEYS) expect(CHAT, `ChatThread 未使用键 ${k}`).toContain(`tr("${k}")`);
    // 标签/提示只经 tr() 渲染,不以 JSX 文本节点硬编码(注释里的中文不算)
    expect(CHAT).not.toMatch(/>\s*在经验库中查看\s*</);
  });

  it("点击引用 chip → opc-navigate 跳经验(记忆)页(复用既有跨页契约)", () => {
    expect(CHAT).toMatch(/new CustomEvent\("opc-navigate",\s*\{\s*detail:\s*\{\s*page:\s*"memory"/);
  });

  it("带 citedMemories 时正文只显示首行摘要,避免与追加的依据经验兜底行重复", () => {
    expect(CHAT).toContain('message.split("\\n")[0]');
    expect(CHAT).toContain("CitedMemoriesBar");
  });
});

describe("i18n · 引用条两键 11 语言全覆盖非空", () => {
  it("cockpit.citedMemories.label / viewHint 各语言存在且非空", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });
});
