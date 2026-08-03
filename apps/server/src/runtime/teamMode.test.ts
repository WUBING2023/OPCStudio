import { describe, it, expect } from "vitest";
import { effEngineForMode } from "./orchestrator.js";

// Stage 2 · Team Mode 引擎策略映射(纯函数,run 级覆盖不持久化)。
describe("effEngineForMode · Team Mode 引擎策略", () => {
  it("无 mode → null(用 agent 自身配置)", () => {
    expect(effEngineForMode("lead", undefined)).toBeNull();
    expect(effEngineForMode("dev", undefined)).toBeNull();
  });

  it("economy → 全 deepseek/api", () => {
    for (const role of ["ceo", "lead", "dev", "test"]) {
      expect(effEngineForMode(role, "economy")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
    }
  });

  it("maxQuality → 全 sonnet/claude-code", () => {
    for (const role of ["ceo", "lead", "dev", "test"]) {
      expect(effEngineForMode(role, "maxQuality")).toEqual({ framework: "claude-code", provider: "anthropic", model: "sonnet" });
    }
  });

  it("balanced → 协调+核查(lead/test)用 sonnet,执行(ceo/dev)用 deepseek", () => {
    expect(effEngineForMode("lead", "balanced")?.framework).toBe("claude-code");
    expect(effEngineForMode("test", "balanced")?.framework).toBe("claude-code");
    expect(effEngineForMode("dev", "balanced")?.framework).toBe("api");
    expect(effEngineForMode("ceo", "balanced")?.framework).toBe("api");
  });
});
