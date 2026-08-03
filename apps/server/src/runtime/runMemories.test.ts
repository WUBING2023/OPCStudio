import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveRunMemories } from "./runMemories.js";

const RID = "run-mem1";
function setup(events: object[], committed?: object[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
  const dir = path.join(root, ".opc", "runs", RID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  if (committed) {
    const cdir = path.join(root, ".opc", "runs", "past-run");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "committed-memories.json"), JSON.stringify(committed));
  }
  return root;
}

describe("Stage 4 · deriveRunMemories", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("memory_injected 事件 → 每 agent 注入 + 解析 committed 内容", () => {
    root = setup(
      [
        { type: "info", timestamp: "t0", agentId: "rp-dev", payload: { injectedMemory: ["should-be-ignored"] } },
        { type: "memory_injected", timestamp: "t1", agentId: "rp-dev", payload: { memoryIds: ["past-run-0"], role: "dev" } },
      ],
      [{ memoryId: "past-run-0", version: 1, parentVersion: 0, scope: "project", type: "run_conclusion", content: "上次学到的结论", sourceArtifactRefs: [], approvedBy: "o", confidence: 1, revocable: true, createdAt: "2026-06-29T00:00:00Z" }],
    );
    const u = deriveRunMemories(root, RID);
    // 有 memory_injected → 忽略 info 回退
    expect(u.injections.length).toBe(1);
    expect(u.injections[0].agentId).toBe("rp-dev");
    expect(u.injections[0].memoryIds).toEqual(["past-run-0"]);
    expect(u.injections[0].resolved[0]).toMatchObject({ source: "committed", content: "上次学到的结论", type: "run_conclusion" });
  });

  it("旧 run(无 memory_injected)→ 回退 info+injectedMemory", () => {
    root = setup([
      { type: "info", timestamp: "t0", agentId: "rp-lead", payload: { injectedMemory: ["unknown-id"] } },
      { type: "info", timestamp: "t1", agentId: "rp-lead", payload: { message: "无关 info" } },
    ]);
    const u = deriveRunMemories(root, RID);
    expect(u.injections.length).toBe(1);
    expect(u.injections[0].memoryIds).toEqual(["unknown-id"]);
    expect(u.injections[0].resolved[0].source).toBe("unknown"); // 解析不到 → unknown,但保留 id
  });

  it("无事件文件 → 空 injections 不抛错", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
    expect(deriveRunMemories(root, "nope").injections).toEqual([]);
  });
});
