import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  reclassifyLegacyRunsOnStartup,
  classifyLegacyRun,
  reportHasFailureText,
} from "./legacyRunReclassify.js";

const FFFD = "�";
const FAIL_REASON = "legacy:输出为失败文本,历史数据重分类";
const GARBLE_REASON = "legacy:content/goal 编码损坏(乱码),历史数据重分类";
const UNVERIFIED_REASON = "legacy:测试通过来自 auto-detected(跑到源码树自身而非本 run 产物),成功证据不可信,历史数据重分类";

let root: string;
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

function mkRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-reclass-"));
  return root;
}
function mkRun(id: string, task: Record<string, unknown>, report?: string): void {
  const dir = path.join(root, ".opc", "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id, ...task }));
  if (report !== undefined) fs.writeFileSync(path.join(dir, "report.md"), report);
}
function readTask(id: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", id, "task.json"), "utf-8"));
}
function readIndex(): Record<string, any> {
  const f = path.join(root, ".opc", "runs", "_index.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : {};
}
const markerPath = () => path.join(root, ".opc", "legacy-run-reclassify.v1.json");

describe("classifyLegacyRun / reportHasFailureText(纯判定)", () => {
  it("failure-text:status 成功 + 报告含 OPC harness 错误串 → failure-text", () => {
    expect(classifyLegacyRun({ status: "done" }, "API call failed after 3 retries: Connection error.")).toBe("failure-text");
    expect(classifyLegacyRun({ status: "completed" }, "Provider unavailable")).toBe("failure-text");
    expect(classifyLegacyRun({ status: "accepted" }, "some text after 5 retries and more")).toBe("failure-text");
  });

  it("failure-text 仅限成功 status:失败/其它 status 的失败文本不重分类(已 failed 无需修账)", () => {
    expect(classifyLegacyRun({ status: "failed" }, "API call failed after 3 retries")).toBeNull();
    expect(classifyLegacyRun({ status: "running" }, "API call failed after 3 retries")).toBeNull();
  });

  it("HTTP 4xx/5xx:带 HTTP 字面量或标准 reason 短语才算,正文里的三位数字(如 574 行)不误判", () => {
    expect(reportHasFailureText("HTTP 503 Service Unavailable")).toBe(true);
    expect(reportHasFailureText("请求失败\n502 Bad Gateway\n")).toBe(true);
    // 真实误判案例:量子计算终稿 "574 行 / 42.7 KB",574 恰在 [45]\d\d 范围,但无 HTTP/reason 短语
    expect(reportHasFailureText("### 终稿概况\n\n574 行 / 42.7 KB,覆盖三域六个小节")).toBe(false);
    expect(reportHasFailureText("完成度 400% 超预期")).toBe(false);
  });

  it("garbled:goal 或报告内容成堆 U+FFFD → garbled(status 无关)", () => {
    expect(classifyLegacyRun({ status: "done", userGoal: "请写代" + FFFD.repeat(3) + "码" }, "正常报告")).toBe("garbled");
    expect(classifyLegacyRun({ status: "done", userGoal: "clean goal" }, "User Goal\n" + FFFD.repeat(4) + " garbage")).toBe("garbled");
    // 兼容 goal(而非 userGoal)字段
    expect(classifyLegacyRun({ status: "failed", goal: FFFD.repeat(5) }, "")).toBe("garbled");
  });

  it("正常 run:干净 goal + 干净报告 → null;偶发单个 U+FFFD 不触发(阈值保守)", () => {
    expect(classifyLegacyRun({ status: "done", userGoal: "写个排序脚本" }, "# 报告\n任务完成。")).toBeNull();
    expect(classifyLegacyRun({ status: "done", userGoal: "含一个" + FFFD + "字符" }, "报告正常")).toBeNull();
  });

  it("failure-text 匹配剥页脚:仅页脚(goal 回显)含错误串、正文干净 → 不误判", () => {
    const report = "# 正常报告\n内容完整,已交付。\n\n---\n<sub>OPC Studio · 目标: 研究 API call failed 的处理机制 · 1 agents · 100 tokens</sub>";
    expect(reportHasFailureText(report)).toBe(false);
    expect(classifyLegacyRun({ status: "done", userGoal: "研究 API call failed 的处理机制" }, report)).toBeNull();
  });

  it("unverified-tests:status 成功 + tests.passed=true 但 command=auto-detected → 虚假测试证据", () => {
    // ab4b1c14 型:auto-detected 跑到 OPC 源码树自身 vitest,"通过"是假的,不能作为成功背书
    expect(classifyLegacyRun({ status: "done" }, "报告", { tests: { passed: true, command: "auto-detected" } })).toBe("unverified-tests");
    expect(classifyLegacyRun({ status: "completed" }, "", { tests: { passed: true, command: "auto-detected" } })).toBe("unverified-tests");
  });

  it("unverified-tests 不误伤诚实测试:command=none/明确命令/passed=false/无 evidence 均不重分类", () => {
    // 调研类 run(2431f69a 型):如实标 no run-specific test
    expect(classifyLegacyRun({ status: "done" }, "报告", { tests: { passed: false, command: "none" } })).toBeNull();
    // 诚实跑了产物测试:明确命令
    expect(classifyLegacyRun({ status: "done" }, "报告", { tests: { passed: true, command: "npm test" } })).toBeNull();
    // auto-detected 但没通过:不冒充成功,不重分类
    expect(classifyLegacyRun({ status: "done" }, "报告", { tests: { passed: false, command: "auto-detected" } })).toBeNull();
    // 无 evidence(既有两参调用):零行为回归
    expect(classifyLegacyRun({ status: "done" }, "干净报告")).toBeNull();
  });
});

describe("reclassifyLegacyRunsOnStartup(启动期一次性迁移)", () => {
  it("unverified-tests 集成:auto-detected 虚假通过的 run 读 structured-report 后标 degraded", () => {
    mkRoot();
    mkRun("ut1", { status: "done", userGoal: "REAL_PRODUCT_CODING_SMOKE" }, "# 报告\n完成。");
    fs.writeFileSync(
      path.join(root, ".opc", "runs", "ut1", "structured-report.json"),
      JSON.stringify({ tests: { passed: true, command: "auto-detected", output: "RUN vitest..." } }),
    );
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(1);
    expect(res.touched).toEqual([{ id: "ut1", kind: "unverified-tests" }]);
    const t = readTask("ut1");
    expect(t.status).toBe("done"); // status 不改,只补 degraded 标注
    expect(t.degraded).toBe(true);
    expect(t.degradedReason).toBe(UNVERIFIED_REASON);
    expect(t.legacyReclassified).toBe(true);
  });

  it("unverified-tests 集成:调研类(command=none)不误标 degraded", () => {
    mkRoot();
    mkRun("rr1", { status: "done", userGoal: "写调研报告" }, "# 报告\n完成。");
    fs.writeFileSync(
      path.join(root, ".opc", "runs", "rr1", "structured-report.json"),
      JSON.stringify({ tests: { ran: false, passed: false, command: "none" } }),
    );
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(0);
    expect(readTask("rr1").degraded).toBeUndefined();
  });

  it("失败文本重分类:status 保持不变,补 degraded/degradedReason/legacyReclassified", () => {
    mkRoot();
    mkRun("f1", { status: "done", userGoal: "回复收到" }, "API call failed after 3 retries: Connection error.\n\n---\n<sub>OPC Studio · 目标: 回复收到 · 1 agents</sub>");
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(1);
    expect(res.touched).toEqual([{ id: "f1", kind: "failure-text" }]);
    const t = readTask("f1");
    expect(t.status).toBe("done");           // status 本身不改
    expect(t.degraded).toBe(true);
    expect(t.degradedReason).toBe(FAIL_REASON);
    expect(t.legacyReclassified).toBe(true);
  });

  it("乱码标注:goal 乱码与报告乱码都被 garbled 标注", () => {
    mkRoot();
    mkRun("g1", { status: "done", userGoal: "opc" + FFFD.repeat(4) + "公司" }, "报告正常");
    mkRun("g2", { status: "done", userGoal: "clean" }, "## User Goal\n" + FFFD.repeat(5) + "\n完成");
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(2);
    for (const id of ["g1", "g2"]) {
      const t = readTask(id);
      expect(t.degraded).toBe(true);
      expect(t.degradedReason).toBe(GARBLE_REASON);
      expect(t.legacyReclassified).toBe(true);
    }
  });

  it("正常 run 不动:干净成功 run 保持原样(无 degraded/legacyReclassified)", () => {
    mkRoot();
    mkRun("ok", { status: "done", userGoal: "写脚本" }, "# 报告\n已完成。");
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(0);
    const t = readTask("ok");
    expect(t.degraded).toBeUndefined();
    expect(t.legacyReclassified).toBeUndefined();
  });

  it("已 degraded 的 run 不重复打标、不覆盖原 degradedReason(即使报告含失败文本)", () => {
    mkRoot();
    mkRun("dg", { status: "done", degraded: true, degradedReason: "真实降级原因", userGoal: "x" }, "API call failed after 3 retries");
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(0);
    const t = readTask("dg");
    expect(t.degradedReason).toBe("真实降级原因"); // 不被覆盖
    expect(t.legacyReclassified).toBeUndefined();
  });

  it("失败文本但 status=failed:不重分类(已 failed 无需修账)", () => {
    mkRoot();
    mkRun("ff", { status: "failed", userGoal: "x" }, "API call failed after 3 retries");
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res.reclassified).toBe(0);
    expect(readTask("ff").degraded).toBeUndefined();
  });

  it("同步滚动索引:重分类后 _index.json 该 run 的 degraded=true", () => {
    mkRoot();
    mkRun("f1", { status: "done", userGoal: "回复收到", startedAt: "2026-07-05T00:00:00Z" }, "API call failed after 3 retries");
    reclassifyLegacyRunsOnStartup(root);
    const idx = readIndex();
    expect(idx["f1"]?.degraded).toBe(true);
    expect(idx["f1"]?.degradedReason).toBe(FAIL_REASON);
  });

  it("幂等①:标记文件存在则整体跳过(skippedMarker),不再扫描/改动", () => {
    mkRoot();
    mkRun("f1", { status: "done", userGoal: "x" }, "API call failed after 3 retries");
    const first = reclassifyLegacyRunsOnStartup(root);
    expect(first.reclassified).toBe(1);
    expect(fs.existsSync(markerPath())).toBe(true);
    const second = reclassifyLegacyRunsOnStartup(root);
    expect(second.skippedMarker).toBe(true);
    expect(second.reclassified).toBe(0);
    expect(second.scanned).toBe(0); // 跳过时根本不扫
  });

  it("幂等②:即便标记丢失,per-run 守卫仍保证不重复打标、不覆盖", () => {
    mkRoot();
    mkRun("f1", { status: "done", userGoal: "x" }, "API call failed after 3 retries");
    reclassifyLegacyRunsOnStartup(root);
    fs.rmSync(markerPath()); // 人为删标记
    const again = reclassifyLegacyRunsOnStartup(root);
    expect(again.skippedMarker).toBe(false);
    expect(again.reclassified).toBe(0); // 已 degraded → 全部跳过
    expect(readTask("f1").degradedReason).toBe(FAIL_REASON); // 未被二次改写
  });

  it("鲁棒:损坏/空 task.json 与缺失 report.md 不崩,best-effort 跳过", () => {
    mkRoot();
    const dir = path.join(root, ".opc", "runs", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), "{ not valid json");
    mkRun("noreport", { status: "done", userGoal: "clean" }); // 无 report.md
    let res!: ReturnType<typeof reclassifyLegacyRunsOnStartup>;
    expect(() => { res = reclassifyLegacyRunsOnStartup(root); }).not.toThrow();
    expect(res.reclassified).toBe(0);
    expect(readTask("noreport").degraded).toBeUndefined();
  });

  it("runs 目录不存在:返回零结果不抛", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-empty-"));
    const res = reclassifyLegacyRunsOnStartup(root);
    expect(res).toMatchObject({ scanned: 0, reclassified: 0, skippedMarker: false });
  });
});
