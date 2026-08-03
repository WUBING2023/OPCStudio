import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { gitHeadCommit, seedSnapshotFromWorktree } from "./worktree.js";

// P0-3 · Verifier Snapshot 播种单测:git 路径靠 checkout-index 只导已跟踪文件(天然排除未跟踪的
// .opc/tester 临时产物),非 git 路径靠 fs 递归拷贝并显式跳过 .opc/node_modules/.git。gitHeadCommit
// 返回 HEAD sha(非 git → undefined)。绝不真调模型,纯文件系统/本地 git。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-snap-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync("git init -q", { cwd: dir, stdio: "pipe" });
  try { execSync("git config user.email t@t && git config user.name t", { cwd: dir, stdio: "pipe" }); } catch { /* global */ }
}

describe("gitHeadCommit", () => {
  it("git 仓库 → 返回 HEAD 的 40 位 sha", () => {
    const dir = path.join(tmp, "head-git");
    initRepo(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
    const sha = gitHeadCommit(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("非 git 目录 → undefined(诚实缺省,不虚构)", () => {
    const dir = path.join(tmp, "head-nogit");
    fs.mkdirSync(dir, { recursive: true });
    expect(gitHeadCommit(dir)).toBeUndefined();
  });
});

describe("seedSnapshotFromWorktree · git 路径(checkout-index 只导已跟踪文件)", () => {
  it("已跟踪文件进快照;未跟踪的 .opc/临时产物绝不进(隔离铁律)", () => {
    const src = path.join(tmp, "seed-git-src");
    initRepo(src);
    fs.writeFileSync(path.join(src, "sum.js"), "module.exports.sum=(a,b)=>a+b");
    fs.mkdirSync(path.join(src, "lib"), { recursive: true });
    fs.writeFileSync(path.join(src, "lib", "util.js"), "exports.x=1");
    execSync("git add -A && git commit -q -m init", { cwd: src, stdio: "pipe" });
    // 未跟踪:tester 误写的业务文件 + .opc 元数据 —— 都不在 index,不该进快照
    fs.writeFileSync(path.join(src, "tester-scratch.txt"), "误写");
    fs.mkdirSync(path.join(src, ".opc", "runs"), { recursive: true });
    fs.writeFileSync(path.join(src, ".opc", "runs", "x.json"), "{}");

    const dst = path.join(tmp, "seed-git-dst");
    fs.mkdirSync(dst, { recursive: true });
    const ok = seedSnapshotFromWorktree(src, dst);
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dst, "sum.js"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "lib", "util.js"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "tester-scratch.txt"))).toBe(false); // 未跟踪 → 排除
    expect(fs.existsSync(path.join(dst, ".opc"))).toBe(false);               // 未跟踪 → 排除
  });
});

describe("seedSnapshotFromWorktree · 非 git 路径(fs 递归拷贝,跳过隔离/vendor)", () => {
  it("业务文件拷贝;.opc/node_modules/.git 显式跳过", () => {
    const src = path.join(tmp, "seed-nogit-src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "app.py"), "print(1)");
    fs.writeFileSync(path.join(src, "sub", "mod.py"), "x=1");
    fs.mkdirSync(path.join(src, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(src, ".opc", "meta.json"), "{}");
    fs.mkdirSync(path.join(src, "node_modules", "p"), { recursive: true });
    fs.writeFileSync(path.join(src, "node_modules", "p", "i.js"), "1");
    fs.mkdirSync(path.join(src, ".git"), { recursive: true });
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref");

    const dst = path.join(tmp, "seed-nogit-dst");
    const ok = seedSnapshotFromWorktree(src, dst);
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dst, "app.py"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "sub", "mod.py"))).toBe(true);
    expect(fs.existsSync(path.join(dst, ".opc"))).toBe(false);
    expect(fs.existsSync(path.join(dst, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(dst, ".git"))).toBe(false);
  });
});
