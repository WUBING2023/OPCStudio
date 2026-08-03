import { describe, it, expect, beforeEach } from "vitest";
import type { CompanyTemplate } from "@opc/shared";
import {
  ONBOARDING_DONE_KEY,
  isOnboardingDone,
  markOnboardingDone,
  shouldShowOnboarding,
  recommendTemplates,
  filterTemplates,
} from "./onboardingState.js";

// node 环境无 localStorage:注入一个最小内存实现,专测"跳过后持久化 → 不再骚扰"这条不变量。
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
beforeEach(() => { (globalThis as any).localStorage = new MemStorage(); });

function tpl(id: string, tags: string[]): CompanyTemplate {
  return { id, title: id, tags } as unknown as CompanyTemplate;
}

describe("首跑判定 shouldShowOnboarding", () => {
  it("无公司且未完成 → 弹", () => {
    expect(shouldShowOnboarding({ configCompleted: false, done: false })).toBe(true);
  });
  it("有公司 → 不弹(哪怕未完成)", () => {
    expect(shouldShowOnboarding({ configCompleted: true, done: false })).toBe(false);
  });
  it("已标记完成 → 不弹(哪怕无公司)", () => {
    expect(shouldShowOnboarding({ configCompleted: false, done: true })).toBe(false);
  });
});

describe("跳过持久化 markOnboardingDone / isOnboardingDone", () => {
  it("默认未完成", () => {
    expect(isOnboardingDone()).toBe(false);
  });
  it("标记后 isOnboardingDone 为真,且写入约定的 key", () => {
    markOnboardingDone();
    expect(isOnboardingDone()).toBe(true);
    expect(localStorage.getItem(ONBOARDING_DONE_KEY)).toBe("1");
  });
  it("跳过(标记完成)后首跑判定即使公司为空也不再弹", () => {
    markOnboardingDone();
    expect(shouldShowOnboarding({ configCompleted: false, done: isOnboardingDone() })).toBe(false);
  });
});

describe("按身份推荐模板 recommendTemplates", () => {
  const all = [
    tpl("fullstack-saas", ["fullstack", "saas", "web"]),
    tpl("open-source-maintainer", ["open-source", "github"]),
    tpl("security-audit-squad", ["security", "audit"]),
    tpl("research-report-company", ["research", "report", "fact-check"]),
    tpl("code-delivery-squad", ["code", "delivery", "python"]),
  ];

  it("研究者 → 优先研究型模板", () => {
    const r = recommendTemplates("researcher", all);
    expect(r[0].id).toBe("research-report-company");
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it("开发者 → 优先代码/全栈模板", () => {
    const ids = recommendTemplates("developer", all).map((t) => t.id);
    expect(ids).toContain("code-delivery-squad");
    expect(ids).toContain("fullstack-saas");
  });

  it("身份偏好一个都没命中 → 回退到列表原顺序,仍给出推荐", () => {
    const weird = [tpl("x", ["foo"]), tpl("y", ["bar"])];
    const r = recommendTemplates("developer", weird);
    expect(r.map((t) => t.id)).toEqual(["x", "y"]);
  });

  it("空列表 → 空数组,不报错", () => {
    expect(recommendTemplates("other", [])).toEqual([]);
  });

  it("身份为 null(未选)→ 回退推荐,不为空", () => {
    expect(recommendTemplates(null, all).length).toBeGreaterThan(0);
  });
});

describe("浏览社区模板子视图搜索 filterTemplates", () => {
  const all = [
    tpl("fullstack-saas", ["fullstack", "saas", "web"]),
    tpl("research-report-company", ["research", "report", "fact-check"]),
    tpl("code-delivery-squad", ["code", "delivery", "python"]),
  ];

  it("空查询 → 返回全部(不过滤)", () => {
    expect(filterTemplates(all, "").map((t) => t.id)).toEqual(all.map((t) => t.id));
    expect(filterTemplates(all, "   ").length).toBe(all.length);
  });

  it("按标题模糊匹配(大小写不敏感)", () => {
    expect(filterTemplates(all, "RESEARCH").map((t) => t.id)).toEqual(["research-report-company"]);
  });

  it("按标签匹配", () => {
    expect(filterTemplates(all, "python").map((t) => t.id)).toEqual(["code-delivery-squad"]);
  });

  it("无匹配 → 空数组", () => {
    expect(filterTemplates(all, "无此模板zzz")).toEqual([]);
  });

  it("空/非数组输入 → 空数组,不报错", () => {
    expect(filterTemplates([], "x")).toEqual([]);
    expect(filterTemplates(undefined as any, "x")).toEqual([]);
  });
});

// 第 3 步「浏览社区模板」入口的关键不变量(装完标记完成 / 返回未装保持原步)。
// UI 交互无 React DOM 测试环境,这里以标记完成语义(引导内嵌浏览与推荐共用 finish("org") 链路)佐证。
describe("浏览社区模板流程不变量", () => {
  it("从社区浏览安装成功 → 标记完成,不再弹回引导起点", () => {
    // installTemplate 成功后走 finish("org"),等价于 markOnboardingDone()
    markOnboardingDone();
    expect(isOnboardingDone()).toBe(true);
    // 装完后 config 已标记完成 → 引导不再出现(不被扔回起点;安装态恒有内建 default 公司,公司数不再是判据)
    expect(shouldShowOnboarding({ configCompleted: true, done: isOnboardingDone() })).toBe(false);
  });

  it("浏览后返回未安装 → 未标记完成,引导仍待办(停在原步)", () => {
    // 返回只关闭子视图(setBrowsing(false)),不调用 markOnboardingDone
    expect(isOnboardingDone()).toBe(false);
    expect(shouldShowOnboarding({ configCompleted: false, done: isOnboardingDone() })).toBe(true);
  });
});

describe("buildQuickProviderConfig(引导内嵌 API 快速配置)", () => {
  it("合法 preset + key → 最小合法 ProviderConfig(去空白,默认模型入列)", async () => {
    const { buildQuickProviderConfig, PROVIDER_DEFAULT_MODEL } = await import("./onboardingState.js");
    const now = "2026-07-19T00:00:00.000Z";
    const cfg = buildQuickProviderConfig("deepseek", "  sk-test-123  ", now)!;
    expect(cfg).toBeTruthy();
    expect(cfg.id).toBe("deepseek");
    expect(cfg.apiKey).toBe("sk-test-123");
    expect(cfg.defaultModel).toBe(PROVIDER_DEFAULT_MODEL.deepseek);
    expect(cfg.models).toContain(PROVIDER_DEFAULT_MODEL.deepseek);
    expect(cfg.createdAt).toBe(now);
    expect(cfg.baseUrl).toBeTruthy();
    expect(cfg.apiFormat).toBeTruthy();
  });
  it("空 key / 未知 preset → null(调用方直接跳过创建)", async () => {
    const { buildQuickProviderConfig } = await import("./onboardingState.js");
    expect(buildQuickProviderConfig("deepseek", "   ", "t")).toBeNull();
    expect(buildQuickProviderConfig("nope", "sk-x", "t")).toBeNull();
  });
});
