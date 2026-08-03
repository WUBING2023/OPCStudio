import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";
import {
  CompanyBundleSchema, parseCompanyBundle, migrateLegacyTemplate, bundleToTemplateShape, templateToBundle,
  migrateBundleViaRegistry, bundleMigrations,
  CURRENT_BUNDLE_SCHEMA_VERSION, BUNDLE_SCHEMA_VERSION_HISTORY, LEGACY_BUNDLE_VERSION, LEGACY_BUNDLE_SCHEMA_TAG,
  sanitizeExportProfile, DEFAULT_EXPORT_PROFILE, EXPORT_PROFILES,
  deriveOrgTeamsAndEdges,
  CompanyTemplateSchema,
} from "@opc/shared";
import { companyToBundle, companyToBundleTracked, resolveToolRequirements, mergeDefaultTasks } from "./companyTemplate.js";
import { runTemplateDoctor } from "./templateDoctor.js";
import { addConclusionSummary } from "../storage/registryStore.js";

// companyBundle.schema.ts 本体在 packages/shared/src(vitest include 只扫 apps/*/src),因此测试
// 放在这里(apps/server 依赖 @opc/shared workspace 包,和 templateDoctor.test.ts 里间接测
// CompanyTemplateSchema 的做法一致)。

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "prov-x",
    framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}

function legacyTpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-legacy", title: "旧模板", description: "d", author: "alice",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [
      agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }),
      agent({ id: "dev-0", parentId: "ceo-0" }),
    ],
    ...over,
  };
}

function validBundle(over: Record<string, unknown> = {}) {
  return {
    schema_version: "0.3.0",
    bundle_type: "company" as const,
    title: "测试 Bundle",
    description: "",
    agents: legacyTpl().agents,
    privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
    compatibility: { migration_notes: [] },
    ...over,
  };
}

describe("D2 · CompanyBundleSchema / parseCompanyBundle", () => {
  it("合法 bundle → ok:true", () => {
    const r = parseCompanyBundle(validBundle());
    expect(r.ok).toBe(true);
    expect(r.bundle?.title).toBe("测试 Bundle");
    expect(r.errors).toBeUndefined();
  });

  it("缺 schema_version → 拒绝", () => {
    const { schema_version: _omit, ...rest } = validBundle();
    const r = parseCompanyBundle(rest);
    expect(r.ok).toBe(false);
    expect(r.errors!.some(e => e.includes("schema_version"))).toBe(true);
  });

  it("bundle_type 非法值 → 拒绝", () => {
    const r = parseCompanyBundle(validBundle({ bundle_type: "team" }));
    expect(r.ok).toBe(false);
    expect(r.errors!.some(e => e.includes("bundle_type"))).toBe(true);
  });

  it("旧 CompanyTemplate(无 schema_version/privacy/compatibility)直接喂给 CompanyBundleSchema → 拒绝(这就是需要迁移层的原因)", () => {
    const r = parseCompanyBundle(legacyTpl());
    expect(r.ok).toBe(false);
  });

  // ── 分场景导出档位:export_profile / agentMemories 可选可加性字段(免 bump)──────────
  it("export_profile/agentMemories:合法值被接受;缺省(旧 bundle)照常合法(纯加性,免 bump)", () => {
    expect(parseCompanyBundle(validBundle()).ok).toBe(true); // 不带两字段=旧 bundle,照常合法
    const r = parseCompanyBundle(validBundle({
      export_profile: "full",
      agentMemories: [{ agent_id: "dev-0", role: "dev", content: "偏好:先测再写" }],
    }));
    expect(r.ok).toBe(true);
    expect(r.bundle?.export_profile).toBe("full");
    expect(r.bundle?.agentMemories).toHaveLength(1);
  });

  it("export_profile 非法值 → 整包拒绝(枚举校验,不静默吞)", () => {
    expect(parseCompanyBundle(validBundle({ export_profile: "hax0r" })).ok).toBe(false);
  });

  it("收口④:未知信封顶层键经 parse 后原样保留(.passthrough,闭合 bundle 层 lost=0)", () => {
    const r = parseCompanyBundle(validBundle({ futureBundleField: { nested: [1, 2] }, anotherNewKey: "v9" }));
    expect(r.ok).toBe(true);
    expect((r.bundle as Record<string, unknown>).futureBundleField).toEqual({ nested: [1, 2] });
    expect((r.bundle as Record<string, unknown>).anotherNewKey).toBe("v9");
  });

  it("sanitizeExportProfile:白名单校验,坏值回退缺省 share(不静默升级成 full)", () => {
    expect(EXPORT_PROFILES).toEqual(["full", "share"]);
    expect(DEFAULT_EXPORT_PROFILE).toBe("share");
    expect(sanitizeExportProfile("full")).toBe("full");
    expect(sanitizeExportProfile("share")).toBe("share");
    for (const bad of ["FULL", "hax0r", "", null, undefined, 42, {}]) {
      expect(sanitizeExportProfile(bad)).toBe("share");
    }
  });

  it("templateToBundle 透传 exportProfile/agentMemories(空数组不落字段)", () => {
    const withOpts = templateToBundle(legacyTpl(), {
      exportProfile: "full",
      agentMemories: [{ agent_id: "dev-0", content: "记忆" }],
    });
    expect(withOpts.export_profile).toBe("full");
    expect(withOpts.agentMemories).toHaveLength(1);
    const without = templateToBundle(legacyTpl(), { agentMemories: [] });
    expect(without.export_profile).toBeUndefined();
    expect(without.agentMemories).toBeUndefined();
  });

  it("CompanyBundleSchema.safeParse 直接调用行为一致", () => {
    expect(CompanyBundleSchema.safeParse(validBundle()).success).toBe(true);
    expect(CompanyBundleSchema.safeParse(validBundle({ schema_version: "" })).success).toBe(false);
  });
});

describe("D4+D5 · CompanyBundleSchema — memory.records / required_secrets 对象化", () => {
  it("memory 字段可选:缺省(不带 memory)仍合法(旧 bundle 兼容)", () => {
    expect(CompanyBundleSchema.safeParse(validBundle()).success).toBe(true);
  });

  it("合法的 memory.records 通过校验", () => {
    const bundle = validBundle({
      memory: {
        records: [{
          memory_id: "mem-cs-1", scope: "s", owner_type: "company", owner_id: "c1", content: "内容",
          source: { type: "run", run_id: "r1", task_id: "" }, level: "sop", score: 80, status: "active", tags: [],
          metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
          created_at: "2026-01-01", updated_at: "2026-01-01", last_used_at: "2026-01-01",
        }],
      },
    });
    const r = parseCompanyBundle(bundle);
    expect(r.ok).toBe(true);
    expect(r.bundle?.memory?.records).toHaveLength(1);
  });

  it("memory.records[].level 非法枚举值 → 拒绝", () => {
    const bundle = validBundle({
      memory: {
        records: [{
          memory_id: "mem-cs-1", scope: "s", owner_type: "company", owner_id: "c1", content: "内容",
          source: { type: "run", run_id: "r1", task_id: "" }, level: "not-a-level", score: 80, status: "active", tags: [],
          metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
          created_at: "2026-01-01", updated_at: "2026-01-01", last_used_at: "2026-01-01",
        }],
      },
    });
    expect(parseCompanyBundle(bundle).ok).toBe(false);
  });

  it("required_secrets 升级为对象数组(D4):{name, description, required_for} 通过;纯字符串数组(旧形状)被拒绝", () => {
    const withObjectSecret = validBundle({
      privacy: { redacted: true, redacted_fields: [], required_secrets: [{ name: "DEEPSEEK_API_KEY", description: "d", required_for: "api" }] },
    });
    expect(parseCompanyBundle(withObjectSecret).ok).toBe(true);

    const withStringSecret = validBundle({
      privacy: { redacted: true, redacted_fields: [], required_secrets: ["DEEPSEEK_API_KEY"] },
    });
    expect(parseCompanyBundle(withStringSecret).ok).toBe(false);
  });

  it("空 required_secrets 数组两种历史形状都兼容(migrateLegacyTemplate 产出的空数组照常合法)", () => {
    const { bundle } = migrateLegacyTemplate(legacyTpl());
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

describe("D2 · migrateLegacyTemplate — 旧模板迁移 round-trip(硬验收)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-migrate-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("补 schema_version/bundle_type/privacy/compatibility,映射 title/description/agents/author/version 等原字段", () => {
    const { bundle } = migrateLegacyTemplate(legacyTpl());
    expect(bundle.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION); // legacy 归一:产物落 canonical,不再是 "0.3.0-legacy"
    expect(bundle.bundle_type).toBe("company"); // 有 agents 数组 → company
    expect(bundle.privacy).toEqual({ redacted: true, redacted_fields: [], required_secrets: [] });
    expect(bundle.compatibility.migration_notes[0]).toContain("自动迁移自 legacy template");
    expect(bundle.bundle_id).toBe("t-legacy");
    expect(bundle.title).toBe("旧模板");
    expect(bundle.company?.name).toBe("alice");
    expect(bundle.agents).toHaveLength(2);
  });

  it("无 agents 数组的输入 → bundle_type 判定为 agent", () => {
    const { bundle } = migrateLegacyTemplate({ id: "x", title: "无agents" });
    expect(bundle.bundle_type).toBe("agent");
    expect(bundle.agents).toEqual([]);
  });

  it("迁移产出的 bundle 满足 CompanyBundleSchema", () => {
    const { bundle } = migrateLegacyTemplate(legacyTpl());
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });

  // 硬验收:旧模板导入必须照常成功——迁移壳只用于产出 CompanyBundle 审计视图,实际喂给既有
  // templateDoctor/CompanyTemplateSchema 管线的仍是 legacy 原始对象本身(它已经是 CompanyTemplateSchema
  // 认识的扁平形状;CompanyTemplate 早有一个同名但语义不同的 compatibility 字符串字段,与本 bundle
  // schema 的 compatibility 对象类型冲突,两者不能合并成同一个对象——这正是要分离两种表示的原因)。
  it("硬验收:legacy 原始对象本身直接喂给 templateDoctor 照常成功(不经过迁移壳)", () => {
    const legacy = legacyTpl();
    migrateLegacyTemplate(legacy); // 走一遍迁移探测(路由层同款用法),不影响下面的校验对象
    const report = runTemplateDoctor(legacy, { projectRoot: root });
    expect(report.checks.find(c => c.id === "schema_valid")?.status).toBe("pass");
    expect(report.install_allowed).toBe(true);
  });

  it("非对象输入(null/字符串)→ 不抛异常,退化成空壳 bundle", () => {
    expect(() => migrateLegacyTemplate(null)).not.toThrow();
    expect(() => migrateLegacyTemplate("garbage")).not.toThrow();
    const { bundle } = migrateLegacyTemplate(null);
    expect(bundle.title).toBe("未命名模板");
    expect(bundle.agents).toEqual([]);
  });
});

// ── 迁移注册表 + 金样本(兼容宪法的 CI 执法机构)──────────────────────────────

// 金样本文件冻结在 packages/shared/src/__fixtures__(和 companyBundle.schema.ts 同包共冻结);
// 用相对 import.meta.url 的路径读,和运行时的 cwd 无关(vitest 从仓库根跑也从子目录跑都稳)。
const GOLDEN_BUNDLE_URL = new URL(
  "../../../../packages/shared/src/__fixtures__/company-bundle-golden-v1.json",
  import.meta.url,
);
const goldenBundle = JSON.parse(fs.readFileSync(GOLDEN_BUNDLE_URL, "utf8"));

describe("金样本兼容承诺 · company-bundle-golden-v1.json(改坏即违宪)", () => {
  it("金样本兼容承诺,改坏即违宪:冻结的 canonical 当前版本 CompanyBundle 永远可被 parseCompanyBundle 接受", () => {
    const r = parseCompanyBundle(goldenBundle);
    // 这条红了 = 有人改 schema 把已发布的当前版本 bundle 改成不兼容;要么撤销改动,要么走迁移注册表 + 重新冻结金样本。
    expect(r.ok).toBe(true);
    expect(r.errors).toBeUndefined();
    expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(r.bundle?.bundle_type).toBe("company");
  });

  it("金样本的 schema_version 必须等于当前 canonical 版本(金样本落后于 schema = 该重新冻结一份 golden)", () => {
    expect(goldenBundle.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
  });
});

describe("守卫 · schema_version 演进必须配套注册表迁移条目(否则违宪)", () => {
  it("CURRENT_BUNDLE_SCHEMA_VERSION 必须是历史版本序列的最后一格(bump 版本却不登记历史 → 红)", () => {
    expect(BUNDLE_SCHEMA_VERSION_HISTORY.length).toBeGreaterThan(0);
    expect(BUNDLE_SCHEMA_VERSION_HISTORY[BUNDLE_SCHEMA_VERSION_HISTORY.length - 1]).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
  });

  it("legacy 兜底迁移永远在册(注册表第一格),否则社区已发布的旧模板全数无法导入", () => {
    expect(typeof bundleMigrations[LEGACY_BUNDLE_VERSION]).toBe("function");
  });

  it("历史序列每相邻两档之间,注册表必须有以「前一档」为 key 的迁移条目(bump schema_version 却漏加迁移 → 红)", () => {
    for (let i = 0; i < BUNDLE_SCHEMA_VERSION_HISTORY.length - 1; i++) {
      const from = BUNDLE_SCHEMA_VERSION_HISTORY[i];
      expect(typeof bundleMigrations[from]).toBe("function");
    }
  });
});

describe("migrateBundleViaRegistry · 查注册表逐级迁移(导入兜底)", () => {
  it("legacy 输入(无 schema_version)→ 逐级迁移成功,只走 legacy 那一格,产物 schema_version 归一到 canonical", () => {
    const r = migrateBundleViaRegistry(legacyTpl());
    expect(r.ok).toBe(true);
    expect(r.appliedMigrations).toEqual([LEGACY_BUNDLE_VERSION]);
    expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(r.bundle?.compatibility.migration_notes.some(n => n.includes("legacy"))).toBe(true);
    expect(r.bundle?.bundle_type).toBe("company");
    expect(r.bundle?.agents).toHaveLength(2);
  });

  it("已是原生当前版本 bundle → 无需迁移,appliedMigrations 为空,原样返回", () => {
    const r = migrateBundleViaRegistry(validBundle());
    expect(r.ok).toBe(true);
    expect(r.appliedMigrations).toEqual([]);
    expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
  });

  it("金样本走注册表也无需迁移(已是当前版本)", () => {
    const r = migrateBundleViaRegistry(goldenBundle);
    expect(r.ok).toBe(true);
    expect(r.appliedMigrations).toEqual([]);
  });

  it("与旧 migrateLegacyTemplate 兜底等价 —— 路由响应的 migratedFromLegacy 语义不变", () => {
    const legacy = legacyTpl();
    const viaRegistry = migrateBundleViaRegistry(legacy).bundle;
    const viaLegacy = migrateLegacyTemplate(legacy).bundle;
    expect(viaRegistry?.schema_version).toBe(viaLegacy.schema_version);
    expect(viaRegistry?.bundle_type).toBe(viaLegacy.bundle_type);
    expect(viaRegistry?.title).toBe(viaLegacy.title);
    expect(viaRegistry?.agents).toHaveLength(viaLegacy.agents.length);
  });
});

describe("schema_version 严格化 + legacy 归一(数据兼容宪法)", () => {
  it("schema 只接受 canonical 已知版本:未知版本 / 历史 '0.3.0-legacy' 标签都被 CompanyBundleSchema 拒绝", () => {
    // 历史包袱标签不再是合法产物版本(否则 migrateBundleViaRegistry 会把它原样放行,标签就漏进产物)。
    expect(CompanyBundleSchema.safeParse(validBundle({ schema_version: LEGACY_BUNDLE_SCHEMA_TAG })).success).toBe(false);
    // 来自更新版本的信封:结构可能全对,但版本号不认识 → 严格拒绝,不再"非空串即放行"。
    expect(CompanyBundleSchema.safeParse(validBundle({ schema_version: "0.9.0" })).success).toBe(false);
    // canonical 当前版本照常通过。
    expect(CompanyBundleSchema.safeParse(validBundle({ schema_version: CURRENT_BUNDLE_SCHEMA_VERSION })).success).toBe(true);
    // 受支持集合恒等于历史序列。
    expect(BUNDLE_SCHEMA_VERSION_HISTORY.includes(CURRENT_BUNDLE_SCHEMA_VERSION)).toBe(true);
  });

  it("未知版本经注册表兜底 → 查无此版 → 人话拒绝(点名版本号 + 提示可能来自更新版本)", () => {
    const r = migrateBundleViaRegistry(validBundle({ schema_version: "0.9.0" }));
    expect(r.ok).toBe(false);
    expect(r.bundle).toBeUndefined();
    const msg = (r.errors ?? []).join(" ");
    expect(msg).toContain("0.9.0");
    expect(msg).toContain("不认识");
    expect(msg).toContain("更新版本");
  });

  it("版本是 canonical 已知、只是结构坏(缺 title)→ 回结构错误,而非'未知版本'人话", () => {
    const broken = validBundle();
    delete (broken as Record<string, unknown>).title;
    const r = migrateBundleViaRegistry(broken);
    expect(r.ok).toBe(false);
    const msg = (r.errors ?? []).join(" ");
    expect(msg).toContain("title");
    expect(msg).not.toContain("不认识");
  });

  it("历史 '0.3.0-legacy' 标签的 bundle → 注册表归一到 canonical,迁移痕迹保留,标签不入产物", () => {
    const tagged = validBundle({
      schema_version: LEGACY_BUNDLE_SCHEMA_TAG,
      compatibility: { migration_notes: ["自动迁移自 legacy template(无 schema_version)"] },
    });
    // 严格化后标签本身不再被 schema 接受,必须经注册表归一。
    expect(CompanyBundleSchema.safeParse(tagged).success).toBe(false);
    const r = migrateBundleViaRegistry(tagged);
    expect(r.ok).toBe(true);
    expect(r.appliedMigrations).toEqual([LEGACY_BUNDLE_SCHEMA_TAG]);
    expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(r.bundle?.schema_version).not.toBe(LEGACY_BUNDLE_SCHEMA_TAG);
    expect(r.bundle?.compatibility.migration_notes.some(n => n.includes("legacy"))).toBe(true);
  });

  it("legacy 输入 → 产物 schema_version===canonical 且 migration_notes 含'自动迁移自 legacy'记录", () => {
    const r = migrateBundleViaRegistry(legacyTpl());
    expect(r.ok).toBe(true);
    expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(r.bundle?.compatibility.migration_notes[0]).toContain("自动迁移自 legacy");
  });
});

describe("D2 · bundleToTemplateShape — 原生 bundle 桥接回 CompanyTemplate 扁平形状", () => {
  it("映射 title/description/agents,id 由 bundle_id 或 title 生成安全 slug", () => {
    const bundle = validBundle({ bundle_id: "My Cool Bundle!!", metadata: { license: "MIT", tags: ["a"] } });
    const parsed = parseCompanyBundle(bundle);
    expect(parsed.ok).toBe(true);
    const shape = bundleToTemplateShape(parsed.bundle!);
    expect(shape.id).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
    expect(shape.title).toBe("测试 Bundle");
    expect(shape.agents).toHaveLength(2);
    expect(shape.license).toBe("MIT");
    expect(shape.tags).toEqual(["a"]);
  });

  it("无 bundle_id → 用 title slugify 兜底", () => {
    const bundle = validBundle({ title: "中文标题 Test" });
    const shape = bundleToTemplateShape(parseCompanyBundle(bundle).bundle!);
    expect(typeof shape.id).toBe("string");
    expect((shape.id as string).length).toBeGreaterThan(0);
    expect(shape.id).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
  });
});

describe("D2 · companyToBundle — 导出侧包装(companyToTemplate 产物 + bundle 外壳)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "company-to-bundle-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "导出测试公司", description: "desc", ceoId: "ceo-0", createdAt: "2026-01-01" },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-0", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
    ]));
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("产出通过 CompanyBundleSchema 校验的合法 bundle", () => {
    const bundle = companyToBundle(root, "c1");
    expect(bundle.schema_version).toBe("0.3.0");
    expect(bundle.bundle_type).toBe("company");
    expect(bundle.title).toBe("导出测试公司");
    expect(bundle.agents).toHaveLength(1);
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("活公司旧数据中的 null 可选字段不会污染导出 bundle", () => {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      {
        id: "c1", name: "导出测试公司", description: "desc", ceoId: "ceo-0", createdAt: "2026-01-01",
        visibilityPolicy: null, mcpRequirements: null, a2aChannels: null, defaultTasks: null,
      },
    ]));
    const bundle = companyToBundle(root, "c1") as Record<string, unknown>;
    expect(bundle).not.toHaveProperty("visibilityPolicy");
    expect(bundle).not.toHaveProperty("mcpRequirements");
    expect(bundle).not.toHaveProperty("a2aChannels");
    expect(bundle).not.toHaveProperty("defaultTasks");
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("D4+D5:memory.records 从 registryStore 映射填充;required_secrets 从 agents 的 provider 依赖推导", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["c1 的经验"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = companyToBundle(root, "c1");
    expect(bundle.memory?.records).toHaveLength(1);
    expect(bundle.memory?.records[0].content).toBe("c1 的经验");
    expect(bundle.memory?.records[0].level).toBe("verified"); // 默认(未开审核)自动生效 → approved → verified
    expect(bundle.privacy.required_secrets).toEqual([
      { name: "DEEPSEEK_API_KEY", description: expect.stringContaining("deepseek"), required_for: "api" },
    ]);
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("D4:memory 内容命中密钥形态 → 脱敏值并计入 privacy.redacted_fields", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["密钥 sk-abcdefgh12345678 别泄漏"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = companyToBundle(root, "c1");
    expect(bundle.privacy.redacted_fields).toEqual(["memory.records[0]"]);
    expect(bundle.memory?.records[0].content).not.toContain("sk-abcdefgh12345678");
  });

  it("D5:公司关闭「导出时一并带上记忆」(memoryExportEnabled:false)→ memory.records 恒为空,即便 registryStore 有数据", () => {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "导出测试公司", description: "desc", ceoId: "ceo-0", createdAt: "2026-01-01", memoryExportEnabled: false },
    ]));
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["不该被导出的经验"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = companyToBundle(root, "c1");
    expect(bundle.memory?.records).toEqual([]);
  });

  it("companyToBundleTracked:job 落 queued→...→completed,result 携带记录数统计", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["经验一"], createdAt: "2026-01-02T00:00:00Z" });
    const { bundle, job } = companyToBundleTracked(root, "c1");
    expect(bundle.memory?.records).toHaveLength(1);
    expect(job.kind).toBe("export");
    expect(job.status).toBe("completed");
    expect(job.result?.recordCount).toBe(1);
  });

  // C2 · 活公司导出的 bundle 带 org 派生投影 + recommendedConfig(运行配置快照)。
  it("C2:companyToBundle 真填 org.teams/edges(派生投影)与 recommendedConfig(loadConfig 快照)", () => {
    const bundle = companyToBundle(root, "c1");
    expect(bundle.org?.teams).toEqual([]); // 单 CEO、无 lead → 无队(字段真填,空数组≠缺省)
    expect(bundle.org?.edges).toEqual([]); // 无 parentId 汇报边/预置通道/验证边
    // root 无 config.json → loadConfig 回退默认值,快照的是真实运行缺省配置。
    expect(bundle.recommendedConfig).toEqual({
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 0, maxTokensPerTask: 200_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true },
    });
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

// ── P0 Part B · full 导出/导入保真(visibilityPolicy / toolRequirements / defaultTasks / 单次构建)──
describe("P0-B · full 保真字段(visibilityPolicy/toolRequirements/defaultTasks)", () => {
  it("① CompanyBundleSchema 接受 visibilityPolicy;旧 bundle(无此字段)照常合法(免 bump);非法枚举被拒", () => {
    expect(parseCompanyBundle(validBundle()).ok).toBe(true); // 无 visibilityPolicy = 存量 bundle,照常合法
    const r = parseCompanyBundle(validBundle({ visibilityPolicy: "isolated" }));
    expect(r.ok).toBe(true);
    expect(r.bundle?.visibilityPolicy).toBe("isolated");
    expect(parseCompanyBundle(validBundle({ visibilityPolicy: "nonsense" })).ok).toBe(false); // 枚举校验,不静默吞
  });

  it("① templateToBundle 携带 visibilityPolicy;bundleToTemplateShape 桥回;无该字段则两侧都省略", () => {
    const bundle = templateToBundle(legacyTpl({ visibilityPolicy: "game" }));
    expect(bundle.visibilityPolicy).toBe("game");
    const shape = bundleToTemplateShape(parseCompanyBundle(bundle).bundle!) as Record<string, unknown>;
    expect(shape.visibilityPolicy).toBe("game");
    const plain = templateToBundle(legacyTpl());
    expect(plain.visibilityPolicy).toBeUndefined();
    expect((bundleToTemplateShape(parseCompanyBundle(plain).bundle!) as Record<string, unknown>).visibilityPolicy).toBeUndefined();
  });

  it("② resolveToolRequirements:stored 缺失→纯派生;stored 在→保留 skills/optionalTools/mcp,engines/providers 取并集", () => {
    const agents = legacyTpl().agents; // framework hermes, provider prov-x
    const derived = resolveToolRequirements(undefined, agents);
    expect(derived.requiredSkills).toEqual([]);
    expect(derived.requiredProviders).toEqual(["prov-x"]);
    const stored = {
      requiredEngines: ["claude-code"], requiredProviders: ["anthropic"],
      requiredMcpServers: ["filesystem"], requiredSkills: ["research"], optionalTools: ["browser"],
    };
    const merged = resolveToolRequirements(stored, agents);
    expect(merged.requiredMcpServers).toEqual(["filesystem"]); // 作者手写,不可从 agents 推导 → 原样保留
    expect(merged.requiredSkills).toEqual(["research"]);
    expect(merged.optionalTools).toEqual(["browser"]);
    expect(new Set(merged.requiredProviders)).toEqual(new Set(["anthropic", "prov-x"])); // 并集:新增员工 provider 也反映
    expect(merged.requiredEngines).toContain("claude-code");
  });

  it("③ mergeDefaultTasks:持久任务在前,按 goal 去重合并 run 采集", () => {
    const persisted = [{ title: "A", goal: "g1" }];
    const collected = [{ title: "B", goal: "g1" }, { title: "C", goal: "g2" }];
    expect(mergeDefaultTasks(persisted, collected)).toEqual([{ title: "A", goal: "g1" }, { title: "C", goal: "g2" }]);
    expect(mergeDefaultTasks([], collected)).toEqual(collected);
    expect(mergeDefaultTasks(persisted, [])).toEqual(persisted);
  });
});

// P0-B⑥ · 单次构建:companyToBundle 内部已持有完整 companyToTemplate 产物,一次性落全部可移植结构字段
// (不再由导出端点 companyToTemplate 二扫补挂)。
describe("P0-B⑥ · companyToBundle 单次构建携带全部结构字段", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "company-single-build-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      {
        id: "c1", name: "结构齐备公司", description: "desc", ceoId: "ceo-0", createdAt: "2026-01-01",
        visibilityPolicy: "isolated",
        manifestUseCases: ["场景A"], manifestRiskNotes: ["谨慎B"],
        manifestToolRequirements: { requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: ["fs"], requiredSkills: ["research"], optionalTools: ["browser"] },
        workflow: { verificationEdges: [{ producer: "ceo", verifier: "dev", method: "llm-review", onReject: "redo" }] },
        manifestMcpRequirements: [{ name: "fs", purpose: "读写" }],
        presetChannels: [{ from: "ceo-0", to: "dev-0", purpose: "同步" }],
        defaultTasks: [{ title: "示例", goal: "写调研报告", suggestedRole: "dev" }],
      },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-0", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: ["dev-0"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
      { id: "dev-0", name: "Dev", role: "dev", companyId: "c1", parentId: "ceo-0", framework: "hermes", provider: "deepseek", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
    ]));
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("companyToBundle 直接携带 visibilityPolicy/toolRequirements/workflow/mcpRequirements/a2aChannels/defaultTasks/useCases/riskNotes(无需二次 companyToTemplate)", () => {
    const bundle = companyToBundle(root, "c1");
    expect(bundle.visibilityPolicy).toBe("isolated"); // ①
    expect(bundle.toolRequirements?.requiredSkills).toEqual(["research"]); // ② 作者手写保留
    expect(bundle.toolRequirements?.optionalTools).toEqual(["browser"]);
    expect(bundle.toolRequirements?.requiredMcpServers).toEqual(["fs"]);
    expect(bundle.workflow?.verificationEdges).toHaveLength(1);
    expect(bundle.mcpRequirements).toEqual([{ name: "fs", purpose: "读写" }]);
    expect(bundle.a2aChannels).toEqual([{ from: "ceo", to: "dev", purpose: "同步" }]);
    expect(bundle.defaultTasks).toEqual([{ title: "示例", goal: "写调研报告", suggestedRole: "dev" }]); // ③
    expect(bundle.useCases).toEqual(["场景A"]);
    expect(bundle.riskNotes).toEqual(["谨慎B"]);
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

// P0-3(canonical)· templateToBundle:把扁平 CompanyTemplate 包装成完整 Company Bundle,与
// bundleToTemplateShape 组成"扁平 ⇄ bundle"无损往返——库内模板导出路径(communityRoutes
// templates/:id/export)据此产出带 schema_version 的 canonical bundle,不再输出旧 flat 模板。
describe("P0-3 · templateToBundle ⇄ bundleToTemplateShape 结构字段无损往返", () => {
  const richTpl = (): CompanyTemplate => legacyTpl({
    id: "t-rich",
    workflow: { verificationEdges: [{ producer: "ceo-0", verifier: "dev-0", method: "llm-review", onReject: "redo" }] },
    a2aChannels: [{ from: "ceo", to: "dev", purpose: "同步" }],
    bundledSkills: [{ name: "onboarding", content: "正文", roles: ["dev"] }],
    mcpRequirements: [{ name: "fs", purpose: "读写" }],
    toolRequirements: { requiredEngines: ["hermes"], requiredProviders: ["prov-x"], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
    useCases: ["场景A"],
    riskNotes: ["谨慎B"],
    seedMemories: [{
      memory_id: "mem-cs-1", scope: "s", owner_type: "company", owner_id: "c", content: "经验",
      source: { type: "run", run_id: "r", task_id: "" }, level: "sop", score: 80, status: "active", tags: [],
      metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: "2026-01-01", updated_at: "2026-01-01", last_used_at: "2026-01-01",
    }],
    defaultTasks: [{ title: "示例任务", goal: "写一份调研报告", suggestedRole: "lead" }],
  });

  it("产出带 schema_version 的合法 bundle,携带全部结构字段 + seedMemories→memory", () => {
    const bundle = templateToBundle(richTpl());
    expect(bundle.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(bundle.bundle_type).toBe("company");
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.workflow?.verificationEdges).toHaveLength(1);
    expect(bundle.a2aChannels).toHaveLength(1);
    expect(bundle.bundledSkills).toHaveLength(1);
    expect(bundle.mcpRequirements).toHaveLength(1);
    expect(bundle.toolRequirements?.requiredEngines).toEqual(["hermes"]);
    expect(bundle.useCases).toEqual(["场景A"]);
    expect(bundle.memory?.records).toHaveLength(1);
    expect(bundle.defaultTasks).toEqual([{ title: "示例任务", goal: "写一份调研报告", suggestedRole: "lead" }]); // C3
  });

  it("往返:templateToBundle → parseCompanyBundle → bundleToTemplateShape 保留结构字段(不丢)", () => {
    const bundle = templateToBundle(richTpl());
    const parsed = parseCompanyBundle(bundle);
    expect(parsed.ok).toBe(true);
    const shape = bundleToTemplateShape(parsed.bundle!) as Record<string, any>;
    expect(shape.workflow?.verificationEdges).toHaveLength(1);
    expect(shape.a2aChannels).toHaveLength(1);
    expect(shape.bundledSkills).toHaveLength(1);
    expect(shape.mcpRequirements).toHaveLength(1);
    expect(shape.toolRequirements?.requiredEngines).toEqual(["hermes"]);
    expect(shape.useCases).toEqual(["场景A"]);
    expect(shape.riskNotes).toEqual(["谨慎B"]);
    expect(shape.seedMemories).toHaveLength(1);
    expect(shape.defaultTasks).toEqual([{ title: "示例任务", goal: "写一份调研报告", suggestedRole: "lead" }]); // C3 往返保真
  });

  // C2 · templateToBundle org 真填(teams/edges 派生投影)。
  it("C2:templateToBundle 的 org.teams/edges 真填且与 agents 派生一致(不再只填 agents)", () => {
    const bundle = templateToBundle(richTpl());
    expect(CompanyBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.org?.teams).toEqual([]); // richTpl 无 lead 角色 → 无队,但字段真填(空数组≠缺省)
    expect(bundle.org?.edges).toEqual([
      { from: "ceo-0", to: "dev-0", type: "org" },
      { from: "ceo", to: "dev", type: "a2a", purpose: "同步" },
      { from: "ceo-0", to: "dev-0", type: "verification", purpose: "llm-review" },
    ]);
  });
});

// ── C2 · org.teams/edges 真 schema + deriveOrgTeamsAndEdges 派生投影 ─────────────────
describe("C2 · CompanyBundleOrgSchema 收紧(unknown→typed,optional 免 bump)", () => {
  it("合法 teams/edges 通过;缺省(旧 bundle 不带)照常合法;空数组(金样本形状)照常合法", () => {
    expect(parseCompanyBundle(validBundle()).ok).toBe(true); // org 整体缺省
    expect(parseCompanyBundle(validBundle({ org: { agents: legacyTpl().agents } })).ok).toBe(true); // V0 只填 agents
    expect(parseCompanyBundle(validBundle({ org: { agents: [], teams: [], edges: [] } })).ok).toBe(true); // 金样本形状
    const r = parseCompanyBundle(validBundle({
      org: {
        agents: legacyTpl().agents,
        teams: [{ team_id: "team-lead-1", name: "研发队", lead_agent_id: "lead-1", member_agent_ids: ["dev-0"] }],
        edges: [{ from: "ceo-0", to: "dev-0", type: "org" }, { from: "a", to: "b", type: "a2a", purpose: "同步" }],
      },
    }));
    expect(r.ok).toBe(true);
    expect(r.bundle?.org?.teams).toHaveLength(1);
    expect(r.bundle?.org?.edges).toHaveLength(2);
  });

  it("形状怪的 teams/edges 被拒绝(不再是 z.unknown() 全放行)", () => {
    expect(parseCompanyBundle(validBundle({ org: { teams: [{ nonsense: true }] } })).ok).toBe(false); // 缺 team_id/lead_agent_id
    expect(parseCompanyBundle(validBundle({ org: { edges: [{ from: "a", to: "b", type: "teleport" }] } })).ok).toBe(false); // type 不在枚举
    expect(parseCompanyBundle(validBundle({ org: { edges: ["ceo->dev"] } })).ok).toBe(false); // 字符串边
  });
});

describe("C2 · deriveOrgTeamsAndEdges(纯函数派生投影)", () => {
  const node = (id: string, role: string, parentId?: string) => ({ id, name: `名-${id}`, role, parentId });

  it("多 lead 嵌套子树:每个 lead 一队,成员=parentId 子树全部后代(嵌套 lead 的后代双归属)", () => {
    const agents = [
      node("ceo", "ceo"),
      node("lead-a", "lead", "ceo"),
      node("dev-1", "dev", "lead-a"),
      node("lead-b", "lead", "lead-a"), // 嵌套 lead
      node("dev-2", "dev", "lead-b"),
    ];
    const { teams, edges } = deriveOrgTeamsAndEdges(agents);
    expect(teams).toHaveLength(2);
    const byLead = new Map(teams.map((t) => [t.lead_agent_id, t]));
    expect(byLead.get("lead-a")).toEqual({ team_id: "team-lead-a", name: "名-lead-a", lead_agent_id: "lead-a", member_agent_ids: ["dev-1", "lead-b", "dev-2"] });
    expect(byLead.get("lead-b")!.member_agent_ids).toEqual(["dev-2"]);
    expect(edges).toEqual([
      { from: "ceo", to: "lead-a", type: "org" },
      { from: "lead-a", to: "dev-1", type: "org" },
      { from: "lead-a", to: "lead-b", type: "org" },
      { from: "lead-b", to: "dev-2", type: "org" },
    ]);
  });

  it("孤儿节点(parentId 悬空)与自指 parentId:不出 org 边、不进任何队,不抛", () => {
    const agents = [node("ceo", "ceo"), node("orphan", "dev", "ghost"), { ...node("weird", "dev"), parentId: "weird" }];
    const { teams, edges } = deriveOrgTeamsAndEdges(agents);
    expect(teams).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("parentId 成环:visited 截断,不死循环(环本身由 doctor no_cycle_in_org 拦)", () => {
    const agents = [node("a", "lead", "b"), node("b", "dev", "a")];
    const { teams, edges } = deriveOrgTeamsAndEdges(agents);
    expect(teams).toEqual([{ team_id: "team-a", name: "名-a", lead_agent_id: "a", member_agent_ids: ["b"] }]);
    expect(edges).toEqual([
      { from: "b", to: "a", type: "org" },
      { from: "a", to: "b", type: "org" },
    ]);
  });

  it("a2aChannels/workflow.verificationEdges 映射成 a2a/verification 边(purpose 分别取 purpose/method)", () => {
    const { edges } = deriveOrgTeamsAndEdges(
      [node("x", "dev")],
      [{ from: "x", to: "y", purpose: "对齐" }, { from: "y", to: "x" }],
      { verificationEdges: [{ producer: "x", verifier: "y", method: "code-review" }] },
    );
    expect(edges).toEqual([
      { from: "x", to: "y", type: "a2a", purpose: "对齐" },
      { from: "y", to: "x", type: "a2a" },
      { from: "x", to: "y", type: "verification", purpose: "code-review" },
    ]);
  });

  it("确定性:同一输入两次派生产物逐字节一致(round-trip 可比对的前提)", () => {
    const agents = [node("ceo", "ceo"), node("lead-a", "lead", "ceo"), node("dev-1", "dev", "lead-a")];
    const once = deriveOrgTeamsAndEdges(agents, [{ from: "a", to: "b" }]);
    const twice = deriveOrgTeamsAndEdges(agents, [{ from: "a", to: "b" }]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

// P2(审计)· CompanyTemplateSchema 前向兼容:.passthrough() 保留未知顶层键(未来 Bundle 字段不被静默剥离)。
describe("CompanyTemplateSchema · 前向兼容 passthrough", () => {
  const minimal = {
    id: "wk-passthrough", title: "T", description: "d", author: "a",
    createdAt: "2026-01-01T00:00:00.000Z", tags: [], downloads: 0, stars: 0, readme: "r", agents: [],
  };
  it("未知顶层字段(未来 Bundle 字段)经 parse 后原样保留,不被 strip", () => {
    const withFuture = { ...minimal, futureBundleField: { nested: [1, 2], flag: true }, anotherNewKey: "v9" };
    const parsed = CompanyTemplateSchema.parse(withFuture) as Record<string, unknown>;
    expect(parsed.futureBundleField).toEqual({ nested: [1, 2], flag: true });
    expect(parsed.anotherNewKey).toBe("v9");
  });
  it("已声明字段仍按类型校验(passthrough 不放松已知字段:title 缺失/类型错仍拒)", () => {
    expect(CompanyTemplateSchema.safeParse({ ...minimal, title: "" }).success).toBe(false); // title min(1)
    expect(CompanyTemplateSchema.safeParse({ ...minimal, downloads: "x" }).success).toBe(false); // number
  });
});
