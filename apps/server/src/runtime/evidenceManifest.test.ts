import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildEvidenceManifest, writeEvidenceManifest, loadEvidenceManifest, verifyEvidenceManifest, sha256Hex, type EvidenceManifest } from "./evidenceManifest.js";
import type { RunTestEvidence } from "@opc/shared";

// 战役B · EvidenceManifest 骨架单测:临时目录造假证据文件,验证
// ① 覆盖(存在的 22 类文件全部入账,含 artifacts/**、logs/** 目录)
// ② hash/size 正确(与独立 createHash 计算逐一对得上)
// ③ 缺失文件被跳过(不报错、不虚构条目)
// ④ tests 恒为 null(A8 TestEvidence 合入前不许有任何假值)
// ⑤ changes.json / artifacts.json 的汇入与"缺失→null"语义

let runDir: string;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-evidence-manifest-"));
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return content;
}

function expectedSha(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function entryByPath(m: EvidenceManifest, p: string) {
  return m.files.find((f) => f.path === p);
}

describe("buildEvidenceManifest — 覆盖与 hash 正确性", () => {
  it("存在的证据文件全部入账,sha256/size/kind/createdAt 正确", () => {
    const taskContent = write("task.json", JSON.stringify({ id: "run-x", status: "success" }));
    const reportContent = write("report.md", "# 最终报告\n正文内容");
    const eventsContent = write("events.jsonl", '{"type":"run_started"}\n{"type":"run_finished"}\n');
    const blobContent = write(path.join("artifacts", "art-1.txt"), "worker 产出字节");
    const nestedBlob = write(path.join("artifacts", "sub", "deep.bin"), "嵌套实体");
    const logContent = write(path.join("logs", "engine.log"), "line1\nline2\n");

    const m = buildEvidenceManifest(runDir);

    const task = entryByPath(m, "task.json");
    expect(task).toBeDefined();
    expect(task!.kind).toBe("task");
    expect(task!.sha256).toBe(expectedSha(taskContent));
    expect(task!.size).toBe(Buffer.byteLength(taskContent, "utf-8"));
    expect(Date.parse(task!.createdAt)).not.toBeNaN();

    const report = entryByPath(m, "report.md");
    expect(report!.kind).toBe("report_md");
    expect(report!.sha256).toBe(expectedSha(reportContent));
    expect(report!.size).toBe(Buffer.byteLength(reportContent, "utf-8"));

    const events = entryByPath(m, "events.jsonl");
    expect(events!.kind).toBe("events");
    expect(events!.sha256).toBe(expectedSha(eventsContent));

    const blob = entryByPath(m, "artifacts/art-1.txt");
    expect(blob!.kind).toBe("artifact_entity");
    expect(blob!.sha256).toBe(expectedSha(blobContent));

    const deep = entryByPath(m, "artifacts/sub/deep.bin");
    expect(deep!.kind).toBe("artifact_entity");
    expect(deep!.sha256).toBe(expectedSha(nestedBlob));

    const log = entryByPath(m, "logs/engine.log");
    expect(log!.kind).toBe("log");
    expect(log!.sha256).toBe(expectedSha(logContent));

    expect(m.files).toHaveLength(6);
    expect(m.runId).toBe(path.basename(runDir));
  });

  it("单文件全集:每个已知单文件名映射到正确 kind(§0.2 的 20 个 + MUP 波2 的 producer-manifest.json)", () => {
    const names: Array<[string, string]> = [
      ["task.json", "task"],
      ["report.md", "report_md"],
      ["report.html", "report_html"],
      ["events.jsonl", "events"],
      ["trace.json", "trace"],
      ["cost.json", "cost"],
      ["changes.json", "changes"],
      ["deferred.json", "deferred"],
      ["structured-report.json", "structured_report"],
      ["memory_proposals.json", "memory_proposals"],
      ["committed-memories.json", "committed_memories"],
      ["failure-report.json", "failure_report"],
      ["run-history.jsonl", "run_history"],
      ["run-summary.json", "run_summary"],
      ["result.json", "result"],
      ["diagnostics.json", "diagnostics"],
      ["tool_calls.jsonl", "tool_calls"],
      ["a2a_messages.jsonl", "a2a_messages"],
      ["artifacts.json", "artifact_registry"],
      ["worker.config.json", "worker_config"],
      // MUP 波2 · ProducerArtifactManifest 纳入哈希范围(冻结产物指纹自身也是防篡改证据)
      ["producer-manifest.json", "producer_manifest"],
    ];
    for (const [name] of names) write(name, `content-of-${name}`);

    const m = buildEvidenceManifest(runDir);
    expect(m.files).toHaveLength(names.length);
    for (const [name, kind] of names) {
      const e = entryByPath(m, name);
      expect(e, name).toBeDefined();
      expect(e!.kind, name).toBe(kind);
      expect(e!.sha256, name).toBe(expectedSha(`content-of-${name}`));
    }
  });

  it("缺失文件被跳过:只造 2 个文件就只有 2 条,其余 20 类不虚构", () => {
    write("report.md", "只有报告");
    write("cost.json", "{}");

    const m = buildEvidenceManifest(runDir);
    expect(m.files.map((f) => f.path).sort()).toEqual(["cost.json", "report.md"]);
  });

  it("清单外的杂散文件不入账(manifest 只覆盖 §0.2 的 22 类)", () => {
    write("task.json", "{}");
    write("stray-notes.txt", "不属于证据全集");
    write("manifest.json", "{}"); // 未来双落的 manifest 自身也绝不能自引用入账

    const m = buildEvidenceManifest(runDir);
    expect(m.files.map((f) => f.path)).toEqual(["task.json"]);
  });

  it("run 目录不存在 → 空清单,不抛错", () => {
    const ghost = path.join(runDir, "does-not-exist");
    const m = buildEvidenceManifest(ghost);
    expect(m.files).toEqual([]);
    expect(m.workspaceChanges).toBeNull();
    expect(m.artifactDownloads).toBeNull();
    expect(m.tests).toBeNull();
    expect(m.runId).toBe("does-not-exist");
  });
});

describe("buildEvidenceManifest — workspaceChanges 汇入(changes.json)", () => {
  it("正常数组:path+changeType 入账,before/after 全文不进 manifest", () => {
    write(
      "changes.json",
      JSON.stringify([
        { path: "src/app.ts", changeType: "modify", before: "旧", after: "新" },
        { path: "docs/readme.md", changeType: "create", after: "全文" },
      ]),
    );

    const m = buildEvidenceManifest(runDir);
    expect(m.workspaceChanges).toEqual([
      { path: "src/app.ts", changeType: "modify" },
      { path: "docs/readme.md", changeType: "create" },
    ]);
  });

  it("缺失 → null;存在但空数组 → [](两态严格区分)", () => {
    expect(buildEvidenceManifest(runDir).workspaceChanges).toBeNull();
    write("changes.json", "[]");
    expect(buildEvidenceManifest(runDir).workspaceChanges).toEqual([]);
  });

  it("损坏 JSON → null,但 changes.json 本体仍以字节入账 files(hash 照算)", () => {
    const broken = write("changes.json", "[{截断的损坏内容");
    const m = buildEvidenceManifest(runDir);
    expect(m.workspaceChanges).toBeNull();
    const e = entryByPath(m, "changes.json");
    expect(e).toBeDefined();
    expect(e!.sha256).toBe(expectedSha(broken));
  });

  it("无 path 的条目跳过;changeType 缺失如实记 null", () => {
    write("changes.json", JSON.stringify([{ changeType: "modify" }, { path: "a.txt" }]));
    const m = buildEvidenceManifest(runDir);
    expect(m.workspaceChanges).toEqual([{ path: "a.txt", changeType: null }]);
  });
});

describe("buildEvidenceManifest — artifactDownloads 汇入(artifacts.json)", () => {
  it("只收有 downloadUrl 或 savedPath 的 artifact,字段照抄不重算", () => {
    write(
      "artifacts.json",
      JSON.stringify({
        runId: "run-x",
        degraded: false,
        artifacts: [
          {
            id: "file:report.md",
            kind: "file",
            path: "report.md",
            downloadUrl: "/api/runs/run-x/artifacts/download?artifactId=file%3Areport.md",
            savedPath: "artifacts/file_report.md.md",
            hash: "sha256:abc123",
            size: 3211,
            status: "modified",
          },
          { id: "art-1", kind: "worker-output", title: "无下载入口的纯记录" },
          { id: "report", kind: "report", savedPath: "artifacts/report.md" },
        ],
      }),
    );

    const m = buildEvidenceManifest(runDir);
    expect(m.artifactDownloads).toEqual([
      {
        artifactId: "file:report.md",
        kind: "file",
        path: "report.md",
        downloadUrl: "/api/runs/run-x/artifacts/download?artifactId=file%3Areport.md",
        savedPath: "artifacts/file_report.md.md",
        hash: "sha256:abc123",
        size: 3211,
      },
      { artifactId: "report", kind: "report", savedPath: "artifacts/report.md" },
    ]);
  });

  it("缺失/损坏/形状不对 → null", () => {
    expect(buildEvidenceManifest(runDir).artifactDownloads).toBeNull();
    write("artifacts.json", "不是 JSON");
    expect(buildEvidenceManifest(runDir).artifactDownloads).toBeNull();
    write("artifacts.json", JSON.stringify({ runId: "x" })); // 没有 artifacts 数组
    expect(buildEvidenceManifest(runDir).artifactDownloads).toBeNull();
  });
});

describe("buildEvidenceManifest — tests 接 A8 TestEvidence(诚实纪律)", () => {
  const sampleTe: RunTestEvidence[] = [
    { at: "2026-07-11T00:00:00.000Z", command: "npm test", passed: true, exitCode: 0, source: "quality_gate" },
  ];

  it("不传 testEvidence → tests 为 null(向后兼容,证据齐全也不虚构)", () => {
    write("task.json", "{}");
    write("result.json", JSON.stringify({ status: "success" }));
    expect(buildEvidenceManifest(runDir).tests).toBeNull();
  });

  it("传真实 testEvidence → 原样带出", () => {
    write("task.json", "{}");
    expect(buildEvidenceManifest(runDir, sampleTe).tests).toEqual(sampleTe);
  });

  it("空数组 → null(严格区分'没测过'与'测了但空',不虚构空账本)", () => {
    write("task.json", "{}");
    expect(buildEvidenceManifest(runDir, []).tests).toBeNull();
    expect(buildEvidenceManifest(runDir, null).tests).toBeNull();
  });
});

describe("writeEvidenceManifest / loadEvidenceManifest — 落盘往返", () => {
  it("写 manifest.json 后读回逐字段一致", () => {
    write("task.json", JSON.stringify({ id: "run-x" }));
    write("report.md", "# 报告");
    const m = buildEvidenceManifest(runDir, [
      { at: "2026-07-11T00:00:00.000Z", command: "pytest", passed: false, exitCode: 1, source: "tool" },
    ]);
    writeEvidenceManifest(runDir, m);
    const loaded = loadEvidenceManifest(runDir);
    expect(loaded).toEqual(m);
    // manifest.json 自身不被 build 入账(清单外杂散)
    expect(buildEvidenceManifest(runDir).files.map((f) => f.path)).not.toContain("manifest.json");
  });

  it("loadEvidenceManifest 对缺失/损坏返回 null", () => {
    expect(loadEvidenceManifest(runDir)).toBeNull();
    write("manifest.json", "不是 JSON");
    expect(loadEvidenceManifest(runDir)).toBeNull();
  });
});

describe("verifyEvidenceManifest — 篡改检出(证据链自证)", () => {
  it("未篡改 → ok=true、mismatches 空", () => {
    write("task.json", JSON.stringify({ id: "run-x" }));
    write("report.md", "# 原始报告");
    const m = buildEvidenceManifest(runDir);
    writeEvidenceManifest(runDir, m);
    const r = verifyEvidenceManifest(runDir);
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.checked).toBe(m.files.length);
  });

  it("改 report.md 一个字节 → ok=false,mismatches 精确命中该文件", () => {
    write("task.json", JSON.stringify({ id: "run-x" }));
    const orig = write("report.md", "# 原始报告");
    const m = buildEvidenceManifest(runDir);
    writeEvidenceManifest(runDir, m);
    write("report.md", orig + "X"); // 篡改
    const r = verifyEvidenceManifest(runDir);
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((x) => x.path)).toEqual(["report.md"]);
    expect(r.mismatches[0].actual).not.toBe(r.mismatches[0].expected);
  });

  it("证据文件被删除 → actual=null 记为 mismatch", () => {
    write("task.json", "{}");
    write("report.md", "# 报告");
    const m = buildEvidenceManifest(runDir);
    writeEvidenceManifest(runDir, m);
    fs.rmSync(path.join(runDir, "report.md"));
    const r = verifyEvidenceManifest(runDir);
    expect(r.ok).toBe(false);
    expect(r.mismatches.find((x) => x.path === "report.md")?.actual).toBeNull();
  });

  it("manifest.json 缺失 → ok=false(无从校验)", () => {
    expect(verifyEvidenceManifest(runDir).ok).toBe(false);
  });
});

describe("release gate · EvidenceManifest fail-closed inputs and writes", () => {
  it("release gate: missing manifest never verifies ok", () => {
    const result = verifyEvidenceManifest(runDir);
    expect(result).toMatchObject({ ok: false, checked: 0 });
    expect(result.mismatches).toEqual([
      { path: "manifest.json", expected: "<present>", actual: null },
    ]);
  });

  it("release gate: empty manifest never verifies ok", () => {
    write("manifest.json", JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(runDir),
      generatedAt: new Date().toISOString(),
      files: [],
      workspaceChanges: null,
      artifactDownloads: null,
      tests: null,
    }));

    expect(loadEvidenceManifest(runDir)).toBeNull();
    expect(verifyEvidenceManifest(runDir).ok).toBe(false);
  });

  it("release gate: manifest runId mismatch never verifies ok", () => {
    write("task.json", JSON.stringify({ id: path.basename(runDir) }));
    const mismatched = { ...buildEvidenceManifest(runDir), runId: "different-run" } as EvidenceManifest;
    writeEvidenceManifest(runDir, mismatched);

    expect(loadEvidenceManifest(runDir)).toBeNull();
    expect(verifyEvidenceManifest(runDir).ok).toBe(false);
  });

  it("release gate: manifest write target being a directory throws and never verifies ok", () => {
    write("task.json", JSON.stringify({ id: path.basename(runDir) }));
    fs.mkdirSync(path.join(runDir, "manifest.json"));

    expect(() => writeEvidenceManifest(runDir, buildEvidenceManifest(runDir))).toThrow();
    expect(verifyEvidenceManifest(runDir).ok).toBe(false);
    expect(fs.readdirSync(runDir).some(name => name.startsWith(".manifest.") && name.endsWith(".tmp"))).toBe(false);
  });

  it("release gate: non-writable run target throws and cannot leave an ok manifest", () => {
    const notDirectory = path.join(runDir, "run-target-is-a-file");
    fs.writeFileSync(notDirectory, "cannot contain manifest.json", "utf-8");

    expect(() => writeEvidenceManifest(notDirectory, {
      schemaVersion: 1,
      runId: path.basename(notDirectory),
      generatedAt: new Date().toISOString(),
      files: [],
      workspaceChanges: null,
      artifactDownloads: null,
      tests: null,
    })).toThrow();
    expect(verifyEvidenceManifest(notDirectory).ok).toBe(false);
  });
});

describe("sha256Hex — 自带纯 hash util", () => {
  it("string 与 Buffer 输入均产纯 hex,与 node:crypto 独立计算一致", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// P0(审计修复)· manifest 必须在 events.jsonl 最后一条事件(run_finished)之后构建,否则 events.jsonl
// 哈希必然过期 → verify 端点在所有 run 上失配却仍标 evidenceIntegrity=ok(假阳性)。这里锁死这条时序不变量。
describe("P0 · EvidenceManifest 构建时序不变量(events.jsonl 定稿后才构建)", () => {
  it("先构建 manifest,再往 events.jsonl 追加 run_finished → 自验失配(重现被审计抓到的 bug)", () => {
    write("task.json", JSON.stringify({ id: "run-x", status: "done" }));
    write("events.jsonl", '{"type":"run_started"}\n{"type":"worker_done"}\n');
    const m = buildEvidenceManifest(runDir);
    writeEvidenceManifest(runDir, m);
    // 模拟旧 bug:manifest 已定,之后才 emit run_finished(追加进 events.jsonl)。
    fs.appendFileSync(path.join(runDir, "events.jsonl"), '{"type":"run_finished"}\n', "utf-8");
    const r = verifyEvidenceManifest(runDir);
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((x) => x.path)).toContain("events.jsonl");
  });

  it("先写完 run_finished,再构建 manifest → 立即自验通过(修复后的正确时序)", () => {
    write("task.json", JSON.stringify({ id: "run-x", status: "done" }));
    write("events.jsonl", '{"type":"run_started"}\n{"type":"worker_done"}\n{"type":"run_finished"}\n');
    const m = buildEvidenceManifest(runDir);
    writeEvidenceManifest(runDir, m);
    expect(verifyEvidenceManifest(runDir, m).ok).toBe(true);
  });
});

// P0(审计修复)· 源码顺序守卫:orchestrator run-end 必须在 emit("run_finished") 之后才 buildEvidenceManifest,
// 且早于 run_finished 的旧构建点已移除。镜像 importConfirmUnsafeAck.contract.test 的源码断言手法,防时序回归。
describe("P0 · orchestrator 源码顺序守卫", () => {
  const ORCH = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.ts"), "utf-8");
  it("buildEvidenceManifest 出现在 emit(\"run_finished\") 之后", () => {
    const finishedAt = ORCH.indexOf('emit("run_finished"');
    const buildAt = ORCH.indexOf("buildEvidenceManifest(_emDir");
    expect(finishedAt).toBeGreaterThan(0);
    expect(buildAt).toBeGreaterThan(finishedAt);
  });
  it("构建后立即自验 verifyEvidenceManifest,失败置 evidenceIntegrity=degraded", () => {
    expect(ORCH).toContain("verifyEvidenceManifest(_emDir");
    expect(ORCH).toMatch(/_verify\.ok[\s\S]{0,200}evidenceIntegrity = "degraded"/);
  });
  // P0(审计)· 异步失败反思(追加 lesson 事件 + memory_proposals)必须在 emit(run_finished) 之前 await 完,
  // 否则它在 manifest 之后异步落盘 → events.jsonl/memory_proposals 哈希过期(异步版时序假阳性)。
  it("异步反思不再 void:留 _reflectionPromise 并在 run_finished 前 await(反思落定后才建 manifest)", () => {
    expect(ORCH).toMatch(/_reflectionPromise = reflectOnRun\(/);
    const awaitAt = ORCH.indexOf("await _reflectionPromise");
    // 用实际调用签名匹配(而非注释里的字面量)——正常收尾路径的 run_finished emit。
    const finishedAt = ORCH.indexOf('emit("run_finished", undefined, { runId, totalTokens: run.totalTokens, totalCost: run.totalCostUsd, allClean, deferredCount');
    expect(awaitAt).toBeGreaterThan(0);
    expect(finishedAt).toBeGreaterThan(0);
    expect(awaitAt).toBeLessThan(finishedAt); // await 在 run_finished 之前
    expect(ORCH).not.toMatch(/void reflectOnRun\(/); // 不再 fire-and-forget
  });
  // P1 · 统一 RuntimeTaskContract 必须从不可变用户目标创建。后续拆解与重试只能
  // 通过 tightenRuntimeTaskContract 收紧，不能绕过合同直接弱化验收要求。
  it('RuntimeTaskContract 从不可变目标创建，子任务只收紧且 no-code ceiling 不可抬高', () => {
    expect(ORCH).toMatch(/runtimeTaskContract = createRuntimeTaskContract\(\{/);
    expect(ORCH).toMatch(/objective: goal/);
    expect(ORCH).toMatch(/const runForbidsCode = runtimeTaskContract\.acceptance\.forbidsCode/);
    expect(ORCH).toMatch(/let runRequiresCode = runtimeTaskContract\.acceptance\.requiresCode/);
    expect(ORCH).toMatch(/let runRequiresTests = runtimeTaskContract\.acceptance\.requiresTests/);
    expect(ORCH).toMatch(/runtimeTaskContract = tightenRuntimeTaskContract\(runtimeTaskContract, \{/);
    expect(ORCH).toMatch(/const workerIsCoder = \(runForbidsCode \|\| workerIsTextDependent\) \? false : taskRequiresCode\(wa\.task, worker\.role\)/);
    expect(ORCH).toMatch(/const redoIsCoder = \(runForbidsCode \|\| redoIsTextDependent\) \? false : taskRequiresCode\(newTask, worker\.role\)/);
  });
});
