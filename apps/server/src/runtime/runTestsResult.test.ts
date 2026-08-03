import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { compactTestOutput, runTestsResult, detectBareTestFiles, runVerifierTestsInSnapshot } from "./tools.js";

// A8 · TestEvidence:runTestsResult 的加性字段(command/cwd/exitCode/durationMs)如实性。
// 铁律:真实执行过(ran=true)才带字段;未检测到框架 → 全部缺省,不虚构。
// 真实执行用例走 npm test(detectTestCommand 对 package.json scripts.test 的判定),
// 测试脚本是零依赖的 node -e,一次通过 + 一次失败,不跑任何真实测试套件。

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "opc-a8-tests-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function writePkg(dir: string, testScript: string): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "a8-fixture", version: "0.0.0", scripts: { test: testScript } }), "utf-8");
}

describe("compactTestOutput · failure diagnostics", () => {
  it("long failures preserve both the command context and the assertion/stack tail", () => {
    const output = "suite header\n" + "PASS filler\n".repeat(600) + "FAIL close rejects queued jobs\nAssertionError: expected queued rejection\nstack: test.js:88";
    const compact = compactTestOutput(output, false, 2_000);
    expect(compact.length).toBeLessThanOrEqual(2_000);
    expect(compact).toContain("suite header");
    expect(compact).toContain("middle truncated; failure tail follows");
    expect(compact).toContain("FAIL close rejects queued jobs");
    expect(compact).toContain("AssertionError: expected queued rejection");
  });

  it("short output is unchanged", () => {
    expect(compactTestOutput("short failure", false)).toBe("short failure");
  });
});

describe("runTestsResult · A8 TestEvidence 加性字段", () => {
  it("无测试框架目录 → ran:false 且 command/cwd/exitCode/durationMs 全缺省(诚实缺省,不虚构)", () => {
    const dir = tmpDir();
    const r = runTestsResult(dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.output).toBe("no test framework detected");
    expect("command" in r).toBe(false);
    expect("cwd" in r).toBe(false);
    expect("exitCode" in r).toBe(false);
    expect("durationMs" in r).toBe(false);
  });

  it("真实执行通过 → exitCode=0 + command/cwd/durationMs 如实", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    writePkg(dir, 'node -e "console.log(String.fromCharCode(111,107)); process.exit(0)"');
    const r = runTestsResult(dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.command).toBe("npm test --silent");
    expect(r.cwd).toBe(dir);
    expect(r.exitCode).toBe(0);
    expect(typeof r.durationMs).toBe("number");
  });

  it("真实执行失败 → passed:false + exitCode 非 0", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    writePkg(dir, 'node -e "process.exit(3)"');
    const r = runTestsResult(dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.command).toBe("npm test --silent");
    expect(r.exitCode).toBeGreaterThan(0);
    expect(typeof r.durationMs).toBe("number");
  });
});

describe("P0-3 · detectBareTestFiles —— 浅扫裸测试文件逐文件命令", () => {
  it("匹配 *.test.js / *.spec.mjs / test_*.py / *_test.py,排除 node_modules/.opc,depth≤2", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "sum.test.js"), "process.exit(0)", "utf-8");
    fs.writeFileSync(path.join(dir, "util.spec.mjs"), "process.exit(0)", "utf-8");
    fs.writeFileSync(path.join(dir, "test_calc.py"), "pass", "utf-8");
    fs.writeFileSync(path.join(dir, "calc_test.py"), "pass", "utf-8");
    fs.writeFileSync(path.join(dir, "notes.md"), "not a test", "utf-8"); // 非测试文件不匹配
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "x.test.js"), "process.exit(1)", "utf-8"); // 排除
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".opc", "y.test.js"), "process.exit(1)", "utf-8"); // 排除

    const cmds = detectBareTestFiles(dir);
    expect(cmds.some((c) => /node ".*sum\.test\.js"/.test(c))).toBe(true);
    expect(cmds.some((c) => /node ".*util\.spec\.mjs"/.test(c))).toBe(true);
    expect(cmds.some((c) => /python ".*test_calc\.py"/.test(c))).toBe(true);
    expect(cmds.some((c) => /python ".*calc_test\.py"/.test(c))).toBe(true);
    expect(cmds.some((c) => /node_modules/.test(c))).toBe(false);
    expect(cmds.some((c) => /\.opc/.test(c))).toBe(false);
    expect(cmds.some((c) => /notes\.md/.test(c))).toBe(false);
  });

  it(".ts 测试文件 → npx tsx 命令", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "core.test.ts"), "process.exit(0)", "utf-8");
    const cmds = detectBareTestFiles(dir);
    expect(cmds.some((c) => /npx tsx ".*core\.test\.ts"/.test(c))).toBe(true);
  });
});

describe("P0-3 · runVerifierTestsInSnapshot —— 快照内跑测试收结构化证据", () => {
  it("无框架的裸测试文件:逐文件执行,通过 → exit0/passed;失败 → passed:false", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "pass.test.js"), "process.exit(0)", "utf-8");
    fs.writeFileSync(path.join(dir, "fail.test.js"), "process.exit(2)", "utf-8");
    const results = await runVerifierTestsInSnapshot(dir);
    expect(results).toHaveLength(2);
    const pass = results.find((r) => /pass\.test\.js/.test(r.command ?? ""))!;
    const fail = results.find((r) => /fail\.test\.js/.test(r.command ?? ""))!;
    expect(pass.ran).toBe(true); expect(pass.passed).toBe(true); expect(pass.exitCode).toBe(0);
    expect(pass.cwd).toBe(dir);
    expect(fail.passed).toBe(false); expect(fail.exitCode).toBe(2);
  });

  it("完全无可跑测试 → 空数组(诚实缺省,不虚构)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "readme.md"), "no tests", "utf-8");
    expect(await runVerifierTestsInSnapshot(dir)).toEqual([]);
  });

  it("有 node 框架 + 快照真有 node_modules → 优先框架单条命令", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    writePkg(dir, 'node -e "process.exit(0)"');
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true }); // 依赖就位才跑 node 框架命令
    const results = await runVerifierTestsInSnapshot(dir);
    expect(results).toHaveLength(1);
    expect(results[0].command).toBe("npm test --silent");
    expect(results[0].passed).toBe(true);
  });

  it("MAJOR 修复:node 框架但快照无 node_modules → 不跑框架命令(避免伪依赖失败),退裸测试文件", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    writePkg(dir, 'vitest run'); // package.json 有 scripts.test 但快照无 node_modules
    // 无裸测试文件 → 空(交给独立门判 missing_independent_verification,而非伪 test_failed)
    expect(await runVerifierTestsInSnapshot(dir)).toEqual([]);
    // 若有裸测试文件则跑它(零依赖能真跑),不碰 npm test
    fs.writeFileSync(path.join(dir, "sum.test.js"), "process.exit(0)", "utf-8");
    const r = await runVerifierTestsInSnapshot(dir);
    expect(r).toHaveLength(1);
    expect(r[0].command).toMatch(/sum\.test\.js/);
    expect(r[0].command).not.toMatch(/npm|vitest/);
    expect(r[0].passed).toBe(true);
  });
});

describe("P0 · runVerifierTestsInSnapshot 交付合同绑定 —— 只跑本 run 的测试,拒跑历次遗留", () => {
  it("绑定模式:只跑合同里的测试文件,遗留测试(不在合同、不测合同源文件)被拒;并带 testedFile+hash", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "feature.test.js"), "process.exit(0)", "utf-8");   // 本 run 交付
    fs.writeFileSync(path.join(dir, "leftover.test.js"), "process.exit(0)", "utf-8");  // 历次遗留
    const r = await runVerifierTestsInSnapshot(dir, ["feature.test.js"]);
    expect(r).toHaveLength(1);
    expect(r[0].command).toMatch(/feature\.test\.js/);
    expect(r[0].testedFile).toBe("feature.test.js");
    expect(typeof r[0].testedFileHash).toBe("string");
    expect(r[0].testedFileHash!.length).toBeGreaterThan(0);
  });

  it("绑定模式 · 目标匹配:测试文件本身是遗留,但它测的源文件在合同里 → 跑(它真在验证本 run 改动)", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "clamp.js"), "module.exports={};", "utf-8");        // 本 run 改的源码(在合同)
    fs.writeFileSync(path.join(dir, "clamp.test.js"), "process.exit(0)", "utf-8");      // 测试文件是历史遗留(不在合同)
    fs.writeFileSync(path.join(dir, "gcd.test.js"), "process.exit(0)", "utf-8");        // 纯遗留:测的 gcd 不在合同
    const r = await runVerifierTestsInSnapshot(dir, ["clamp.js"]);
    expect(r.some((x) => /clamp\.test\.js/.test(x.command ?? ""))).toBe(true);  // 测本 run 源文件 → 跑
    expect(r.some((x) => /gcd\.test\.js/.test(x.command ?? ""))).toBe(false);   // 纯遗留 → 拒
  });

  it("绑定模式 · 空合同(本 run 零变更)→ 一条都不跑(独立门将判 missing_independent,而非误判本任务完成)", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "leftover.test.js"), "process.exit(0)", "utf-8");
    expect(await runVerifierTestsInSnapshot(dir, [])).toEqual([]);
  });

  it("非绑定模式(contractFiles 缺省)→ 旧行为:跑目录里全部裸测试(兼容既有调用)", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.test.js"), "process.exit(0)", "utf-8");
    fs.writeFileSync(path.join(dir, "b.test.js"), "process.exit(0)", "utf-8");
    expect(await runVerifierTestsInSnapshot(dir)).toHaveLength(2);
  });

  it("MUP 波2 目录敏感修复:合同 src/sum.js × 根级 sum.test.js → 绑定成立(verifier 快照自建测试进合同视野)", { timeout: 120_000 }, async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "sum.js"), "module.exports = (a, b) => a + b;", "utf-8");
    fs.writeFileSync(path.join(dir, "sum.test.js"), "process.exit(0)", "utf-8");
    fs.writeFileSync(path.join(dir, "gcd.test.js"), "process.exit(0)", "utf-8"); // 纯遗留 → 仍拒
    const r = await runVerifierTestsInSnapshot(dir, ["src/sum.js"]);
    expect(r).toHaveLength(1);
    expect(r[0].testedFile).toBe("sum.test.js");
    expect(r[0].passed).toBe(true);
  });
});

// 选1(降级·07-14):进程外观测器已移除。runVerifierTestsInSnapshot 普通 execSync 跑测试,只产 pass/fail + testedFile
// 绑定,【绝不产 resolvedProducerFiles】——"测过 producer 逻辑"的可信证据不存在(见 opc-verified-cdp-observer-mandate)。
// deliveryAcceptance 据"独立测试通过 + 交付字节==冻结 manifest"收 independent_tests_passed(接受档)。
describe("选1 · runVerifierTestsInSnapshot 普通执行(pass/fail + 合同绑定;不产 resolvedProducerFiles)", () => {
  it("测试 require+调用 producer 通过 → passed + testedFile+hash,但【无】resolvedProducerFiles", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "sum.js"), "function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "sum.test.js"),
      'const assert = require("node:assert");\nconst { sum } = require("./src/sum.js");\nassert.strictEqual(sum(1, 2), 3);\n',
      "utf-8",
    );
    const r = runVerifierTestsInSnapshot(dir, ["src/sum.js"]);
    expect(r).toHaveLength(1);
    expect(r[0].passed).toBe(true);
    expect(r[0].testedFile).toBe("sum.test.js");
    expect("resolvedProducerFiles" in r[0]).toBe(false); // 选1:强证据已退役,永不产出
  });

  it("断言失败 → passed:false(退出码非0);且无 resolvedProducerFiles", { timeout: 120_000 }, () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "sum.js"), "function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n", "utf-8");
    fs.writeFileSync(path.join(dir, "sum.test.js"), 'const assert=require("node:assert");\nconst { sum }=require("./src/sum.js");\nassert.strictEqual(sum(1,2),999);\n', "utf-8");
    const r = runVerifierTestsInSnapshot(dir, ["src/sum.js"]);
    expect(r).toHaveLength(1);
    expect(r[0].passed).toBe(false);
    expect("resolvedProducerFiles" in r[0]).toBe(false);
  });
});
