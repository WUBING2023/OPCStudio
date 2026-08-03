import { describe, it, expect } from "vitest";
import { decideTeamScale } from "./teamScalePolicy.js";

// 效率治理 · decideTeamScale 建议最小团队规模(纯函数确定性单测,不靠真实 LLM run)。
// 锁两端:trivial 编码 → 最小团队(单 coder / +tester);复杂(expand)→ 保留完整规模不钳。

describe("decideTeamScale · trivial 编码任务收敛到最小团队", () => {
  it("trivial 编码 + 不要求测试 → 单 coder,maxLeads=1,不铺满", () => {
    const rec = decideTeamScale({ goal: "写一个函数把数组去重", taskScale: "trivial", requiresTests: false });
    expect(rec.scale).toBe("trivial");
    expect(rec.roles).toEqual(["coder"]);
    expect(rec.maxLeads).toBe(1);
    expect(rec.maxWorkersPerTeam).toBe(1);
    expect(rec.requireVerifier).toBe(false);
  });

  it("trivial 编码 + 要求测试 → 单 coder + 独立 tester(保留验证边)", () => {
    const rec = decideTeamScale({ goal: "实现一个排序函数并写单元测试", taskScale: "trivial", requiresTests: true });
    expect(rec.roles).toEqual(["coder", "tester"]);
    expect(rec.requireVerifier).toBe(true);
    expect(rec.maxWorkersPerTeam).toBe(2);
    expect(rec.maxLeads).toBe(1);
  });

  it("trivial 非编码任务 → 单 worker(不开满编团队)", () => {
    const rec = decideTeamScale({ goal: "查一下某个事实并写一句话", taskScale: "trivial", requiresTests: false });
    expect(rec.roles).toEqual(["worker"]);
    expect(rec.maxLeads).toBe(1);
    expect(rec.maxWorkersPerTeam).toBe(1);
    expect(rec.requireVerifier).toBe(false);
  });
});

describe("decideTeamScale · 复杂任务保留完整规模", () => {
  it("expand → 不钳(maxLeads/maxWorkersPerTeam undefined,不建议裁剪角色)", () => {
    const rec = decideTeamScale({ goal: "对整个系统做端到端安全审计并重构架构", taskScale: "expand", requiresTests: true });
    expect(rec.scale).toBe("expand");
    expect(rec.maxLeads).toBeUndefined();
    expect(rec.maxWorkersPerTeam).toBeUndefined();
    expect(rec.roles).toEqual([]);
    // 要求测试时 requireVerifier 仍透传(即便不钳,验证边诉求不丢)。
    expect(rec.requireVerifier).toBe(true);
  });

  it("default → 收敛到单团队(maxLeads=1),团队内 worker 数由 lead 自拆(不额外钳)", () => {
    const rec = decideTeamScale({ goal: "做个中等规模的功能", taskScale: "default", requiresTests: false });
    expect(rec.scale).toBe("default");
    expect(rec.maxLeads).toBe(1);
    expect(rec.maxWorkersPerTeam).toBeUndefined();
    expect(rec.roles).toEqual([]);
  });
});

describe("decideTeamScale · 缺省与边界", () => {
  it("未传 taskScale → 保守按 default(不钳成员)", () => {
    const rec = decideTeamScale({ goal: "随便写点东西" });
    expect(rec.scale).toBe("default");
    expect(rec.maxLeads).toBe(1);
    expect(rec.roles).toEqual([]);
  });

  it("纯函数:同输入恒同输出", () => {
    const a = decideTeamScale({ goal: "写个脚本", taskScale: "trivial", requiresTests: true });
    const b = decideTeamScale({ goal: "写个脚本", taskScale: "trivial", requiresTests: true });
    expect(a).toEqual(b);
  });
});
