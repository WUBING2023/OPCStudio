import { describe, it, expect } from "vitest";
import type { EngineAvailability } from "@opc/shared";
import { collectCliStatus, type CliStatusProbes } from "./onboardingRoutes.js";

// 定稿 2.3 首跑第 1 步 CLI 检测端点。用注入的假探针覆盖聚合逻辑:不真装 CLI、不起服务、绝不打真实
// 模型——只验证归一化(installed/version/loggedIn)、anyInstalled/anyLoggedIn 汇总、单探针抛错的降级。
function av(partial: Partial<EngineAvailability>): EngineAvailability {
  return { framework: "claude-code", installed: false, loggedIn: false, version: "", ...partial } as EngineAvailability;
}

function probes(over: Partial<CliStatusProbes> = {}): CliStatusProbes {
  return {
    claude: async () => av({ framework: "claude-code", installed: false }),
    codex: async () => av({ framework: "codex", installed: false }),
    gemini: async () => av({ framework: "gemini-cli", installed: false }),
    kimi: async () => av({ framework: "kimi-cli", installed: false }),
    grok: async () => av({ framework: "grok-build", installed: false }),
    ...over,
  };
}

describe("collectCliStatus · 首跑 CLI 检测聚合(mock probes)", () => {
  it("三家全未安装:engines 三条、anyInstalled/anyLoggedIn 均 false", async () => {
    const r = await collectCliStatus(probes());
    expect(r.engines.map((e) => e.framework)).toEqual(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
    expect(r.engines.every((e) => e.installed === false && e.loggedIn === false)).toBe(true);
    expect(r.anyInstalled).toBe(false);
    expect(r.anyLoggedIn).toBe(false);
  });

  it("claude 已装已登录:透传 version/loggedIn,anyInstalled+anyLoggedIn 置真", async () => {
    const r = await collectCliStatus(probes({
      claude: async () => av({ framework: "claude-code", installed: true, loggedIn: true, version: "1.2.3 (Claude Code)" }),
    }));
    const claude = r.engines.find((e) => e.framework === "claude-code")!;
    expect(claude).toMatchObject({ installed: true, loggedIn: true, version: "1.2.3 (Claude Code)" });
    expect(r.anyInstalled).toBe(true);
    expect(r.anyLoggedIn).toBe(true);
  });

  it("codex 已装未登录:installed 真 / loggedIn 假,anyInstalled 真但 anyLoggedIn 假", async () => {
    const r = await collectCliStatus(probes({
      codex: async () => av({ framework: "codex", installed: true, loggedIn: false, version: "codex 0.9" }),
    }));
    expect(r.engines.find((e) => e.framework === "codex")).toMatchObject({ installed: true, loggedIn: false, version: "codex 0.9" });
    expect(r.anyInstalled).toBe(true);
    expect(r.anyLoggedIn).toBe(false);
  });

  it("gemini 只有 installed/version,loggedIn 恒为 false(本步骤不臆测其登录态)", async () => {
    const r = await collectCliStatus(probes({
      gemini: async () => av({ framework: "gemini-cli", installed: true, loggedIn: false, version: "0.4.1" }),
    }));
    expect(r.engines.find((e) => e.framework === "gemini-cli")).toMatchObject({ installed: true, loggedIn: false, version: "0.4.1" });
    expect(r.anyInstalled).toBe(true);
  });

  it("单个探针抛错:降级为未安装,不拖垮整体聚合", async () => {
    const r = await collectCliStatus(probes({
      claude: async () => { throw new Error("spawn claude ENOENT"); },
      codex: async () => av({ framework: "codex", installed: true, loggedIn: true, version: "1.0" }),
    }));
    expect(r.engines.find((e) => e.framework === "claude-code")).toMatchObject({ installed: false, loggedIn: false });
    expect(r.anyInstalled).toBe(true);
    expect(r.anyLoggedIn).toBe(true);
  });
});
