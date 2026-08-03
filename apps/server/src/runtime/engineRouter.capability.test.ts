import { describe, it, expect } from "vitest";
import { capabilityFor, frameworkPolicy, routeEngine, getEngine, normalizeFramework } from "./engineRouter.js";

// WS6 集成:capabilityFor 暴露框架能力画像;frameworkPolicy 附带 riskLevel(加性,不改 allow 决策)。
describe("engineRouter ⇄ agentCapabilities (WS6 集成)", () => {
  it("capabilityFor 返回已知框架的能力画像", () => {
    const api = capabilityFor("api");
    expect(api).toBeDefined();
    expect(api?.provider).toBe("api");
    expect(["low", "medium", "high"]).toContain(api?.riskLevel);
  });

  it("capabilityFor 无参默认 api", () => {
    expect(capabilityFor()?.provider).toBe("api");
  });

  it("capabilityFor 读侧 alias:历史值 hermes 归一到 api 画像", () => {
    expect(capabilityFor("hermes")?.provider).toBe("api");
  });

  it("frameworkPolicy 放行已知框架并附带 riskLevel", () => {
    const p = frameworkPolicy({ framework: "api", role: "dev" });
    expect(p.allowed).toBe(true);
    expect(["low", "medium", "high"]).toContain(p.riskLevel);
  });

  it("frameworkPolicy 放行历史值 hermes(存量节点绝不因 alias 变 restricted)", () => {
    const p = frameworkPolicy({ framework: "hermes", role: "dev" });
    expect(p.allowed).toBe(true);
  });

  it("frameworkPolicy 拦截未知框架(行为不变)", () => {
    const p = frameworkPolicy({ framework: "bogus" as never, role: "dev" });
    expect(p.allowed).toBe(false);
    expect(p.reason).toContain("未知执行框架");
  });
});

describe("normalizeFramework — hermes/缺省 归一 api", () => {
  it("hermes → api;undefined/空 → api;其余原样", () => {
    expect(normalizeFramework("hermes")).toBe("api");
    expect(normalizeFramework(undefined)).toBe("api");
    expect(normalizeFramework("claude-code")).toBe("claude-code");
    expect(normalizeFramework("codex")).toBe("codex");
  });
});

describe("routeEngine — capability-aware dispatch (引擎路由加性阶段)", () => {
  it("返回实际引擎对象(不为 null)", () => {
    const r = routeEngine("api", "worker");
    expect(r.engine).toBeDefined();
  });

  it("chosenProvider 与传入 framework 一致", () => {
    expect(routeEngine("api", "researcher").chosenProvider).toBe("api");
  });

  it("framework 未传时 chosenProvider 默认 api", () => {
    expect(routeEngine(undefined, "worker").chosenProvider).toBe("api");
  });

  it("历史值 hermes:chosenProvider 归一为 api,引擎解析到 ApiEngine", () => {
    const r = routeEngine("hermes", "worker");
    expect(r.chosenProvider).toBe("api");
    expect(r.engine.framework).toBe("api");
    expect(getEngine("hermes")).toBe(getEngine("api"));
  });

  it("riskLevel 是合法值", () => {
    const r = routeEngine("api", "ceo");
    expect(["low", "medium", "high"]).toContain(r.riskLevel);
  });

  it("api+researcher: idealProvider=api → capabilityMatch=true", () => {
    const r = routeEngine("api", "researcher");
    expect(r.idealProvider).toBe("api");
    expect(r.capabilityMatch).toBe(true);
  });

  it("api+lead: idealProvider=claude-code(不匹配) → capabilityMatch=false,但不抛", () => {
    // lead 的能力偏好 = claude-code; 当前 framework=api → gap
    const r = routeEngine("api", "lead");
    expect(r.idealProvider).toBe("claude-code");
    expect(r.capabilityMatch).toBe(false);
    expect(r.engine).toBeDefined(); // engine 仍正常返回
  });

  it("role 未传时不抛(默认 worker 偏好)", () => {
    expect(() => routeEngine("api", undefined)).not.toThrow();
  });
});
