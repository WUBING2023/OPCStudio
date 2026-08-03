// P0-1 · 导入绑定计划单测:五种缺失场景 + applyImportBindingPlans 的 map/disable/configure 语义。
// 纯函数,不打真模型/不起路由;覆盖用户验收口径:
//   ① 缺 DeepSeek provider(有候选替代)  ② 缺 Codex 引擎  ③ 缺 Claude 引擎
//   ④ 缺 MCP 服务器  ⑤ 无可替代模型(候选为空)
import { describe, it, expect } from "vitest";
import type { CompanyTemplate, AgentNodeConfig } from "@opc/shared";
import { buildImportBindingPlans, applyImportBindingPlans, type ImportBindingPlanItem } from "./companyTemplate.js";

function agent(overrides: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "a-1", name: "A", role: "dev", childrenIds: [], provider: "deepseek", model: "deepseek-v4-pro",
    framework: "api", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function tpl(agents: AgentNodeConfig[], extra: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-1", title: "T", description: "", author: "x", createdAt: "2026-07-21T00:00:00Z",
    tags: [], downloads: 0, stars: 0, license: "OPC-Original", readme: "", agents,
    ...extra,
  } as CompanyTemplate;
}

const localFull = {
  availableProviders: new Set(["deepseek", "minimax"]),
  availableEngines: new Set(["api", "claude-code", "codex"]),
  availableMcpServers: new Set(["ddg-search"]),
  defaultModelFor: (p: string) => (p === "minimax" ? "MiniMax-M3" : undefined),
};

describe("buildImportBindingPlans · 五种缺失场景", () => {
  it("① 缺 DeepSeek provider(本机无 key,有 minimax 候选)→ missing + candidates 带默认模型", () => {
    const plans = buildImportBindingPlans(tpl([agent()]), {
      availableProviders: new Set(["minimax"]),
      availableEngines: new Set(["api"]),
      availableMcpServers: new Set(),
      defaultModelFor: (p) => (p === "minimax" ? "MiniMax-M3" : undefined),
    });
    const provider = plans.find((p) => p.originalBinding.kind === "provider");
    expect(provider?.status).toBe("missing");
    expect(provider?.action).toBe("configure");
    expect(provider?.userApproved).toBe(false);
    expect(provider?.candidates).toHaveLength(1);
    expect(provider?.candidates?.[0]).toMatchObject({ provider: "minimax", model: "MiniMax-M3", recommended: true });
    // model 诚实派生:provider 缺失 → model 同样 missing,注明派生原因,绝不一律 available
    const model = plans.find((p) => p.originalBinding.kind === "model");
    expect(model?.status).toBe("missing");
    expect(model?.reason).toContain("deepseek");
  });

  it("② 缺 Codex 引擎(模板 requiredEngines 含 codex,本机未登录)→ engine missing", () => {
    const plans = buildImportBindingPlans(
      tpl([agent({ framework: "codex", provider: "openai" })], {
        toolRequirements: { requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
      }),
      { availableProviders: new Set(), availableEngines: new Set(["api"]), availableMcpServers: new Set() },
    );
    const engine = plans.find((p) => p.originalBinding.kind === "engine" && p.originalBinding.name === "codex");
    expect(engine?.status).toBe("missing");
    expect(engine?.action).toBe("configure");
  });

  it("③ 缺 Claude 引擎(claude-code 未登录)→ engine missing", () => {
    const plans = buildImportBindingPlans(
      tpl([agent({ framework: "claude-code", provider: "anthropic" })], {
        toolRequirements: { requiredEngines: ["claude-code"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
      }),
      { availableProviders: new Set(), availableEngines: new Set(["api"]), availableMcpServers: new Set() },
    );
    const engine = plans.find((p) => p.originalBinding.kind === "engine" && p.originalBinding.name === "claude-code");
    expect(engine?.status).toBe("missing");
  });

  it("④ 缺 MCP 服务器 → mcp missing;enabled 的 MCP 视为可用", () => {
    const plans = buildImportBindingPlans(
      tpl([agent()], {
        toolRequirements: { requiredEngines: ["api"], requiredProviders: [], requiredMcpServers: ["ddg-search"], requiredSkills: [], optionalTools: [] },
      }),
      localFull,
    );
    const mcp = plans.find((p) => p.originalBinding.kind === "mcp");
    expect(mcp?.status).toBe("available"); // localFull 有 ddg-search
    const missing = buildImportBindingPlans(
      tpl([agent()], {
        toolRequirements: { requiredEngines: ["api"], requiredProviders: [], requiredMcpServers: ["fetch-x"], requiredSkills: [], optionalTools: [] },
      }),
      localFull,
    ).find((p) => p.originalBinding.kind === "mcp");
    expect(missing?.status).toBe("missing");
  });

  it("⑤ 无可替代模型(本机无任何 provider)→ provider missing 且 candidates 为空数组", () => {
    const plans = buildImportBindingPlans(tpl([agent()]), {
      availableProviders: new Set(),
      availableEngines: new Set(["api"]),
      availableMcpServers: new Set(),
    });
    const provider = plans.find((p) => p.originalBinding.kind === "provider");
    expect(provider?.status).toBe("missing");
    expect(provider?.candidates).toEqual([]);
  });

  it("provider 可用 → keep + userApproved=true,model 同步 available", () => {
    const plans = buildImportBindingPlans(tpl([agent()]), localFull);
    const provider = plans.find((p) => p.originalBinding.kind === "provider");
    expect(provider?.status).toBe("available");
    expect(provider?.action).toBe("keep");
    expect(provider?.userApproved).toBe(true);
    const model = plans.find((p) => p.originalBinding.kind === "model");
    expect(model?.status).toBe("available");
  });

  it("offers configured API providers as replacements for a missing subscription engine", () => {
    const plans = buildImportBindingPlans(
      tpl([agent({ framework: "codex", provider: "openai", model: "gpt-5.5" })], {
        toolRequirements: { requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
      }),
      {
        availableProviders: new Set(["minimax"]),
        availableEngines: new Set(["api"]),
        availableMcpServers: new Set(),
        defaultModelFor: () => "MiniMax-M3",
      },
    );
    expect(plans.find((p) => p.originalBinding.kind === "engine")?.candidates).toContainEqual(expect.objectContaining({
      engine: "api", provider: "minimax", model: "MiniMax-M3",
    }));
  });

  it("关键岗位缺强模型时优先推荐本机强档候选,而不是按 provider 枚举顺序盲选", () => {
    const plans = buildImportBindingPlans(tpl([
      agent({ role: "ceo", model: "deepseek-v4-pro" }),
    ]), {
      availableProviders: new Set(["fast-provider", "strong-provider"]),
      availableEngines: new Set(["api"]),
      availableMcpServers: new Set(),
      defaultModelFor: (provider) => provider === "fast-provider" ? "flash-lite" : "sonnet-pro",
    });
    const candidates = plans.find((plan) => plan.originalBinding.kind === "provider")?.candidates;
    expect(candidates?.[0]).toMatchObject({
      provider: "strong-provider", model: "sonnet-pro", recommended: true,
    });
    expect(candidates?.[0].recommendationReason).toContain("启发式");
  });

  it("deduplicates model binding rows by provider and model", () => {
    const plans = buildImportBindingPlans(tpl([
      agent({ id: "a-1" }),
      agent({ id: "a-2" }),
    ]), { ...localFull, availableProviders: new Set() });
    expect(plans.filter((p) => p.originalBinding.kind === "model")).toHaveLength(1);
  });
});

describe("applyImportBindingPlans · 落地语义", () => {
  it("map(userApproved) → 改写受影响员工的 provider/model,其余员工不变", () => {
    const agents = [agent({ id: "a-1" }), agent({ id: "a-2", provider: "minimax", model: "MiniMax-M3" })];
    const plans: ImportBindingPlanItem[] = [{
      originalBinding: { kind: "provider", name: "deepseek" }, status: "missing",
      action: "map", targetBinding: { provider: "minimax", model: "MiniMax-M3" }, userApproved: true,
    }];
    const out = applyImportBindingPlans(tpl(agents), plans);
    expect(out.agents[0].provider).toBe("minimax");
    expect(out.agents[0].model).toBe("MiniMax-M3");
    expect(out.agents[0].enabled).toBe(true); // map 成功,员工保持启用
    expect(out.agents[1].provider).toBe("minimax"); // 本就 minimax,不受影响
  });

  it("disable(userApproved) → 受影响员工 enabled=false", () => {
    const plans: ImportBindingPlanItem[] = [{
      originalBinding: { kind: "provider", name: "deepseek" }, status: "missing",
      action: "disable", userApproved: true,
    }];
    const out = applyImportBindingPlans(tpl([agent()]), plans);
    expect(out.agents[0].enabled).toBe(false);
    expect(out.agents[0].provider).toBe("deepseek"); // disable 不改写绑定,只禁用
  });

  it("configure 未确认(userApproved=false)→ 诚实降级为 disable(不留运行时炸点)", () => {
    const plans: ImportBindingPlanItem[] = [{
      originalBinding: { kind: "provider", name: "deepseek" }, status: "missing",
      action: "configure", userApproved: false,
    }];
    const out = applyImportBindingPlans(tpl([agent()]), plans);
    expect(out.agents[0].enabled).toBe(false);
  });

  it("keep(userApproved) → 原样;订阅 CLI 员工(claude-code/codex)不受 provider 计划影响", () => {
    const agents = [
      agent({ id: "a-1" }),
      agent({ id: "a-2", framework: "codex", provider: "openai" }),
    ];
    const plans: ImportBindingPlanItem[] = [
      { originalBinding: { kind: "provider", name: "deepseek" }, status: "available", action: "keep", userApproved: true },
      { originalBinding: { kind: "provider", name: "openai" }, status: "missing", action: "map", targetBinding: { provider: "minimax" }, userApproved: true },
    ];
    const out = applyImportBindingPlans(tpl(agents), plans);
    expect(out.agents[0].provider).toBe("deepseek");
    // codex 订阅员工不走 API provider 映射——openai 计划对它无操作
    expect(out.agents[1].provider).toBe("openai");
    expect(out.agents[1].enabled).toBe(true);
  });

  it("计划指向模板未引用的 provider → 无操作(纵深防御)", () => {
    const plans: ImportBindingPlanItem[] = [{
      originalBinding: { kind: "provider", name: "openai" }, status: "missing",
      action: "disable", userApproved: true,
    }];
    const out = applyImportBindingPlans(tpl([agent()]), plans);
    expect(out.agents[0].enabled).toBe(true); // 模板员工用 deepseek,openai 计划无关
  });

  it("applies engine disable to subscription workers", () => {
    const out = applyImportBindingPlans(tpl([agent({ framework: "codex", provider: "openai" })]), [{
      originalBinding: { kind: "engine", name: "codex" }, status: "missing",
      action: "disable", userApproved: true,
    }]);
    expect(out.agents[0].enabled).toBe(false);
  });

  it("maps a missing subscription engine to an available API provider and rewrites requirements", () => {
    const source = tpl([agent({ framework: "codex", provider: "openai", model: "gpt-5.5" })], {
      toolRequirements: {
        requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [],
      },
    });
    const out = applyImportBindingPlans(source, [{
      originalBinding: { kind: "engine", name: "codex" }, status: "missing",
      action: "map", targetBinding: { engine: "api", provider: "minimax", model: "MiniMax-M3" }, userApproved: true,
    }]);
    expect(out.agents[0]).toMatchObject({ framework: "api", provider: "minimax", model: "MiniMax-M3", enabled: true });
    expect(out.toolRequirements?.requiredEngines).toEqual(["api"]);
  });

  it("rewrites provider requirements when mapping an API provider", () => {
    const source = tpl([agent()], {
      toolRequirements: {
        requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: [], requiredSkills: [], optionalTools: [],
      },
    });
    const out = applyImportBindingPlans(source, [{
      originalBinding: { kind: "provider", name: "deepseek" }, status: "missing",
      action: "map", targetBinding: { provider: "minimax", model: "MiniMax-M3" }, userApproved: true,
    }]);
    expect(out.toolRequirements?.requiredProviders).toEqual(["minimax"]);
  });

  it("applies an explicit model mapping", () => {
    const out = applyImportBindingPlans(tpl([agent()]), [{
      originalBinding: { kind: "model", name: "deepseek-v4-pro" }, status: "missing",
      action: "map", targetBinding: { provider: "minimax", model: "MiniMax-M3" }, userApproved: true,
    }]);
    expect(out.agents[0]).toMatchObject({ provider: "minimax", model: "MiniMax-M3", enabled: true });
  });

  it("removes a disabled MCP dependency from both portable declarations", () => {
    const source = tpl([agent()], {
      toolRequirements: {
        requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: ["fetch", "search"],
        requiredSkills: [], optionalTools: [],
      },
      mcpRequirements: [{ name: "fetch" }, { name: "search" }],
    });
    const out = applyImportBindingPlans(source, [{
      originalBinding: { kind: "mcp", name: "fetch" }, status: "missing",
      action: "disable", userApproved: true,
    }]);
    expect(out.toolRequirements?.requiredMcpServers).toEqual(["search"]);
    expect(out.mcpRequirements?.map((m) => m.name)).toEqual(["search"]);
  });
});
