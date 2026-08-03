import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Artifact, RunArtifact } from "@opc/shared";
import { buildRunArtifactCollection, saveArtifactRegistry, enrichArtifactEvidence, archiveArtifactEntities } from "./artifactRegistry.js";
import { artifactLineage, resolveArtifactDownload, resolveArtifactPreview } from "./artifactLineage.js";
import { loadRunArtifacts } from "./runArtifacts.js";

const RID = "run-1abc";

function art(partial: Partial<Artifact> & { id: string; producedBy: string }): Artifact {
  return { kind: "text", name: `${partial.producedBy} 产出`, type: "report", createdAt: "2026-06-30T00:00:00Z", ...partial } as Artifact;
}

describe("Stage 3 · buildRunArtifactCollection", () => {
  it("worker 产出→accepted + 文件子产物带 lineage/downloadUrl;report 来源链=所有 worker", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [
        art({ id: "art-1", producedBy: "rp-dev", kind: "file-change", fileChanges: [{ path: "a.md", changeType: "create" }] }),
        art({ id: "art-2", producedBy: "rp-research" }),
      ],
      deferred: [],
      degraded: false,
      hasReport: true,
      reportProducer: "rp-lead",
      roleOf: { "rp-dev": "dev", "rp-research": "research", "rp-lead": "lead" },
    });
    const w1 = col.artifacts.find(a => a.id === "art-1");
    expect(w1?.status).toBe("accepted");
    expect(w1?.producerRole).toBe("dev");
    expect(w1?.inFinalDeliverable).toBe(true); // 非降级
    const file = col.artifacts.find(a => a.id === "file:a.md");
    expect(file?.status).toBe("added");
    expect(file?.producer).toBe("rp-dev");
    expect(file?.sourceArtifactIds).toEqual(["art-1"]);
    expect(file?.downloadUrl).toContain("/artifacts/download?artifactId=file%3Aa.md");
    const report = col.artifacts.find(a => a.id === "report");
    expect(report?.status).toBe("final");
    expect(report?.sourceArtifactIds).toEqual(["art-1", "art-2"]);
    expect(report?.downloadUrl).toBe(`/api/runs/${RID}/artifacts/download?artifactId=report`);
    expect(report?.lineage?.every(e => e.relationship === "synthesized-from")).toBe(true);
  });

  it("orphanChanges:changes.json 里没被 worker 覆盖的文件(如 lead 直写)也生成可下载 file artifact,已有的不重复", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [
        art({ id: "art-1", producedBy: "rp-dev", kind: "file-change", fileChanges: [{ path: "a.md", changeType: "create" }] }),
      ],
      deferred: [], degraded: false, hasReport: true, reportProducer: "rp-lead",
      orphanChanges: [
        { path: "a.md", changeType: "create" },       // 已被 art-1 覆盖 → 不重复登记
        { path: "report.md", changeType: "create" },  // lead 直写、worker 没覆盖 → 补生成可下载 file artifact
      ],
    });
    const files = col.artifacts.filter(a => a.kind === "file");
    expect(files.filter(f => f.path === "a.md")).toHaveLength(1); // 去重:不因 orphan 重复登记
    const orphan = files.find(f => f.path === "report.md");
    expect(orphan).toBeTruthy();                          // changes.json 里的孤儿文件补上了 artifact
    expect(orphan?.reviewStatus).toBe("accepted");
    expect(orphan?.producer).toBe("synthesis");
    expect(orphan?.inFinalDeliverable).toBe(true);
    expect(orphan?.downloadUrl).toContain("artifactId=file%3Areport.md"); // 可下载
  });

  it("多 worker 改同一文件 → 文件产物合并所有来源(不丢归属)", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [
        art({ id: "art-A", producedBy: "wA", kind: "file-change", fileChanges: [{ path: "shared.ts", changeType: "create" }] }),
        art({ id: "art-B", producedBy: "wB", kind: "file-change", fileChanges: [{ path: "shared.ts", changeType: "modify" }] }),
      ],
      deferred: [], degraded: false, hasReport: true, reportProducer: "rp-lead",
    });
    const files = col.artifacts.filter(a => a.id === "file:shared.ts");
    expect(files.length).toBe(1); // 仍只一个文件产物
    expect(files[0].sourceArtifactIds).toEqual(["art-A", "art-B"]); // 两个 worker 都记入来源
    expect(files[0].lineage?.map(e => e.via)).toEqual(["wA", "wB"]);
    // 下游对称:wB 的 downstream 含该文件
    const linB = artifactLineage(col, "art-B");
    expect(linB?.downstream.map(n => n.artifact.id)).toContain("file:shared.ts");
  });

  it("降级 run → worker 产出 inFinalDeliverable=false;report status=degraded,来源关系=derived-from;被拒来自 deferred", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-x", producedBy: "wX" })],
      deferred: [
        { agentId: "rp-dev", taskId: "t1", reason: "quality_gate_failed", lastError: "缺来源引用" },
        { reason: "timeout" }, // 无 agentId/taskId,验证 id 不碰撞
        { reason: "timeout" },
      ],
      degraded: true,
      degradedReason: "worker 全失败",
      hasReport: true,
      reportProducer: "rp-lead",
    });
    expect(col.artifacts.find(a => a.id === "art-x")?.inFinalDeliverable).toBe(false);
    const report = col.artifacts.find(a => a.id === "report");
    expect(report?.status).toBe("degraded");
    expect(report?.reason).toBe("worker 全失败");
    expect(report?.lineage?.every(e => e.relationship === "derived-from")).toBe(true);
    const rej = col.artifacts.filter(a => a.status === "rejected");
    expect(rej.length).toBe(3);
    expect(new Set(rej.map(r => r.id)).size).toBe(3); // id 不碰撞
    expect(rej.every(r => r.kind === "worker-output")).toBe(true);
    expect(col.artifacts.find(a => a.id.startsWith("rejected:rp-dev"))?.reason).toBe("缺来源引用");
  });

  it("DIRECT_ANSWER:无 worker,report producer=ceo,无来源链", () => {
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: [], deferred: [], degraded: false, hasReport: true, reportProducer: "ceo",
      roleOf: { ceo: "ceo" },
    });
    const report = col.artifacts.find(a => a.id === "report");
    expect(report?.producer).toBe("ceo");
    expect(report?.producerRole).toBe("ceo");
    expect(report?.sourceArtifactIds).toBeUndefined();
  });
  it("deduplicates review ids and removes rejected worker outputs from report lineage", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [
        art({ id: "art-dev", producedBy: "dev", kind: "file-change", fileChanges: [{ path: "bad.ts", changeType: "create" }] }),
        art({ id: "art-ok", producedBy: "ok", kind: "file-change", fileChanges: [{ path: "ok.ts", changeType: "create" }] }),
      ],
      deferred: [],
      degraded: false,
      hasReport: true,
      reportProducer: "lead",
      verificationResults: [
        { reviewArtifactId: "art-dev", reviewedArtifactId: "dev", producerId: "dev", verifierId: "tester", verifierRole: "test", method: "code-review", accept: false, summary: "broken", createdAt: "2026-06-30T00:01:00Z" },
      ],
    });

    expect(new Set(col.artifacts.map(a => a.id)).size).toBe(col.artifacts.length);
    expect(col.artifacts.find(a => a.id === "art-dev")?.status).toBe("rejected");
    expect(col.artifacts.some(a => a.id === "art-dev:1" && a.kind === "review-result")).toBe(true);
    expect(col.artifacts.find(a => a.id === "file:bad.ts")?.status).toBe("rejected");
    expect(col.artifacts.find(a => a.id === "file:bad.ts")?.downloadUrl).toBeUndefined();
    expect(col.artifacts.find(a => a.id === "report")?.sourceArtifactIds).toEqual(["art-ok"]);
  });
});

describe("Stage 3 · artifactLineage 上游/下游(带 relationship)", () => {
  const col = buildRunArtifactCollection({
    runId: RID,
    artifacts: [art({ id: "art-1", producedBy: "rp-dev", kind: "file-change", fileChanges: [{ path: "a.md", changeType: "create" }] })],
    deferred: [], degraded: false, hasReport: true, reportProducer: "rp-lead",
  });
  it("report 的上游=worker 产出,边关系=synthesized-from", () => {
    const lin = artifactLineage(col, "report");
    expect(lin?.upstream.map(n => n.artifact.id)).toContain("art-1");
    expect(lin?.upstream[0].relationship).toBe("synthesized-from");
  });
  it("worker 产出的下游=报告(+其文件)", () => {
    const lin = artifactLineage(col, "art-1");
    expect(lin?.downstream.map(n => n.artifact.id)).toEqual(expect.arrayContaining(["report", "file:a.md"]));
  });
  it("不存在的 id → null", () => {
    expect(artifactLineage(col, "nope")).toBeNull();
  });
});

describe("Stage 3 · resolveArtifactDownload 守卫 + loadRunArtifacts 回退", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("report→report.md;file 越界(../)→null;file 软链逃逸→null;rejected→null;deleted→null", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar3-"));
    const dir = path.join(root, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.md"), "# 报告");
    fs.writeFileSync(path.join(root, "a.md"), "文件内容");
    const F = (over: any) => ({ id: "x", kind: "file", title: "t", status: "added", inFinalDeliverable: true, ...over });
    // workRoot == root:该测试里工作区文件(a.md)与 projectRoot 同目录(report 走 .opc/runs,file 走 workRoot)
    expect(resolveArtifactDownload(root, root, RID, { id: "report", kind: "report", title: "r", status: "final", inFinalDeliverable: true })?.body).toContain("报告");
    expect(resolveArtifactDownload(root, root, RID, F({ path: "a.md" }))?.body).toBe("文件内容");
    expect(resolveArtifactDownload(root, root, RID, F({ path: "../../../etc/passwd" }))).toBeNull();
    expect(resolveArtifactDownload(root, root, RID, F({ path: "a.md", status: "rejected" }))).toBeNull();
    expect(resolveArtifactDownload(root, root, RID, F({ path: "a.md", status: "deleted" }))).toBeNull();
    // 软链逃逸:link → 外部文件,守卫应拒
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
    fs.writeFileSync(outside, "secret");
    try {
      fs.symlinkSync(outside, path.join(root, "link.txt"));
      expect(resolveArtifactDownload(root, root, RID, F({ path: "link.txt" }))).toBeNull();
    } catch { /* 无符号链接权限(Windows 非管理员)→ 跳过该断言 */ }
    finally { try { fs.rmSync(outside); } catch { /* */ } }
  });

  it("P0 · file 产物基于独立 workRoot(≠projectRoot)下载:字节一致 + 越界拒 + workRoot=null 不可下载", () => {
    // 复刻真实缺陷场景:calc.py 类交付物落在公司 workRoot,不在 projectRoot 的 .opc/runs 下。
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-wr-"));
    const proj = path.join(root, "proj");                       // projectRoot(.opc/runs 元数据在此)
    const workRoot = path.join(root, "company-workspace");      // run 的持久工作根(交付物在此)
    fs.mkdirSync(path.join(proj, ".opc", "runs", RID), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    const calcBody = "def add(a, b):\n    return a + b\n";
    fs.writeFileSync(path.join(workRoot, "calc.py"), calcBody, "utf-8");
    const F = (over: any) => ({ id: "x", kind: "file", title: "t", status: "added", inFinalDeliverable: true, ...over });

    // 基于 workRoot 解析 → 字节完全一致
    const dl = resolveArtifactDownload(proj, workRoot, RID, F({ path: "calc.py" }));
    expect(dl?.body).toBe(calcBody);
    expect(dl?.filename).toBe("calc.py");
    // 路径穿越:resolve 后逃出 workRoot → 拒
    expect(resolveArtifactDownload(proj, workRoot, RID, F({ path: "../proj/.opc/runs/" + RID }))).toBeNull();
    expect(resolveArtifactDownload(proj, workRoot, RID, F({ path: "../../etc/passwd" }))).toBeNull();
    // 若误用 projectRoot 当工作根(旧 bug)→ calc.py 不在那里 → 无归档副本时不可下载(证明确实读的是 workRoot)
    expect(resolveArtifactDownload(proj, proj, RID, F({ path: "calc.py" }))).toBeNull();
    // 无 workRoot 历史 run(workRoot=null)+ file 类 + 无 savedPath → 诚实不可下载
    expect(resolveArtifactDownload(proj, null, RID, F({ path: "calc.py" }))).toBeNull();
    // 预览同源:基于 workRoot 可读,workRoot=null 则 null
    expect(resolveArtifactPreview(proj, workRoot, RID, F({ path: "calc.py" }))?.content).toBe(calcBody);
    expect(resolveArtifactPreview(proj, null, RID, F({ path: "calc.py" }))).toBeNull();
  });

  it("B5 · hash/size:kind=file 经 run 持久 workRoot 解析算 sha256+字节数;缺文件/越界 workRoot 诚实留空;report 走 .opc;worker-output 不虚构", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar5-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "workspace"); // 该 run 的公司工作根,与 proj 分离
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    // task.json.workRoot 是 resolveRunWorkRoot 三态解析的权威首态
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: RID, workRoot }));
    const reportBody = "# 报告\n中文内容也计入字节数";
    fs.writeFileSync(path.join(dir, "report.md"), reportBody);
    const fileBody = "console.log('hi')\n";
    fs.writeFileSync(path.join(workRoot, "a.ts"), fileBody); // 真实交付物落在 workRoot,不在 proj
    fs.writeFileSync(path.join(root, "outside.ts"), "越界文件真实存在,守卫仍须拒"); // workRoot 之外

    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-1", producedBy: "dev", kind: "file-change", fileChanges: [
        { path: "a.ts", changeType: "create" },
        { path: "missing.ts", changeType: "create" },
        { path: "../outside.ts", changeType: "create" },
      ] })],
      deferred: [], degraded: false, hasReport: true, reportProducer: "lead",
    });
    saveArtifactRegistry(proj, RID, col); // 落盘前自动 enrich
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "artifacts.json"), "utf-8")) as { artifacts: RunArtifact[] };
    const byId = (id: string) => saved.artifacts.find(a => a.id === id)!;

    expect(byId("file:a.ts").hash).toBe("sha256:" + createHash("sha256").update(Buffer.from(fileBody)).digest("hex"));
    expect(byId("file:a.ts").size).toBe(Buffer.byteLength(fileBody));
    expect(byId("report").hash).toBe("sha256:" + createHash("sha256").update(Buffer.from(reportBody)).digest("hex"));
    expect(byId("report").size).toBe(Buffer.byteLength(reportBody));
    expect(byId("file:missing.ts").hash).toBeUndefined();
    expect(byId("file:missing.ts").size).toBeUndefined();
    expect(byId("file:../outside.ts").hash).toBeUndefined(); // 越界 workRoot 拒
    expect(byId("file:../outside.ts").size).toBeUndefined();
    expect(byId("art-1").hash).toBeUndefined(); // 无磁盘实体的 worker-output 不虚构

    // enrichArtifactEvidence 可单独调用,行为一致
    const col2 = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-2", producedBy: "dev", kind: "file-change", fileChanges: [{ path: "a.ts", changeType: "modify" }] })],
      deferred: [], degraded: false, hasReport: false,
    });
    enrichArtifactEvidence(proj, RID, col2);
    expect(col2.artifacts.find(a => a.id === "file:a.ts")?.size).toBe(Buffer.byteLength(fileBody));
  });

  it("B5 · workRoot=null(历史 run 无 task.json.workRoot、无事件推断)→ kind=file 证据/归档如实跳过,绝不回退 projectRoot;report 仍补", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar5null-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    // 不写 task.json.workRoot,也无 events "工作目录:" → resolveRunWorkRoot 返回 null
    const reportBody = "# 历史报告";
    fs.writeFileSync(path.join(dir, "report.md"), reportBody);
    // 即便 proj 下真有同名文件,也绝不能被误读(旧 bug 正是误读 projectRoot)
    fs.writeFileSync(path.join(proj, "a.ts"), "不应被读到");
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-1", producedBy: "dev", kind: "file-change", fileChanges: [{ path: "a.ts", changeType: "create" }] })],
      deferred: [], degraded: false, hasReport: true, reportProducer: "lead",
    });
    saveArtifactRegistry(proj, RID, col);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "artifacts.json"), "utf-8")) as { artifacts: RunArtifact[] };
    const byId = (id: string) => saved.artifacts.find(a => a.id === id)!;
    expect(byId("file:a.ts").hash).toBeUndefined(); // workRoot=null → 跳过,不回退 projectRoot
    expect(byId("file:a.ts").size).toBeUndefined();
    expect(byId("file:a.ts").savedPath).toBeUndefined(); // 文件归档副本也不生成
    expect(fs.existsSync(path.join(dir, "artifacts", "file_a.ts.ts"))).toBe(false);
    expect(byId("report").hash).toBe("sha256:" + createHash("sha256").update(Buffer.from(reportBody)).digest("hex")); // report 走 .opc,不受 workRoot 影响
  });

  it("B5 · acceptedBy:核查通过 → 记 verifier;后到否决推翻且 JSON 落盘不留键;无验收数据留空", () => {
    const T = "2026-06-30T00:01:00Z";
    const vr = (over: object) => ({ reviewArtifactId: "rev", reviewedArtifactId: "dev", producerId: "dev", verifierId: "qa", method: "code-review", accept: true, summary: "ok", createdAt: T, ...over });

    const accepted = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
      verificationResults: [vr({ reviewArtifactId: "rev-1" })],
    });
    expect(accepted.artifacts.find(a => a.id === "art-1")?.acceptedBy).toBe("qa");

    const overturned = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
      verificationResults: [
        vr({ reviewArtifactId: "rev-1" }),
        vr({ reviewArtifactId: "rev-2", verifierId: "qa2", accept: false, summary: "翻案" }),
      ],
    });
    const w = overturned.artifacts.find(a => a.id === "art-1")!;
    expect(w.status).toBe("rejected");
    expect(w.acceptedBy).toBeUndefined();
    expect("acceptedBy" in JSON.parse(JSON.stringify(w))).toBe(false);

    const noVerify = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
    });
    expect(noVerify.artifacts.find(a => a.id === "art-1")?.acceptedBy).toBeUndefined();

    // 反向顺序:先否决后通过——"否决定终身"语义,accept 不复活 status 也不写 acceptedBy(验收报告问题#3补测)
    const rejectedFirst = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
      verificationResults: [
        vr({ reviewArtifactId: "rev-1", verifierId: "qa1", accept: false, summary: "先否决" }),
        vr({ reviewArtifactId: "rev-2", verifierId: "qa2", accept: true, summary: "后通过" }),
      ],
    });
    const rf = rejectedFirst.artifacts.find(a => a.id === "art-1")!;
    expect(rf.status).toBe("rejected");
    expect(rf.acceptedBy).toBeUndefined();
  });

  it("loadRunArtifacts:有 artifacts.json 用注册表,无则回退派生", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar3-"));
    const dir = path.join(root, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.md"), "# 报告");
    expect(loadRunArtifacts(root, RID).artifacts.some(a => a.id === "report")).toBe(true);
    saveArtifactRegistry(root, RID, buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-9", producedBy: "rp-dev" })], deferred: [], degraded: false, hasReport: true, reportProducer: "rp-lead",
    }));
    expect(loadRunArtifacts(root, RID).artifacts.some(a => a.id === "art-9")).toBe(true);
  });
});

describe("B5c · status 双字段拆分(changeType/reviewStatus,旧 status 不变)", () => {
  it("worker-output:旧 status=accepted 不变;新增 reviewStatus=accepted,changeType 缺省", () => {
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
    });
    const w = col.artifacts.find(a => a.id === "art-1")!;
    expect(w.status).toBe("accepted");
    expect(w.reviewStatus).toBe("accepted");
    expect(w.changeType).toBeUndefined();
  });

  it("file:旧 status 三态不变;新增 changeType 同值,reviewStatus=accepted", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-1", producedBy: "dev", kind: "file-change", fileChanges: [
        { path: "a.ts", changeType: "create" },
        { path: "b.ts", changeType: "modify" },
        { path: "c.ts", changeType: "delete" },
      ] })],
      deferred: [], degraded: false, hasReport: false,
    });
    const fa = col.artifacts.find(a => a.id === "file:a.ts")!;
    const fb = col.artifacts.find(a => a.id === "file:b.ts")!;
    const fc = col.artifacts.find(a => a.id === "file:c.ts")!;
    expect(fa.status).toBe("added"); expect(fa.changeType).toBe("added"); expect(fa.reviewStatus).toBe("accepted");
    expect(fb.status).toBe("modified"); expect(fb.changeType).toBe("modified"); expect(fb.reviewStatus).toBe("accepted");
    expect(fc.status).toBe("deleted"); expect(fc.changeType).toBe("deleted"); expect(fc.reviewStatus).toBe("accepted");
  });

  it("否决回标:worker-output/file 的 status+reviewStatus 都转 rejected,但 file 的 changeType 保留原变更类型不被覆盖", () => {
    const col = buildRunArtifactCollection({
      runId: RID,
      artifacts: [art({ id: "art-dev", producedBy: "dev", kind: "file-change", fileChanges: [{ path: "bad.ts", changeType: "create" }] })],
      deferred: [], degraded: false, hasReport: false,
      verificationResults: [
        { reviewArtifactId: "rev-1", reviewedArtifactId: "dev", producerId: "dev", verifierId: "tester", method: "code-review", accept: false, summary: "broken", createdAt: "2026-06-30T00:01:00Z" },
      ],
    });
    const w = col.artifacts.find(a => a.id === "art-dev")!;
    expect(w.status).toBe("rejected"); expect(w.reviewStatus).toBe("rejected");
    const f = col.artifacts.find(a => a.id === "file:bad.ts")!;
    expect(f.status).toBe("rejected"); // 旧字段:此刻语义已切到"验收结论"(历史混装的真实写照)
    expect(f.reviewStatus).toBe("rejected");
    expect(f.changeType).toBe("added"); // 新字段:变更类型不受验收结论影响,如实保留
  });

  it("deferred:status/reviewStatus 都=rejected,changeType 缺省(非文件产物)", () => {
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: [], degraded: true, degradedReason: "全失败", hasReport: false,
      deferred: [{ agentId: "dev", taskId: "t1", reason: "timeout" }],
    });
    const d = col.artifacts.find(a => a.kind === "worker-output")!;
    expect(d.status).toBe("rejected"); expect(d.reviewStatus).toBe("rejected"); expect(d.changeType).toBeUndefined();
  });

  it("review-result:status 与 reviewStatus 同步 accepted", () => {
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: [art({ id: "art-1", producedBy: "dev" })], deferred: [], degraded: false, hasReport: false,
      verificationResults: [{ reviewArtifactId: "rev-1", reviewedArtifactId: "dev", producerId: "dev", verifierId: "qa", method: "code-review", accept: true, summary: "ok", createdAt: "2026-06-30T00:01:00Z" }],
    });
    const rr = col.artifacts.find(a => a.kind === "review-result")!;
    expect(rr.status).toBe("accepted"); expect(rr.reviewStatus).toBe("accepted");
  });

  it("report:final→reviewStatus=accepted;degraded→reviewStatus=degraded,旧 status 值不变", () => {
    const okReport = buildRunArtifactCollection({
      runId: RID, artifacts: [], deferred: [], degraded: false, hasReport: true, reportProducer: "lead",
    }).artifacts.find(a => a.kind === "report")!;
    expect(okReport.status).toBe("final"); expect(okReport.reviewStatus).toBe("accepted");

    const degReport = buildRunArtifactCollection({
      runId: RID, artifacts: [], deferred: [], degraded: true, degradedReason: "x", hasReport: true, reportProducer: "lead",
    }).artifacts.find(a => a.kind === "report")!;
    expect(degReport.status).toBe("degraded"); expect(degReport.reviewStatus).toBe("degraded");
  });
});

describe("B5c · artifacts/ 实体目录归档(archiveArtifactEntities / saveArtifactRegistry sourceArtifacts)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("归档 report/file/worker-output(inlineText)内容;kind=review-result 无实体不归档;savedPath 指向真实可读文件", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const workRoot = path.join(root, "workspace");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: RID, workRoot }));
    const reportBody = "# 报告正文,归档副本应与此一致";
    fs.writeFileSync(path.join(dir, "report.md"), reportBody);
    const fileBody = "console.log('归档副本')\n";
    fs.writeFileSync(path.join(workRoot, "a.ts"), fileBody); // kind=file 交付物落在 workRoot
    const inline = "worker 内联文本产出,应原样归档";

    const artifactsIn: Artifact[] = [
      art({ id: "art-file", producedBy: "dev", kind: "file-change", fileChanges: [{ path: "a.ts", changeType: "create" }] }),
      art({ id: "art-inline", producedBy: "researcher", inlineText: inline }),
    ];
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: true, reportProducer: "lead",
      verificationResults: [{ reviewArtifactId: "rev-1", reviewedArtifactId: "dev", producerId: "dev", verifierId: "qa", method: "x", accept: true, summary: "ok", createdAt: "2026-06-30T00:01:00Z" }],
    });
    saveArtifactRegistry(proj, RID, col, artifactsIn);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "artifacts.json"), "utf-8")) as { artifacts: RunArtifact[] };
    const byId = (id: string) => saved.artifacts.find(a => a.id === id)!;

    const report = byId("report");
    expect(report.savedPath).toBe("artifacts/report.md");
    expect(fs.readFileSync(path.join(dir, report.savedPath!), "utf-8")).toBe(reportBody);

    const file = byId("file:a.ts");
    expect(file.savedPath).toBe("artifacts/file_a.ts.ts");
    expect(fs.readFileSync(path.join(dir, file.savedPath!), "utf-8")).toBe(fileBody);

    const worker = byId("art-inline");
    expect(worker.savedPath).toBe("artifacts/art-inline.txt");
    expect(fs.readFileSync(path.join(dir, worker.savedPath!), "utf-8")).toBe(inline);
    expect(worker.savedPathTruncated).toBeUndefined();

    const review = saved.artifacts.find(a => a.kind === "review-result")!;
    expect(review.savedPath).toBeUndefined(); // 无实体(既非磁盘文件也无 inlineText)不归档
  });

  it("超 1MB 截断并标记 savedPathTruncated;真实写入字节数=上限", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    const bigText = "x".repeat(1024 * 1024 + 777);
    const artifactsIn: Artifact[] = [art({ id: "art-big", producedBy: "researcher", inlineText: bigText })];
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: false,
    });
    saveArtifactRegistry(proj, RID, col, artifactsIn);
    const big = col.artifacts.find(a => a.id === "art-big")!;
    expect(big.savedPathTruncated).toBe(true);
    const bytes = fs.statSync(path.join(dir, big.savedPath!));
    expect(bytes.size).toBe(1024 * 1024);
  });

  it("id 含路径穿越字符(../)→ 字符被替换成安全文件名,归档副本仍落在 artifacts/ 内,不产生越界文件", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    const artifactsIn: Artifact[] = [art({ id: "worker:../../evil", producedBy: "dev", inlineText: "越界尝试" })];
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: false,
    });
    saveArtifactRegistry(proj, RID, col, artifactsIn);
    const w = col.artifacts.find(a => a.producer === "dev")!;
    expect(w.savedPath).toBe("artifacts/worker_.._.._evil.txt");
    expect(w.savedPath).not.toMatch(/\.\.[\\/]/); // 归档相对路径本身不含 "../" 分隔序列(斜杠已被替换)
    // 越界检查:项目根目录、run 目录之外都不应出现名为 evil 的文件
    expect(fs.existsSync(path.join(proj, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(root, "evil"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, w.savedPath!), "utf-8")).toBe("越界尝试");
    expect(fs.readdirSync(path.join(dir, "artifacts"))).toEqual([path.basename(w.savedPath!)]);
  });

  it("净化后仍以字面 .. 开头的极端 id → relEscapes 按分段判定不误杀,安全归档在 artifacts/ 内", () => {
    // relEscapes 改为路径分段判断(".." 必须是完整首段)后,".._.._evil.txt" 这类不含分隔符的
    // 文件名物理上无法穿越,应正常归档——旧的字符串前缀判断会把它误杀(验收报告瑕疵项)。
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    const artifactsIn: Artifact[] = [art({ id: "../../evil", producedBy: "dev", inlineText: "越界尝试" })];
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: false,
    });
    saveArtifactRegistry(proj, RID, col, artifactsIn);
    const w = col.artifacts.find(a => a.producer === "dev")!;
    expect(w.savedPath).toBe("artifacts/.._.._evil.txt");
    expect(fs.readFileSync(path.join(dir, w.savedPath!), "utf-8")).toBe("越界尝试");
    // 越界检查:归档只落在 artifacts/ 内,项目根/更外层不出现 evil 文件
    expect(fs.existsSync(path.join(proj, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(root, "evil"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, "artifacts"))).toEqual([".._.._evil.txt"]);
  });

  it("无任何可归档实体(纯 deferred,无 report/file/inlineText)时不创建 artifacts/ 目录", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    const col = buildRunArtifactCollection({
      runId: RID, artifacts: [], degraded: true, degradedReason: "全失败", hasReport: false,
      deferred: [{ agentId: "dev", taskId: "t1", reason: "timeout" }],
    });
    saveArtifactRegistry(proj, RID, col, []);
    expect(fs.existsSync(path.join(dir, "artifacts"))).toBe(false);
    expect(col.artifacts.every(a => a.savedPath === undefined)).toBe(true);
  });

  it("archiveArtifactEntities 可单独调用(不依赖 saveArtifactRegistry)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar6-"));
    const proj = path.join(root, "proj");
    const dir = path.join(proj, ".opc", "runs", RID);
    fs.mkdirSync(dir, { recursive: true });
    const artifactsIn: Artifact[] = [art({ id: "art-solo", producedBy: "dev", inlineText: "独立调用" })];
    const col = buildRunArtifactCollection({ runId: RID, artifacts: artifactsIn, deferred: [], degraded: false, hasReport: false });
    archiveArtifactEntities(proj, RID, col, artifactsIn);
    const w = col.artifacts.find(a => a.id === "art-solo")!;
    expect(w.savedPath).toBe("artifacts/art-solo.txt");
    expect(fs.readFileSync(path.join(dir, w.savedPath!), "utf-8")).toBe("独立调用");
  });
});
