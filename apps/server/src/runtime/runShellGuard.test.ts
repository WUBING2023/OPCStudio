import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTool, runWithAgent, isRestrictedTestCommand } from "./tools.js";

// A1-V3: runShell 的角色 shellMode 档位拦截(tools.ts 接线层)。
// 角色判定发生在全局 allowShell 门与真实 execSync 之前,因此这些用例不执行任何真实命令、不读 config。

describe("runShell 角色档位拦截", () => {
  it("fact_checker(shellMode=none)被拦截,错误信息带角色名", async () => {
    const out = await runWithAgent("fc1", () => runTool("runShell", { command: "echo hi" }), "fact_checker");
    expect(out).toContain("shell blocked by role profile (fact_checker)");
    expect(out).toContain("none");
  });

  it("researcher(shellMode=allowlist)执行白名单外首词被拦截", async () => {
    const out = await runWithAgent("r1", () => runTool("runShell", { command: "del x.txt" }), "researcher");
    expect(out).toContain("shell blocked by role profile (researcher)");
    expect(out).toContain("del");
  });

  it("researcher 复合命令搭车违规段同样被拦截", async () => {
    const out = await runWithAgent("r1", () => runTool("runShell", { command: "echo ok && del x" }), "researcher");
    expect(out).toContain("shell blocked by role profile");
  });

  it("未知角色兜底最保守 research profile(allowlist),白名单外被拦", async () => {
    const out = await runWithAgent("x1", () => runTool("runShell", { command: "makething --now" }), "totally_unknown_role");
    expect(out).toContain("shell blocked by role profile (totally_unknown_role)");
  });

  it("缺 command 参数仍先报参数错误(与既有行为一致)", async () => {
    const out = await runWithAgent("r1", () => runTool("runShell", {}), "researcher");
    expect(out).toBe("Error: command is required");
  });
});

// P0-4 · 受限测试通道:白名单测试命令即便全局 allowShell=false 也放行,只在 workRoot 内跑,输出带
// [test-evidence] 头(命令/cwd/exitCode/stdout → TestEvidence)。不是开放 shell。角色门只挡 shellMode=none
// (fact_checker);其余角色(dev/tester/architect/lead/researcher…allowlist|full)皆放行——活体验证暴露
// 实际跑测试的常是 dev/architect 单 worker,只放 verifier 会让"要求测试的编码任务"永远拿不到 TestEvidence。
describe("P0-4 · runShell 受限测试通道", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "p0-4-shell-"));
    fs.writeFileSync(path.join(root, "ok.test.js"), "console.log('PASS_MARKER');\n");
    fs.writeFileSync(path.join(root, "bad.test.js"), "console.error('BOOM');process.exit(1);\n");
  });
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("isRestrictedTestCommand:白名单测试命令匹配;普通命令/shell 串接一律拒绝", () => {
    for (const c of ["node sum.test.js", "node a.spec.mjs", "node --test", "node --test sum.test.js", "npm test", "pnpm test", "pnpm run test", "yarn test", "npx vitest", "npx jest", "python -m pytest", "pytest", "python test_x.py", "go test ./...", "cargo test"])
      expect(isRestrictedTestCommand(c), c).toBe(true);
    for (const c of ["node server.js", "echo hi", "rm -rf x", "npm run build", "npm test && rm -rf x", "node sum.test.js; cat /etc/passwd", "cat sum.js", "node a.test.js | tee out"])
      expect(isRestrictedTestCommand(c), c).toBe(false);
  });

  it("tester 跑 node <测试文件> 即使全局 allowShell 关闭也放行,头带 command/cwd/exit=0/passed=true", async () => {
    const out = await runWithAgent("tester-1", () => runTool("runShell", { command: "node ok.test.js" }, root), "tester");
    expect(out.startsWith("[test-evidence] ")).toBe(true);
    expect(out).toContain("command=node ok.test.js");
    expect(out).toContain(`cwd=${root}`);
    expect(out).toContain("exit=0");
    expect(out).toContain("passed=true");
    expect(out).toContain("PASS_MARKER");
  });

  it("Node 官方 node --test <file> 语法生成可绑定 TestEvidence", async () => {
    const out = await runWithAgent("tester-node", () => runTool("runShell", { command: "node --test ok.test.js" }, root), "test");
    expect(out.startsWith("[test-evidence] ")).toBe(true);
    expect(out).toContain("command=node --test ok.test.js");
    expect(out).toContain("testedFile=ok.test.js");
    expect(out).toMatch(/testedHash=[a-f0-9]{16}/);
    expect(out).toContain("passed=true");
  });

  it("失败测试如实 exit≠0 / passed=false(不掩盖)", async () => {
    const out = await runWithAgent("qa-1", () => runTool("runShell", { command: "node bad.test.js" }, root), "qa");
    expect(out).toContain("exit=1");
    expect(out).toContain("passed=false");
    expect(out).toContain("Tests failed");
  });

  it("编码角色(dev,shellMode=full)同一测试命令也走受限通道 → 产 [test-evidence](实际跑测试的常是 dev 单 worker)", async () => {
    const out = await runWithAgent("dev-1", () => runTool("runShell", { command: "node ok.test.js" }, root), "dev");
    expect(out.startsWith("[test-evidence] ")).toBe(true);
    expect(out).toContain("exit=0");
    expect(out).toContain("PASS_MARKER");
  });

  it("architect(shellMode=full)尾部 `; echo EXIT_CODE=$?` 被剥离后放行(agent 惯用拿退出码)", async () => {
    const out = await runWithAgent("arch-1", () => runTool("runShell", { command: "node ok.test.js; echo EXIT_CODE=$?" }, root), "architect");
    expect(out.startsWith("[test-evidence] ")).toBe(true);
    expect(out).toContain("command=node ok.test.js"); // 尾部 echo 已剥离,证据头只记真命令
    expect(out).toContain("passed=true");
  });

  it("shellMode=none 角色(fact_checker)测试命令不破例 → 不走受限通道,被角色档拦,无 [test-evidence]", async () => {
    const out = await runWithAgent("fc-1", () => runTool("runShell", { command: "node ok.test.js" }, root), "fact_checker");
    expect(out).not.toContain("[test-evidence]");
    expect(out).toContain("shell blocked by role profile (fact_checker)");
  });

  it("验证角色的非测试命令不走受限通道(不伪造测试证据)", async () => {
    const out = await runWithAgent("tester-1", () => runTool("runShell", { command: "echo hi" }, root), "tester");
    expect(out).not.toContain("[test-evidence]");
  });
});
