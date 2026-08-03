import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, Company, CompanyBundle, CompanyTemplate } from "@opc/shared";
import {
  CompanyTemplateSchema, AgentNodeConfigSchema,
  COMPANY_TEMPLATE_FIELD_REGISTRY, REGISTERED_TEMPLATE_FIELD_KEYS, companyFieldAttr,
  TEMPLATE_WORKSHOP_SKIP_KEYS, PORTABLE_DESIGN_FIELD_KEYS,
  COMPANY_LEVEL_MERGE_FIELDS, TOOL_REQUIREMENT_KEYS, listUnregisteredTemplateFields,
  AGENT_FIELD_REGISTRY, AGENT_LOCAL_PATH_FIELDS, AGENT_RUNTIME_RESET_FIELDS,
  AGENT_SHARE_STRIPPED_FIELDS, AGENT_WORKSHOP_SKIP_KEYS, AGENT_SENSITIVE_FIELDS,
  WORKSPACE_DIR_PLACEHOLDER, CLI_CONFIG_DIR_PLACEHOLDER,
} from "@opc/shared";
import { sanitizeBundleForExport } from "./memoryBundle.js";
import { rerootAgents } from "./install.js";
import { mergeCompanyLevelFields } from "./installMerge.js";

// ─────────────────────────────────────────────────────────────────────────────
// 收口④ · companyFieldRegistry 一致性守卫。
// 登记表是唯一真相源:①覆盖 CompanyTemplateSchema / AgentNodeConfigSchema 全部顶层字段(新增字段
// 忘记登记 → 本文件红);②消费方(installMerge / sanitizeBundleForExport / rerootAgents / 工坊 skip
// 集合)的字段清单与登记表逐键对齐;③sensitive 字段绝不以原始值出现在导出的 share/full bundle;
// ④未登记顶层字段进 merge 报告(不静默丢)。
// ─────────────────────────────────────────────────────────────────────────────

const sorted = (a: readonly string[]) => [...a].sort();

describe("收口④ · 登记表覆盖(schema ↔ registry 一一对应)", () => {
  it("CompanyTemplateSchema 全部顶层字段都已登记,且登记表无 schema 之外的幽灵字段", () => {
    const schemaKeys = Object.keys(CompanyTemplateSchema.shape);
    expect(sorted(REGISTERED_TEMPLATE_FIELD_KEYS)).toEqual(sorted(schemaKeys));
  });

  it("AgentNodeConfigSchema 全部字段都已在 agent 级登记表登记(一一对应)", () => {
    const schemaKeys = Object.keys(AgentNodeConfigSchema.shape);
    expect(sorted(AGENT_FIELD_REGISTRY.map((e) => e.key))).toEqual(sorted(schemaKeys));
  });

  it("登记表无重复 key;每条属性完备(category/editable/portable/sensitive/requiresLocalSetup/mergeStrategy)", () => {
    const keys = COMPANY_TEMPLATE_FIELD_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of COMPANY_TEMPLATE_FIELD_REGISTRY) {
      expect(typeof e.editable, e.key).toBe("boolean");
      expect(typeof e.portable, e.key).toBe("boolean");
      expect(typeof e.sensitive, e.key).toBe("boolean");
      expect(typeof e.requiresLocalSetup, e.key).toBe("boolean");
      expect(["union", "target-preferred", "requires-review", "keep-target", "non-portable"]).toContain(e.mergeStrategy);
      expect(["org", "execution", "collab", "governance", "memory", "workspace"]).toContain(e.category);
    }
  });
});

describe("收口④ · 工坊 skip 集合来自登记表,且与收敛前的清单逐键一致(防属性误改静默漂移)", () => {
  it("TEMPLATE_WORKSHOP_SKIP_KEYS == 收敛前 TEMPLATE_PASSTHROUGH_SKIP 的 26 键(其余顶层字段仍走 passthrough)", () => {
    expect(sorted(TEMPLATE_WORKSHOP_SKIP_KEYS)).toEqual(sorted([
      "id", "title", "description", "tags", "useCases", "riskNotes", "readme",
      "agents", "workflow", "bundledSkills", "mcpRequirements", "a2aChannels", "recommendedConfig", "forkedFrom",
      "seedMemories", "agentMemories", "defaultTasks", "visibilityPolicy", "toolRequirements",
      "author", "downloads", "stars", "createdAt",
      "hash", "signature", "trustLevel",
    ]));
    // passthrough 组(license/version/compatibility/requiredPermissions/exampleTrace/exampleArtifacts/
    // authorGitHub/verifiedAuthor)原样带回,绝不能混进 skip。
    for (const k of ["license", "version", "compatibility", "requiredPermissions", "exampleTrace", "exampleArtifacts", "authorGitHub", "verifiedAuthor"]) {
      expect(TEMPLATE_WORKSHOP_SKIP_KEYS, k).not.toContain(k);
    }
  });

  it("AGENT_WORKSHOP_SKIP_KEYS == 收敛前 AGENT_PASSTHROUGH_SKIP 的 17 键", () => {
    expect(sorted(AGENT_WORKSHOP_SKIP_KEYS)).toEqual(sorted([
      "id", "name", "role", "provider", "model", "framework", "parentId", "childrenIds", "card",
      "companyId", "workspaceDir", "cliConfigDir", "status", "currentTask", "lastAction", "tokenUsage", "costUsd",
    ]));
  });

  it("PORTABLE_DESIGN_FIELD_KEYS 覆盖 fidelity 链路原有的 13 个可移植设计字段(登记表新增设计字段自动跟进)", () => {
    for (const k of [
      "agents", "workflow", "a2aChannels", "bundledSkills", "mcpRequirements", "toolRequirements",
      "visibilityPolicy", "defaultTasks", "useCases", "riskNotes", "recommendedConfig", "seedMemories", "agentMemories",
    ]) {
      expect(PORTABLE_DESIGN_FIELD_KEYS, k).toContain(k);
    }
    // 身份/元数据与安全信号不属于设计载荷投影。
    for (const k of ["id", "title", "description", "readme", "author", "createdAt", "downloads", "stars", "hash", "signature", "trustLevel"]) {
      expect(PORTABLE_DESIGN_FIELD_KEYS, k).not.toContain(k);
    }
  });
});

describe("收口④ · merge 消费方与登记表对齐(收口②行为不回退)", () => {
  const company = (over: Partial<Company> = {}): Company => ({
    id: "target", name: "目标公司", description: "", createdAt: "2026-01-01T00:00:00Z", ceoId: "ceo-x", ...over,
  });
  const tpl = (over: Partial<CompanyTemplate> = {}): CompanyTemplate => ({
    id: "t-reg", title: "登记表测试模板", description: "d", author: "a",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r", agents: [],
    ...over,
  });

  it("COMPANY_LEVEL_MERGE_FIELDS = 收口②四字段,templateKey→companyKey 映射与策略逐条对齐", () => {
    expect(COMPANY_LEVEL_MERGE_FIELDS).toEqual([
      { templateKey: "toolRequirements", companyKey: "manifestToolRequirements", mergeStrategy: "union" },
      { templateKey: "defaultTasks", companyKey: "defaultTasks", mergeStrategy: "union" },
      { templateKey: "workflow", companyKey: "workflow", mergeStrategy: "requires-review" },
      { templateKey: "visibilityPolicy", companyKey: "visibilityPolicy", mergeStrategy: "target-preferred" },
    ]);
  });

  it("mergeCompanyLevelFields 的 preMerge 整值快照键集合 == 登记表 companyLevelMerge 的 companyKey 集合", () => {
    const out = mergeCompanyLevelFields(company({ visibilityPolicy: "isolated" }), tpl());
    expect(sorted(Object.keys(out.preMergeCompanyFields))).toEqual(
      sorted(COMPANY_LEVEL_MERGE_FIELDS.map((f) => f.companyKey)),
    );
  });

  it("TOOL_REQUIREMENT_KEYS 与 CompanyTemplateSchema.toolRequirements 的子键一一对应", () => {
    const shape = (CompanyTemplateSchema.shape.toolRequirements as { unwrap: () => { shape: Record<string, unknown> } }).unwrap().shape;
    expect(sorted(TOOL_REQUIREMENT_KEYS)).toEqual(sorted(Object.keys(shape)));
  });

  it("未登记顶层字段进 merge 报告 requires_review(passthrough 保留 + 如实列出,不静默丢);已登记/控制键不误报", () => {
    const withUnknown = { ...tpl(), futureBlueprintField: { anything: 1 }, mode: "merge", targetCompanyId: "x" } as unknown as CompanyTemplate;
    const out = mergeCompanyLevelFields(company(), withUnknown);
    const fields = out.report.requires_review.map((i) => i.field);
    expect(fields).toContain("futureBlueprintField");
    expect(fields).not.toContain("mode");           // 导入控制键不误报
    expect(fields).not.toContain("targetCompanyId");
    expect(fields).not.toContain("title");          // 已登记字段不误报
    // 干净模板零误报。
    expect(mergeCompanyLevelFields(company(), tpl()).report.requires_review).toEqual([]);
    // 帮助函数口径一致。
    expect(listUnregisteredTemplateFields(withUnknown)).toEqual(["futureBlueprintField"]);
  });
});

describe("收口④ · sensitive/non-portable 字段绝不以原始值进导出 bundle(share 与 full 都不)", () => {
  const RAW_WORKSPACE = "M:\\reg-guard\\co-workspace-XKQ";
  const RAW_CLI_CONFIG = "C:\\Users\\reg-author\\.claude-XKQ";
  const agent: AgentNodeConfig = {
    id: "a1", name: "守卫员工", role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    framework: "generic-cli", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
    workspaceDir: RAW_WORKSPACE, cliConfigDir: RAW_CLI_CONFIG,
    genericCli: { command: "mycli-xkq", args: ["--go"], authEnvVar: "MYCLI_TOKEN" },
  };
  const bundle: CompanyBundle = {
    schema_version: "0.3.0", bundle_type: "company", title: "守卫包", description: "",
    agents: [agent],
    privacy: { redacted: false, redacted_fields: [], required_secrets: [] },
    compatibility: { migration_notes: [] },
  };

  it("AGENT_SENSITIVE_FIELDS(登记表)= workspaceDir/cliConfigDir;share 档整字段剥离并记入 redacted_fields", () => {
    expect(sorted(AGENT_SENSITIVE_FIELDS)).toEqual(["cliConfigDir", "workspaceDir"]);
    const share = sanitizeBundleForExport(structuredClone(bundle), { profile: "share" });
    const a = share.bundle.agents[0];
    for (const k of AGENT_LOCAL_PATH_FIELDS) expect(a[k], k).toBeUndefined();
    for (const k of AGENT_SHARE_STRIPPED_FIELDS) expect((a as Record<string, unknown>)[k], k).toBeUndefined();
    expect(share.bundle.privacy.redacted_fields).toContain("agents[0].workspaceDir");
    expect(share.bundle.privacy.redacted_fields).toContain("agents[0].cliConfigDir");
    const wire = JSON.stringify(share.bundle);
    expect(wire).not.toContain("co-workspace-XKQ");
    expect(wire).not.toContain("reg-author");
  });

  it("full 档:本机路径只占位($OPC_REMAP_*$),原始盘符/家目录同样绝不出包;genericCli 按设计保留", () => {
    const full = sanitizeBundleForExport(structuredClone(bundle), { profile: "full" });
    const a = full.bundle.agents[0];
    expect(a.workspaceDir).toBe(WORKSPACE_DIR_PLACEHOLDER);
    expect(a.cliConfigDir).toBe(CLI_CONFIG_DIR_PLACEHOLDER);
    expect(a.genericCli).toEqual(agent.genericCli); // full=自己备份,登记表 handling=share-strip 只在 share 档剥
    const wire = JSON.stringify(full.bundle);
    expect(wire).not.toContain("co-workspace-XKQ");
    expect(wire).not.toContain("reg-author");
  });

  it("rerootAgents(导出/导入公共关口):登记表 local-path 字段全清空,runtime 字段全部 start-fresh 复位", () => {
    const dirty: AgentNodeConfig = {
      ...agent, status: "working", currentTask: "残留任务", lastAction: "残留动作",
      tokenUsage: { prompt: 9, completion: 9, total: 18 }, costUsd: 1.5, companyId: "old-co",
    };
    const { agents } = rerootAgents([dirty], "new-co", (old) => `${old}-new`);
    const out = agents[0];
    for (const k of AGENT_LOCAL_PATH_FIELDS) expect(out[k], k).toBeUndefined();
    const expectedReset: Record<string, unknown> = {
      status: "idle", currentTask: undefined, lastAction: undefined,
      tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    };
    for (const k of AGENT_RUNTIME_RESET_FIELDS) {
      expect((out as unknown as Record<string, unknown>)[k], k).toEqual(expectedReset[k]);
    }
    expect(Object.keys(expectedReset).sort()).toEqual(sorted(AGENT_RUNTIME_RESET_FIELDS)); // 复位值映射覆盖登记表全集
  });

  it("模板顶层无 sensitive 字段(敏感载荷都在 agent 级/内容形态扫描);requiresLocalSetup 声明类如实标注", () => {
    for (const e of COMPANY_TEMPLATE_FIELD_REGISTRY) expect(e.sensitive, e.key).toBe(false);
    expect(companyFieldAttr("toolRequirements")?.requiresLocalSetup).toBe(true);
    expect(companyFieldAttr("mcpRequirements")?.requiresLocalSetup).toBe(true);
    expect(companyFieldAttr("requiredPermissions")?.requiresLocalSetup).toBe(true);
  });
});
