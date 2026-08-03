import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, Company, Skill } from "@opc/shared";

// applyArchitectActions 的 add/remove/update_agent 落地经由 runtime/orchestrator.js 的
// getAgents/addAgents/updateAgent——那几个函数操作的是该模块级、跨全项目共享的单例状态,不吃调用方
// 传的 projectRoot(与 companyRoutes.test.ts 顶部同一处说明一致)。这里 mock 成一份纯内存实现,行为上
// 忠实复刻真实版本(add 时联动 parent.childrenIds、update 时 Object.assign 原地patch),让测试真能验证
// "父级 childrenIds 是否被正确摘除/加入"这类效果,而不只是空断言"调用过"。
const { mockAgents } = vi.hoisted(() => ({ mockAgents: [] as AgentNodeConfig[] }));
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: () => mockAgents,
  addAgents: (nodes: AgentNodeConfig[]) => {
    let added = 0;
    for (const n of nodes) {
      if (mockAgents.some(a => a.id === n.id)) continue;
      mockAgents.push(n);
      added++;
      if (n.parentId) {
        const parent = mockAgents.find(a => a.id === n.parentId);
        if (parent && !parent.childrenIds.includes(n.id)) parent.childrenIds.push(n.id);
      }
    }
    return added;
  },
  updateAgent: (id: string, patch: Partial<AgentNodeConfig>) => {
    const a = mockAgents.find(x => x.id === id);
    if (a) Object.assign(a, patch);
    return a;
  },
  removeAgentsByCompany: () => 0,
}));

const { mockResolveBinding } = vi.hoisted(() => ({ mockResolveBinding: vi.fn() }));
vi.mock("./adaptiveModelBinding.js", () => ({ resolveAdaptiveModelBinding: mockResolveBinding }));

import {
  ARCHITECT_CHAT_TOPIC_RULES, ARCHITECT_ACTION_TYPES_DOC, ARCHITECT_BEST_PRACTICES, ArchitectActionSchema, buildArchitectContext,
  applyArchitectActions, type ArchitectAction,
} from "./architectAssistant.js";
import { loadCompanies } from "../storage/companyStore.js";

function agent(overrides: Partial<AgentNodeConfig> & { id: string; name: string; role: string }): AgentNodeConfig {
  return {
    parentId: undefined, childrenIds: [], model: "deepseek-chat", provider: "deepseek",
    framework: "hermes", companyId: "co1", status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function resetRoster() {
  mockAgents.length = 0;
  mockAgents.push(
    agent({ id: "ceo-1", name: "CEO", role: "ceo", childrenIds: ["lead-1"] }),
    agent({ id: "lead-1", name: "Lead B", role: "lead", parentId: "ceo-1", childrenIds: ["dev-1"] }),
    agent({ id: "dev-1", name: "Dev A", role: "dev", parentId: "lead-1" }),
  );
}

function setupRoot(company: Partial<Company> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "architect-assistant-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  const co: Company = {
    id: "co1", name: "测试公司", description: "", createdAt: "2026-01-01",
    workflow: { verificationEdges: [] }, presetChannels: [],
    ...company,
  };
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([co]));
  return root;
}

describe("ARCHITECT_CHAT_TOPIC_RULES(对话模式,叠加在真实 CEO 身份之上的话题规则段)", () => {
  it("是非空字符串常量,明确划定只答架构问题、引导日常任务去简报栏", () => {
    expect(typeof ARCHITECT_CHAT_TOPIC_RULES).toBe("string");
    expect(ARCHITECT_CHAT_TOPIC_RULES).toContain("简报栏");
  });

  it("纯问答——不再允许模型输出 JSON/actions(端点级硬保证,和 ARCHITECT_ACTION_TYPES_DOC 无关)", () => {
    // 用户最终定调:对话模式绝不产出结构性修改方案,那是执行模式(architect-decompose)的职责。
    expect(ARCHITECT_CHAT_TOPIC_RULES).not.toContain("```json");
    expect(ARCHITECT_CHAT_TOPIC_RULES).not.toContain("actions");
    expect(ARCHITECT_CHAT_TOPIC_RULES).not.toContain(ARCHITECT_ACTION_TYPES_DOC);
  });

  it("不重新声明身份(不是一份独立的'你是架构助手'系统提示词)——身份来自 resolveCeoForChat 的基底 system", () => {
    // 用户纠正后的设计:这只是叠加在"和该公司真实 CEO 对话"之上的话题规则,不应该再自称一个和
    // CEO 无关的独立身份(比如"架构助手")。
    expect(ARCHITECT_CHAT_TOPIC_RULES).not.toContain("架构助手");
  });

  it("注入了公司架构最佳实践指南(来自 opc-company-architect skill),且不违反对话模式的纯问答约束", () => {
    expect(typeof ARCHITECT_BEST_PRACTICES).toBe("string");
    expect(ARCHITECT_BEST_PRACTICES.length).toBeGreaterThan(100);
    // 关键实战要点在场:按任务选队形 / 过度部署 / 验证关系 / 综合撰写融进答案
    expect(ARCHITECT_BEST_PRACTICES).toContain("过度部署");
    expect(ARCHITECT_BEST_PRACTICES).toContain("验证关系");
    // 已拼进对话规则段(让"公司架构对话"Agent 依据它给建议)
    expect(ARCHITECT_CHAT_TOPIC_RULES).toContain(ARCHITECT_BEST_PRACTICES);
    // 但不能引入结构化输出的禁忌(对话模式仍纯问答)
    expect(ARCHITECT_BEST_PRACTICES).not.toContain("```json");
    expect(ARCHITECT_BEST_PRACTICES).not.toContain("架构助手");
  });
});

describe("ARCHITECT_ACTION_TYPES_DOC", () => {
  it("提到全部 7 种 action 类型", () => {
    for (const t of [
      "add_agent", "remove_agent", "update_agent",
      "add_verification_edge", "remove_verification_edge",
      "add_a2a_channel", "remove_a2a_channel",
    ]) {
      expect(ARCHITECT_ACTION_TYPES_DOC).toContain(t);
    }
  });
});

describe("buildArchitectContext", () => {
  it("把成员/汇报对象/验证边(换算成名字)/A2A通道(换算成名字)序列化成中文描述", () => {
    resetRoster();
    const company: Company = {
      id: "co1", name: "测试公司", description: "", createdAt: "2026-01-01",
      workflow: { verificationEdges: [{ producer: "dev", verifier: "lead", method: "llm-review", onReject: "redo" }] },
      presetChannels: [{ from: "dev-1", to: "lead-1", purpose: "日常同步" }],
      visibilityPolicy: "isolated",
      requiredPermissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false, mcpServers: ["filesystem"] },
      manifestToolRequirements: { requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: ["filesystem"], requiredSkills: ["代码审查"], optionalTools: [] },
    };
    mockAgents[2].workingDirectory = "packages/api";
    mockAgents[2].systemPrompt = "只修改 API 模块";
    const skills: Skill[] = [{
      id: "bundled-review", title: "代码审查", role: "dev", enabled: true,
      lastModified: "2026-01-01", origin: "bundled", companyId: "co1", content: "先运行测试再审查",
    }];
    const ctx = buildArchitectContext(company, mockAgents, skills);
    expect(ctx).toContain("Dev A");
    expect(ctx).toContain("Lead B");
    expect(ctx).toContain("汇报对象:CEO"); // Lead B 汇报给 CEO
    expect(ctx).toContain("Dev A 的产出由 Lead B 用「llm-review」方式核验");
    expect(ctx).toContain("Dev A ↔ Lead B(用途:日常同步)");
    expect(ctx).toContain("工作目录:packages/api");
    expect(ctx).toContain("只修改 API 模块");
    expect(ctx).toContain("代码审查");
    expect(ctx).toContain("先运行测试再审查");
    expect(ctx).toContain('"visibilityPolicy":"isolated"');
    expect(ctx).toContain('"requiredSkills":["代码审查"]');
  });
});

describe("applyArchitectActions", () => {
  let root: string;
  beforeEach(() => {
    resetRoster();
    mockResolveBinding.mockImplementation(async (_root: string, requested?: { framework?: string; provider?: string; model?: string }) => ({
      choice: {
        framework: requested?.framework ?? "api",
        provider: requested?.provider ?? "deepseek",
        model: requested?.model ?? "deepseek-chat",
      },
      source: requested ? "requested" : "system-default",
      substituted: false,
      reason: "test binding",
    }));
  });
  afterEach(() => { if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("add_agent:不给 reportsToName → 默认挂到 CEO 下,CEO.childrenIds 联动更新", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "add_agent", role: "test", name: "小测" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results).toEqual([{ action: actions[0], ok: true }]);
    const created = mockAgents.find(a => a.name === "小测");
    expect(created).toBeTruthy();
    expect(created!.role).toBe("test");
    expect(created!.parentId).toBe("ceo-1");
    expect(created!.provider).toBe("deepseek");
    expect(created!.model).toBe("deepseek-chat");
    expect(mockAgents.find(a => a.id === "ceo-1")!.childrenIds).toContain(created!.id);
  });

  it("add_agent:给定 reportsToName → 挂到指定成员下,支持自定义 provider/model", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "add_agent", role: "security", name: "小安", reportsToName: "Lead B", provider: "anthropic", model: "sonnet" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const created = mockAgents.find(a => a.name === "小安")!;
    expect(created.parentId).toBe("lead-1");
    expect(created.provider).toBe("anthropic");
    expect(created.model).toBe("sonnet");
    expect(mockAgents.find(a => a.id === "lead-1")!.childrenIds).toContain(created.id);
  });

  it("remove_agent:软删除——从父级 childrenIds 摘除 + enabled:false(不硬删除)", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "remove_agent", name: "Dev A" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const devA = mockAgents.find(a => a.id === "dev-1")!;
    expect(devA.enabled).toBe(false);
    expect(mockAgents.find(a => a.id === "lead-1")!.childrenIds).not.toContain("dev-1");
    // 仍然留在列表里(没有被硬删除)
    expect(mockAgents.some(a => a.id === "dev-1")).toBe(true);
  });

  it("update_agent:改名/改模型 + 换汇报对象——旧父级摘除、新父级加入,parentId 同步更新", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "update_agent", name: "Dev A", newName: "Dev A2", model: "deepseek-v4-pro", reportsToName: "CEO" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const devA = mockAgents.find(a => a.id === "dev-1")!;
    expect(devA.name).toBe("Dev A2");
    expect(devA.model).toBe("deepseek-v4-pro");
    expect(devA.parentId).toBe("ceo-1");
    expect(mockAgents.find(a => a.id === "lead-1")!.childrenIds).not.toContain("dev-1");
    expect(mockAgents.find(a => a.id === "ceo-1")!.childrenIds).toContain("dev-1");
  });

  it("add_verification_edge:按 name 解析出 role,patch company.workflow.verificationEdges", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "add_verification_edge", producerName: "Dev A", verifierName: "Lead B", method: "code-review" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const saved = loadCompanies(root).find(c => c.id === "co1")!;
    expect(saved.workflow?.verificationEdges).toEqual([
      { producer: "dev", verifier: "lead", method: "code-review", onReject: "redo", maxRounds: 1 },
    ]);
  });

  it("remove_verification_edge:按 name 解析出 role,从 verificationEdges 里移除匹配项", async () => {
    root = setupRoot({ workflow: { verificationEdges: [{ producer: "dev", verifier: "lead", method: "llm-review", onReject: "redo", maxRounds: 1 }] } });
    const actions: ArchitectAction[] = [{ type: "remove_verification_edge", producerName: "Dev A", verifierName: "Lead B" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const saved = loadCompanies(root).find(c => c.id === "co1")!;
    expect(saved.workflow?.verificationEdges).toEqual([]);
  });

  it("add_a2a_channel:按 name 解析出真实 agent id,patch company.presetChannels", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [{ type: "add_a2a_channel", fromName: "Dev A", toName: "Lead B", purpose: "日常同步" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const saved = loadCompanies(root).find(c => c.id === "co1")!;
    expect(saved.presetChannels).toEqual([{ from: "dev-1", to: "lead-1", purpose: "日常同步" }]);
  });

  it("remove_a2a_channel:按 name 解析出真实 agent id,从 presetChannels 里移除匹配项", async () => {
    root = setupRoot({ presetChannels: [{ from: "dev-1", to: "lead-1", purpose: "日常同步" }] });
    const actions: ArchitectAction[] = [{ type: "remove_a2a_channel", fromName: "Dev A", toName: "Lead B" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(true);
    const saved = loadCompanies(root).find(c => c.id === "co1")!;
    expect(saved.presetChannels).toEqual([]);
  });

  it("找不到 name → ok:false + reason,不阻断同批次里其他合法 action", async () => {
    root = setupRoot();
    const actions: ArchitectAction[] = [
      { type: "remove_agent", name: "不存在的人" },
      { type: "add_agent", role: "dev", name: "小开" },
    ];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toMatch(/未找到/);
    expect(results[1].ok).toBe(true); // 前一条失败不阻断后一条
    expect(mockAgents.some(a => a.name === "小开")).toBe(true);
  });

  it("name 歧义(同名多人)→ ok:false + reason,明确说明无法确定引用哪一个", async () => {
    root = setupRoot();
    mockAgents.push(agent({ id: "dev-2", name: "Dev A", role: "dev", parentId: "lead-1" })); // 同名第二人
    const actions: ArchitectAction[] = [{ type: "update_agent", name: "Dev A", model: "x" }];
    const results = await applyArchitectActions(root, "co1", actions);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toMatch(/不唯一/);
  });

  it("模型绑定不可用时 fail-closed,不创建员工也不修改现有员工", async () => {
    root = setupRoot();
    mockResolveBinding.mockRejectedValue(new Error("没有可用的模型执行方式"));
    const add: ArchitectAction = { type: "add_agent", role: "test", name: "不可执行员工" };
    const update: ArchitectAction = { type: "update_agent", name: "Dev A", model: "missing-model" };
    const results = await applyArchitectActions(root, "co1", [add, update]);
    expect(results).toEqual([
      { action: add, ok: false, reason: "没有可用的模型执行方式" },
      { action: update, ok: false, reason: "没有可用的模型执行方式" },
    ]);
    expect(mockAgents.some((agent) => agent.name === "不可执行员工")).toBe(false);
    expect(mockAgents.find((agent) => agent.id === "dev-1")?.model).toBe("deepseek-chat");
  });
});

describe("ArchitectActionSchema", () => {
  it("接受 10 种合法类型各一个实例", () => {
    const samples: unknown[] = [
      { type: "add_agent", role: "dev", name: "a" },
      { type: "remove_agent", name: "a" },
      { type: "update_agent", name: "a" },
      { type: "add_verification_edge", producerName: "a", verifierName: "b", method: "llm-review" },
      { type: "remove_verification_edge", producerName: "a", verifierName: "b" },
      { type: "add_a2a_channel", fromName: "a", toName: "b" },
      { type: "remove_a2a_channel", fromName: "a", toName: "b" },
      { type: "upsert_bundled_skill", skillName: "review", content: "steps", roles: ["dev"] },
      { type: "remove_bundled_skill", skillName: "review" },
      { type: "update_company_governance", requiredPermissions: { allowShell: true } },
    ];
    for (const s of samples) expect(ArchitectActionSchema.safeParse(s).success).toBe(true);
  });

  it("拒绝未知 type 和缺字段", () => {
    const added = ArchitectActionSchema.parse({ type: "add_agent", role: "tech_lead", name: "技术主管" });
    const updated = ArchitectActionSchema.parse({ type: "update_agent", name: "技术主管", role: "engineering-lead" });
    const skill = ArchitectActionSchema.parse({ type: "upsert_bundled_skill", skillName: "交付", content: "规则", roles: ["tech_lead", "dev"] });
    expect(added.type === "add_agent" && added.role).toBe("lead");
    expect(updated.type === "update_agent" && updated.role).toBe("lead");
    expect(skill.type === "upsert_bundled_skill" && skill.roles).toEqual(["lead", "dev"]);
    expect(ArchitectActionSchema.safeParse({ type: "delete_everything" }).success).toBe(false);
    expect(ArchitectActionSchema.safeParse({ type: "add_agent", role: "dev" }).success).toBe(false); // 缺 name
    expect(ArchitectActionSchema.safeParse({ type: "add_verification_edge", producerName: "a", verifierName: "b", method: "unsupported" }).success).toBe(false); // 未知 method
  });
});
