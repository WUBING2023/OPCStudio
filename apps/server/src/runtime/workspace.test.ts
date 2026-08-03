import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { ensureGitRepo } from "./workspace.js";

// v4 E4：工作区 git 隔离不变量——即使工作区嵌套在另一个 git 仓库的工作树内，
// ensureGitRepo 也必须给它建**自己的 .git**，否则运行的 git 操作会落到父仓库（污染风险）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-ws-"));

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("ensureGitRepo — 工作区独立 git 隔离", () => {
  it("嵌套在父仓库工作树内的工作区，拿到自己的 .git（不复用父仓库）", () => {
    // 造一个父仓库
    const parent = path.join(tmp, "parent-repo");
    fs.mkdirSync(parent, { recursive: true });
    execSync("git init -q", { cwd: parent, stdio: "pipe" });
    try { execSync("git config user.email t@t && git config user.name t", { cwd: parent, stdio: "pipe" }); } catch { /* global */ }
    fs.writeFileSync(path.join(parent, "parent-file.txt"), "x");

    // 工作区是父仓库工作树内的子目录
    const ws = path.join(parent, ".opc-studio", "company-a");

    const ok = ensureGitRepo(ws);
    expect(ok).toBe(true);
    // 关键断言：工作区有自己的 .git，且 git 顶层指向工作区自身（而非 parent）
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(true);
    const top = execSync("git rev-parse --show-toplevel", { cwd: ws }).toString().trim();
    expect(path.resolve(top)).toBe(path.resolve(ws));
    expect(path.resolve(top)).not.toBe(path.resolve(parent));
  });

  it("MUP Gate A#3: 多 worker 产同名文件 merge-back 撞车 → conflict(绝不 -X theirs 强并),workRoot 干净、分支保留", async () => {
    const { createWorktree, commitWorktree, mergeWorktree, removeWorktree } = await import("./worktree.js");
    const { execSync } = await import("node:child_process");
    const root = path.join(tmp, "wsp", "默认公司"); // 含中文名（复刻真实工作区）
    ensureGitRepo(root);
    execSync("git checkout -q -b opc-run-x", { cwd: root, stdio: "pipe" });
    const wA = createWorktree(root, "run-fe"); fs.writeFileSync(path.join(wA.dir, "out.txt"), "A\n"); commitWorktree(wA, "fe run-fe");
    const wB = createWorktree(root, "run-be"); fs.writeFileSync(path.join(wB.dir, "out.txt"), "B\n"); commitWorktree(wB, "be run-be");
    expect(mergeWorktree(root, wA)).toEqual({ outcome: "merged", conflictFiles: [] });
    // 第二个撞车:conflict + 冲突文件清单;先落地的 A 版本原样保留,一个字节不被 B 覆盖
    const res = mergeWorktree(root, wB);
    expect(res.outcome).toBe("conflict");
    expect(res.conflictFiles).toContain("out.txt");
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf-8")).toBe("A\n");
    // 冲突已 abort:workRoot 干净;worker 分支与 worktree 保留供人工决裁(不删)
    expect(execSync("git status --porcelain", { cwd: root }).toString().trim()).toBe("");
    expect(execSync("git branch --list opc-wt-run-be", { cwd: root }).toString()).toContain("opc-wt-run-be");
    expect(fs.existsSync(wB.dir)).toBe(true);
    removeWorktree(root, wA); removeWorktree(root, wB);
  });

  it("MUP D3: managed 初始化到已有用户内容的目录 → 绝不 add -A,用户文件保持未跟踪", () => {
    const ws = path.join(tmp, "managed-preexisting");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "user-secret.txt"), "用户私有文件,不许自动入库");
    expect(ensureGitRepo(ws)).toBe(true);
    // HEAD 存在(worktree 可分支),但用户文件绝不被首提交卷入
    expect(execSync("git rev-parse HEAD", { cwd: ws }).toString().trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(execSync("git ls-files", { cwd: ws }).toString()).not.toContain("user-secret.txt");
    expect(execSync("git status --porcelain", { cwd: ws }).toString()).toContain("user-secret.txt");
  });

  it("MUP D3: OPC 全新创建的空管理目录 → 首提交只含 OPC 自建文件(README/.gitignore)", () => {
    const ws = path.join(tmp, "managed-fresh");
    expect(ensureGitRepo(ws)).toBe(true);
    const tracked = execSync("git ls-files", { cwd: ws }).toString().trim().split(/\r?\n/).filter(Boolean).sort();
    expect(tracked).toEqual([".gitignore", "README.md"]);
  });

  it("工作区内 git 操作不影响父仓库（隔离）", () => {
    const parent = path.join(tmp, "parent-repo2");
    fs.mkdirSync(parent, { recursive: true });
    execSync("git init -q", { cwd: parent, stdio: "pipe" });
    try { execSync("git config user.email t@t && git config user.name t", { cwd: parent, stdio: "pipe" }); } catch { /* global */ }
    fs.writeFileSync(path.join(parent, "dirty.txt"), "uncommitted");  // 父仓库有未提交改动

    const ws = path.join(parent, ".opc-studio", "company-b");
    ensureGitRepo(ws);
    fs.writeFileSync(path.join(ws, "out.txt"), "worker output");
    execSync("git add -A && git commit -q -m work", { cwd: ws, stdio: "pipe" });

    // 父仓库的 dirty.txt 仍是未跟踪/未提交，没被工作区的 commit 卷进去
    const parentStatus = execSync("git status --porcelain", { cwd: parent }).toString();
    expect(parentStatus).toContain("dirty.txt");  // 仍在父仓库的未提交区，未被工作区操作影响
  });
});

// 收口③ · 工作目录设置 V0:bound 模式(用户绑定的既有目录)零隐式初始化硬约束——
// 非 Git 目录绝不 git init/写 .gitignore/README/建 commit;既有 Git 仓库只做 .git 目录内的
// 本地调整只限 info/exclude,工作树、提交历史和仓库既有 Git 配置均零改动。
describe("ensureGitRepo · bound 模式(零隐式初始化)", () => {
  it("非 Git 目录:返回 false,且目录零改动(无 .git/.gitignore/README)", () => {
    const ws = path.join(tmp, "bound-plain");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "user-file.txt"), "用户自己的文件");
    expect(ensureGitRepo(ws, { mode: "bound" })).toBe(false);
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "README.md"))).toBe(false);
    expect(fs.readdirSync(ws)).toEqual(["user-file.txt"]);
  });

  it("不存在的目录:返回 false 且不创建目录", () => {
    const ws = path.join(tmp, "bound-missing");
    expect(ensureGitRepo(ws, { mode: "bound" })).toBe(false);
    expect(fs.existsSync(ws)).toBe(false);
  });

  it("有 .git 但无首个 commit:返回 false,不代替用户建 README/commit", () => {
    const ws = path.join(tmp, "bound-no-commit");
    fs.mkdirSync(ws, { recursive: true });
    execSync("git init -q", { cwd: ws, stdio: "pipe" });
    try { execSync("git config user.email t@t && git config user.name t", { cwd: ws, stdio: "pipe" }); } catch { /* global */ }
    expect(ensureGitRepo(ws, { mode: "bound" })).toBe(false);
    expect(fs.existsSync(path.join(ws, "README.md"))).toBe(false);
    expect(() => execSync("git rev-parse HEAD", { cwd: ws, stdio: "pipe" })).toThrow();
  });

  it("带首个 commit 的既有仓库:返回 true;不写 .gitignore、不产生新 commit;.opc/ 落进 .git/info/exclude", () => {
    const ws = path.join(tmp, "bound-real-repo");
    fs.mkdirSync(ws, { recursive: true });
    execSync("git init -q", { cwd: ws, stdio: "pipe" });
    try { execSync("git config user.email t@t && git config user.name t", { cwd: ws, stdio: "pipe" }); } catch { /* global */ }
    execSync("git config core.autocrlf true", { cwd: ws, stdio: "pipe" });
    fs.writeFileSync(path.join(ws, "app.txt"), "code\r\n");
    execSync("git add -A && git commit -q -m init", { cwd: ws, stdio: "pipe" });
    const headBefore = execSync("git rev-parse HEAD", { cwd: ws }).toString().trim();
    expect(execSync("git status --porcelain", { cwd: ws }).toString()).toBe("");

    expect(ensureGitRepo(ws, { mode: "bound" })).toBe(true);

    expect(fs.existsSync(path.join(ws, ".gitignore"))).toBe(false);      // 工作树零写入
    expect(fs.existsSync(path.join(ws, "README.md"))).toBe(false);
    expect(execSync("git rev-parse HEAD", { cwd: ws }).toString().trim()).toBe(headBefore); // 零新 commit
    const exclude = fs.readFileSync(path.join(ws, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain(".opc/");                                   // 私有 exclude 承接忽略规则
    expect(execSync("git config core.autocrlf", { cwd: ws }).toString().trim()).toBe("true"); // 保留用户仓库策略
    expect(execSync("git status --porcelain", { cwd: ws }).toString()).toBe("");             // 不制造 CRLF 脏树
  });
});
