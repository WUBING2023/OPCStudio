import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evalTask, type BenchmarkTask } from "./benchmark.js";

// 阶段2 前置修复:benchmark 不得对【无机器可验断言】的任务判成功(旧行为 else→success=true 是假阳性,
// 不能作为产品证据)。本测试锁死机器核验逻辑的四条分支。
describe("benchmark evalTask — 机器核验(禁假成功)", () => {
  let root = "";
  const stats = () => ({ tokens: 100, cost: 0.01 });
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-")); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("无 expectedFile/expectedContent → verifiable=false 且 success=false(修复:不再假成功)", async () => {
    const task: BenchmarkTask = { id: "no-assert", goal: "do something unverifiable", expectedFile: null };
    const r = await evalTask(task, "run-x", Date.now(), stats, root);
    expect(r.verifiable).toBe(false);
    expect(r.success).toBe(false); // 关键:旧代码这里是 true(假阳性),现在必须 false
    expect(r.qualityNotes).toContain("NOT counted as success");
  });

  it("有 expectedFile 且文件存在 → verifiable=true, success=true", async () => {
    fs.writeFileSync(path.join(root, "README.md"), "# hi");
    const task: BenchmarkTask = { id: "readme", goal: "make readme", expectedFile: "README.md" };
    const r = await evalTask(task, "run-x", Date.now(), stats, root);
    expect(r.verifiable).toBe(true);
    expect(r.success).toBe(true);
  });

  it("有 expectedFile 但文件不存在 → verifiable=true, success=false", async () => {
    const task: BenchmarkTask = { id: "readme", goal: "make readme", expectedFile: "README.md" };
    const r = await evalTask(task, "run-x", Date.now(), stats, root);
    expect(r.verifiable).toBe(true);
    expect(r.success).toBe(false);
    expect(r.qualityNotes).toContain("not found");
  });

  it("expectedFile+expectedContent:内容命中→success=true,未命中→success=false(均 verifiable)", async () => {
    fs.writeFileSync(path.join(root, "out.js"), "module.exports = function gcd(){ return 1; }");
    const hit: BenchmarkTask = { id: "c1", goal: "g", expectedFile: "out.js", expectedContent: "gcd" };
    const miss: BenchmarkTask = { id: "c2", goal: "g", expectedFile: "out.js", expectedContent: "isPalindrome" };
    const rHit = await evalTask(hit, "run-x", Date.now(), stats, root);
    const rMiss = await evalTask(miss, "run-x", Date.now(), stats, root);
    expect(rHit.verifiable).toBe(true); expect(rHit.success).toBe(true);
    expect(rMiss.verifiable).toBe(true); expect(rMiss.success).toBe(false);
  });

  it("成本/token 从 getRunStats 如实带出", async () => {
    fs.writeFileSync(path.join(root, "README.md"), "x");
    const r = await evalTask({ id: "readme", goal: "g", expectedFile: "README.md" }, "run-x", Date.now(), () => ({ tokens: 4242, cost: 0.42 }), root);
    expect(r.tokensUsed).toBe(4242);
    expect(r.cost).toBe(0.42);
  });
});
