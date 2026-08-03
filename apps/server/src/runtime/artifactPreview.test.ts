import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Artifact, RunArtifact, RunArtifactCollection } from "@opc/shared";
import { buildRunArtifactCollection, saveArtifactRegistry } from "./artifactRegistry.js";
import { resolveArtifactDownload, resolveArtifactPreview } from "./artifactLineage.js";
import { loadRunArtifacts } from "./runArtifacts.js";

const RID = "run-prev1";
const REPORT_BODY = "REPORT-BODY-0123456789"; // ASCII:字节数=字符数,截断断言可精确

function baseArt(partial: Partial<Artifact> & { id: string; producedBy: string }): Artifact {
  return { kind: "text", name: "x", type: "report", createdAt: "2026-07-09T00:00:00Z", ...partial } as Artifact;
}

describe("成果卡下载/预览:savedPath 归档 + 越界守卫 + 预览截断", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  function setup(inline: string): { proj: string; col: RunArtifactCollection } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "art-prev-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.md"), REPORT_BODY);
    const artifactsIn: Artifact[] = [baseArt({ id: "art-inline", producedBy: "researcher", inlineText: inline })];
    const col = buildRunArtifactCollection({ runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: true, reportProducer: "lead" });
    saveArtifactRegistry(proj, RID, col, artifactsIn);
    return { proj, col: loadRunArtifacts(proj, RID) };
  }

  it("worker-output(inlineText 归档)经 savedPath 可下载,内容/文件名正确", () => {
    const { proj, col } = setup("worker 内联产出正文");
    const w = col.artifacts.find(a => a.id === "art-inline")!;
    expect(w.savedPath).toBe("artifacts/art-inline.txt");
    const dl = resolveArtifactDownload(proj, proj, RID, w);
    expect(dl?.body).toBe("worker 内联产出正文");
    expect(dl?.filename).toBe("art-inline.txt");
  });

  it("worker-output 预览返回归档文本(未截断)", () => {
    const { proj, col } = setup("内联预览内容");
    const w = col.artifacts.find(a => a.id === "art-inline")!;
    const pv = resolveArtifactPreview(proj, proj, RID, w)!;
    expect(pv.content).toBe("内联预览内容");
    expect(pv.truncated).toBe(false);
    expect(pv.filename).toBe("art-inline.txt");
  });

  it("savedPath 被篡改为越界路径(../..)→ 下载/预览均拒(即便越界文件真实存在)", () => {
    const { proj, col } = setup("x");
    const tampered: RunArtifact = { ...col.artifacts.find(a => a.id === "art-inline")!, savedPath: "../../evil.txt" };
    fs.writeFileSync(path.join(proj, ".opc", "evil.txt"), "secret"); // ../../ 从 run 目录出去正好落这里
    expect(resolveArtifactDownload(proj, proj, RID, tampered)).toBeNull();
    expect(resolveArtifactPreview(proj, proj, RID, tampered)).toBeNull();
  });

  it("report 预览:小上限触发截断,标 truncated,previewBytes==上限,totalBytes 保留完整值", () => {
    const { proj, col } = setup("x");
    const report = col.artifacts.find(a => a.kind === "report")!;
    const full = resolveArtifactPreview(proj, proj, RID, report)!;
    expect(full.truncated).toBe(false);
    expect(full.totalBytes).toBe(REPORT_BODY.length);
    expect(full.content).toBe(REPORT_BODY);

    const capped = resolveArtifactPreview(proj, proj, RID, report, 5)!;
    expect(capped.truncated).toBe(true);
    expect(capped.previewBytes).toBe(5);
    expect(capped.totalBytes).toBe(REPORT_BODY.length);
    expect(capped.content).toBe(REPORT_BODY.slice(0, 5));
  });

  it("report.md 主源缺失 → 下载退回 savedPath 归档副本", () => {
    const { proj, col } = setup("x");
    fs.rmSync(path.join(proj, ".opc", "runs", RID, "report.md"));
    const report = col.artifacts.find(a => a.kind === "report")!;
    expect(report.savedPath).toBe("artifacts/report.md");
    const dl = resolveArtifactDownload(proj, proj, RID, report);
    expect(dl?.body).toBe(REPORT_BODY);
  });

  it("不可下载状态(rejected)→ 预览返回 null", () => {
    const { proj } = setup("x");
    const rejected: RunArtifact = { id: "r", kind: "worker-output", title: "t", status: "rejected", inFinalDeliverable: false };
    expect(resolveArtifactPreview(proj, proj, RID, rejected)).toBeNull();
  });
});

// P1(审计)· 已完成 run 的文件产物是不可变交付物:下载优先冻结归档,而非共享 workRoot 的当前(可变)文件。
describe("P1 · file 产物不可变下载(冻结归档优先 + hash 校验回退)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });
  const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

  function fileArt(over: Partial<RunArtifact> = {}): RunArtifact {
    return {
      id: "file:sum.js", kind: "file", title: "sum.js", status: "modified", changeType: "modified",
      reviewStatus: "accepted", path: "sum.js", inFinalDeliverable: true, ...over,
    };
  }

  it("workRoot 文件被后续 run 改动,下载仍返回 run-end 冻结归档快照(不漂移)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "art-immut-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "work");
    fs.mkdirSync(path.join(proj, ".opc", "runs", RID, "artifacts"), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(proj, ".opc", "runs", RID, "artifacts", "file_sum.js.js"), "V1-FROZEN"); // run-end 快照
    fs.writeFileSync(path.join(workRoot, "sum.js"), "V2-MUTATED"); // 后续 run/人工改动
    const art = fileArt({ savedPath: "artifacts/file_sum.js.js", hash: sha("V1-FROZEN") });
    const dl = resolveArtifactDownload(proj, workRoot, RID, art);
    expect(dl?.body).toBe("V1-FROZEN"); // 冻结归档,不是 workRoot 的 V2
  });

  it("无冻结归档(老 run),workRoot 内容被改导致 registry hash 失配 → 拒发(不供漂移内容)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "art-mism-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "work");
    fs.mkdirSync(path.join(proj, ".opc", "runs", RID), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "sum.js"), "V2-MUTATED");
    const art = fileArt({ hash: sha("V1-ORIGINAL") }); // registry 记的是 run-end 的 V1;无 savedPath
    expect(resolveArtifactDownload(proj, workRoot, RID, art)).toBeNull();
  });

  it("无冻结归档但 workRoot 内容未变(hash 一致)→ 正常回退下载(未改动的老 run 仍可取)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "art-ok-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "work");
    fs.mkdirSync(path.join(proj, ".opc", "runs", RID), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "sum.js"), "V1-UNCHANGED");
    const art = fileArt({ hash: sha("V1-UNCHANGED") });
    expect(resolveArtifactDownload(proj, workRoot, RID, art)?.body).toBe("V1-UNCHANGED");
  });

  it("截断归档(savedPathTruncated)不作冻结源,回退 workRoot 走 hash 校验", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "art-trunc-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "work");
    fs.mkdirSync(path.join(proj, ".opc", "runs", RID, "artifacts"), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(proj, ".opc", "runs", RID, "artifacts", "file_big.js.js"), "TRUNC"); // 截断副本
    fs.writeFileSync(path.join(workRoot, "sum.js"), "FULL-UNCHANGED");
    const art = fileArt({ savedPath: "artifacts/file_big.js.js", savedPathTruncated: true, hash: sha("FULL-UNCHANGED") });
    // 截断副本不作冻结源 → 回退 workRoot,hash 一致 → 取完整内容
    expect(resolveArtifactDownload(proj, workRoot, RID, art)?.body).toBe("FULL-UNCHANGED");
  });
});
