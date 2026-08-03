import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mapConclusionSummaryToBundleRecord, mapProceduralSkillToBundleRecord, mapLessonToBundleRecord,
  exportMemoryRecordsForCompany, redactMemoryRecords, deriveRequiredSecrets,
  filterMemoryRecordsByImportMode, sanitizeMemoryImportMode, DEFAULT_MEMORY_IMPORT_MODE, MEMORY_IMPORT_MODES,
  importMemoryRecords, applyMemoryImportMode, sanitizeBundleForExport,
} from "./memoryBundle.js";
import { addConclusionSummary, upsertProceduralSkill, upsertPlanTemplate, loadRegistry, type ConclusionSummary, type ProceduralSkill } from "../storage/registryStore.js";
import { commitLesson, loadLessons, type ReflectionLesson } from "../storage/reflectionStore.js";
import { decideGovernedMemoryProposal, listGovernedMemoryProposals } from "./memoryGovernance.js";
import type { AgentNodeConfig, BundleMemoryRecord, CompanyBundle } from "@opc/shared";
import { WORKSPACE_DIR_PLACEHOLDER, CLI_CONFIG_DIR_PLACEHOLDER } from "@opc/shared";

const NOW = "2026-07-08T00:00:00.000Z";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-bundle-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});

function conclusion(over: Partial<ConclusionSummary> = {}): ConclusionSummary {
  return {
    id: "concl-1", kind: "conclusion_summary", runId: "run-1", goalSlug: "sort",
    points: ["快排最坏 O(n^2)"], tags: ["sort"], createdAt: NOW, ...over,
  };
}

function skill(over: Partial<ProceduralSkill> = {}): ProceduralSkill {
  return {
    id: "skill-1", kind: "procedural_skill", role: "dev", taskType: "coding",
    preconditions: [], successfulSequence: ["read", "write", "test"], producedArtifacts: [], antiPatterns: [],
    support: 3, successRate: 1, sourceRuns: ["run-1"], status: "verified", createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function lesson(over: Partial<ReflectionLesson> = {}): ReflectionLesson {
  return {
    id: "lesson-1", schemaVersion: "reflection_lesson.v1", kind: "failure_lesson",
    scope: { role: "dev" },
    trigger: { eventTypes: [], failureMode: "timeout", conditionText: "超时" },
    diagnosis: "任务超时未完成", lesson: "拆分子任务避免单任务过长", recommendedChange: "把大任务拆成更小的子任务",
    injection: { strength: "hint", promptText: "把大任务拆成更小的子任务再执行" },
    evidence: { runId: "run-1", agentId: "agent-1" },
    confidence: 0.8, status: "committed", version: 1, createdAt: NOW, updatedAt: NOW, hits: 0, ineffective: 0, support: 1,
    ...over,
  };
}

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}

describe("D5 · 五级映射(draft → noted → verified → sop → doctrine),各级至少一个用例", () => {
  it("draft ← conclusion_summary status=pending(临时观察,尚未审核)", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ status: "pending" }));
    expect(rec?.level).toBe("draft");
  });

  it("verified ← conclusion_summary status=approved(给定映射规则)", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ status: "approved" }));
    expect(rec?.level).toBe("verified");
  });

  it("verified ← conclusion_summary status=undefined(默认自动生效,同 approved 处理)", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ status: undefined }));
    expect(rec?.level).toBe("verified");
  });

  it("conclusion_summary status=rejected → 不导出(null)", () => {
    expect(mapConclusionSummaryToBundleRecord(conclusion({ status: "rejected" }))).toBeNull();
  });

  it("noted ← procedural_skill status=candidate(已记录经验,尚未验证)", () => {
    const rec = mapProceduralSkillToBundleRecord(skill({ status: "candidate", support: 1 }));
    expect(rec?.level).toBe("noted");
  });

  it("noted ← lesson status=committed(给定映射规则)", () => {
    const rec = mapLessonToBundleRecord(lesson({ status: "committed" }));
    expect(rec?.level).toBe("noted");
  });

  it("sop ← procedural_skill status=verified 且 support 低于 doctrine 阈值(给定映射规则)", () => {
    const rec = mapProceduralSkillToBundleRecord(skill({ status: "verified", support: 3 }));
    expect(rec?.level).toBe("sop");
  });

  it("doctrine ← procedural_skill status=verified 且 support 达到高阈值(启发式近似,见函数顶注)", () => {
    const rec = mapProceduralSkillToBundleRecord(skill({ status: "verified", support: 6 }));
    expect(rec?.level).toBe("doctrine");
  });

  it("procedural_skill status=retired → 不导出(null)", () => {
    expect(mapProceduralSkillToBundleRecord(skill({ status: "retired" }))).toBeNull();
  });

  it("lesson 非 committed 态(proposed/revoked/superseded/deprecated)均不导出", () => {
    for (const status of ["proposed", "approved", "revoked", "superseded", "deprecated"] as const) {
      expect(mapLessonToBundleRecord(lesson({ status }))).toBeNull();
    }
  });
});

describe("D5 · company/team/agent/project 分层保留(owner_type/owner_id)", () => {
  it("conclusion_summary:teamId 设了 → owner_type team", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ companyId: "c1", teamId: "engineering" }));
    expect(rec).toMatchObject({ owner_type: "team", owner_id: "engineering" });
  });
  it("conclusion_summary:只设 companyId → owner_type company", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ companyId: "c1", teamId: undefined }));
    expect(rec).toMatchObject({ owner_type: "company", owner_id: "c1" });
  });
  it("conclusion_summary:只设 goalSlug → owner_type project", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ companyId: undefined, teamId: undefined, goalSlug: "sort" }));
    expect(rec).toMatchObject({ owner_type: "project", owner_id: "sort" });
  });
  it("procedural_skill:role 映射为 owner_type agent", () => {
    const rec = mapProceduralSkillToBundleRecord(skill({ role: "researcher" }));
    expect(rec).toMatchObject({ owner_type: "agent", owner_id: "researcher" });
  });
  it("lesson:scope.agentId 设了 → owner_type agent(优先于 role)", () => {
    const rec = mapLessonToBundleRecord(lesson({ scope: { agentId: "agent-42", role: "dev" } }));
    expect(rec).toMatchObject({ owner_type: "agent", owner_id: "agent-42" });
  });
  it("lesson:只设 taskType → owner_type project", () => {
    const rec = mapLessonToBundleRecord(lesson({ scope: { taskType: "coding" } }));
    expect(rec).toMatchObject({ owner_type: "project", owner_id: "coding" });
  });
});

describe("D5 · exportMemoryRecordsForCompany(真实 store 集成)", () => {
  it("conclusion_summary 按 companyId 过滤;procedural_skill/lesson 按角色是否在本公司圈定范围", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["c1 的结论"], createdAt: NOW });
    addConclusionSummary(root, { runId: "r2", companyId: "c2", points: ["c2 的结论,不该导出"], createdAt: NOW });
    upsertProceduralSkill(root, { role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1"], status: "verified" }, NOW);
    upsertProceduralSkill(root, { role: "pm", taskType: "coding", preconditions: [], successfulSequence: ["a"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1"], status: "verified" }, NOW);
    commitLesson(root, {
      kind: "failure_lesson", scope: { companyId: "c1", role: "dev" },
      trigger: { eventTypes: [], failureMode: "timeout", conditionText: "超时" },
      diagnosis: "任务超时未完成", lesson: "拆分子任务避免单任务过长", recommendedChange: "把大任务拆成更小的子任务",
      injection: { strength: "hint", promptText: "把大任务拆成更小的子任务再执行" },
      evidence: { runId: "run-1", agentId: "agent-1" }, confidence: 0.8,
    }, NOW);

    const records = exportMemoryRecordsForCompany(root, "c1", ["dev"]);
    const contents = records.map((r) => r.content).join("\n");
    expect(contents).toContain("c1 的结论");
    expect(contents).not.toContain("c2 的结论");
    expect(records.some((r) => r.owner_id === "dev")).toBe(true);
    expect(records.some((r) => r.owner_id === "pm")).toBe(false); // pm 不在本公司角色集合内
  });

  it("P0 · 双公司隔离:已归属他公司的同角色 procedural_skill 绝不因同名角色被导出进本公司(收口跨公司来源漂移)", () => {
    // c1 与 c2 各有一条 role=test 的技能,分别归属各自公司。
    upsertProceduralSkill(root, { companyId: "c1", role: "test", taskType: "coding", preconditions: [], successfulSequence: ["c1-seq"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r-c1"], status: "verified" } as any, NOW);
    upsertProceduralSkill(root, { companyId: "c2", role: "test", taskType: "coding", preconditions: [], successfulSequence: ["c2-seq"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r-c2"], status: "verified" } as any, NOW);
    // 去重键含 companyId → 两条各自成条(不合并)。
    expect(loadRegistry(root).filter((r) => r.kind === "procedural_skill" && (r as any).role === "test").length).toBe(2);
    // 导出 c1(含 test 角色)→ 只拿 c1 的技能,c2 的绝不混入(即便同为 test 角色)。
    const recs = exportMemoryRecordsForCompany(root, "c1", ["test"]);
    const contents = recs.map((r) => r.content).join("\n");
    expect(contents).toContain("c1-seq");
    expect(contents).not.toContain("c2-seq");
  });

  it("P0 · 幂等:同公司同 role+taskType 的技能再次 upsert → 合并版本(support+1)而非新建重复条", () => {
    upsertProceduralSkill(root, { companyId: "c1", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["x"], producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r1"], status: "candidate" } as any, NOW);
    upsertProceduralSkill(root, { companyId: "c1", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["x"], producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r2"], status: "candidate" } as any, NOW);
    const skills = loadRegistry(root).filter((r) => r.kind === "procedural_skill" && (r as any).companyId === "c1");
    expect(skills.length).toBe(1); // 幂等合并,不增生
  });

  it("plan_template 不映射进 memory.records(不是 11.6 定义的经验/记忆)", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["结论"], createdAt: NOW });
    upsertPlanTemplate(root, { companyId: "c1", taskType: "coding", split: ["子任务A", "子任务B"], sourceRun: "r1" }, NOW);
    expect(loadRegistry(root).some((r) => r.kind === "plan_template")).toBe(true); // 确认真的写进了 registry
    const records = exportMemoryRecordsForCompany(root, "c1", []);
    expect(records).toHaveLength(1); // 只有那条 conclusion_summary,plan_template 被如实排除
    expect(records[0].memory_id.startsWith("mem-cs-")).toBe(true);
  });
});

describe("D4 · 导出脱敏扫描(命中 → 脱敏 + 记 redacted_fields;不误伤正常文本)", () => {
  it("命中密钥形态(sk-...)→ 整条记录脱敏值,记进 redactedFields", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ points: ["密钥是 sk-abcdefgh12345678,别泄漏"] }))!;
    const { records, redactedFields } = redactMemoryRecords([rec]);
    expect(redactedFields).toEqual(["memory.records[0]"]);
    expect(records[0].content).not.toContain("sk-abcdefgh12345678");
    expect(records[0].content).toContain("[REDACTED_SECRET]");
  });

  it("命中本机绝对路径(Windows)→ 脱敏值,记进 redactedFields", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ points: ["文件在 C:\\Users\\bob\\secret-project\\a.ts"] }))!;
    const { records, redactedFields } = redactMemoryRecords([rec]);
    expect(redactedFields).toEqual(["memory.records[0]"]);
    expect(records[0].content).toContain("[REDACTED_PATH]");
  });

  it("不误伤:正常文本(不含密钥/路径形态)原样返回,不记 redactedFields", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ points: ["快排最坏情况是 O(n^2),归并排序更稳定"] }))!;
    const { records, redactedFields } = redactMemoryRecords([rec]);
    expect(redactedFields).toEqual([]);
    expect(records[0].content).toBe(rec.content);
    expect(records[0]).toBe(rec); // 未命中 → 原对象引用,不做无意义拷贝
  });
});

describe("P0-4 · sanitizeBundleForExport(导出/分享脱敏统一层)", () => {
  function bundle(over: Partial<CompanyBundle> = {}): CompanyBundle {
    const agents: AgentNodeConfig[] = [agent({ id: "ceo-0", role: "ceo" })];
    return {
      schema_version: "0.3.0", bundle_type: "company", bundle_id: "b1", title: "t", description: "",
      org: { agents }, agents,
      privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
      compatibility: { migration_notes: [] },
      ...over,
    };
  }

  it("剥离 agents 的 workspaceDir/cliConfigDir(纯本机路径),记进 redacted_fields", () => {
    const dirty: AgentNodeConfig[] = [
      agent({ id: "ceo-0", role: "ceo", workspaceDir: "C:\\Users\\bob\\proj", cliConfigDir: "C:\\Users\\bob\\.opc\\cli" }),
      agent({ id: "dev-0", role: "dev" }),
    ];
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({ org: { agents: dirty }, agents: dirty }));
    expect(out.agents[0].workspaceDir).toBeUndefined();
    expect(out.agents[0].cliConfigDir).toBeUndefined();
    expect(out.org?.agents?.[0].workspaceDir).toBeUndefined();
    expect(redactedFields).toContain("agents[0].workspaceDir");
    expect(redactedFields).toContain("agents[0].cliConfigDir");
    // stringify 后不含任何盘符路径
    expect(JSON.stringify(out)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("bundledSkills 正文里的本机路径/密钥 → 占位化,记进 redacted_fields", () => {
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({
      bundledSkills: [
        { name: "clean", content: "干净的人设正文", roles: ["dev"] },
        { name: "leaky", content: "工作目录在 C:\\Users\\bob\\secret,密钥 sk-abcdefgh12345678", roles: ["dev"] },
      ],
    }));
    expect(out.bundledSkills![0].content).toBe("干净的人设正文");
    expect(out.bundledSkills![1].content).not.toContain("C:\\Users\\bob\\secret");
    expect(out.bundledSkills![1].content).not.toContain("sk-abcdefgh12345678");
    expect(out.bundledSkills![1].content).toContain("[REDACTED");
    expect(redactedFields).toContain("bundledSkills[1].content");
  });

  it("memory.records 的密钥/路径同样脱敏(与 redactMemoryRecords 一致)", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ points: ["密钥 sk-abcdefgh12345678"] }))!;
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({ memory: { records: [rec] } }));
    expect(out.memory!.records[0].content).toContain("[REDACTED_SECRET]");
    expect(redactedFields).toContain("memory.records[0]");
  });

  it("干净 bundle:无命中 → redacted_fields 为空,agents 原样", () => {
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle());
    expect(redactedFields).toEqual([]);
    expect(out.privacy.redacted).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/[A-Za-z]:\\/);
  });

  it("GitHub PAT(ghp_)/AWS(AKIA)形态也被脱敏", () => {
    const { bundle: out } = sanitizeBundleForExport(bundle({
      bundledSkills: [{ name: "s", content: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 与 AKIAIOSFODNN7EXAMPLE", roles: ["dev"] }],
    }));
    expect(out.bundledSkills![0].content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out.bundledSkills![0].content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("剥离 agents 的 genericCli(command 是机器本地可执行文件绝对路径,与 workspaceDir 同类)", () => {
    const dirty: AgentNodeConfig[] = [
      agent({ id: "dev-0", role: "dev", framework: "generic-cli", genericCli: { command: "C:\\Users\\bob\\bin\\mycli.exe", args: ["--cfg", "/home/bob/.mycli"] } }),
    ];
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({ org: { agents: dirty }, agents: dirty }));
    expect(out.agents[0].genericCli).toBeUndefined();
    expect(out.org?.agents?.[0].genericCli).toBeUndefined();
    expect(redactedFields).toContain("agents[0].genericCli.command");
    // command 与 args 里的盘符/家目录路径都随整块剥离一起消失
    expect(JSON.stringify(out)).not.toMatch(/[A-Za-z]:\\/);
    expect(JSON.stringify(out)).not.toContain("/home/bob");
  });

  it("agents 运行时残留 currentTask/lastAction 里的本机路径被占位化(export 未经 rerootAgents 复位的兜底)", () => {
    const dirty: AgentNodeConfig[] = [
      agent({ id: "dev-0", role: "dev", currentTask: "写文件到 C:\\Users\\bob\\proj\\a.ts", lastAction: "读取 /home/bob/secret.txt" }),
    ];
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({ org: { agents: dirty }, agents: dirty }));
    expect(out.agents[0].currentTask).not.toContain("C:\\Users\\bob");
    expect(out.agents[0].currentTask).toContain("[REDACTED_PATH]");
    expect(out.agents[0].lastAction).not.toContain("/home/bob");
    expect(redactedFields).toContain("agents[0].currentTask");
    expect(redactedFields).toContain("agents[0].lastAction");
  });

  it("模板级 readme/description/useCases/riskNotes 里的本机路径/密钥被占位化", () => {
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({
      description: "部署在 /home/bob/companies/acme",
      readme: "配置见 C:\\Users\\bob\\.opc\\config.json",
      useCases: ["跑在 /home/alice/proj 上"],
      riskNotes: ["密钥 sk-abcdefgh12345678 别外泄"],
    }));
    expect(out.description).not.toContain("/home/bob");
    expect(out.readme).not.toContain("C:\\Users\\bob");
    expect(out.useCases![0]).not.toContain("/home/alice");
    expect(out.riskNotes![0]).not.toContain("sk-abcdefgh12345678");
    expect(redactedFields).toContain("description");
    expect(redactedFields).toContain("readme");
    expect(redactedFields).toContain("useCases[0]");
    expect(redactedFields).toContain("riskNotes[0]");
  });

  it("综合脏模板 → 导出物 stringify 全文无盘符/家目录路径(要求3)", () => {
    const dirty: AgentNodeConfig[] = [
      agent({
        id: "ceo-0", role: "ceo",
        workspaceDir: "C:\\Users\\bob\\proj", cliConfigDir: "C:\\Users\\bob\\.opc",
        currentTask: "在 C:\\Users\\bob\\proj 工作", lastAction: "写 /home/bob/out.txt",
        framework: "generic-cli", genericCli: { command: "/home/bob/bin/cli", args: ["/opt/data"] },
      }),
    ];
    const { bundle: out } = sanitizeBundleForExport(bundle({
      org: { agents: dirty }, agents: dirty,
      description: "在 /home/bob 下运行", readme: "见 C:\\Users\\bob\\readme.md",
      useCases: ["/home/bob/uc"], riskNotes: ["C:\\Windows\\risk"],
      bundledSkills: [{ name: "p", content: "人设正文 C:\\Users\\bob\\persona.md", roles: ["ceo"] }],
      memory: { records: [mapConclusionSummaryToBundleRecord(conclusion({ points: ["日志在 /home/bob/log"] }))!] },
    }));
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/[A-Za-z]:\\/);
    expect(s).not.toContain("/home/bob");
    expect(s).not.toContain("/opt/data");
  });

  it("缺省(不传 profile、bundle 无 export_profile)= share 档,产物盖 export_profile=share", () => {
    const { bundle: out } = sanitizeBundleForExport(bundle());
    expect(out.export_profile).toBe("share");
  });
});

// ── 分场景导出档位:full(自己备份/迁移,保真)vs share(社区分享,全脱敏,缺省)────────────
describe("分场景 · sanitizeBundleForExport({ profile })", () => {
  function bundle(over: Partial<CompanyBundle> = {}): CompanyBundle {
    const agents: AgentNodeConfig[] = [agent({ id: "ceo-0", role: "ceo" })];
    return {
      schema_version: "0.3.0", bundle_type: "company", bundle_id: "b1", title: "t", description: "",
      org: { agents }, agents,
      privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
      compatibility: { migration_notes: [] },
      ...over,
    };
  }
  const dirtyAgents = (): AgentNodeConfig[] => [
    agent({
      id: "qa-0", role: "qa", framework: "generic-cli",
      genericCli: { command: "C:\\Users\\bob\\bin\\mycli.exe", args: ["--check"], authEnvVar: "MYCLI_ENV" },
      workspaceDir: "C:\\Users\\bob\\proj", cliConfigDir: "C:\\Users\\bob\\.opc\\cli",
    }),
  ];

  it("full:genericCli 原样保留(命令含本机路径也不动);share:整块剥离", () => {
    const full = sanitizeBundleForExport(bundle({ agents: dirtyAgents(), org: { agents: dirtyAgents() } }), { profile: "full" });
    expect(full.bundle.agents[0].genericCli).toEqual({ command: "C:\\Users\\bob\\bin\\mycli.exe", args: ["--check"], authEnvVar: "MYCLI_ENV" });
    expect(full.redactedFields).not.toContain("agents[0].genericCli.command");

    const share = sanitizeBundleForExport(bundle({ agents: dirtyAgents(), org: { agents: dirtyAgents() } }), { profile: "share" });
    expect(share.bundle.agents[0].genericCli).toBeUndefined();
    expect(share.redactedFields).toContain("agents[0].genericCli.command");
  });

  it("full:workspaceDir/cliConfigDir 不删除、占位成重映射标记(不外泄作者路径,导入侧收到显式信号)", () => {
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({ agents: dirtyAgents(), org: { agents: dirtyAgents() } }), { profile: "full" });
    expect(out.agents[0].workspaceDir).toBe(WORKSPACE_DIR_PLACEHOLDER);
    expect(out.agents[0].cliConfigDir).toBe(CLI_CONFIG_DIR_PLACEHOLDER);
    expect(redactedFields).toContain("agents[0].workspaceDir");
    expect(redactedFields).toContain("agents[0].cliConfigDir");
    // 作者机器的这两个目录路径本身没进导出物
    expect(JSON.stringify(out)).not.toContain("C:\\\\Users\\\\bob\\\\proj");
    expect(JSON.stringify(out)).not.toContain(".opc\\\\cli");
  });

  it("full:密钥形态仍硬剥(两档都剥),但正文里的本机路径保留(自己的备份,不占位)", () => {
    const rec = mapConclusionSummaryToBundleRecord(conclusion({ points: ["日志在 C:\\Users\\bob\\log,密钥 sk-abcdefgh12345678"] }))!;
    const { bundle: out } = sanitizeBundleForExport(bundle({
      memory: { records: [rec] },
      agentMemories: [{ agent_id: "dev-1", role: "dev", content: "工作区在 C:\\Users\\bob\\ws,token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }],
    }), { profile: "full" });
    expect(out.memory!.records[0].content).toContain("[REDACTED_SECRET]");
    expect(out.memory!.records[0].content).toContain("C:\\Users\\bob\\log");
    expect(out.agentMemories![0].content).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out.agentMemories![0].content).toContain("C:\\Users\\bob\\ws");
  });

  it("share:agentMemories 随包带走(记忆两档都带),正文密钥+本机路径全占位化", () => {
    const { bundle: out, redactedFields } = sanitizeBundleForExport(bundle({
      agentMemories: [{ agent_id: "dev-1", role: "dev", content: "工作区在 C:\\Users\\bob\\ws,密钥 sk-abcdefgh12345678" }],
    }), { profile: "share" });
    expect(out.agentMemories).toHaveLength(1);
    expect(out.agentMemories![0].content).toContain("[REDACTED_SECRET]");
    expect(out.agentMemories![0].content).toContain("[REDACTED_PATH]");
    expect(out.agentMemories![0].content).not.toContain("C:\\Users\\bob\\ws");
    expect(redactedFields).toContain("agentMemories[0].content");
  });

  it("档位解析:显式 opts.profile 优先于 bundle.export_profile;无 opts 时认 bundle 自带声明", () => {
    const withFull = bundle({ export_profile: "full", agents: dirtyAgents(), org: { agents: dirtyAgents() } });
    // 无 opts → 认 bundle 自带 full
    expect(sanitizeBundleForExport(withFull).bundle.agents[0].genericCli).toBeTruthy();
    // 显式 share 压过 bundle 自带 full(分享端点的强制口径)
    const forced = sanitizeBundleForExport(withFull, { profile: "share" });
    expect(forced.bundle.agents[0].genericCli).toBeUndefined();
    expect(forced.bundle.export_profile).toBe("share");
  });

  it("产物永远盖上生效档位:full → export_profile=full", () => {
    const { bundle: out } = sanitizeBundleForExport(bundle(), { profile: "full" });
    expect(out.export_profile).toBe("full");
  });
});

describe("D4 · required_secrets 从能力依赖推导", () => {
  it("非 CLI(API)provider → 生成 required_secrets;订阅制 CLI(claude-code/codex)不生成", () => {
    const secrets = deriveRequiredSecrets([
      agent({ id: "a1", provider: "deepseek", framework: "hermes" }),
      agent({ id: "a2", provider: "anthropic", framework: "claude-code" }),
    ]);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ name: "DEEPSEEK_API_KEY", required_for: "api" });
  });

  it("多个 API agent 用同一 provider → 去重成一条", () => {
    const secrets = deriveRequiredSecrets([
      agent({ id: "a1", provider: "deepseek" }),
      agent({ id: "a2", provider: "deepseek" }),
    ]);
    expect(secrets).toHaveLength(1);
  });
});

describe("D5 · Memory Import Mode 四选一(默认 structure-sop)", () => {
  const byLevel = (level: BundleMemoryRecord["level"]): BundleMemoryRecord => ({
    memory_id: `mem-cs-${level}`, scope: "s", owner_type: "company", owner_id: "c1", content: "内容",
    source: { type: "run", run_id: "r1", task_id: "" }, level, score: 50, status: "active", tags: [],
    metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
    created_at: NOW, updated_at: NOW, last_used_at: NOW,
  });
  const all: BundleMemoryRecord[] = (["draft", "noted", "verified", "sop", "doctrine"] as const).map(byLevel);

  it("structure-only:不导入任何记忆", () => {
    expect(filterMemoryRecordsByImportMode(all, "structure-only")).toEqual([]);
  });
  it("structure-sop(默认):只导 sop/doctrine 级", () => {
    const levels = filterMemoryRecordsByImportMode(all, "structure-sop").map((r) => r.level).sort();
    expect(levels).toEqual(["doctrine", "sop"]);
    expect(DEFAULT_MEMORY_IMPORT_MODE).toBe("structure-sop");
  });
  it("structure-sop-verified:sop/doctrine/verified 三级", () => {
    const levels = filterMemoryRecordsByImportMode(all, "structure-sop-verified").map((r) => r.level).sort();
    expect(levels).toEqual(["doctrine", "sop", "verified"]);
  });
  it("full:全部五级", () => {
    expect(filterMemoryRecordsByImportMode(all, "full")).toHaveLength(5);
  });
  it("sanitizeMemoryImportMode:非法值回退默认;合法值原样通过", () => {
    expect(sanitizeMemoryImportMode("not-a-real-mode")).toBe(DEFAULT_MEMORY_IMPORT_MODE);
    expect(sanitizeMemoryImportMode(undefined)).toBe(DEFAULT_MEMORY_IMPORT_MODE);
    for (const m of MEMORY_IMPORT_MODES) expect(sanitizeMemoryImportMode(m)).toBe(m);
  });
});

describe("D5 · importMemoryRecords 统一写入受治理记忆提案", () => {
  function bundleRec(over: Partial<BundleMemoryRecord> & { memory_id: string }): BundleMemoryRecord {
    return {
      scope: "s", owner_type: "agent", owner_id: "dev", content: "导入内容",
      source: { type: "run", run_id: "r1", task_id: "" }, level: "sop", score: 80, status: "active", tags: ["t1"],
      metrics: { cited_count: 2, cited_success_count: 2, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: NOW, updated_at: NOW, last_used_at: NOW, ...over,
    };
  }

  it("mem-ps- 前缀 → 生成 success_experience 提案,不伪装成运行时 Skill", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-ps-x1", owner_type: "agent", owner_id: "dev", level: "sop" })]);
    expect(result.byKind.proceduralSkill).toBe(1);
    expect(loadRegistry(root).filter((r) => r.kind === "procedural_skill")).toHaveLength(0);
    expect(listGovernedMemoryProposals(root)).toMatchObject([{
      proposalId: result.recordIds.governedProposalIds[0], objectType: "success_experience",
      scope: "company", scopeId: "default", sourceType: "import", status: "proposed",
    }]);
  });

  it("mem-cs- 前缀 → 生成待审 success_experience,不写旧 conclusion_summary", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-cs-x1", owner_type: "company", owner_id: "c1", content: "导入的结论" })]);
    expect(result.byKind.conclusionSummary).toBe(1);
    expect(loadRegistry(root).filter((r) => r.kind === "conclusion_summary")).toHaveLength(0);
    expect(listGovernedMemoryProposals(root)[0]).toMatchObject({
      proposalId: result.recordIds.governedProposalIds[0], objectType: "success_experience",
      scope: "company", scopeId: "default", status: "proposed",
    });
    expect(listGovernedMemoryProposals(root)[0].content).toContain("导入的结论");
  });

  it("模板导入不允许 asProposal:false 绕过审批", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-cs-x2", owner_type: "company", owner_id: "c1", content: "显式直批的结论" })], { asProposal: false });
    expect(result.byKind.conclusionSummary).toBe(1);
    expect(listGovernedMemoryProposals(root)[0].status).toBe("proposed");
    expect(listGovernedMemoryProposals(root)[0].memoryId).toBeUndefined();
  });

  it("mem-ls- 前缀 → 生成严格的 failure_lesson 提案,不写旧 reflectionStore", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-ls-x1", owner_type: "agent", owner_id: "dev", content: "把大任务拆成更小的子任务" })]);
    expect(result.byKind.lesson).toBe(1);
    expect(loadLessons(root)).toHaveLength(0);
    expect(listGovernedMemoryProposals(root)[0]).toMatchObject({
      proposalId: result.recordIds.governedProposalIds[0], objectType: "failure_lesson", status: "proposed",
    });
  });

  it("导入失败教训即使 asProposal:false 也保持 proposed", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-ls-x2", owner_type: "agent", owner_id: "dev", content: "显式直批的教训" })], { asProposal: false });
    expect(result.byKind.lesson).toBe(1);
    expect(listGovernedMemoryProposals(root)[0].status).toBe("proposed");
    expect(listGovernedMemoryProposals(root)[0].memoryId).toBeUndefined();
  });

  it("不认识的前缀 → 兜底写进 conclusion_summary(约束最少的通用容器)", () => {
    const result = importMemoryRecords(root, [bundleRec({ memory_id: "mem-external-x1", content: "外部来源的记录" })]);
    expect(result.byKind.conclusionSummary).toBe(1);
  });

  it("applyMemoryImportMode:按等级过滤后才写入,totalRecords/filteredRecords 如实反映", () => {
    const records: BundleMemoryRecord[] = [
      bundleRec({ memory_id: "mem-ps-a", level: "sop" }),
      bundleRec({ memory_id: "mem-ps-b", level: "noted" }), // structure-sop 模式下应被过滤掉
    ];
    const result = applyMemoryImportMode(root, records, "structure-sop", { companyId: "c1" });
    expect(result.totalRecords).toBe(2);
    expect(result.filteredRecords).toBe(1);
    expect(result.imported).toBe(1);
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);
    expect(listGovernedMemoryProposals(root)[0].scopeId).toBe("c1");
  });

  it("applyMemoryImportMode:records 为 undefined(模板没有 seedMemories)→ 安全返回空结果,不抛异常", () => {
    const result = applyMemoryImportMode(root, undefined, "full");
    expect(result).toMatchObject({ imported: 0, skipped: 0, totalRecords: 0, filteredRecords: 0 });
    expect(result.recordIds).toEqual({ governedProposalIds: [], conclusionIds: [], lessonCreatedIds: [], lessonMergedIds: [], proceduralSkillCreatedIds: [], proceduralSkillMergedIds: [] });
  });

  // #9(D6 回滚缺口):导入写回的记录 id 必须交回给调用方记进 install transaction,回滚才能按 id 撤销;
  // "新建"与"upsert 合并进既有记录"分开报——后者删掉会伤及本地原有记忆,回滚只删前者。
  it("#9:importMemoryRecords 返回三条真实 governed proposal id", () => {
    const result = importMemoryRecords(root, [
      bundleRec({ memory_id: "mem-cs-r1", owner_type: "company", owner_id: "c1", content: "结论要点" }),
      bundleRec({ memory_id: "mem-ps-r1", owner_type: "agent", owner_id: "dev", level: "sop" }),
      bundleRec({ memory_id: "mem-ls-r1", owner_type: "agent", owner_id: "dev", content: "把大任务拆成更小的子任务" }),
    ]);
    expect(result.recordIds.governedProposalIds).toHaveLength(3);
    expect(result.recordIds.conclusionIds).toEqual([]);
    expect(result.recordIds.proceduralSkillCreatedIds).toEqual([]);
    expect(result.recordIds.lessonCreatedIds).toEqual([]);
    expect(result.recordIds.proceduralSkillMergedIds).toEqual([]);
    expect(result.recordIds.lessonMergedIds).toEqual([]);
    const proposalIds = new Set(listGovernedMemoryProposals(root).map((r) => r.proposalId));
    expect(result.recordIds.governedProposalIds.every((id) => proposalIds.has(id))).toBe(true);
  });

  it("#9:未审核导入不会覆盖既有 procedural_skill,而是创建独立 proposal", () => {
    const pre = upsertProceduralSkill(root, {
      role: "dev", taskType: undefined, preconditions: [], successfulSequence: ["本地步骤"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r0"], status: "candidate",
    }, NOW);
    const result = importMemoryRecords(root, [
      bundleRec({ memory_id: "mem-ps-merge", owner_type: "agent", owner_id: "dev", level: "sop", source: { type: "run", run_id: "r1", task_id: "" } }),
    ]);
    expect(result.recordIds.governedProposalIds).toHaveLength(1);
    expect(result.recordIds.proceduralSkillCreatedIds).toEqual([]);
    expect(result.recordIds.proceduralSkillMergedIds).toEqual([]);
    const all = loadRegistry(root).filter((r): r is ProceduralSkill => r.kind === "procedural_skill");
    expect(all.find((r) => r.id === pre.id)?.successfulSequence).toEqual(["本地步骤"]);
    expect(all).toHaveLength(1);
    expect(listGovernedMemoryProposals(root)[0]).toMatchObject({
      proposalId: result.recordIds.governedProposalIds[0], objectType: "success_experience", sourceType: "import", status: "proposed",
    });
    expect(listGovernedMemoryProposals(root)[0].content).toBe("导入内容");
    expect(listGovernedMemoryProposals(root)[0].portableBundleRecord?.source.run_id).toBe("r1");
  });

  it("审批后的导入记忆由 canonical layered store 原样导出,未审批和其它公司不外泄", () => {
    const imported = bundleRec({
      memory_id: "mem-cs-portable",
      owner_type: "company",
      owner_id: "source-company",
      scope: "source-company",
      content: "上线前先冒烟再放量",
      level: "verified",
      score: 60,
    });
    const result = importMemoryRecords(root, [imported], { companyId: "target-company" });
    expect(exportMemoryRecordsForCompany(root, "target-company", [])).toEqual([]);
    expect(decideGovernedMemoryProposal(root, result.recordIds.governedProposalIds[0], "approved", "test")?.status).toBe("approved");

    const exported = exportMemoryRecordsForCompany(root, "target-company", []);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      content: imported.content,
      level: imported.level,
      score: imported.score,
      owner_type: "company",
      owner_id: "target-company",
      scope: "target-company",
      source: { ...imported.source, type: "import" },
    });
    expect(exportMemoryRecordsForCompany(root, "other-company", [])).toEqual([]);
  });

  it("preserves non-company owner type and identity after governed import approval", () => {
    const imported = bundleRec({
      memory_id: "mem-ps-portable-agent",
      owner_type: "agent",
      owner_id: "dev",
      scope: "source-company",
      content: "Run the focused regression before merging.",
      level: "sop",
    });
    const result = importMemoryRecords(root, [imported], { companyId: "target-company" });
    expect(decideGovernedMemoryProposal(root, result.recordIds.governedProposalIds[0], "approved", "test")?.status).toBe("approved");

    expect(exportMemoryRecordsForCompany(root, "target-company", ["dev"])[0]).toMatchObject({
      owner_type: "agent",
      owner_id: "dev",
      scope: "target-company",
      content: imported.content,
    });
  });
});
