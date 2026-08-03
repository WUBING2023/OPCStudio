import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileChange, RunTestEvidence } from "@opc/shared";
import {
  taskRequiresCode,
  goalForbidsCode,
  taskRequiresTests,
  evaluateDeliveryAcceptance,
  isDeliveryVerified,
  isVerifierRole,
  isVerifierTask,
  isTextDependentWorker,
  isTestFilePath,
  deriveFinalRunState,
  verifyContractSubsetAgainstManifest,
  type ProducerManifestEntryLike,
} from "./deliveryAcceptance.js";

// P0 · DeliveryAcceptance 单测:交付验收唯一门槛。覆盖用户 7 条验收测试的单元级
// (② 编码任务只文本无文件→非 verified;④ 声称文件但不存在→失败;⑤ 缺文件/缺测试→非 verified),
// 以及 requiresCode 由任务合同/角色判定(不依赖 code-review edge)。

let workRoot: string;
beforeEach(() => { workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opc-delivacc-")); });
afterEach(() => { fs.rmSync(workRoot, { recursive: true, force: true }); });

function writeFile(rel: string, content = "x"): string {
  const abs = path.join(workRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}
const change = (p: string, changeType = "create"): FileChange => ({ path: p, changeType } as FileChange);
const pmEntry = (p: string, hash: string, over: Partial<ProducerManifestEntryLike> = {}): ProducerManifestEntryLike =>
  ({ path: p, hash, agentId: "dev-1", role: "dev", mergedAt: "2026-07-13T00:00:00.000Z", ...over });
const te = (passed: boolean, exitCode?: number): RunTestEvidence =>
  ({ at: "2026-07-11T00:00:00.000Z", command: "npm test", passed, ...(exitCode !== undefined ? { exitCode } : {}), source: "quality_gate" } as RunTestEvidence);

describe("taskRequiresCode —— 由任务合同+角色判定,不看 code-review edge", () => {
  it("任务文本含代码文件/实现信号 → true", () => {
    expect(taskRequiresCode("创建 sum.js 和 sum.test.js 并实现 sum 函数")).toBe(true);
    expect(taskRequiresCode("实现一个快排算法")).toBe(true);
    expect(taskRequiresCode("write a function that parses CSV")).toBe(true);
    expect(taskRequiresCode("修复登录 bug")).toBe(true);
  });
  it("dev/engineer 角色 + 非纯研究任务 → true(角色是次级信号)", () => {
    expect(taskRequiresCode("把用户列表做出来", "dev")).toBe(true);
    expect(taskRequiresCode("build the checkout flow", "engineer")).toBe(true);
  });
  it("expected artifacts 含代码扩展名 → true", () => {
    expect(taskRequiresCode("交付", undefined, ["report.md", "index.ts"])).toBe(true);
  });
  it("纯研究/写作任务 → false(即便 dev 角色也不误判)", () => {
    expect(taskRequiresCode("研究 2026 年 AI 市场趋势并写一份报告", "dev")).toBe(false);
    expect(taskRequiresCode("撰写一篇关于气候变化的综述")).toBe(false);
    expect(taskRequiresCode("analyze the competitor landscape and summarize", "researcher")).toBe(false);
  });

  // Fix1 回归:否定式"不要编写代码/只做研究"结构化意图优先于关键词——此前"不要编写代码"里的"编写…代码"
  // 被 CODE_SIGNAL_RE 命中,把研究任务误判编码 → no_delivery(实测 DRACO 研究题的失败根因)。
  it("否定式'不要编写代码/无需代码/只输出研究报告' → false(结构化意图优先,不被'代码'两字触发)", () => {
    expect(taskRequiresCode("不要编写代码，只输出研究报告", "researcher")).toBe(false);
    expect(taskRequiresCode("研究并撰写研究报告，回答问题。不要编写任何代码、不要创建任何文件。问题:量子计算进展", "dev")).toBe(false);
    expect(taskRequiresCode("无需代码，给出一份分析", "dev")).toBe(false);
    expect(taskRequiresCode("Research the topic and write a report. Do not write any code.", "dev")).toBe(false);
    expect(taskRequiresCode("text-only: summarize the findings", "dev")).toBe(false);
  });

  it("否定式短路绝不误伤真编码任务(有明确写码意图/代码产物时仍 true)", () => {
    expect(taskRequiresCode("创建 sum.js 和 sum.test.js 并实现 sum 函数")).toBe(true);
    expect(taskRequiresCode("实现一个快排算法")).toBe(true);
    expect(taskRequiresCode("修复登录 bug", "dev")).toBe(true);
    expect(taskRequiresCode("交付一份研究报告", undefined, ["report.md", "app.ts"])).toBe(true); // 产物含 .ts → 仍编码
  });

  // 核心B+C:goalForbidsCode = 全链路"是否编码"的单一事实源(ceiling)。目标显式禁代码 → 整条 run 非编码,
  // 子任务措辞里出现"代码/实现"也不能把它抬回 coding(治研究综合被误判编码→注入写码→no_delivery 的根因)。
  it("goalForbidsCode:显式禁代码/纯研究意图 → true;真编码/普通目标 → false", () => {
    expect(goalForbidsCode("研究并撰写报告,不要编写任何代码、不要创建任何文件")).toBe(true);
    expect(goalForbidsCode("不要编写代码，只输出研究报告")).toBe(true);
    expect(goalForbidsCode("Research and write a report. Do not write any code.")).toBe(true);
    expect(goalForbidsCode("实现一个快排算法")).toBe(false);
    expect(goalForbidsCode("创建 sum.js 实现 sum 函数")).toBe(false);
    expect(goalForbidsCode("分析市场趋势")).toBe(false); // 无显式否定 → 不强制(保守,交给 taskRequiresCode)
  });
});

describe('explicit no-file task classification', () => {
  it('keeps calculation tasks out of the coding pipeline', () => {
    const goal = 'Calculate the answer. Do not create or modify files.';
    expect(taskRequiresCode(goal, 'dev')).toBe(false);
    expect(goalForbidsCode(goal)).toBe(true);
  });
});

describe("taskRequiresTests", () => {
  it("任务提到测试 → true", () => {
    expect(taskRequiresTests("实现 sum 并写单元测试确保通过")).toBe(true);
    expect(taskRequiresTests("add tests for the parser")).toBe(true);
  });
  it("无测试要求 → false", () => {
    expect(taskRequiresTests("实现一个 sum 函数")).toBe(false);
  });
});

describe("evaluateDeliveryAcceptance —— 单一验收门", () => {
  it("非编码任务 → not_required(研究交付是文本,不要求 workRoot 代码文件)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: false, requiresTests: false, workRoot, allChanges: [], testEvidence: [] });
    expect(r.status).toBe("not_required");
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("② 编码任务零 fileChanges → no_delivery(scratch 假交付被堵)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [], testEvidence: [] });
    expect(r.status).toBe("no_delivery");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toMatch(/未落盘|文件变更/);
  });

  it("编码任务有真文件且落 workRoot(无测试要求)→ verified", () => {
    writeFile("sum.js", "module.exports.sum=(a,b)=>a+b");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [change("sum.js")], testEvidence: [] });
    expect(r.status).toBe("verified");
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("④ 声称变更但 workRoot 里文件不存在 → missing_required_files", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [change("sum.js"), change("sum.test.js")], testEvidence: [] });
    expect(r.status).toBe("missing_required_files");
    expect(r.missingFiles).toEqual(["sum.js", "sum.test.js"]);
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("delete 型变更不要求文件存在(删除本就该不在)", () => {
    writeFile("keep.js");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [change("keep.js"), change("gone.js", "delete")], testEvidence: [] });
    expect(r.status).toBe("verified");
  });

  it("⑤ 要求测试但无 TestEvidence → missing_test_evidence(不用自然语言确认替代真测试)", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")], testEvidence: [] });
    expect(r.status).toBe("missing_test_evidence");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("要求测试 + TestEvidence exitCode≠0 → test_failed", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")], testEvidence: [te(false, 1)] });
    expect(r.status).toBe("test_failed");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  // 【成对翻转 · MUP Gate A#1 决策①】旧语义:requiresIndependent 缺省时全绿自测 → verified。
  // 新契约:独立验证由任务合同派生(requiresCode && requiresTests 即要求),无强绑定独立证据的全绿自测
  // → tests_ran_unbound(展示"已运行测试·未强绑定"),诚实失败,绝不 verified(矩阵4:没有 tester 时诚实失败)。
  it("要求测试 + 文件在 + 自测 exit0 全绿 → tests_ran_unbound(合同派生独立验证,自测不算强绑定)", () => {
    writeFile("sum.js"); writeFile("sum.test.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("sum.js"), change("sum.test.js")], testEvidence: [te(true, 0)],
    });
    expect(r.status).toBe("tests_ran_unbound");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toContain("已运行测试·未强绑定");
  });
});

describe("P0-3 · evaluateDeliveryAcceptance 独立验证门", () => {
  // 带 agentId/independent 的证据构造。
  const ev = (over: Partial<RunTestEvidence>): RunTestEvidence =>
    ({ at: "2026-07-11T00:00:00.000Z", command: "node sum.test.js", passed: true, exitCode: 0, source: "quality_gate", ...over } as RunTestEvidence);

  // 【成对翻转 · MUP Gate A#1】旧语义:producer 自测通过但无独立证据 → missing_independent_verification。
  // 新契约:测试确实运行且全绿 → 如实展示"已运行测试"(tests_ran_unbound),仍诚实失败、绝不 verified。
  it("要求独立验证但一条独立证据都没有(只有 producer 自测全绿)→ tests_ran_unbound(仍失败)", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [ev({ agentId: "dev-1", passed: true, exitCode: 0 })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("tests_ran_unbound");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toContain("producer 自测不算数");
  });

  it("producer 自测 fail 但独立 verifier(independent:true)通过 → verified(忽略 producer 自测 fail)", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [
        ev({ agentId: "dev-1", passed: false, exitCode: 1 }),                 // producer 本地迭代失败,不阻塞
        ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true }), // 独立快照证据
      ],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("verified");
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("独立性靠 agentId∈verifierAgentIds 兜底(证据无 independent 标记)→ verified", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0 })], // 无 independent 标记,靠 verifierAgentIds 判独立
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("verified");
  });

  // 【成对翻转 · MUP Gate A#1】独立性否决不变(producer 伪造 independent:true 仍不算独立);
  // 状态语义升级:全绿自测落 tests_ran_unbound(仍失败,绝不 verified)。
  it("producer 的证据即便带 independent:true 也不算独立(agentId∈producerAgentIds 先否决)→ tests_ran_unbound", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [ev({ agentId: "dev-1", passed: true, exitCode: 0, independent: true })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("tests_ran_unbound");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("独立证据存在但全失败(exitCode≠0)→ test_failed(独立验证判定失败,而非从未验证)", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: false, exitCode: 1, independent: true })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("test_failed");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  // 【成对翻转 · MUP Gate A#1 决策①】旧语义:不传 requiresIndependentVerification → 退回"有通过证据即
  // verified"。新契约:独立验证由合同派生(requiresCode&&requiresTests),该入参不再是开关——缺省/false
  // 都不能对要求测试的编码任务关闭独立门。
  it("不传独立验证入参 → 仍按合同派生独立验证:自测全绿只到 tests_ran_unbound", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("sum.js")],
      testEvidence: [ev({ agentId: "dev-1", passed: true, exitCode: 0 })],
    });
    expect(r.status).toBe("tests_ran_unbound");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  // P0 · 合同覆盖门(contractFiles 启用):独立通过测试必须至少一条覆盖本 run 交付文件(testedFile∈合同)。
  it("合同覆盖门:独立通过测试 testedFile∈合同 → verified", () => {
    writeFile("clamp.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("clamp.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, command: "node clamp.test.js", testedFile: "clamp.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["clamp.js", "clamp.test.js"],
    });
    expect(r.status).toBe("verified");
  });

  it("合同覆盖门:独立通过测试但 testedFile∉合同(遗留测试)→ 拒,不能把遗留测试通过当本任务完成", () => {
    writeFile("clamp.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("clamp.js")],
      // 遗留测试 gcd.test.js 通过,但它不在本 run 合同里(合同=clamp.*)
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, command: "node gcd.test.js", testedFile: "gcd.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["clamp.js", "clamp.test.js"],
    });
    expect(r.status).toBe("missing_independent_verification");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toMatch(/未覆盖本 run 交付文件/);
  });

  it("合同覆盖门:遗留失败 + 合同内通过混合 → 以合同内通过为准 verified", () => {
    writeFile("clamp.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("clamp.js")],
      testEvidence: [
        ev({ agentId: "qa-1", passed: false, exitCode: 1, independent: true, command: "node stale.test.js", testedFile: "stale.test.js" }),
        ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, command: "node clamp.test.js", testedFile: "clamp.test.js" }),
      ],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["clamp.js", "clamp.test.js"],
    });
    expect(r.status).toBe("verified");
  });

  it("合同覆盖门:只有套件级独立证据(无 testedFile)+ 有合同 → 拒(不能用遗留测试兜底,收口软路径)", () => {
    writeFile("clamp.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("clamp.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, command: "npm test" })], // 无 testedFile
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["clamp.js"],
    });
    expect(r.status).toBe("missing_independent_verification");
    expect(r.reasons[0]).toMatch(/无一条能关联到本 run 交付文件/);
  });

  it("合同覆盖门:不传 contractFiles → 不启用覆盖门(旧行为,任意独立通过即 verified)", () => {
    writeFile("clamp.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot, allChanges: [change("clamp.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "gcd.test.js" })], // testedFile∉合同但没传 contractFiles
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
    });
    expect(r.status).toBe("verified");
  });
});

describe("P0(用户审计)· producer 源码门 —— 防验证者创造被验证交付物的自证", () => {
  const ev = (over: Partial<RunTestEvidence>): RunTestEvidence =>
    ({ at: "2026-07-11T00:00:00.000Z", command: "node impl.test.js", passed: true, exitCode: 0, source: "quality_gate", ...over } as RunTestEvidence);

  it("producer 源码=0 但 verifier 源码>0(代码全来自 verifier)→ no_producer_source,非 verified", () => {
    writeFile("impl.js"); writeFile("impl.test.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("impl.js"), change("impl.test.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "impl.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      producerCodeFileCount: 0, verifierCodeFileCount: 2, // ← verifier 自建了源码+测试,producer 零源码
    });
    expect(r.status).toBe("no_producer_source");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("对抗验证回归修复 · producer=0 且 verifier=0(合法非代码交付,如 .html/.css)→ 不误杀,不判 no_producer_source", () => {
    writeFile("index.html"); writeFile("style.css");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("index.html"), change("style.css")],
      testEvidence: [],
      requiresIndependentVerification: false, producerAgentIds: ["dev-1"], verifierAgentIds: [],
      producerCodeFileCount: 0, verifierCodeFileCount: 0, // 无任何 CODE_PATH_EXT 文件 → 门不触发
    });
    expect(r.status).not.toBe("no_producer_source");
    expect(r.status).toBe("verified"); // requiresTests=false + 文件存在 → verified
  });

  it("producerCodeFileCount≥1(有 producer 源码)+ 独立测试覆盖 → verified", () => {
    writeFile("impl.js"); writeFile("impl.test.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("impl.js"), change("impl.test.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "impl.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["impl.js", "impl.test.js"], producerCodeFileCount: 1,
    });
    expect(r.status).toBe("verified");
  });

  it("不传 producerCodeFileCount(undefined)→ 不启用门,退回原判定(兼容)", () => {
    writeFile("impl.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot, allChanges: [change("impl.js")], testEvidence: [],
    });
    expect(r.status).toBe("verified"); // requiresTests=false,有文件即 verified;producer 门未启用
  });
});

describe("Model C(用户决策)· 测试引用门 —— 独立测试须 import/require producer 源码,自包含测试不算", () => {
  const ev = (over: Partial<RunTestEvidence>): RunTestEvidence =>
    ({ at: "2026-07-11T00:00:00.000Z", command: "node solution.test.js", passed: true, exitCode: 0, source: "quality_gate", ...over } as RunTestEvidence);

  it("自证:verifier 把实现藏进 solution.test.js(不引用 producer 源码)+ producer 交 stub → missing_independent_verification", () => {
    writeFile("solution.js", "module.exports = () => null; // stub");
    writeFile("solution.test.js", "function solve(){return 42} const a=require('assert'); a.strictEqual(solve(),42);"); // 自包含,不 require ./solution
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "solution.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"],
      producerCodeFileCount: 1, verifierCodeFileCount: 1,
      producerSourcePaths: ["solution.js"], // producer 授权的非测试源码
    });
    expect(r.status).toBe("missing_independent_verification");
    expect(r.reasons[0]).toContain("未 import/require 任何 producer 源码");
  });

  it("合法:verifier 写的 solution.test.js require('./solution')(真测 producer 源码)→ verified", () => {
    writeFile("solution.js", "module.exports = (n) => n * 2;");
    writeFile("solution.test.js", "const solve=require('./solution'); const a=require('assert'); a.strictEqual(solve(21),42);");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "solution.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"],
      producerCodeFileCount: 1, verifierCodeFileCount: 1,
      producerSourcePaths: ["solution.js"],
    });
    expect(r.status).toBe("verified");
  });

  it("不传 producerSourcePaths → 测试引用门不启用,退回旧的 ∈合同 判定(兼容)", () => {
    writeFile("solution.js", "module.exports = () => null;");
    writeFile("solution.test.js", "function solve(){return 42}");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({ agentId: "qa-1", passed: true, exitCode: 0, independent: true, testedFile: "solution.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"], producerCodeFileCount: 1,
    });
    expect(r.status).toBe("verified"); // 未传 producerSourcePaths → 只判 ∈合同
  });
});

// ── MUP Gate A#1 · ProducerArtifactManifest 清单模式(强判据/hash 复核/误杀修复)──────────
describe("MUP Gate A#1 · 清单模式 —— 解析链×产物清单强判据", () => {
  const ev = (over: Partial<RunTestEvidence>): RunTestEvidence =>
    ({ at: "2026-07-13T00:00:00.000Z", command: "node solution.test.js", passed: true, exitCode: 0, source: "quality_gate", ...over } as RunTestEvidence);

  it("独立测试通过+绑定合同+交付字节==冻结 manifest → independent_tests_passed(接受档;resolvedProducerFiles 忽略)", () => {
    const hImpl = writeFile("solution.js", "module.exports = (n) => n * 2;");
    writeFile("solution.test.js", "const solve=require('./solution'); const a=require('assert'); a.strictEqual(solve(21),42);");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({
        agentId: "qa-1", independent: true, testedFile: "solution.test.js",
        resolvedProducerFiles: [{ path: "solution.js", hash: hImpl }], // 选1:该字段被忽略,不再升级为 verified
      })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"],
      producerManifestEntries: [pmEntry("solution.js", hImpl)],
      verifierChangeFileCount: 1,
      producerSourcePaths: ["solution.js"],
    });
    expect(r.status).toBe("independent_tests_passed");
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("无 resolvedProducerFiles 也一样 independent_tests_passed(解析链退役,不再因缺它而失败)", () => {
    const hImpl = writeFile("solution.js", "module.exports = (n) => n * 2;");
    writeFile("solution.test.js", "const solve=require('./solution'); solve(1);");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "solution.test.js" })], // 无解析链
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"],
      producerManifestEntries: [pmEntry("solution.js", hImpl)],
      verifierChangeFileCount: 1,
      producerSourcePaths: ["solution.js"],
    });
    expect(r.status).toBe("independent_tests_passed");
    expect(isDeliveryVerified(r)).toBe(true);
    expect(r.reasons[0]).toContain("独立测试通过并绑定合同");
  });

  it("resolvedProducerFiles 的 hash 与 manifest 不一致【已忽略】→ 交付字节仍==manifest → independent_tests_passed", () => {
    const hImpl = writeFile("solution.js", "module.exports = (n) => n * 2;");
    writeFile("solution.test.js", "require('./solution');");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solution.js"), change("solution.test.js")],
      testEvidence: [ev({
        agentId: "qa-1", independent: true, testedFile: "solution.test.js",
        resolvedProducerFiles: [{ path: "solution.js", hash: "e".repeat(64) }], // 选1:忽略;artifact 门只看交付文件字节
      })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solution.js", "solution.test.js"],
      producerManifestEntries: [pmEntry("solution.js", hImpl)],
      verifierChangeFileCount: 1,
    });
    expect(r.status).toBe("independent_tests_passed");
  });

  it("artifact 门按【最新】清单条目比对交付字节(旧轮 hash 不作数);resolvedProducerFiles 一律忽略", () => {
    const hV2 = writeFile("app.js", "v2");
    writeFile("app.test.js", "require('./app');");
    const evidence = (hash: string) => ev({
      agentId: "qa-1", independent: true, testedFile: "app.test.js", command: "node app.test.js",
      resolvedProducerFiles: [{ path: "app.js", hash }],
    });
    const staleHash = createHash("sha256").update("v1").digest("hex");
    const entries = [pmEntry("app.js", staleHash), pmEntry("app.js", hV2)]; // append-only,消费取最新
    const base = {
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("app.js"), change("app.test.js")],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"] as string[],
      contractFiles: ["app.js", "app.test.js"], producerManifestEntries: entries, verifierChangeFileCount: 1,
    };
    // 交付 app.js=v2==最新条目 → artifact 门过;独立测试通过 → independent_tests_passed(resolvedProducerFiles 无论 hV2/stale 都不影响)。
    expect(evaluateDeliveryAcceptance({ ...base, testEvidence: [evidence(hV2)] }).status).toBe("independent_tests_passed");
    expect(evaluateDeliveryAcceptance({ ...base, testEvidence: [evidence(staleHash)] }).status).toBe("independent_tests_passed");
  });

  it("泳道2:根级 sum.test.js 经 stem 绑 src/sum.js 合同 → independent_tests_passed(stem 绑定成立,不落 testedFile∉合同)", () => {
    const hImpl = writeFile("src/sum.js", "module.exports=(a,b)=>a+b;");
    writeFile("sum.test.js", "const s=require('./src/sum');");
    const base = {
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("src/sum.js"), change("sum.test.js")],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"] as string[],
      contractFiles: ["src/sum.js"], // 测试文件自身不在合同 → 只能靠目标 stem 绑定(contractBindsTest 共享判据)
      producerManifestEntries: [pmEntry("src/sum.js", hImpl)],
      verifierChangeFileCount: 1,
    };
    // stem 绑上 → 独立测试通过 + 交付字节==manifest → independent_tests_passed。resolvedProducerFiles 有无都不影响。
    expect(evaluateDeliveryAcceptance({ ...base, testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "sum.test.js", command: "node sum.test.js" })] }).status).toBe("independent_tests_passed");
    expect(evaluateDeliveryAcceptance({ ...base, testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "sum.test.js", command: "node sum.test.js", resolvedProducerFiles: [{ path: "src/sum.js", hash: hImpl }] })] }).status).toBe("independent_tests_passed");
  });

  // 选1(降级·07-14):解析链强判据退役后,Node/python 不再有语言歧视——都靠"独立测试通过 + 交付字节==冻结 manifest"
  // 收 independent_tests_passed。python 独立测试通过 + 字节匹配即接受档(此前因无 Node 解析链被封顶失败,现修正)。
  it("非 Node 族(python)独立测试通过+绑定合同+字节匹配 → independent_tests_passed(与 node 同待遇)", () => {
    const hImpl = writeFile("solver.py", "def solve(n):\n    return n * 2\n");
    writeFile("test_solver.py", "from solver import solve\nassert solve(21) == 42\n");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("solver.py"), change("test_solver.py")],
      testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "test_solver.py", command: "python test_solver.py" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["solver.py", "test_solver.py"],
      producerManifestEntries: [pmEntry("solver.py", hImpl)],
      verifierChangeFileCount: 1,
      producerSourcePaths: ["solver.py"],
    });
    expect(r.status).toBe("independent_tests_passed");
    expect(isDeliveryVerified(r)).toBe(true);
    expect(r.reasons[0]).toContain("独立测试通过并绑定合同");
  });

  // 选1 锁死:即便证据带完整 resolvedProducerFiles×manifest hash 一致,也【不再】升级为 verified(解析链可被 vm 逐字节
  // 重跑伪造,已退役)——最高接受档就是 independent_tests_passed。verified 状态在类型里保留但当前无路径产出。
  it("带完整 resolvedProducerFiles×manifest hash 一致的证据 → independent_tests_passed(不再 verified,解析链退役)", () => {
    const hImpl = writeFile("node_solver.js", "module.exports=(n)=>n*2;");
    writeFile("node_solver.test.js", "const s=require('./node_solver'); const a=require('assert'); a.strictEqual(s(21),42);");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("node_solver.js"), change("node_solver.test.js")],
      testEvidence: [ev({
        agentId: "qa-1", independent: true, testedFile: "node_solver.test.js", command: "node node_solver.test.js",
        resolvedProducerFiles: [{ path: "node_solver.js", hash: hImpl }],
      })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["node_solver.js", "node_solver.test.js"],
      producerManifestEntries: [pmEntry("node_solver.js", hImpl)],
      verifierChangeFileCount: 1,
    });
    expect(r.status).toBe("independent_tests_passed");
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("合同外遗留测试(stem 也绑不上)→ 仍是 missing_independent_verification(不误落 unbound)", () => {
    const hImpl = writeFile("clamp.js", "module.exports=(x)=>x;");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("clamp.js")],
      testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "gcd.test.js", command: "node gcd.test.js" })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["clamp.js"],
      producerManifestEntries: [pmEntry("clamp.js", hImpl)],
      verifierChangeFileCount: 0,
    });
    expect(r.status).toBe("missing_independent_verification");
    expect(r.reasons[0]).toMatch(/未覆盖本 run 交付文件/);
  });
});

describe("MUP Gate A#1 · artifact_mismatch —— 验收重算 workRoot hash 与冻结清单比对", () => {
  const ev = (over: Partial<RunTestEvidence>): RunTestEvidence =>
    ({ at: "2026-07-13T00:00:00.000Z", command: "node x.test.js", passed: true, exitCode: 0, source: "quality_gate", ...over } as RunTestEvidence);

  it("合同文件在冻结后被改写(重算 hash ≠ 最新条目)→ artifact_mismatch,isDeliveryVerified=false", () => {
    const hFrozen = writeFile("index.html", "<h1>v1</h1>");
    writeFile("index.html", "<h1>tampered</h1>"); // 冻结后被改写
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("index.html")],
      testEvidence: [],
      producerManifestEntries: [pmEntry("index.html", hFrozen)],
      verifierChangeFileCount: 0,
    });
    expect(r.status).toBe("artifact_mismatch");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toContain("ProducerArtifactManifest");
  });

  it("hash 一致 → 门放行(requiresTests=false 时走到 verified)", () => {
    const h = writeFile("style.css", "body{margin:0}");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("style.css")], testEvidence: [],
      producerManifestEntries: [pmEntry("style.css", h)],
      verifierChangeFileCount: 0,
    });
    expect(r.status).toBe("verified");
  });

  it("清单条目不在合同内(前序 veto 已撤账)→ 不参与比对,不误判 mismatch", () => {
    const hKeep = writeFile("keep.js", "ok");
    const hVeto = writeFile("vetoed.js", "v1");
    writeFile("vetoed.js", "v2-mutated"); // 被否决文件后续变化,但它已不在合同
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("keep.js")], testEvidence: [],
      contractFiles: ["keep.js"],
      producerManifestEntries: [pmEntry("keep.js", hKeep), pmEntry("vetoed.js", hVeto)],
      verifierChangeFileCount: 0,
    });
    expect(r.status).toBe("verified");
  });

  it("独立测试证据齐全但交付文件被改写 → artifact_mismatch 先于测试门(强判据救不回被改写的交付)", () => {
    const hFrozen = writeFile("mod.js", "module.exports=1;");
    writeFile("mod.test.js", "require('./mod');");
    writeFile("mod.js", "module.exports=2;"); // 冻结后改写
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("mod.js"), change("mod.test.js")],
      testEvidence: [ev({ agentId: "qa-1", independent: true, testedFile: "mod.test.js", resolvedProducerFiles: [{ path: "mod.js", hash: hFrozen }] })],
      requiresIndependentVerification: true, producerAgentIds: ["dev-1"], verifierAgentIds: ["qa-1"],
      contractFiles: ["mod.js", "mod.test.js"],
      producerManifestEntries: [pmEntry("mod.js", hFrozen)],
      verifierChangeFileCount: 1,
    });
    expect(r.status).toBe("artifact_mismatch");
  });
});

describe("MUP Gate A#1 · no_producer_source 清单模式 —— HTML/CSS 误杀修复(矩阵2)", () => {
  it(".html/.css producer + verifier 新建 .test.js:清单有非测试条目(任意扩展名)→ 不判 no_producer_source,走通", () => {
    const hHtml = writeFile("index.html", "<h1>hi</h1>");
    const hCss = writeFile("style.css", "h1{color:red}");
    writeFile("page.test.js", "console.log('checked');"); // verifier 合法新建的测试
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("index.html"), change("style.css"), change("page.test.js")],
      testEvidence: [],
      producerManifestEntries: [pmEntry("index.html", hHtml), pmEntry("style.css", hCss)],
      verifierChangeFileCount: 1, // verifier 新建了 page.test.js
    });
    expect(r.status).not.toBe("no_producer_source");
    expect(r.status).toBe("verified");
  });

  it("清单零非测试条目(producer 只冻结了测试文件)+ verifier 有变更 → no_producer_source(自证仍被堵)", () => {
    const hTest = writeFile("impl.test.js", "test");
    writeFile("impl.js", "code");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("impl.js"), change("impl.test.js")],
      testEvidence: [],
      producerManifestEntries: [pmEntry("impl.test.js", hTest)], // producer 唯一冻结产物是测试文件
      verifierChangeFileCount: 1,
    });
    expect(r.status).toBe("no_producer_source");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("清单为空数组(冻结失败/零 producer 产物)+ verifier 有变更 → no_producer_source", () => {
    writeFile("impl.js", "code");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("impl.js")], testEvidence: [],
      producerManifestEntries: [],
      verifierChangeFileCount: 1,
    });
    expect(r.status).toBe("no_producer_source");
  });

  it("清单为空 + verifier 也零变更(纯 producer run 冻结失败)→ 门不触发,不误杀", () => {
    writeFile("solo.md", "notes");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: false, workRoot,
      allChanges: [change("solo.md")], testEvidence: [],
      producerManifestEntries: [],
      verifierChangeFileCount: 0,
    });
    expect(r.status).toBe("verified");
  });
});

describe("MUP Gate A#1 · verifyContractSubsetAgainstManifest / isTestFilePath —— 消费前子集自验", () => {
  it("合同∩清单最新条目逐个重算:一致 → ok;改写 → 失配列出该文件", () => {
    const h = writeFile("a.js", "v1");
    const entries = [pmEntry("a.js", h)];
    expect(verifyContractSubsetAgainstManifest(workRoot, ["a.js"], entries)).toEqual({ ok: true, mismatches: [] });
    writeFile("a.js", "v2");
    const r = verifyContractSubsetAgainstManifest(workRoot, ["a.js"], entries);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(["a.js"]);
  });

  it("文件消失 → 失配(比 hash 不一致更严重的信号);清单为空 → ok(无基准不虚构失配)", () => {
    const h = writeFile("gone.js", "x");
    const entries = [pmEntry("gone.js", h)];
    fs.rmSync(path.join(workRoot, "gone.js"));
    expect(verifyContractSubsetAgainstManifest(workRoot, ["gone.js"], entries).ok).toBe(false);
    expect(verifyContractSubsetAgainstManifest(workRoot, ["gone.js"], []).ok).toBe(true);
  });

  it("同 path 多条取最新;合同外条目跳过", () => {
    writeFile("b.js", "old");
    const hNew = writeFile("b.js", "new");
    const staleHash = createHash("sha256").update("old").digest("hex");
    const entries = [pmEntry("b.js", staleHash), pmEntry("b.js", hNew), pmEntry("outside.js", "1".repeat(64))];
    expect(verifyContractSubsetAgainstManifest(workRoot, ["b.js"], entries).ok).toBe(true);
  });

  it("isTestFilePath:*.test.* / *.spec.* / tests|__tests__ 目录为测试路径;.html/.css/.md 源文件不是", () => {
    for (const p of ["a.test.js", "b.spec.ts", "tests/x.py", "__tests__/y.js", "pkg\\tests\\z.rb"]) expect(isTestFilePath(p), p).toBe(true);
    for (const p of ["index.html", "style.css", "README.md", "src/app.js", "contest.js"]) expect(isTestFilePath(p), p).toBe(false);
  });
});

describe("isDeliveryVerified", () => {
  it("verified / not_required → true;其余 → false", () => {
    expect(isDeliveryVerified({ status: "verified" })).toBe(true);
    expect(isDeliveryVerified({ status: "not_required" })).toBe(true);
    expect(isDeliveryVerified({ status: "no_delivery" })).toBe(false);
    expect(isDeliveryVerified({ status: "missing_test_evidence" })).toBe(false);
    expect(isDeliveryVerified({ status: "simulated_run" })).toBe(false); // MUP Gate A#2:模拟 run 永不算已验证交付
    expect(isDeliveryVerified(undefined)).toBe(false);
  });
});

describe("MUP Gate A#2 · simulated_run —— mock/模拟 run 永不 verified", () => {
  it("simulated:true → simulated_run(编码任务:即便文件/测试证据齐全也不 verified)", () => {
    writeFile("sum.js"); writeFile("sum.test.js");
    const r = evaluateDeliveryAcceptance({
      requiresCode: true, requiresTests: true, workRoot,
      allChanges: [change("sum.js"), change("sum.test.js")], testEvidence: [te(true, 0)],
      simulated: true,
    });
    expect(r.status).toBe("simulated_run");
    expect(isDeliveryVerified(r)).toBe(false);
    expect(r.reasons[0]).toContain("simulated_run");
  });

  it("simulated 优先于 not_required:非编码 mock run 也不给纯净等价态", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: false, requiresTests: false, workRoot, allChanges: [], testEvidence: [], simulated: true });
    expect(r.status).toBe("simulated_run");
    expect(isDeliveryVerified(r)).toBe(false);
  });

  it("不传 simulated(旧调用)→ 行为不变,零回归", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [change("sum.js")], testEvidence: [] });
    expect(r.status).toBe("verified");
  });

  it("simulated + hasPartialSalvage → simulated_run 且带 partialDelivery(两个加性痕迹并存)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: false, requiresTests: false, workRoot, allChanges: [], testEvidence: [], simulated: true, hasPartialSalvage: true });
    expect(r.status).toBe("simulated_run");
    expect(r.partialDelivery).toBe(true);
  });
});

describe("D2(已拍板)· hasPartialSalvage —— 超时抢救 partial 不得纯净通过", () => {
  it("非编码 + hasPartialSalvage → not_required 但带 partialDelivery:true(不再是纯净通过;run 级终态至少 degraded)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: false, requiresTests: false, workRoot, allChanges: [], testEvidence: [], hasPartialSalvage: true });
    expect(r.status).toBe("not_required");
    expect(r.partialDelivery).toBe(true);
    expect(r.reasons.join(" ")).toContain("超时抢救");
    // isDeliveryVerified 仍 true(status 语义冻结;不纯净由 run.partialDelivery + finalState=degraded 承载)
    expect(isDeliveryVerified(r)).toBe(true);
  });

  it("编码 verified + hasPartialSalvage → 仍 verified 但带 partialDelivery:true(痕迹不丢)", () => {
    writeFile("sum.js");
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [change("sum.js")], testEvidence: [], hasPartialSalvage: true });
    expect(r.status).toBe("verified");
    expect(r.partialDelivery).toBe(true);
  });

  it("失败状态 + hasPartialSalvage → 状态不变,仍附 partialDelivery(不改失败语义)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: true, requiresTests: false, workRoot, allChanges: [], testEvidence: [], hasPartialSalvage: true });
    expect(r.status).toBe("no_delivery");
    expect(r.partialDelivery).toBe(true);
  });

  it("不传 hasPartialSalvage(旧调用)→ 无 partialDelivery 字段(零回归)", () => {
    const r = evaluateDeliveryAcceptance({ requiresCode: false, requiresTests: false, workRoot, allChanges: [], testEvidence: [] });
    expect(r.partialDelivery).toBeUndefined();
  });
});

describe("MUP Gate A · deriveFinalRunState —— run 终态单一收敛(requires_review > failed > degraded > verified)", () => {
  const base = { status: "done", deliveryAcceptance: { status: "verified" } };

  it("干净 done + verified → verified", () => {
    expect(deriveFinalRunState(base)).toBe("verified");
  });

  it("研究型 done + not_required → verified(非编码干净等价态)", () => {
    expect(deriveFinalRunState({ status: "done", deliveryAcceptance: { status: "not_required" } })).toBe("verified");
  });

  it("选1(降级):独立测试通过的编码交付 → tests_passed(诚实终态,绝不收敛到 verified/已验证)", () => {
    expect(deriveFinalRunState({ status: "done", deliveryAcceptance: { status: "independent_tests_passed" } })).toBe("tests_passed");
  });

  it("simulated run 永不 verified → degraded(即便交付验收字段是 verified)", () => {
    expect(deriveFinalRunState({ ...base, simulated: true })).toBe("degraded");
  });

  it("partialDelivery → 至少 degraded(D2:含 partial 的 run 绝不纯净 done)", () => {
    expect(deriveFinalRunState({ ...base, partialDelivery: true })).toBe("degraded");
  });

  it("done + degraded(证据自验失败路径)→ degraded:done+degraded 矛盾由 finalState 权威消灭", () => {
    expect(deriveFinalRunState({ ...base, degraded: true })).toBe("degraded");
  });

  it("evidenceIntegrity=degraded → degraded", () => {
    expect(deriveFinalRunState({ ...base, evidenceIntegrity: "degraded" })).toBe("degraded");
  });

  it("done 但交付未验证(如 simulated_run/no_delivery 残留)→ 防御性 degraded,绝不 verified", () => {
    expect(deriveFinalRunState({ status: "done", deliveryAcceptance: { status: "simulated_run" } })).toBe("degraded");
    expect(deriveFinalRunState({ status: "done", deliveryAcceptance: { status: "no_delivery" } })).toBe("degraded");
    expect(deriveFinalRunState({ status: "done" })).toBe("degraded"); // 无验收记录 → 不虚构 verified
  });

  it("status=failed → failed(degraded/partial 不改写)", () => {
    expect(deriveFinalRunState({ status: "failed", degraded: true, partialDelivery: true })).toBe("failed");
  });

  it("hasUnresolvedConflict → requires_review,优先级最高(压过 failed/degraded/simulated)", () => {
    expect(deriveFinalRunState({ ...base, hasUnresolvedConflict: true })).toBe("requires_review");
    expect(deriveFinalRunState({ status: "failed", degraded: true, hasUnresolvedConflict: true })).toBe("requires_review");
    expect(deriveFinalRunState({ ...base, simulated: true, hasUnresolvedConflict: true })).toBe("requires_review");
  });

  it("非终态 status(running 等异常调用)→ failed 兜底,不虚构成功", () => {
    expect(deriveFinalRunState({ status: "running", deliveryAcceptance: { status: "verified" } })).toBe("failed");
  });
});

describe("P0-3 · isVerifierRole / isVerifierTask —— 依赖序分批判定", () => {
  it("验证角色 test/tester/qa/reviewer/review/code-reviewer → isVerifierRole true", () => {
    for (const r of ["test", "tester", "qa", "reviewer", "review", "code_reviewer", "code-reviewer", "QA", " Tester "])
      expect(isVerifierRole(r)).toBe(true);
  });

  it("编码/研究角色不是验证角色", () => {
    for (const r of ["dev", "coder", "researcher", "lead", "ceo", "pm", undefined])
      expect(isVerifierRole(r as any)).toBe(false);
  });

  it("isVerifierTask:验证角色恒为 verifier(不看任务文本)", () => {
    expect(isVerifierTask("tester", "验证一下")).toBe(true);
    expect(isVerifierTask("reviewer", "看看代码")).toBe(true);
  });

  it("isVerifierTask:非验证角色但任务要求测试且非编码任务 → verifier(纯核验)", () => {
    // 注意:"单元测试/测试文件"是 taskRequiresCode 的代码信号(写测试=写代码),会被判成 producer;
    // 这里用"跑/运行测试、确保通过"这类【只要求执行测试、不含代码信号】的措辞才落到任务型 verifier 分支。
    expect(isVerifierTask("worker", "运行测试并确保全部通过")).toBe(true);
    expect(isVerifierTask("analyst", "跑一下测试,确认结果通过")).toBe(true);
  });

  it("isVerifierTask:编码任务(要写代码)即使提到测试也不是 verifier(它是 producer)", () => {
    expect(isVerifierTask("dev", "写一个 sum 函数并补充单元测试")).toBe(false);
    expect(isVerifierTask("dev", "实现 sum.js 模块")).toBe(false);
  });

  it("isVerifierTask:纯研究任务(既不编码也不测试)不是 verifier", () => {
    expect(isVerifierTask("researcher", "调研市场并写一份报告")).toBe(false);
  });

  it("#1 isTextDependentWorker:综合/事实核查角色 → 文本依赖(true)", () => {
    expect(isTextDependentWorker("synthesizer")).toBe(true);
    expect(isTextDependentWorker("synth")).toBe(true);
    expect(isTextDependentWorker("fact-checker")).toBe(true);
    expect(isTextDependentWorker("fact_check")).toBe(true);
    expect(isTextDependentWorker("综合员")).toBe(true);
    expect(isTextDependentWorker("事实核查")).toBe(true);
    expect(isTextDependentWorker("editor")).toBe(true);
  });

  it("#1 isTextDependentWorker:普通研究员/lead/dev/verifier 不是文本依赖(零破坏现有团队)", () => {
    expect(isTextDependentWorker("researcher")).toBe(false);
    expect(isTextDependentWorker("lead")).toBe(false);
    expect(isTextDependentWorker("dev")).toBe(false);
    expect(isTextDependentWorker("ceo")).toBe(false);
    expect(isTextDependentWorker("reviewer")).toBe(false); // verifier 优先
    expect(isTextDependentWorker("tester")).toBe(false);
    expect(isTextDependentWorker(undefined)).toBe(false);
  });

  it("#1 isTextDependentWorker:任务措辞显式声明综合他人产出也算(保守:综合动词+他人产出)", () => {
    expect(isTextDependentWorker("worker", "综合各研究员的产出写成报告")).toBe(true);
    expect(isTextDependentWorker("worker", "核查其他成员的产出是否准确")).toBe(true);
    // 只有综合动词、没提他人产出 → 不算(避免误伤普通"综合分析"研究任务)
    expect(isTextDependentWorker("worker", "综合分析这个市场")).toBe(false);
  });
});
