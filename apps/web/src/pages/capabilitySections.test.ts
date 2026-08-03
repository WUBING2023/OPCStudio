import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_TABS } from "./CapabilityPage.js";

// 能力页板块分离(用户定稿"订阅就是订阅"):每个能力独立板块,「订阅」与「API 连接」平级且边界清楚。
// 组件无 DOM 测试基建 → 板块渲染逻辑用导出的 tab 表 + 源码契约(同 appShellI18n.test.ts 的 fs 做法)锁住。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");
const exists = (rel: string) => fs.existsSync(path.join(HERE, rel));

describe("CAPABILITY_TABS · 板块结构", () => {
  const keys = CAPABILITY_TABS.map(t => t.key);

  it("订阅与 API 是两个独立板块(都在,且键不同)", () => {
    expect(keys).toContain("subscription");
    expect(keys).toContain("api");
    expect("subscription").not.toBe("api");
  });

  it("订阅板块紧邻且先于 API(执行方式分组:订阅 / API)", () => {
    expect(keys.indexOf("subscription")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("subscription")).toBeLessThan(keys.indexOf("api"));
    expect(keys.indexOf("api")).toBe(keys.indexOf("subscription") + 1);
  });

  it("六个板块键唯一(总览 / 订阅 / API / MCP / 技能 / 成本),总览居首", () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["overview", "subscription", "api", "mcp", "skills", "cost"]);
    expect(keys[0]).toBe("overview");
  });

  it("每个板块有独立标题键;订阅用自己的 capability.subscription(不与 API 的 nav.api 混用)", () => {
    const byKey = Object.fromEntries(CAPABILITY_TABS.map(t => [t.key, t.labelKey]));
    expect(byKey.overview).toBe("capability.overview");
    expect(byKey.subscription).toBe("capability.subscription");
    expect(byKey.api).toBe("nav.api");
    expect(byKey.subscription).not.toBe(byKey.api);
    const labelKeys = CAPABILITY_TABS.map(t => t.labelKey);
    expect(new Set(labelKeys).size).toBe(labelKeys.length);
  });
});

describe("E4 · 能力总览(四能力一等呈现)", () => {
  const page = read("CapabilityPage.tsx");
  const overview = read("../components/capability/CapabilityOverview.tsx");
  const DICTS = JSON.parse(read("../i18n.dict.json")) as Record<string, Record<string, string>>;
  const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

  it("总览是默认 tab(无 pending tab 时落 overview)", () => {
    expect(page).toContain('?? "overview"');
  });

  it("四能力卡组件存在且被能力页懒加载", () => {
    expect(exists("../components/capability/CapabilityOverview.tsx")).toBe(true);
    expect(page).toContain("components/capability/CapabilityOverview.js");
  });

  it("ACP 卡复用 traceTypes 的 deriveRunExecutors/EXECUTOR_BADGE,不另起判定", () => {
    expect(overview).toContain("deriveRunExecutors");
    expect(overview).toContain("EXECUTOR_BADGE");
  });

  it("宪法:不可得数据用「待接入」占位键,绝不虚构(占位键被引用)", () => {
    expect(overview).toContain('"capability.card.pending"');
    expect(overview).toContain('"capability.card.pendingNote"');
  });

  it("记忆/模板卡经 opc-navigate 跳经验页/社区页", () => {
    expect(overview).toContain('"opc-navigate"');
    expect(overview).toContain('"memory"');
    expect(overview).toContain('"community"');
  });

  it("四能力卡新键 11 语言全覆盖且非空", () => {
    const KEYS = [
      "capability.overview", "capability.overview.intro",
      "capability.card.pending", "capability.card.pendingNote", "capability.card.sample",
      "capability.card.a2a.title", "capability.card.a2a.desc", "capability.card.a2a.msgs",
      "capability.card.a2a.runsWith", "capability.card.a2a.resolved",
      "capability.card.acp.title", "capability.card.acp.desc", "capability.card.acp.tracked", "capability.card.acp.empty",
      "capability.card.memory.title", "capability.card.memory.desc", "capability.card.memory.committed",
      "capability.card.memory.pending", "capability.card.memory.action",
      "capability.card.template.title", "capability.card.template.desc", "capability.card.template.local",
      "capability.card.template.companies", "capability.card.template.action",
    ];
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
      expect(DICTS[lang]["capability.card.sample"], `${lang} capability.card.sample 缺 {n}`).toContain("{n}");
    }
  });
});

describe("「API 连接」板块回归纯 API", () => {
  const src = read("ProviderSettingsPage.tsx");

  it("不再混排 CLI 订阅入口(CliFrameworkLogin 已从 API 页移除)", () => {
    expect(src).not.toContain("CliFrameworkLogin");
  });

  it("供应商多账号/key 管理照旧(仍用 ProviderAccountsManager)", () => {
    expect(src).toContain("ProviderAccountsManager");
  });

  it("旧的混排组件文件已删除(不留死代码入口)", () => {
    expect(exists("../components/CliFrameworkLogin.tsx")).toBe(false);
  });
});

describe("「订阅」板块契约(SubscriptionPage)", () => {
  const src = read("SubscriptionPage.tsx");
  const installJob = read("../lib/useSetupInstallJob.ts");
  const availabilityStore = read("../store/useFrameworkAvailabilityStore.ts");
  const accountsSrc = read("../components/CliApiKeyAccounts.tsx");

  it("品牌徽复用 SUBSCRIPTION_BRAND(不外链图,CSP 自包含)", () => {
    expect(src).toContain("SUBSCRIPTION_BRAND");
  });

  it("安装与登录状态走共享 availability store 的 /frameworks 探针", () => {
    expect(src).toContain("useFrameworkAvailabilityStore");
    expect(availabilityStore).toContain('"/frameworks"');
    expect(availabilityStore).toContain("lastCheckedAt");
  });

  it("未安装时一键安装:POST /setup/install + 轮询 /setup/install/status(员工面板同款)", () => {
    expect(src).toContain("useSetupInstallJob");
    expect(installJob).toContain('"/setup/install"');
    expect(installJob).toContain('"/setup/install/status"');
    expect(installJob).toContain("setInterval");

  });

  it("安装/登录文案复用既有 agent.install.* 键", () => {
    for (const k of ["agent.install.btn", "agent.install.running", "agent.install.failed"]) {
      expect(src, `SubscriptionPage 未复用 ${k}`).toContain(`"${k}"`);
    }
    expect(src).toContain('"subscription.updateDone"');
    expect(src).toContain('"api.accounts.loginLaunched"');
    expect(accountsSrc).toContain("encodeURIComponent(account.id)");
    expect(accountsSrc).toContain("encodeURIComponent(id)");
  });

  it("模型目录操作保持可用，但不再展示实现来源或静态兜底说明", () => {
    expect(src).toContain('refreshModelCatalog("subscription"');
    expect(src).toContain('subscription.refreshModels');
    expect(src).toContain('subscription.updateCli');
    expect(src).not.toContain('subscription.modelSource.acp');
    expect(src).not.toContain('subscription.modelSource.static');
  });

  it("多账号管理嵌入对应订阅卡片，不再单独铺第二层卡片", () => {
    expect(src).toContain("ProviderAccountsManager");
    expect(src).not.toContain('mt-6 grid grid-cols-1 lg:grid-cols-2');
  });

  it("显示五家订阅，并把 GLM Coding Plan 保持为 Claude Code ACP 后端", () => {
    for (const id of ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]) {
      expect(src).toContain(id);
    }
    expect(src).toContain('data-testid="glm-coding-plan-card"');
    expect(src).toContain('providerId="z-ai"');
    expect(src).toContain('cliBackend="glm-coding-plan"');
    expect(src).toContain('通过 Claude Code 运行');
    expect(src).toContain('https://open.bigmodel.cn/api/anthropic');
    expect(src).toContain('https://api.z.ai/api/anthropic');
    expect(src).not.toContain('fw: "glm-coding-plan"');
  });
});
