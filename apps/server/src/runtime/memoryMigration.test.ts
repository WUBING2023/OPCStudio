import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverLayeredScopes } from "../storage/layeredMemory.js";
import { closeAllDbs } from "../storage/sqlite/db.js";
import { listGovernedMemoryProposals } from "./memoryGovernance.js";
import { runMemoryDoctor } from "./memoryDoctor.js";
import {
  auditLegacyMemoryMigration,
  migrateLegacyMemoryToLayeredProposals,
} from "./memoryMigration.js";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

describe("Layered Memory legacy migration boundary", () => {
  const roots: string[] = [];
  const priorBackend = process.env.OPC_STORAGE_BACKEND;

  function root(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "opc-memory-migration-"));
    roots.push(value);
    return value;
  }

  function write(rootDir: string, relativePath: string, content: string): string {
    const file = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
    return file;
  }

  function projectMemory(id: string, companyId: string, text: string): Record<string, unknown> {
    return {
      id,
      agentRole: "dev",
      companyId,
      goalSlug: "parser-retry",
      text,
      tags: ["parser", "retry"],
      source: { runId: "run-legacy-001", agentId: "dev-1", type: "run" },
      createdAt: "2026-08-01T00:00:00.000Z",
      hits: 0,
    };
  }

  beforeEach(() => {
    process.env.OPC_STORAGE_BACKEND = "json";
  });

  afterEach(() => {
    closeAllDbs();
    if (priorBackend === undefined) delete process.env.OPC_STORAGE_BACKEND;
    else process.env.OPC_STORAGE_BACKEND = priorBackend;
    for (const value of roots.splice(0)) {
      try { fs.rmSync(value, { recursive: true, force: true }); }
      catch { /* Windows handle cleanup */ }
    }
  });

  it("audits JSONL and old Markdown without writing migration state", () => {
    const projectRoot = root();
    const projectFile = write(
      projectRoot,
      ".opc/memory/project.jsonl",
      JSON.stringify(projectMemory("legacy-1", "company-a", "Retry parser failures once with jitter."))
        + "\n{\"id\":\"schema-invalid\"}\n{bad-json\n",
    );
    const markdownFile = write(
      projectRoot,
      ".opc/knowledge/companies/company-a/company.md",
      "# Customer export rule\n\nRedact private headers before sharing a report.\n",
    );
    const beforeProject = fs.readFileSync(projectFile, "utf-8");
    const beforeMarkdown = fs.readFileSync(markdownFile, "utf-8");

    const report = auditLegacyMemoryMigration(projectRoot);

    expect(report.mode).toBe("legacy_read_only");
    expect(report.legacyRecordCount).toBe(2);
    expect(report.pendingMigrationCount).toBe(2);
    expect(report.failureCount).toBe(2);
    expect(report.state).toBe("failed");
    expect(report.sources.find((item) => item.source === "project_memory")).toMatchObject({
      writer: "storage/memoryStore.addMemory",
      fileCount: 1,
      recordCount: 1,
      failedCount: 2,
    });
    expect(fs.readFileSync(projectFile, "utf-8")).toBe(beforeProject);
    expect(fs.readFileSync(markdownFile, "utf-8")).toBe(beforeMarkdown);
    expect(fs.existsSync(path.join(projectRoot, ".opc/memory/proposals-v2.json"))).toBe(false);
  });

  it("migrates only proposed records and is idempotent by content hash", () => {
    const projectRoot = root();
    const source = JSON.stringify(projectMemory(
      "legacy-1",
      "company-a",
      "Retry parser failures once, then validate the delimiter before continuing.",
    )) + "\n";
    const sourceFile = write(projectRoot, ".opc/memory/project.jsonl", source);

    const first = migrateLegacyMemoryToLayeredProposals(projectRoot);
    const proposals = listGovernedMemoryProposals(projectRoot);

    expect(first.status).toBe("completed");
    expect(first.proposedCount).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "proposed",
      sourceType: "import",
      scope: "company",
      scopeId: "company-a",
    });
    expect(proposals[0].memoryId).toBeUndefined();
    expect(discoverLayeredScopes(projectRoot)).toEqual([]);
    expect(fs.readFileSync(sourceFile, "utf-8")).toBe(source);

    const second = migrateLegacyMemoryToLayeredProposals(projectRoot);
    expect(second.status).toBe("no_op");
    expect(second.proposedCount).toBe(0);
    expect(second.auditBefore.duplicateCount).toBe(1);
    expect(listGovernedMemoryProposals(projectRoot)).toHaveLength(1);
  });

  it("keeps legacy procedural records inside memory proposals and never creates a Skill", () => {
    const projectRoot = root();
    const record = {
      id: "proc-1",
      kind: "procedural_skill",
      companyId: "company-a",
      role: "dev",
      taskType: "bugfix",
      preconditions: ["A reproducible failing test exists"],
      successfulSequence: ["Run the focused test", "Apply the smallest correction"],
      producedArtifacts: ["Patch and test evidence"],
      antiPatterns: ["Do not silence the assertion"],
      support: 2,
      successRate: 0.9,
      sourceRuns: ["run-legacy-001"],
      sourceType: "run",
      status: "verified",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    write(projectRoot, ".opc/memory/registry.jsonl", JSON.stringify(record) + "\n");

    const result = migrateLegacyMemoryToLayeredProposals(projectRoot);
    const proposal = listGovernedMemoryProposals(projectRoot)[0];

    expect(result.proposedCount).toBe(1);
    expect(proposal.objectType).toBe("success_experience");
    expect(proposal.status).toBe("proposed");
    expect(fs.existsSync(path.join(projectRoot, ".opc/skills"))).toBe(false);
    const source = fs.readFileSync(path.join(runtimeDir, "memoryMigration.ts"), "utf-8");
    expect(source).not.toMatch(/skillStore|createSkill|incubat/i);
  });

  it("reports same content hash across different scopes as a conflict", () => {
    const projectRoot = root();
    const text = "Use concise release notes with direct evidence links.";
    write(
      projectRoot,
      ".opc/memory/project.jsonl",
      JSON.stringify(projectMemory("legacy-1", "company-a", text)) + "\n",
    );
    write(
      projectRoot,
      ".opc/memory/users/local-user/preferences.md",
      text + "\n",
    );

    const report = auditLegacyMemoryMigration(projectRoot);

    expect(report.conflictCount).toBe(2);
    expect(report.pendingMigrationCount).toBe(0);
    expect(report.state).toBe("conflict");
    expect(report.candidates.every((item) => item.disposition === "conflict")).toBe(true);
  });

  it("surfaces read-only, pending, conflict and failure states through Memory Doctor", () => {
    const projectRoot = root();
    const text = "Validate generated reports against their artifact hashes.";
    write(
      projectRoot,
      ".opc/memory/project.jsonl",
      JSON.stringify(projectMemory("legacy-1", "company-a", text)) + "\n{bad-json\n",
    );
    write(
      projectRoot,
      ".opc/memory/users/local-user/preferences.md",
      text + "\n",
    );

    const report = runMemoryDoctor(projectRoot);
    const codes = report.issues.map((issue) => issue.code);

    expect(report.status).toBe("error");
    expect(report.migration.mode).toBe("legacy_read_only");
    expect(codes).toContain("legacy_read_only");
    expect(codes).toContain("legacy_migration_conflict");
    expect(codes).toContain("legacy_migration_failed");
  });
});
