import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Run } from "@opc/shared";
import {
  guardEvidenceWrite,
  finalizeEvidenceIntegrity,
  type EvidenceIntegrityState,
} from "./orchestrator.js";

// A6/终验 · 证据链去 best-effort:关键证据(result.json/changes/artifact registry/report/账本)写盘失败时
// run 不得纯净成功。orchestrator.startRun 依赖面极重、其 E2E 冒烟被 vitest 显式排除,故这里对承载该
// 语义的两个纯函数(guardEvidenceWrite / finalizeEvidenceIntegrity)做直接单测,并用 mock/真·fs 写失败
// 驱动"写盘失败 → degraded 标记 + 结构化事件 + 不再纯净 success"这条链。

function freshState(): EvidenceIntegrityState {
  return { integrity: "ok", criticalFailed: false, failures: [] };
}

type Ev = { type: string; agentId: string | undefined; payload: { evidenceKind: string; critical: boolean; error: string } };
function collector() {
  const events: Ev[] = [];
  const emit = (type: "evidence_write_failed", agentId: string | undefined, payload: Ev["payload"]) =>
    void events.push({ type, agentId, payload });
  return { events, emit };
}

describe("guardEvidenceWrite — 证据写失败记账 + 结构化事件", () => {
  it("写成功:返回 true,integrity 保持 ok,不发事件", () => {
    const state = freshState();
    const { events, emit } = collector();
    const ok = guardEvidenceWrite(state, "changes", false, () => { /* success */ }, emit);
    expect(ok).toBe(true);
    expect(state.integrity).toBe("ok");
    expect(state.criticalFailed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("非 critical 写失败:degraded + 记录失败点 + 发 evidence_write_failed(带 evidenceKind/error 摘要)", () => {
    const state = freshState();
    const { events, emit } = collector();
    const ok = guardEvidenceWrite(state, "changes", false, () => { throw new Error("EACCES: permission denied"); }, emit);
    expect(ok).toBe(false);
    expect(state.integrity).toBe("degraded");
    expect(state.criticalFailed).toBe(false);
    expect(state.failures).toEqual([{ evidenceKind: "changes", critical: false, error: expect.stringContaining("EACCES") }]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("evidence_write_failed");
    expect(events[0].agentId).toBeUndefined();
    expect(events[0].payload.evidenceKind).toBe("changes");
    expect(events[0].payload.critical).toBe(false);
    expect(events[0].payload.error).toContain("EACCES");
  });

  it("critical(result.json)写失败:criticalFailed=true(供收尾升级为 run failed)", () => {
    const state = freshState();
    const { events, emit } = collector();
    guardEvidenceWrite(state, "result.json", true, () => { throw new Error("disk full"); }, emit);
    expect(state.integrity).toBe("degraded");
    expect(state.criticalFailed).toBe(true);
    expect(events[0].payload.critical).toBe(true);
  });

  it("错误摘要截断到 300 字符", () => {
    const state = freshState();
    const { events, emit } = collector();
    guardEvidenceWrite(state, "report", false, () => { throw new Error("x".repeat(1000)); }, emit);
    expect(events[0].payload.error.length).toBe(300);
  });

  it("emit 回调自身抛错也不掩盖原始写失败(仍记 degraded、仍返回 false)", () => {
    const state = freshState();
    const ok = guardEvidenceWrite(state, "report", false, () => { throw new Error("boom"); }, () => { throw new Error("emit broke"); });
    expect(ok).toBe(false);
    expect(state.integrity).toBe("degraded");
    expect(state.failures).toHaveLength(1);
  });

  it("多个写点失败:全部累积进 failures", () => {
    const state = freshState();
    const { emit } = collector();
    guardEvidenceWrite(state, "report", false, () => { throw new Error("e1"); }, emit);
    guardEvidenceWrite(state, "changes", false, () => { throw new Error("e2"); }, emit);
    guardEvidenceWrite(state, "artifact-registry", false, () => { throw new Error("e3"); }, emit);
    expect(state.failures.map(f => f.evidenceKind)).toEqual(["report", "changes", "artifact-registry"]);
  });

  it("真·fs 写失败(把已存在目录当文件写,result.json critical):guard 捕获 → degraded + criticalFailed + 事件带真实 fs 错误", () => {
    // 与 orchestrator 的 result.json guard 逐字节同款:直接 fs.writeFileSync 落盘。把 run 目录本身当文件写 →
    // 真实 fs 抛错(EISDIR/EPERM),无需 mock builtin(node:fs.writeFileSync 不可 redefine)。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-evidence-"));
    try {
      const state = freshState();
      const { events, emit } = collector();
      const ok = guardEvidenceWrite(
        state,
        "result.json",
        true,
        () => fs.writeFileSync(root, JSON.stringify({}), "utf-8"), // 目录路径当文件写 → 真实 fs 写失败
        emit,
      );
      expect(ok).toBe(false);
      expect(state.integrity).toBe("degraded");
      expect(state.criticalFailed).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].payload.evidenceKind).toBe("result.json");
      expect(events[0].payload.error.length).toBeGreaterThan(0);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

describe("finalizeEvidenceIntegrity — 收敛到 run 记录 + allClean", () => {
  const baseRun = (): Pick<Run, "status" | "degraded" | "degradedReason" | "evidenceIntegrity"> => ({ status: "done" });

  it("干净路径:integrity=ok → allClean 原样返回,run.evidenceIntegrity 补 ok,status 不动", () => {
    const run = baseRun();
    const allClean = finalizeEvidenceIntegrity(run, true, freshState());
    expect(allClean).toBe(true);
    expect(run.evidenceIntegrity).toBe("ok");
    expect(run.status).toBe("done");
  });

  it("非 critical 降级:run 不再纯净成功(allClean=false)、evidenceIntegrity=degraded,但 status 不翻 failed", () => {
    const run = baseRun();
    const state: EvidenceIntegrityState = { integrity: "degraded", criticalFailed: false, failures: [{ evidenceKind: "changes", critical: false, error: "x" }] };
    const allClean = finalizeEvidenceIntegrity(run, true, state);
    expect(allClean).toBe(false);
    expect(run.evidenceIntegrity).toBe("degraded");
    expect(run.status).toBe("done");
    expect(run.degraded).toBeFalsy();
  });

  it("critical(result.json)降级:升级为 run failed(status=failed + degraded + reason 追加),allClean=false", () => {
    const run: Pick<Run, "status" | "degraded" | "degradedReason" | "evidenceIntegrity"> = { status: "done", degradedReason: "已有原因" };
    const state: EvidenceIntegrityState = { integrity: "degraded", criticalFailed: true, failures: [{ evidenceKind: "result.json", critical: true, error: "disk full" }] };
    const allClean = finalizeEvidenceIntegrity(run, true, state);
    expect(allClean).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.degraded).toBe(true);
    expect(run.evidenceIntegrity).toBe("degraded");
    expect(run.degradedReason).toContain("已有原因");
    expect(run.degradedReason).toContain("result.json");
  });

  it("已是 failed 的 run:critical 失败不重复改 status/reason,但 evidenceIntegrity 与 allClean 仍降级", () => {
    const run: Pick<Run, "status" | "degraded" | "degradedReason" | "evidenceIntegrity"> = { status: "failed", degraded: true, degradedReason: "原失败" };
    const state: EvidenceIntegrityState = { integrity: "degraded", criticalFailed: true, failures: [] };
    const allClean = finalizeEvidenceIntegrity(run, false, state);
    expect(allClean).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.evidenceIntegrity).toBe("degraded");
    expect(run.degradedReason).toBe("原失败");
  });
});
