import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { buildSystemPrompt, type InjectionContext } from "./contextBuilder.js";
import {
  isMemoryReuseEligible,
  type MemoryReuseRun,
} from "./memoryReuseEligibility.js";
import { retrieveCommittedMemories } from "./committedMemoryRetriever.js";
import {
  appendReuseOutcomes,
  loadReuseStats,
  type MemoryReuseEntry,
} from "../storage/memoryReuseStore.js";

let root: string;

const MEMORY_ID = "release-memory-1";
const MEMORY_CONTENT = "For payment webhook retries, deduplicate by event id before applying side effects.";

function agent(): AgentNodeConfig {
  return {
    id: "dev-release",
    name: "Release Developer",
    role: "dev",
    childrenIds: [],
    model: "offline-test-model",
    provider: "offline-test-provider",
    framework: "hermes",
    companyId: "release-company",
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true,
    deletable: true,
    enabled: true,
  };
}

function writeCommittedMemory(): void {
  const runDir = path.join(root, ".opc", "runs", "source-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "task.json"), JSON.stringify({
    id: "source-run",
    status: "done",
  }), "utf-8");
  fs.writeFileSync(path.join(runDir, "committed-memories.json"), JSON.stringify([{
    memoryId: MEMORY_ID,
    version: 1,
    parentVersion: 0,
    scope: "project",
    type: "lesson",
    content: MEMORY_CONTENT,
    sourceArtifactRefs: [],
    approvedBy: "release-reviewer",
    confidence: 0.95,
    revocable: true,
    createdAt: "2026-08-02T00:00:00.000Z",
    companyId: "release-company",
  }]), "utf-8");
}

function injectionContext(): InjectionContext {
  return {
    projectRoot: root,
    runId: "current-run",
    injectedSkillIds: [],
    injectedMemoryIds: [],
  };
}

function cleanRun(): MemoryReuseRun {
  return {
    status: "done",
    evidenceIntegrity: "ok",
    deliveryAcceptance: {
      status: "independent_tests_passed",
      requiresCode: true,
      requiresTests: true,
      reasons: [],
    },
    finalState: "tests_passed",
    mergeConflicts: [],
  };
}

function reuseEntry(patch: Partial<MemoryReuseEntry> = {}): MemoryReuseEntry {
  return {
    runId: "current-run",
    agentId: "dev-release",
    role: "dev",
    memoryId: MEMORY_ID,
    kind: "committed",
    taskType: "coding",
    runStatus: "done",
    degraded: false,
    at: "2026-08-02T01:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reuse-release-gate-"));
  writeCommittedMemory();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Phase 6 deterministic memory reuse matrix", () => {
  it("release gate: committed memory is injected, cited, persisted as a clean reuse, and retrievable", () => {
    const context = injectionContext();
    const goal = "Implement safe payment webhook retries with event id deduplication";
    const prompt = buildSystemPrompt(agent(), "You are a developer.", goal, root, context);

    expect(prompt).toContain(MEMORY_CONTENT);
    expect(context.injectedMemoryIds).toContain(MEMORY_ID);
    const injected = context.injectedMemories?.find((entry) => entry.id === MEMORY_ID);
    expect(injected).toMatchObject({ id: MEMORY_ID, kind: "committed" });

    expect(isMemoryReuseEligible(cleanRun(), true, false)).toBe(true);
    appendReuseOutcomes(root, [reuseEntry({ kind: injected?.kind ?? "committed" })]);

    expect(loadReuseStats(root).get(MEMORY_ID)).toEqual({
      injected: 1,
      cleanRuns: 1,
      failedRuns: 0,
    });
    expect(retrieveCommittedMemories(
      root,
      goal,
      "current-run",
      800,
      "dev",
      undefined,
      { taskType: "coding", companyId: "release-company" },
    ).map((entry) => entry.memoryId)).toContain(MEMORY_ID);
  });

  it("release gate: uncertain or degraded reuse never strengthens memory", () => {
    const context = injectionContext();
    buildSystemPrompt(
      agent(),
      "You are a developer.",
      "Implement safe payment webhook retries with event id deduplication",
      root,
      context,
    );
    expect(context.injectedMemoryIds).toContain(MEMORY_ID);

    expect(isMemoryReuseEligible(cleanRun(), true, true)).toBe(false);
    appendReuseOutcomes(root, [reuseEntry({
      runId: "uncertain-run",
      runStatus: "failed",
      degraded: true,
    })]);

    expect(loadReuseStats(root).get(MEMORY_ID)).toEqual({
      injected: 1,
      cleanRuns: 0,
      failedRuns: 1,
    });
  });
});
