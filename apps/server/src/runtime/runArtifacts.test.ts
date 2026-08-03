import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectRunArtifacts } from "./runArtifacts.js";

const RID = "run-1";

function setupRun(files: { events?: string[]; changes?: unknown[]; report?: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-"));
  const dir = path.join(root, ".opc", "runs", RID);
  fs.mkdirSync(dir, { recursive: true });
  if (files.events) fs.writeFileSync(path.join(dir, "events.jsonl"), files.events.join("\n"));
  if (files.changes) fs.writeFileSync(path.join(dir, "changes.json"), JSON.stringify(files.changes));
  if (files.report) fs.writeFileSync(path.join(dir, "report.md"), "# 报告\n内容");
  return root;
}

describe("Stage 2 · collectRunArtifacts 归集", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("正常 run:report(final)+ 文件变更映射 added/modified/deleted", () => {
    root = setupRun({
      report: true,
      changes: [
        { path: "a.md", changeType: "create", agentId: "w1" },
        { path: "b.ts", changeType: "modify" },
        { path: "c.txt", changeType: "delete" },
      ],
    });
    const col = collectRunArtifacts(root, RID);
    expect(col.degraded).toBe(false);
    const report = col.artifacts.find(a => a.kind === "report");
    expect(report?.status).toBe("final");
    expect(report?.downloadUrl).toBe(`/api/runs/${RID}/artifacts/download?artifactId=report`);
    expect(report?.inFinalDeliverable).toBe(true);
    expect(col.artifacts.find(a => a.path === "a.md")?.status).toBe("added");
    expect(col.artifacts.find(a => a.path === "a.md")?.producer).toBe("w1");
    expect(col.artifacts.find(a => a.path === "b.ts")?.status).toBe("modified");
    expect(col.artifacts.find(a => a.path === "c.txt")?.status).toBe("deleted");
  });

  it("降级 run:report 状态=degraded 并带原因(来自 deliverable_degraded 事件)", () => {
    root = setupRun({
      report: true,
      events: [
        JSON.stringify({ type: "deliverable_degraded", payload: { reason: "worker 全失败" } }),
      ],
    });
    const col = collectRunArtifacts(root, RID);
    expect(col.degraded).toBe(true);
    expect(col.degradedReason).toBe("worker 全失败");
    expect(col.artifacts.find(a => a.kind === "report")?.status).toBe("degraded");
    expect(col.artifacts.find(a => a.kind === "report")?.reason).toBe("worker 全失败");
  });

  it("被拒产物:status=rejected、带原因、不进最终交付", () => {
    root = setupRun({
      report: true,
      events: [
        JSON.stringify({ type: "artifact_rejected", agentId: "w2", payload: { artifactId: "draft.md", reason: "缺来源引用" } }),
      ],
    });
    const col = collectRunArtifacts(root, RID);
    const rej = col.artifacts.find(a => a.status === "rejected");
    expect(rej?.title).toBe("draft.md");
    expect(rej?.reason).toBe("缺来源引用");
    expect(rej?.inFinalDeliverable).toBe(false);
  });

  it("空 run(无任何文件):返回空清单不抛错", () => {
    root = setupRun({});
    const col = collectRunArtifacts(root, RID);
    expect(col.artifacts).toEqual([]);
    expect(col.degraded).toBe(false);
  });
});
