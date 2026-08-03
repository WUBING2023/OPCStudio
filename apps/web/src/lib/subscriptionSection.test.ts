import { describe, it, expect } from "vitest";
import type { EngineAvailability } from "@opc/shared";
import type { ModelCatalog } from "../api/client.js";
import {
  SUBSCRIPTIONS, SUB_LOGIN_CMD,
  subscriptionStatus, statusDotColor, catalogViewFor,
} from "./subscriptionSection.js";

// 能力页「订阅」板块渲染逻辑(纯逻辑代理式,仓库无 React DOM 测试环境):三态推导 / 状态点颜色 / 模型目录
// 来源。SubscriptionPage.tsx 的视图直接消费这些纯函数,故断言它们即锁住卡片渲染分支。

// v8 ChatGPT pass:状态点从写死 hex 改走语义令牌(亮暗主题自适应),契约随源同步
const GREEN = "var(--color-success)", AMBER = "var(--color-warning)", GRAY = "var(--color-ink-subtle)";
const av = (installed: boolean, loggedIn: boolean): EngineAvailability =>
  ({ framework: "claude-code", installed, loggedIn, version: "" }) as EngineAvailability;

describe("subscriptionStatus · 安装/登录三态(+ 探针未回=检测中)", () => {
  it("探针未回(undefined)→ detecting", () => {
    expect(subscriptionStatus(undefined)).toBe("detecting");
  });
  it("未安装 → not-installed(此分支出「一键安装」按钮)", () => {
    expect(subscriptionStatus(av(false, false))).toBe("not-installed");
  });
  it("已装未登录 → installed-not-logged-in(此分支出终端登录指引 + 登录按钮)", () => {
    expect(subscriptionStatus(av(true, false))).toBe("installed-not-logged-in");
  });
  it("已装已登录 → ready(此分支出就绪 + 登出)", () => {
    expect(subscriptionStatus(av(true, true))).toBe("ready");
  });
});

describe("statusDotColor · 与员工面板 dotColor 同款", () => {
  it("就绪=绿 / 已装未登录=琥珀 / 未装=灰 / 检测中=灰", () => {
    expect(statusDotColor(av(true, true))).toBe(GREEN);
    expect(statusDotColor(av(true, false))).toBe(AMBER);
    expect(statusDotColor(av(false, false))).toBe(GRAY);
    expect(statusDotColor(undefined)).toBe(GRAY);
  });
});

describe("五种订阅常量表", () => {
  it("正好五家原生订阅框架，各带展示名与终端登录命令", () => {
    expect(SUBSCRIPTIONS.map(s => s.fw)).toEqual(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
    for (const { fw } of SUBSCRIPTIONS) {
      expect(SUB_LOGIN_CMD[fw]).toBeTruthy();
    }
  });
});

describe("catalogViewFor · 模型目录来源(/model-catalog 单一事实源)", () => {
  const catalog: ModelCatalog = {
    subscriptions: [
      { engine: "claude-code", installed: true, source: "acp", models: [{ id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }] },
      { engine: "codex", installed: false, source: "static", models: [{ id: "gpt-5.5", label: "gpt-5.5" }] },
      { engine: "gemini", installed: true, source: "static", models: [{ id: "gemini-3-pro", label: "gemini-3-pro" }] },
      { engine: "kimi", installed: true, source: "acp", models: [{ id: "kimi-live", label: "kimi-live" }] },
      { engine: "grok", installed: false, source: "static", models: [{ id: "default", label: "default" }] },
    ],
    apiProviders: [],
  };

  it("目录未加载(null)→ null(卡片不出目录来源行)", () => {
    expect(catalogViewFor(null, "claude-code")).toBeNull();
  });

  it("claude-code:acp 活值 + 模型 id 列表", () => {
    expect(catalogViewFor(catalog, "claude-code")).toEqual({ installed: true, source: "acp", modelIds: ["sonnet", "opus"] });
  });

  it("gemini-cli 经 gemini engine 侦测(framework→engine 映射不是恒等)", () => {
    expect(catalogViewFor(catalog, "gemini-cli")).toEqual({ installed: true, source: "static", modelIds: ["gemini-3-pro"] });
  });

  it("Kimi/Grok 使用各自稳定 engine id", () => {
    expect(catalogViewFor(catalog, "kimi-cli")?.modelIds).toEqual(["kimi-live"]);
    expect(catalogViewFor(catalog, "grok-build")?.installed).toBe(false);
  });

  it("codex:static 兜底", () => {
    expect(catalogViewFor(catalog, "codex")?.source).toBe("static");
  });

  it("目录缺该订阅段 → null", () => {
    expect(catalogViewFor({ subscriptions: [], apiProviders: [] }, "codex")).toBeNull();
  });
});
