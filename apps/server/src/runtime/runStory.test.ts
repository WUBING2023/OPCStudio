import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveRunStory } from "./runStory.js";

const RID = "run-1";
function setup(events: object[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const dir = path.join(root, ".opc", "runs", RID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  return root;
}

describe("Stage 2 · deriveRunStory 人话叙述", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("里程碑事件翻成人话,滤掉 model_call/info 噪声", () => {
    root = setup([
      { type: "info", timestamp: "t0", payload: { message: "工作目录" } },
      { type: "run_started", timestamp: "t1", payload: { goal: "调研 X" } },
      { type: "model_call_started", timestamp: "t2", agentId: "ceo", payload: {} },
      { type: "agent_status_changed", timestamp: "t3", agentId: "rp-lead", payload: { status: "working" } },
      { type: "memory_committed", timestamp: "t4", payload: { scope: "team", type: "insight" } },
      { type: "run_finished", timestamp: "t5", payload: {} },
    ]);
    const s = deriveRunStory(root, RID);
    const types = s.lines.map(l => l.type);
    expect(types).toEqual(["run_started", "agent_status_changed", "memory_committed", "run_finished"]);
    expect(s.lines[0].line).toContain("调研 X");
    expect(s.lines[1].line).toContain("主管");
    expect(s.lines[2].line).toContain("记忆");
  });

  it("同一 agent 多次 working 只报一次", () => {
    root = setup([
      { type: "agent_status_changed", timestamp: "t1", agentId: "ceo", payload: { status: "working" } },
      { type: "agent_status_changed", timestamp: "t2", agentId: "ceo", payload: { status: "idle" } },
      { type: "agent_status_changed", timestamp: "t3", agentId: "ceo", payload: { status: "working" } },
    ]);
    const s = deriveRunStory(root, RID);
    expect(s.lines.length).toBe(1);
  });

  it("退回/降级/延后都有专门话术,降级 error 不重复报", () => {
    root = setup([
      { type: "artifact_rejected", timestamp: "t1", agentId: "rp-dev", payload: { reason: "缺来源" } },
      { type: "agent_deferred", timestamp: "t2", agentId: "rp-test", payload: { reason: "timeout" } },
      { type: "deliverable_degraded", timestamp: "t3", payload: { reason: "worker 全失败" } },
      { type: "error", timestamp: "t4", payload: { degraded: true, message: "合成降级" } },
    ]);
    const s = deriveRunStory(root, RID);
    const lines = s.lines.map(l => l.line);
    expect(lines.some(l => l.includes("退回") && l.includes("缺来源"))).toBe(true);
    expect(lines.some(l => l.includes("延后") && l.includes("超时"))).toBe(true);
    expect(lines.some(l => l.includes("交付降级"))).toBe(true);
    // degraded:true 的 error 被滤掉(已由 deliverable_degraded 覆盖)
    expect(s.lines.filter(l => l.type === "error").length).toBe(0);
  });

  it("无事件文件:空 lines 不抛错", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
    expect(deriveRunStory(root, "nope").lines).toEqual([]);
  });
});
