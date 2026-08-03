import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  retrieveConclusionPoints, retrieveProceduralSkills, restoreRegistrySnapshot,
  type MemoryRecord,
} from "./registryStore.js";

// 效率治理 · registryStore 检索 Top-K 硬顶(只收紧不改语义)。
// 锁:调用方误传超大 limit,conclusion 要点 / procedural 技能条数仍被 ceiling 截断,不把整库拉进注入。

const NOW = "2026-07-02T00:00:00.000Z";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-topk-")); });

function seedConclusions(n: number): void {
  const recs: MemoryRecord[] = [];
  for (let i = 0; i < n; i++) {
    recs.push({
      id: `concl-${i}`, kind: "conclusion_summary", goalSlug: "sort",
      points: [`要点${i}`], tags: [], sourceType: "manual", status: "approved", createdAt: NOW,
    } as MemoryRecord);
  }
  restoreRegistrySnapshot(root, recs);
}

function seedProceduralSkills(n: number): void {
  const recs: MemoryRecord[] = [];
  for (let i = 0; i < n; i++) {
    recs.push({
      id: `skill-${i}`, kind: "procedural_skill", role: "dev", taskType: "coding",
      preconditions: [], successfulSequence: ["Read", "Edit", "Bash"], producedArtifacts: [], antiPatterns: [],
      support: 10 - i, successRate: 1, sourceRuns: [], externalSourceRuns: [], sourceType: "manual",
      status: "verified", createdAt: NOW, updatedAt: NOW,
    } as MemoryRecord);
  }
  restoreRegistrySnapshot(root, recs);
}

describe("registryStore · Top-K ceiling", () => {
  it("retrieveConclusionPoints:误传超大 limit → 扁平要点仍被 MAX_CONCLUSION_POINTS(6)截断", () => {
    seedConclusions(20); // 20 条各 1 要点,全命中 goalSlug → 若无上限会全部注入
    const pts = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort", limit: 999 });
    expect(pts.length).toBeLessThanOrEqual(6);
  });

  it("retrieveConclusionPoints:默认 limit(不传)行为不变,仍受要点上限", () => {
    seedConclusions(20);
    const pts = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" });
    expect(pts.length).toBeLessThanOrEqual(6);
    expect(pts.length).toBeGreaterThan(0);
  });

  it("retrieveProceduralSkills:误传超大 limit → 被 MAX_PROCEDURAL_SKILLS(3)截断,且高 support 优先", () => {
    seedProceduralSkills(10); // support 递减,skill-0 最高
    const got = retrieveProceduralSkills(root, { role: "dev", limit: 999 });
    expect(got.length).toBeLessThanOrEqual(3);
    expect(got[0].id).toBe("skill-0"); // 高 support 优先保留
  });

  it("retrieveProceduralSkills:默认 limit(不传)= 1(既有行为不变)", () => {
    seedProceduralSkills(10);
    const got = retrieveProceduralSkills(root, { role: "dev" });
    expect(got.length).toBe(1);
    expect(got[0].id).toBe("skill-0");
  });
});
