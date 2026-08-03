// 令二.5 · memoryRoutes 的 procedural_skill 审批端点(镜像 lessons/:id/approve 风格)活体验证。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../runtime/orchestrator.js", () => ({ getAgents: () => [] }));

import { register } from "./memoryRoutes.js";
import { loadRegistry } from "../storage/registryStore.js";

let root: string;
let server: Server;
let baseUrl: string;

const NOW = "2026-07-02T00:00:00.000Z";
function seedSkill(id: string, status: string) {
  return { id, kind: "procedural_skill", companyId: "co-A", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1"], status, createdAt: NOW, updatedAt: NOW };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-route-"));
  const f = path.join(root, ".opc", "memory", "registry.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [seedSkill("skill-prop", "proposed"), seedSkill("skill-cand", "candidate")].map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
  const app = express();
  app.use(express.json());
  register(app, root);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(() => { server.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("POST /api/memory/skills/:id/approve|reject", () => {
  it("approve proposed → verified(200);落盘 status=verified", async () => {
    const res = await fetch(`${baseUrl}/api/memory/skills/skill-prop/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("verified");
    const row = loadRegistry(root).find((r) => r.id === "skill-prop") as { status?: string };
    expect(row.status).toBe("verified");
  });
  it("reject proposed → retired(200);落盘 status=retired", async () => {
    const res = await fetch(`${baseUrl}/api/memory/skills/skill-prop/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("retired");
    expect((loadRegistry(root).find((r) => r.id === "skill-prop") as { status?: string }).status).toBe("retired");
  });
  it("非 proposed(candidate)→ 404;不存在 → 404", async () => {
    expect((await fetch(`${baseUrl}/api/memory/skills/skill-cand/approve`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/memory/skills/skill-nope/reject`, { method: "POST" })).status).toBe(404);
  });
});
