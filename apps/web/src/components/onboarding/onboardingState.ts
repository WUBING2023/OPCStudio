import type { CompanyTemplate, UserIdentity, ProviderConfig } from "@opc/shared";
import { PRESET_PROVIDERS, DEFAULT_PROVIDER_OPTIONS, DEFAULT_PROVIDER_PERMISSIONS } from "@opc/shared";

// 首跑引导的纯逻辑层(无 React、无 DOM),便于单测:①首跑判定 ②跳过持久化 ③按身份推荐模板。
// 定稿 2.3:首跑 = 无任何公司(companies 空)且未在 localStorage 标记完成;可随时跳过,跳过后不再骚扰。

export const ONBOARDING_DONE_KEY = "opc-onboarding-done";

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

// 完成或跳过都写这一个标记 —— 之后即便公司又被清空也不再自动弹(设置里"重看引导"仍可手动触发)。
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    /* localStorage 不可用(隐私模式等)时静默:大不了下次再判一次,不报错 */
  }
}

// 首跑判定(2026-07-19 修):旧口径"无任何公司才弹"在安装态永远不成立——server 无名册时兜底
// 内建 default 公司(11 agents),companyCount 恒 ≥1,两段式引导在安装包里一次都不会弹。
// 新真源 = server 侧 config.onboarding.completed(跨浏览器/重装一致)+ 本机 localStorage 跳过标记。
export function shouldShowOnboarding(opts: { configCompleted: boolean; done: boolean }): boolean {
  return !opts.done && !opts.configCompleted;
}

// 身份 → 推荐种子模板的偏好(id 优先,tag 兜底)。数据源是 /api/community/templates(种子公司模板),
// 这里只做纯排序/挑选,不请求网络。命中不足时回退到列表原顺序(popular 优先),至少给 1-2 个。
const IDENTITY_PREF: Record<UserIdentity, { ids: string[]; tags: string[] }> = {
  developer: { ids: ["code-delivery-squad", "fullstack-saas"], tags: ["code", "fullstack", "dev", "web"] },
  product: { ids: ["fullstack-saas", "code-delivery-squad"], tags: ["saas", "product", "fullstack"] },
  founder: { ids: ["fullstack-saas", "code-delivery-squad"], tags: ["saas", "fullstack", "prototype"] },
  researcher: { ids: ["research-report-company"], tags: ["research", "report", "fact-check"] },
  student: { ids: ["research-report-company", "code-delivery-squad"], tags: ["research", "code", "report"] },
  other: { ids: [], tags: [] },
};

// 引导内嵌「浏览社区模板」子视图的搜索过滤:按标题/标签模糊匹配(大小写不敏感)。空查询返回全部。
// 数据源与推荐同一份 /api/community/templates,这里只做纯过滤,不请求网络。
export function filterTemplates(templates: CompanyTemplate[], query: string): CompanyTemplate[] {
  if (!Array.isArray(templates)) return [];
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter((t) =>
    (t.title ?? "").toLowerCase().includes(q) ||
    (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
  );
}

// 引导第 2 步内嵌「API Key 快速配置」的数据与纯构造(自废弃的 OnboardingWizard 迁入,保持可单测):
// 只挑热门四家;buildQuickProviderConfig 把 preset+key 组装成最小合法 ProviderConfig。
// 用户定稿的两段式引导:第一段=身份+配置 API/订阅(在引导内完成,绝不把用户踢到配置页丢失引导),
// 第二段=新手教程(TutorialHints,由 config.onboarding.tutorial 接通)。
export const QUICK_PROVIDER_IDS = ["deepseek", "anthropic", "minimax", "openai"] as const;
export const QUICK_PROVIDERS = PRESET_PROVIDERS.filter((p) => (QUICK_PROVIDER_IDS as readonly string[]).includes(p.id));
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-v4-pro", anthropic: "claude-sonnet-5", minimax: "MiniMax-M3", openai: "gpt-5-mini",
};

export function buildQuickProviderConfig(presetId: string, apiKey: string, nowIso: string): ProviderConfig | null {
  const preset = QUICK_PROVIDERS.find((p) => p.id === presetId);
  const key = apiKey.trim();
  if (!preset || !key) return null;
  const model = PROVIDER_DEFAULT_MODEL[preset.id];
  return {
    id: preset.id, name: preset.name, website: preset.website,
    kind: preset.kind, apiFormat: preset.apiFormat, baseUrl: preset.baseUrl, apiKey: key,
    defaultModel: model, models: [model].filter(Boolean),
    headers: {}, env: {}, options: { ...DEFAULT_PROVIDER_OPTIONS }, permissions: { ...DEFAULT_PROVIDER_PERMISSIONS },
    createdAt: nowIso, updatedAt: nowIso,
  };
}

export function recommendTemplates(identity: UserIdentity | null, templates: CompanyTemplate[], limit = 2): CompanyTemplate[] {
  if (!Array.isArray(templates) || templates.length === 0) return [];
  const pref = (identity && IDENTITY_PREF[identity]) || IDENTITY_PREF.other;

  const seen = new Set<string>();
  const picked: CompanyTemplate[] = [];
  const push = (t?: CompanyTemplate) => {
    if (t && !seen.has(t.id)) { seen.add(t.id); picked.push(t); }
  };

  for (const id of pref.ids) push(templates.find((t) => t.id === id));
  for (const t of templates) {
    if (pref.tags.some((k) => (t.tags ?? []).some((tag) => tag.toLowerCase().includes(k)))) push(t);
  }
  // 偏好一个都没命中(自定义/未知模板集)→ 回退到列表原顺序,保证永远有推荐可展示。
  for (const t of templates) push(t);

  return picked.slice(0, limit);
}
