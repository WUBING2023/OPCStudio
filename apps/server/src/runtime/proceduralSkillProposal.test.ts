import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  upsertProceduralSkill, retrieveProceduralSkills, loadRegistry,
  approveProceduralSkill, rejectProceduralSkill, type ProceduralSkill,
} from "../storage/registryStore.js";
import { exportMemoryRecordsForCompany, mapProceduralSkillToBundleRecord } from "./memoryBundle.js";

// 令二.5 · procedural_skill 统一 proposal/approval 状态机:proposed 不注入/不导出;
// approve → verified(可注入/可导出);reject → retired(终态);proposed 不因 support 自动晋升。

let root: string;
const NOW = "2026-07-02T00:00:00.000Z";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prop-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

function seedProposed(over: Partial<ProceduralSkill> = {}): ProceduralSkill {
  return upsertProceduralSkill(root, {
    companyId: "co-A", role: "dev", taskType: "coding", preconditions: [],
    successfulSequence: ["read", "write", "test"], producedArtifacts: [], antiPatterns: [],
    support: 3, successRate: 1, sourceRuns: ["r1", "r2", "r3"], status: "proposed", ...over,
  } as Omit<ProceduralSkill, "id" | "kind" | "createdAt" | "updatedAt">, NOW);
}

describe("proposed procedural_skill · 不注入 / 不导出", () => {
  it("proposed → retrieveProceduralSkills 不返回(只认 verified)", () => {
    seedProposed();
    expect(retrieveProceduralSkills(root, { role: "dev", companyId: "co-A", taskType: "coding", limit: 5 }).length).toBe(0);
  });
  it("proposed → 导出被排除(mapProceduralSkillToBundleRecord=null 且 exportMemoryRecordsForCompany 不含)", () => {
    const s = seedProposed();
    expect(mapProceduralSkillToBundleRecord({ ...s, status: "proposed" })).toBeNull();
    const exported = exportMemoryRecordsForCompany(root, "co-A", ["dev"]);
    expect(exported.some((r) => r.memory_id === `mem-ps-${s.id}`)).toBe(false);
  });
});

describe("approve / reject 状态机", () => {
  it("approve:proposed → verified,之后可注入 + 可导出", () => {
    const s = seedProposed();
    const approved = approveProceduralSkill(root, s.id, NOW);
    expect(approved?.status).toBe("verified");
    expect(retrieveProceduralSkills(root, { role: "dev", companyId: "co-A", taskType: "coding", limit: 5 }).length).toBe(1);
    const exported = exportMemoryRecordsForCompany(root, "co-A", ["dev"]);
    expect(exported.some((r) => r.memory_id === `mem-ps-${s.id}`)).toBe(true);
  });
  it("reject:proposed → retired,不注入不导出", () => {
    const s = seedProposed();
    const rejected = rejectProceduralSkill(root, s.id, NOW);
    expect(rejected?.status).toBe("retired");
    expect(retrieveProceduralSkills(root, { role: "dev", companyId: "co-A", taskType: "coding", limit: 5 }).length).toBe(0);
    expect(exportMemoryRecordsForCompany(root, "co-A", ["dev"]).length).toBe(0);
  });
  it("approve/reject 只对 proposed 生效:candidate/verified/retired/不存在 → null", () => {
    const cand = upsertProceduralSkill(root, {
      companyId: "co-A", role: "pm", taskType: "coding", preconditions: [], successfulSequence: ["a"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r1"], status: "candidate",
    } as Omit<ProceduralSkill, "id" | "kind" | "createdAt" | "updatedAt">, NOW);
    expect(approveProceduralSkill(root, cand.id, NOW)).toBeNull();
    expect(rejectProceduralSkill(root, cand.id, NOW)).toBeNull();
    expect(approveProceduralSkill(root, "skill-nope", NOW)).toBeNull();
  });
});

describe("proposed 黏性:不因 support 达标自动晋升 verified(须显式审批)", () => {
  it("同 role+taskType+company 再沉淀(support 增至 ≥3)仍停 proposed", () => {
    seedProposed({ support: 1, sourceRuns: ["r1"] });
    upsertProceduralSkill(root, {
      companyId: "co-A", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r2"], status: "proposed",
    } as Omit<ProceduralSkill, "id" | "kind" | "createdAt" | "updatedAt">, NOW);
    const merged = upsertProceduralSkill(root, {
      companyId: "co-A", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r3", "r4"], status: "proposed",
    } as Omit<ProceduralSkill, "id" | "kind" | "createdAt" | "updatedAt">, NOW);
    expect(merged.support).toBeGreaterThanOrEqual(3);
    expect(merged.status).toBe("proposed"); // 黏住,不自动 verified
    const rows = loadRegistry(root).filter((r) => r.kind === "procedural_skill");
    expect(rows).toHaveLength(1);
  });
});
