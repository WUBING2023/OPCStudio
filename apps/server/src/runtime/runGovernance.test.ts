// E3 · Run Governance 判级规则单测:纯函数,规则确定性——每条 reason 对应真实命中的规则。
import { describe, it, expect } from "vitest";
import { decideGovernanceLevel, governanceLevelFromRank, governanceLevelRank } from "./runGovernance.js";

const base = {
  frameworks: ["api", "api"] as ("api" | "hermes" | "claude-code")[],
  writesFiles: false,
  involvesMcp: false,
  involvesAcp: false,
  involvesShell: false,
  fullHostAccess: false,
};

describe("decideGovernanceLevel — 规则档位", () => {
  it("无任何信号 → L0 只记录", () => {
    const d = decideGovernanceLevel({ ...base });
    expect(d.level).toBe("L0");
    expect(d.reason.join()).toContain("L0 只记录");
  });

  it("写文件 → 至少 L1", () => {
    const d = decideGovernanceLevel({ ...base, writesFiles: true });
    expect(d.level).toBe("L1");
    expect(d.reason.join()).toContain("质量门");
  });

  it("MCP → 至少 L2;ACP → 至少 L2", () => {
    expect(decideGovernanceLevel({ ...base, involvesMcp: true }).level).toBe("L2");
    expect(decideGovernanceLevel({ ...base, involvesAcp: true }).level).toBe("L2");
  });

  it("含 CLI 子进程型后端(非 API 引擎)→ 至少 L2;纯 api(含历史 alias hermes)不因后端升级", () => {
    expect(decideGovernanceLevel({ ...base, frameworks: ["api", "claude-code"] }).level).toBe("L2");
    expect(decideGovernanceLevel({ ...base, frameworks: ["api", undefined] }).level).toBe("L0");
    expect(decideGovernanceLevel({ ...base, frameworks: ["hermes", "hermes"] }).level).toBe("L0");
  });

  it("shell → L3", () => {
    const d = decideGovernanceLevel({ ...base, involvesShell: true });
    expect(d.level).toBe("L3");
    expect(d.reason.join()).toContain("人工审批");
  });

  it("确定性:同输入同输出", () => {
    const input = { ...base, writesFiles: true, involvesMcp: true };
    expect(decideGovernanceLevel(input)).toEqual(decideGovernanceLevel(input));
  });
});

describe("decideGovernanceLevel — 与复杂度预估合流(一致采纳/冲突取严)", () => {
  it("预估与规则一致 → 直接采纳并写明", () => {
    const d = decideGovernanceLevel({
      ...base, involvesMcp: true,
      complexityEstimate: { complexity: "L", recommended_governance_level: 2 },
    });
    expect(d.level).toBe("L2");
    expect(d.reason.join()).toContain("直接采纳");
  });

  it("预估更严 → 取预估,reason 写明取较严格者", () => {
    const d = decideGovernanceLevel({
      ...base,
      complexityEstimate: { complexity: "M", recommended_governance_level: 1 },
    });
    expect(d.level).toBe("L1");
    expect(d.reason.join()).toContain("取较严格者 L1");
  });

  it("规则更严 → 保持规则档,reason 写明冲突", () => {
    const d = decideGovernanceLevel({
      ...base, involvesShell: true,
      complexityEstimate: { complexity: "S", recommended_governance_level: 1 },
    });
    expect(d.level).toBe("L3");
    expect(d.reason.join()).toContain("取较严格者 L3");
  });

  it("预估 XL(3)可把无规则信号的 run 抬到 L3", () => {
    const d = decideGovernanceLevel({
      ...base,
      complexityEstimate: { complexity: "XL", recommended_governance_level: 3 },
    });
    expect(d.level).toBe("L3");
  });
});

describe("governance level rank 工具", () => {
  it("rank ↔ level 双向一致且钳位", () => {
    expect(governanceLevelRank("L0")).toBe(0);
    expect(governanceLevelRank("L3")).toBe(3);
    expect(governanceLevelFromRank(2)).toBe("L2");
    expect(governanceLevelFromRank(-1)).toBe("L0");
    expect(governanceLevelFromRank(9)).toBe("L3");
  });
});

describe("full-host execution governance", () => {
  it("requires L3 approval even when the goal does not mention shell", () => {
    const decision = decideGovernanceLevel({ ...base, frameworks: ["claude-code"], fullHostAccess: true });
    expect(decision.level).toBe("L3");
    expect(decision.reason.join()).toContain("完整宿主权限");
  });
});
