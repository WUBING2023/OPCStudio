import { describe, it, expect } from "vitest";
import {
  CAPABILITY_TABLE,
  pickEngineForRole,
  type AgentCapabilities,
} from "./agentCapabilities.js";

describe("CAPABILITY_TABLE — 四大 provider 能力基线", () => {
  it("包含 api / claude-code / codex / generic-cli 四条", () => {
    expect(Object.keys(CAPABILITY_TABLE).sort()).toEqual(
      ["api", "claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"].sort(),
    );
  });

  it("api: api-key + stateful session + A2A + riskLevel medium", () => {
    const h = CAPABILITY_TABLE["api"];
    expect(h.authMode).toBe("api-key");
    expect(h.supportsStatefulSession).toBe(true);
    expect(h.supportsA2A).toBe(true);
    expect(h.riskLevel).toBe("medium");
    // api 没有原生文件编辑
    expect(h.supportsFileEditing).toBe(false);
  });

  it("claude-code: subscription + 文件编辑 + MCP + riskLevel high", () => {
    const cc = CAPABILITY_TABLE["claude-code"];
    expect(cc.authMode).toBe("user-cli-subscription");
    expect(cc.supportsFileEditing).toBe(true);
    expect(cc.supportsMCP).toBe(true);
    expect(cc.supportsStreaming).toBe(true);
    expect(cc.riskLevel).toBe("high");
    // 无原生 A2A，靠 OPC 桥接
    expect(cc.supportsA2A).toBe(false);
    expect(cc.supportsStatefulSession).toBe(false);
  });

  it("codex: subscription + 文件编辑 + 无 MCP + riskLevel medium（沙箱）", () => {
    const cx = CAPABILITY_TABLE["codex"];
    expect(cx.authMode).toBe("user-cli-subscription");
    expect(cx.supportsFileEditing).toBe(true);
    expect(cx.supportsStructuredOutput).toBe(true);
    expect(cx.supportsMCP).toBe(false);
    expect(cx.riskLevel).toBe("medium");
  });

  it("generic-cli: 全能力关闭 + authMode unknown + riskLevel low", () => {
    const g = CAPABILITY_TABLE["generic-cli"];
    expect(g.authMode).toBe("unknown");
    expect(g.supportsStreaming).toBe(false);
    expect(g.supportsFileEditing).toBe(false);
    expect(g.supportsShellExecution).toBe(false);
    expect(g.supportsStructuredOutput).toBe(false);
    expect(g.supportsStatefulSession).toBe(false);
    expect(g.supportsMCP).toBe(false);
    expect(g.supportsA2A).toBe(false);
    expect(g.recommendedRoles).toHaveLength(0);
    expect(g.riskLevel).toBe("low");
  });

  it("所有条目满足 AgentCapabilities 类型形状", () => {
    const boolFields: (keyof AgentCapabilities)[] = [
      "supportsStreaming",
      "supportsFileEditing",
      "supportsShellExecution",
      "supportsStructuredOutput",
      "supportsStatefulSession",
      "supportsMCP",
      "supportsA2A",
    ];
    for (const entry of Object.values(CAPABILITY_TABLE)) {
      for (const k of boolFields) {
        expect(typeof entry[k], `${entry.provider}.${k} 应为 boolean`).toBe("boolean");
      }
      expect(Array.isArray(entry.recommendedRoles)).toBe(true);
      expect(["low", "medium", "high"]).toContain(entry.riskLevel);
      expect(["api-key", "user-cli-subscription", "oauth", "unknown"]).toContain(entry.authMode);
    }
  });
});

describe("pickEngineForRole — 按角色选最优 provider", () => {
  it("role=dev 且 codex 可用时优先选 codex", () => {
    expect(pickEngineForRole("dev", ["api", "codex"])).toBe("codex");
  });

  it("role=researcher 且 api 可用时优先选 api", () => {
    expect(pickEngineForRole("researcher", ["claude-code", "api"])).toBe("api");
  });

  it("role=lead 优先选 claude-code", () => {
    expect(pickEngineForRole("lead", ["api", "codex", "claude-code"])).toBe("claude-code");
  });

  it("role=ceo 且只有 api 可用时返回 api", () => {
    expect(pickEngineForRole("ceo", ["api"])).toBe("api");
  });

  it("role=worker 有 api 和 claude-code 时优先 api（stateful session）", () => {
    expect(pickEngineForRole("worker", ["claude-code", "api"])).toBe("api");
  });

  it("首选不可用时降到次选", () => {
    // lead 首选 claude-code，不可用时选 api
    expect(pickEngineForRole("lead", ["api", "codex"])).toBe("api");
  });

  it("available 为空时返回 null", () => {
    expect(pickEngineForRole("dev", [])).toBeNull();
  });

  it("未知 role 降级到 api 优先", () => {
    expect(pickEngineForRole("future-role", ["codex", "api"])).toBe("api");
  });

  it("所有标准 provider 均不可用时兜底返回 available[0]", () => {
    // "my-custom-cli" 不在任何偏好列表里
    expect(pickEngineForRole("dev", ["my-custom-cli"])).toBe("my-custom-cli");
  });

  it("只有 generic-cli 可用时也能正常返回（在偏好列表末位）", () => {
    expect(pickEngineForRole("dev", ["generic-cli"])).toBe("generic-cli");
  });
});
