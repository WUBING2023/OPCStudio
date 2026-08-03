import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommittedMemory } from "./memoryCommit.js";
import { commitProposal, normalizeRole } from "./memoryCommit.js";
import { isVisibleToRole, retrieveCommittedMemories, listAllCommittedMemories } from "./committedMemoryRetriever.js";

function cm(over: Partial<CommittedMemory>): CommittedMemory {
  return { memoryId: "m", version: 1, parentVersion: 0, scope: "agent", type: "x", content: "c", sourceArtifactRefs: [], approvedBy: "o", confidence: 1, revocable: true, createdAt: "2026-06-30T00:00:00Z", ...over } as CommittedMemory;
}

describe("Stage 4 · isVisibleToRole 角色隔离规则", () => {
  it("无 role(旧条目)→ 任何 agent 可见", () => {
    expect(isVisibleToRole(cm({ role: undefined }), "test")).toBe(true);
    expect(isVisibleToRole(cm({ role: undefined }), undefined)).toBe(true);
  });
  it("非 agent scope(project/team/run)→ 始终共享", () => {
    expect(isVisibleToRole(cm({ scope: "project", role: "dev" }), "test")).toBe(true);
    expect(isVisibleToRole(cm({ scope: "team", role: "dev" }), undefined)).toBe(true);
  });
  it("scope=agent → 只同 role 可见(归一小写),role 未知不可见", () => {
    expect(isVisibleToRole(cm({ scope: "agent", role: "dev" }), "dev")).toBe(true);
    expect(isVisibleToRole(cm({ scope: "agent", role: "Dev" }), "dev")).toBe(true); // 归一
    expect(isVisibleToRole(cm({ scope: "agent", role: "dev" }), "test")).toBe(false);
    expect(isVisibleToRole(cm({ scope: "agent", role: "dev" }), undefined)).toBe(false);
  });
});

describe("Stage 4 · commitProposal 记录 role/agentId(归一)", () => {
  it("role 归一小写 + agentId 透传", () => {
    const c = commitProposal(
      { proposalId: "p", runId: "r", scope: "agent", type: "x", content: "c", sourceArtifactRefs: [], proposedBy: "rp-dev", confidence: 1, tags: [], status: "pending", role: "Dev", agentId: "rp-dev" },
      "orchestrator", "2026-06-30T00:00:00Z", "mem-1",
    );
    expect(c.role).toBe("dev");
    expect(c.agentId).toBe("rp-dev");
  });
  it("normalizeRole 空白/空 → undefined", () => {
    expect(normalizeRole("  ")).toBeUndefined();
    expect(normalizeRole(undefined)).toBeUndefined();
    expect(normalizeRole("Test")).toBe("test");
  });
});

describe("Stage 4 · retrieve/list 按 role 隔离(落盘)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  function writeRun(runId: string, mems: Partial<CommittedMemory>[]) {
    const dir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "committed-memories.json"), JSON.stringify(mems.map((m, i) => cm({ memoryId: `${runId}-${i}`, content: `内容 ${runId} 关键词`, ...m }))));
    // 这些是干净成功 run 产出的 committed 记忆:补 task.json(done/verified),否则 fail-closed 硬化后
    // 缺 task.json 的 run 目录被整体排除,检索得空(本用例测的是 role 隔离,不是 run 终态门)。
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: runId, status: "done", finalState: "verified" }));
  }

  it("dev 私有记忆不注入给 test;project 记忆共享;dev 自己能拿到", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-"));
    writeRun("past-1", [
      { scope: "agent", role: "dev", content: "dev 私有 关键词" },
      { scope: "agent", role: "test", content: "test 私有 关键词" },
      { scope: "project", role: "lead", content: "项目共享 关键词" },
    ]);
    const forDev = retrieveCommittedMemories(root, "关键词", "cur", 5000, "dev").map(m => m.content);
    expect(forDev.some(c => c.includes("dev 私有"))).toBe(true);
    expect(forDev.some(c => c.includes("test 私有"))).toBe(false); // 隔离
    expect(forDev.some(c => c.includes("项目共享"))).toBe(true);   // 共享
    const forTest = retrieveCommittedMemories(root, "关键词", "cur", 5000, "test").map(m => m.content);
    expect(forTest.some(c => c.includes("test 私有"))).toBe(true);
    expect(forTest.some(c => c.includes("dev 私有"))).toBe(false); // 隔离
  });

  it("不传 role(旧调用)→ agent 私有记忆不可见(role 未知),共享可见", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-"));
    writeRun("past-1", [
      { scope: "agent", role: "dev", content: "dev 私有 关键词" },
      { scope: "project", content: "无 role 旧条目 关键词" },
    ]);
    const r = retrieveCommittedMemories(root, "关键词", "cur", 5000).map(m => m.content);
    expect(r.some(c => c.includes("dev 私有"))).toBe(false);
    expect(r.some(c => c.includes("旧条目"))).toBe(true);
  });

  it("listAllCommittedMemories ?role= 过滤", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mr-"));
    writeRun("past-1", [{ scope: "agent", role: "dev" }, { scope: "agent", role: "test" }, { scope: "project", role: "lead" }]);
    const dev = listAllCommittedMemories(root, { role: "dev" });
    expect(dev.some(m => m.role === "test")).toBe(false);
    expect(dev.some(m => m.role === "dev")).toBe(true);
    expect(dev.some(m => m.scope === "project")).toBe(true); // 共享仍在
  });
});
