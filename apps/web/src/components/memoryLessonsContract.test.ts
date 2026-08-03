import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #12/#30 回归约束(员工详情记忆面板):
// #12 — revoke 在服务端是终态(同内容重建 409),必须先过 confirmDialog(danger),且 revoke/bind-agent
//       失败不许静默吞错,必须 pushToast("error")——与 MemoryPage.handleRevoke/handleApplyToAgent 同款。
// #30 — 教训卡元信息(注入次数/无效次数/来源 run)必须走词典,不许硬编码中文。
// 组件无 DOM 测试基建(纯 node vitest),以源码契约锁住不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const SRC = read("MemoryLessons.tsx");
const DICTS = JSON.parse(read("../i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

describe("#12 · revoke 前确认弹窗 + 失败可见", () => {
  it("revoke 先走 confirmDialog(danger: true),确认后才打 /revoke 端点", () => {
    expect(SRC).toMatch(/import \{ confirmDialog \} from "\.\/common\/ConfirmDialog\.js"/);
    const confirmAt = SRC.indexOf('tr("memory.lessons.revokeConfirmTitle")');
    const revokeAt = SRC.indexOf("/revoke`");
    expect(confirmAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(-1);
    expect(confirmAt, "confirmDialog 必须在 revoke 请求之前").toBeLessThan(revokeAt);
    expect(SRC).toMatch(/danger:\s*true/);
    expect(SRC).toMatch(/if \(!ok\) return;/);
  });

  it("revoke/bind-agent 不再 .catch(() => {}) 吞错,失败 pushToast(\"error\"),成功有 success toast", () => {
    expect(SRC).not.toMatch(/\/revoke`,\s*\{\}\)\.catch/);
    expect(SRC).not.toMatch(/bind-agent`,[^\n]*\)\.catch/);
    expect(SRC).toMatch(/import \{ pushToast \} from "\.\/common\/Toast\.js"/);
    expect(SRC).toContain('pushToast("error", tr("memory.lessons.revokeFailed")');
    expect(SRC).toContain('pushToast("error", tr("memory.lessons.applyFailed")');
    expect(SRC).toContain('pushToast("success", tr("memory.lessons.revokeSuccess"))');
    expect(SRC).toContain('pushToast("success", tr("memory.lessons.applySuccess"))');
  });
});

describe("#30 · 教训卡元信息走词典", () => {
  it("硬编码中文已清除", () => {
    for (const s of ["注入 ", "无效 ", "来源 run"]) {
      expect(SRC, `MemoryLessons.tsx 残留硬编码文案: ${s}`).not.toContain(s);
    }
  });

  it("使用 memory.lessons.injected / ineffective / sourceRun 三键", () => {
    expect(SRC).toMatch(/tr\("memory\.lessons\.injected",\s*\{\s*n:/);
    expect(SRC).toMatch(/tr\("memory\.lessons\.ineffective",\s*\{\s*n:/);
    expect(SRC).toMatch(/tr\("memory\.lessons\.sourceRun",\s*\{\s*id:/);
  });
});

describe("i18n · #12/#30 相关键 11 语言全覆盖", () => {
  const KEYS = [
    "memory.lessons.injected", "memory.lessons.ineffective", "memory.lessons.sourceRun",
    "memory.lessons.revokeConfirmTitle", "memory.lessons.revokeConfirmBody", "memory.lessons.revoke",
    "memory.lessons.revokeSuccess", "memory.lessons.revokeFailed",
    "memory.lessons.applySuccess", "memory.lessons.applyFailed",
  ];

  it("各语言均有非空文案(applySuccess/applyFailed 此前只有 en/zh-CN,已逐语补齐)", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("带参数的键在各语言保留占位符", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]["memory.lessons.injected"], `${lang} injected`).toContain("{n}");
      expect(DICTS[lang]["memory.lessons.ineffective"], `${lang} ineffective`).toContain("{n}");
      expect(DICTS[lang]["memory.lessons.sourceRun"], `${lang} sourceRun`).toContain("{id}");
    }
  });
});
