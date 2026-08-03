import { describe, it, expect } from "vitest";
import { getProfileForRole, research_profile_v1 } from "./roleProfile.js";
import { checkWorkerArtifact } from "./workerArtifactGate.js";
import { dirSizeExceeds } from "./diskQuota.js";
import { RunHistory } from "./runHistory.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 阶段0③ 工程健康测试:证明"宿主侧 enforcement"三大不变式真生效(组合现有原语做显式断言),
// 而非靠提示词。这是 DRACO 实验前 P0 的硬门槛——边界、产物、历史可解释。

describe("enforcement 健康:宿主侧边界真生效", () => {
  // ① role profile:研究角色被编译出磁盘/后缀/禁环境硬边界(§4 防误建 Python 环境)
  it("research_profile_v1 有界且禁建环境", () => {
    expect(research_profile_v1.maxWorkspaceBytes).toBe(32 * 1024 * 1024);
    expect(research_profile_v1.allowedExtensions).toContain(".md");
    expect(research_profile_v1.blockedGlobs.some((g) => g.includes("*.py"))).toBe(true);
    expect(research_profile_v1.maxDepth).toBeGreaterThan(0);
    expect(research_profile_v1.maxFilenameBytes).toBeGreaterThan(0);
  });
  it("getProfileForRole 给任意角色返回有界 profile", () => {
    for (const role of ["dev", "lead", "ceo", "test", "unknown-role"]) {
      const p = getProfileForRole(role);
      expect(p.maxWorkspaceBytes).toBeGreaterThan(0);
      expect(p.allowedExtensions.length).toBeGreaterThan(0);
      expect(p.maxDepth).toBeGreaterThan(0);
    }
  });

  // ② 磁盘配额看门狗的判断:超过 profile 上限即触发(物理止损的核心)
  it("dirSizeExceeds 在超出配额时触发、配额内不触发", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehealth-"));
    try {
      fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB
      expect(dirSizeExceeds(dir, 1 * 1024 * 1024)).toBe(true);  // 限 1MB → 超
      expect(dirSizeExceeds(dir, 10 * 1024 * 1024)).toBe(false); // 限 10MB → 不超
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  });

  // ③ outputGate/artifact 门控:拦空产出、放行正常报告,且不误杀提及 pip 的合法报告(关键回归)
  it("artifact 门控拦空、放行正常、不误杀提及 pip 的报告", () => {
    expect(checkWorkerArtifact("").passed).toBe(false);
    expect(checkWorkerArtifact("   \n  ").passed).toBe(false);
    expect(checkWorkerArtifact("# 报告\n\n## 结论\n快排平均 O(n log n)。").passed).toBe(true);
    // 回归:正文提到 pip install 的合法研究报告绝不能被误杀(曾经的 false-positive)
    expect(checkWorkerArtifact("# 部署\n用 `pip install torch` 装依赖后运行。").passed).toBe(true);
  });

  // ④ 事件完整性:每个 defer/degrade 都进事件流并能派生出可解释的 failure report
  it("RunHistory 从事件流派生 failure report(defer/degrade 不丢)", () => {
    const h = new RunHistory();
    const now = new Date().toISOString();
    h.appendEvent("agent_deferred", now, "rp-data", { reason: "timeout" });
    h.appendEvent("deliverable_degraded", now, undefined, { reason: "合成失败" });
    const r = h.deriveFailureReport();
    expect(r.degraded).toBe(true);
    expect(r.deferred).toContain("rp-data");
  });
});
