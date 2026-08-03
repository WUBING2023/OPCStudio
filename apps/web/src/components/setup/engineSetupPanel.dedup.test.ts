import { describe, it, expect } from "vitest";
import type { EngineAvailability } from "@opc/shared";
import { planInitialProbe } from "./EngineSetupPanel.js";
import { cliStatusToFrameworks } from "../onboarding/OnboardingFlow.js";

// 引导 CLI 检测去重回归(用户实测:引导里 CLI 检测出现两次)。修复:第 1 步已探过一次
// (/onboarding/cli-status),第 2 步复用 EngineSetupPanel 时把那次结果作为 initialFrameworks 传下去,
// 面板据此跳过挂载首探(/frameworks)——整条引导只探一次。无种子(设置页 / 旧引导独立复用)时仍挂载
// 即自探,行为不回归。组件无 DOM 测试基建,这里驱动组件挂载真正用来 gate 首探的同一份纯决策函数
// planInitialProbe(EngineSetupPanel effect 里 `if (shouldSelfProbe.current) refreshFrameworks()`)做
// "探测计数"断言。

// 用 planInitialProbe.shouldProbe 模拟一次挂载,数真正会发出的探测次数(与组件 effect 逻辑一一对应)。
function mountProbeCount(initial?: EngineAvailability[]): number {
  let probes = 0;
  if (planInitialProbe(initial).shouldProbe) probes += 1;
  return probes;
}

// 第 1 步身份页探回来的订阅 CLI 状态(cli-status 形状)。
const cliLoaded = {
  engines: [
    { framework: "claude-code", installed: true, loggedIn: true, version: "1.2.3" },
    { framework: "codex", installed: false, loggedIn: false, version: "" },
    { framework: "gemini-cli", installed: true, loggedIn: false, version: "0.4.1" },
  ],
  anyInstalled: true,
  anyLoggedIn: true,
};

describe("第 2 步复用 EngineSetupPanel:有种子则跳过首探", () => {
  it("父级把第 1 步结果作种子传下 → 挂载不再探测(计数 0),种子直接作初始状态", () => {
    const seed = cliStatusToFrameworks(cliLoaded);
    expect(seed).toBeTruthy();
    expect(mountProbeCount(seed)).toBe(0);
    expect(planInitialProbe(seed).seed).toEqual(seed);
  });
});

describe("整条引导 CLI 只探一次(第 1 步 + 第 2 步合计)", () => {
  it("第 1 步 cli-status 探 1 次 + 第 2 步复用面板探 0 次 = 合计 1 次", () => {
    const step1Probes = 1; // OnboardingFlow 挂载时固定探一次 /onboarding/cli-status
    const step2Probes = mountProbeCount(cliStatusToFrameworks(cliLoaded));
    expect(step1Probes + step2Probes).toBe(1);
  });
});

describe("无 prop / 探测尚未回来:行为不回归", () => {
  it("无 initialFrameworks(设置页 / 旧引导)→ 挂载自探一次(计数 1)", () => {
    expect(mountProbeCount(undefined)).toBe(1);
    expect(planInitialProbe(undefined).shouldProbe).toBe(true);
    expect(planInitialProbe(undefined).seed).toEqual([]);
  });

  it("cli 尚未探回(null)→ mapper 返回 undefined → 面板回退自探(计数 1)", () => {
    expect(cliStatusToFrameworks(null)).toBeUndefined();
    expect(mountProbeCount(cliStatusToFrameworks(null))).toBe(1);
  });

  it("空种子(空数组)不被误判为已探 → 仍自探(计数 1)", () => {
    expect(mountProbeCount([])).toBe(1);
    expect(planInitialProbe([]).shouldProbe).toBe(true);
  });
});

describe("cliStatusToFrameworks 映射契约", () => {
  it("四字段透传(framework/installed/loggedIn/version),gemini 项保留(下游只匹配 claude-code/codex 无害忽略)", () => {
    const fw = cliStatusToFrameworks(cliLoaded)!;
    expect(fw.map((f) => f.framework)).toEqual(["claude-code", "codex", "gemini-cli"]);
    expect(fw.find((f) => f.framework === "claude-code")).toMatchObject({ installed: true, loggedIn: true, version: "1.2.3" });
    expect(fw.find((f) => f.framework === "codex")).toMatchObject({ installed: false, loggedIn: false, version: "" });
  });

  it("null → undefined(不是空数组;空数组会被 planInitialProbe 判为需自探,语义不同)", () => {
    expect(cliStatusToFrameworks(null)).toBeUndefined();
  });
});
