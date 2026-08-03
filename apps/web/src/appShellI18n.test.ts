import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #11/#13 回归约束:App.tsx(run 系统通知/SSE 断线横幅/侧栏折叠 tooltip/更新横幅)与 useTaskChat
// (派任务回执/错误回执)的用户可见文案必须走词典,不许硬编码中文。组件无 DOM 测试基建
// (纯 node vitest),沿用 briefingPanelCeoScope.test.ts 的源码契约做法锁住不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const APP = read("App.tsx");
const USE_TASK_CHAT = read("lib/useTaskChat.ts");
const DICTS = JSON.parse(read("i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

const APP_KEYS = [
  "notify.runFailed", "notify.runDone", "notify.runDeferred", "notify.clickToView",
  "app.connectionLost", "app.sidebar.expand", "app.sidebar.collapse",
  "app.update.available", "app.update.download", "app.update.dismiss",
];

describe("#11/#13 · App.tsx 用户可见文案全走 i18n", () => {
  it("原硬编码中文文案已清除(中文注释除外)", () => {
    for (const s of [
      "OPC 任务失败", "OPC 任务完成", "点击查看结果",
      "展开侧栏", "收起侧栏",
      "与服务器的实时连接已断开",
      "新版本 {",
    ]) {
      expect(APP, `App.tsx 残留硬编码文案: ${s}`).not.toContain(s);
    }
    // 更新横幅的 JSX 文本节点(独占一行)不许回归
    expect(APP).not.toMatch(/^\s*(下载最新版|忽略)\s*$/m);
  });

  it("十个新词典键全部被引用", () => {
    for (const k of APP_KEYS) {
      expect(APP, `App.tsx 未使用键 ${k}`).toContain(`"${k}"`);
    }
  });

  it("run 系统通知在 [] 依赖的 effect 里,必须用非 hook 的 t()(否则语言锁死在挂载时)", () => {
    expect(APP).toMatch(/\bt\("notify\.runFailed"\)/);
    expect(APP).toMatch(/\bt\("notify\.runDone"\)/);
    expect(APP).toMatch(/\bt\("notify\.runDeferred",\s*\{\s*n:/);
    expect(APP).toMatch(/\bt\("notify\.clickToView",\s*\{\s*id:/);
    expect(APP).toMatch(/import \{[^}]*\bt\b[^}]*\} from "\.\/i18n\.js"/);
  });
});

describe("#11 · useTaskChat 系统回执走 i18n", () => {
  it("派任务回执/错误回执不再硬编码中文(governance 注释里的「已派任务」除外)", () => {
    expect(USE_TASK_CHAT).not.toContain("已派任务 · Run");
    expect(USE_TASK_CHAT).not.toContain("错误: ");
    expect(USE_TASK_CHAT).not.toContain('"快速"');
  });

  it("回执用 org.brief.taskDispatched,模式标签复用 runType/quality 既有键,错误复用 cockpit.errorPrefix", () => {
    expect(USE_TASK_CHAT).toContain('tr("org.brief.taskDispatched"');
    expect(USE_TASK_CHAT).toContain('"org.brief.mission.runType.quick"');
    expect(USE_TASK_CHAT).toContain('"org.brief.mission.runType.team"');
    expect(USE_TASK_CHAT).toContain('"org.brief.instant.quality.economy"');
    expect(USE_TASK_CHAT).toContain('"org.brief.instant.quality.balanced"');
    expect(USE_TASK_CHAT).toContain('"org.brief.instant.quality.maxQuality"');
    expect(USE_TASK_CHAT).toContain('tr("cockpit.errorPrefix"');
  });
});

describe("i18n · #11/#13 新增键 11 语言全覆盖", () => {
  it("App 十键 + org.brief.taskDispatched 各语言非空", () => {
    for (const lang of LANGS) {
      for (const key of [...APP_KEYS, "org.brief.taskDispatched"]) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("useTaskChat 复用的既有键各语言非空(runType 两键此前只有 en/zh-CN,已逐语补齐)", () => {
    for (const lang of LANGS) {
      for (const key of [
        "cockpit.errorPrefix",
        "org.brief.mission.runType.quick", "org.brief.mission.runType.team",
        "org.brief.instant.quality.economy", "org.brief.instant.quality.balanced", "org.brief.instant.quality.maxQuality",
      ]) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("带参数的键在各语言保留占位符", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]["notify.runDeferred"], `${lang} notify.runDeferred`).toContain("{n}");
      expect(DICTS[lang]["notify.clickToView"], `${lang} notify.clickToView`).toContain("{id}");
      expect(DICTS[lang]["app.update.available"], `${lang} app.update.available`).toContain("{version}");
      for (const ph of ["{id}", "{mode}", "{message}"]) {
        expect(DICTS[lang]["org.brief.taskDispatched"], `${lang} org.brief.taskDispatched 缺 ${ph}`).toContain(ph);
      }
      expect(DICTS[lang]["org.brief.mission.runType.team"], `${lang} runType.team`).toContain("{teamMode}");
      expect(DICTS[lang]["cockpit.errorPrefix"], `${lang} cockpit.errorPrefix`).toContain("{msg}");
    }
  });
});
