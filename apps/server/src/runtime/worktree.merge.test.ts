import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createWorktree, commitWorktree, mergeWorktree, removeWorktree } from "./worktree.js";
import { ensureGitRepo } from "./workspace.js";

// MUP Gate A#3 / D3 · mergeWorktree 新契约:
//   ① 返回冻结接口 { outcome: 'merged'|'conflict', conflictFiles } — 'merged-theirs' 强并语义废弃;
//   ② 脏 workRoot 绝不 add -A / 自动全量提交;仅 protectPaths(本 run 已接受产出的精确路径)被
//      stage+提交保护,其余脏/未跟踪文件绝不入库;
//   ③ merge 将覆盖非保护脏/未跟踪文件 → conflict,用户文件一个字节不动;
//   ④ 冲突时 merge --abort 保 workRoot 干净,worker 分支/worktree 保留(不在本函数内删)。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-wtm-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeRepo(name: string): string {
  const root = path.join(tmp, name);
  ensureGitRepo(root);
  return root;
}

describe("mergeWorktree · protectPaths 精确保护(D3)", () => {
  it("只有 protectPaths 被 stage+提交;其余未跟踪用户文件绝不入库", () => {
    const root = makeRepo("protect");
    const wt = createWorktree(root, "t-protect");
    fs.writeFileSync(path.join(wt.dir, "feature.txt"), "new feature\n");
    commitWorktree(wt, "dev-1 t-protect");
    // workRoot 脏:上一 worker 已落地的产出(受保护)+ 用户游离文件(绝不入库)
    fs.writeFileSync(path.join(root, "prior-output.md"), "上一 worker 的产出\n");
    fs.writeFileSync(path.join(root, "user-note.txt"), "用户随手记\n");

    const res = mergeWorktree(root, wt, ["prior-output.md"]);
    expect(res).toEqual({ outcome: "merged", conflictFiles: [] });
    expect(fs.existsSync(path.join(root, "feature.txt"))).toBe(true);
    const tracked = execSync("git ls-files", { cwd: root }).toString();
    expect(tracked).toContain("prior-output.md");   // 精确保护 → 已入库
    expect(tracked).not.toContain("user-note.txt"); // 用户文件绝不 add
    expect(execSync("git status --porcelain", { cwd: root }).toString()).toContain("user-note.txt");
    // 保护提交是基建性提交(OPC: 前缀),不冒充 worker 提交
    const subjects = execSync("git log --format=%s -n 5", { cwd: root }).toString();
    expect(subjects).toContain("OPC: protect run outputs before merge");
    expect(subjects).not.toContain("OPC: pre-merge snapshot");
    removeWorktree(root, wt);
  });

  it("merge 将覆盖非保护的未跟踪文件 → conflict,用户文件内容原样保留", () => {
    const root = makeRepo("overwrite");
    const wt = createWorktree(root, "t-clash");
    fs.writeFileSync(path.join(wt.dir, "data.txt"), "WORKER\n");
    commitWorktree(wt, "dev-2 t-clash");
    fs.writeFileSync(path.join(root, "data.txt"), "USER\n"); // 用户未跟踪同名文件

    const res = mergeWorktree(root, wt);
    expect(res.outcome).toBe("conflict");
    expect(res.conflictFiles).toContain("data.txt");
    expect(fs.readFileSync(path.join(root, "data.txt"), "utf-8")).toBe("USER\n");
    // 用户文件仍未跟踪,workRoot 无半拉子 merge 状态
    expect(execSync("git ls-files", { cwd: root }).toString()).not.toContain("data.txt");
    expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    // 分支与 worktree 保留供人工决裁
    expect(execSync(`git branch --list ${wt.branch}`, { cwd: root }).toString()).toContain(wt.branch);
    expect(fs.existsSync(wt.dir)).toBe(true);
    removeWorktree(root, wt);
  });

  it("与 merge 无关的脏文件不阻塞合并,也不被卷进任何提交", () => {
    const root = makeRepo("unrelated");
    const wt = createWorktree(root, "t-clean");
    fs.writeFileSync(path.join(wt.dir, "feature2.txt"), "ok\n");
    commitWorktree(wt, "dev-3 t-clean");
    fs.writeFileSync(path.join(root, "scratch.txt"), "无关脏文件\n");

    const res = mergeWorktree(root, wt);
    expect(res.outcome).toBe("merged");
    expect(fs.existsSync(path.join(root, "feature2.txt"))).toBe(true);
    expect(execSync("git ls-files", { cwd: root }).toString()).not.toContain("scratch.txt");
    expect(execSync("git status --porcelain", { cwd: root }).toString()).toContain("scratch.txt");
    removeWorktree(root, wt);
  });

  it("无 commit 可并(worker 零改动)→ merged 空清单", () => {
    const root = makeRepo("nothing");
    const wt = createWorktree(root, "t-noop");
    expect(mergeWorktree(root, wt)).toEqual({ outcome: "merged", conflictFiles: [] });
    removeWorktree(root, wt);
  });
});

describe("commitWorktree · 消息格式契约(execFileSync 化后不变)", () => {
  it("提交主题原样 = '<agentId> <taskId>'(归因解析依赖)", () => {
    const root = makeRepo("msgfmt");
    const wt = createWorktree(root, "t-msg");
    fs.writeFileSync(path.join(wt.dir, "x.txt"), "1");
    expect(commitWorktree(wt, "dev-agent task-42")).toBe(true);
    expect(execSync("git log -1 --format=%s", { cwd: wt.dir }).toString().trim()).toBe("dev-agent task-42");
    removeWorktree(root, wt);
  });
});
