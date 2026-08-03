import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { validateWorkspaceFolder, isSameOrInside } from "./workspaceGuard.js";

// 收口③ · 工作目录设置 V0:主工作目录安全检查(realpath/允许根/读写/磁盘/穿越)+ Git 状态探测的
// 单元锚定。核心不变量:① 非法路径逐类拒绝且带机器可读 code;② 通过时返回 canonical realPath
// (冻结进 task.json 的就是它);③ 只探测 Git 状态、绝不初始化(needsInit 交由绑定/起跑侧要求
// 用户显式确认)。

let tmp: string;
let projectRoot: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-wsguard-"));
  projectRoot = path.join(tmp, "project");
  fs.mkdirSync(path.join(projectRoot, ".opc"), { recursive: true });
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function gitInit(dir: string, withCommit: boolean): void {
  execSync("git init -q", { cwd: dir, stdio: "pipe" });
  try { execSync("git config user.email t@t && git config user.name t", { cwd: dir, stdio: "pipe" }); } catch { /* global */ }
  if (withCommit) {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
  }
}

describe("validateWorkspaceFolder · 逐类拒绝", () => {
  it("空 / 相对路径 / 含 .. 段", () => {
    expect(validateWorkspaceFolder(projectRoot, "")).toMatchObject({ ok: false, code: "empty" });
    expect(validateWorkspaceFolder(projectRoot, "  ")).toMatchObject({ ok: false, code: "empty" });
    expect(validateWorkspaceFolder(projectRoot, "relative/dir")).toMatchObject({ ok: false, code: "not_absolute" });
    const withDotDot = `${tmp}${path.sep}..${path.sep}x`;
    expect(validateWorkspaceFolder(projectRoot, withDotDot)).toMatchObject({ ok: false, code: "traversal" });
  });

  it("不存在的目录 / 指向文件", () => {
    expect(validateWorkspaceFolder(projectRoot, path.join(tmp, "no-such-dir"))).toMatchObject({ ok: false, code: "not_found" });
    const f = path.join(tmp, "a-file.txt");
    fs.writeFileSync(f, "x");
    expect(validateWorkspaceFolder(projectRoot, f)).toMatchObject({ ok: false, code: "not_directory" });
  });

  it("允许根:盘符根 / 家目录本身 / app 自己的 .opc 元数据库内部一律拒绝", () => {
    const driveRoot = path.parse(tmp).root; // 如 C:\ 或 /
    expect(validateWorkspaceFolder(projectRoot, driveRoot)).toMatchObject({ ok: false, code: "forbidden_root" });
    expect(validateWorkspaceFolder(projectRoot, os.homedir())).toMatchObject({ ok: false, code: "forbidden_root" });
    expect(validateWorkspaceFolder(projectRoot, path.join(projectRoot, ".opc"))).toMatchObject({ ok: false, code: "forbidden_root" });
  });

  it("Windows 系统目录拒绝(仅 win32 有意义)", () => {
    if (process.platform !== "win32") return;
    const winDir = process.env.WINDIR || "C:\\Windows";
    if (!fs.existsSync(winDir)) return;
    expect(validateWorkspaceFolder(projectRoot, winDir)).toMatchObject({ ok: false, code: "forbidden_root" });
  });
});

describe("validateWorkspaceFolder · 通过路径与 Git 探测(绝不初始化)", () => {
  it("普通可写非 Git 目录:ok + canonical realPath + needsInit,且目录零改动", () => {
    const ws = path.join(tmp, "plain-ws");
    fs.mkdirSync(ws);
    const before = fs.readdirSync(ws);
    const r = validateWorkspaceFolder(projectRoot, ws);
    expect(r.ok).toBe(true);
    expect(r.realPath).toBe(fs.realpathSync(ws));
    expect(r.isGitRepo).toBe(false);
    expect(r.needsInit).toBe(true);
    // 零隐式初始化:探测不产生任何文件(探针已删)
    expect(fs.readdirSync(ws)).toEqual(before);
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(false);
  });

  it("有 .git 但无首个 commit:isGitRepo=true 但 needsInit=true", () => {
    const ws = path.join(tmp, "git-no-commit");
    fs.mkdirSync(ws);
    gitInit(ws, false);
    const r = validateWorkspaceFolder(projectRoot, ws);
    expect(r.ok).toBe(true);
    expect(r.isGitRepo).toBe(true);
    expect(r.hasCommit).toBe(false);
    expect(r.needsInit).toBe(true);
  });

  it("带首个 commit 的 Git 仓库:needsInit=false", () => {
    const ws = path.join(tmp, "git-with-commit");
    fs.mkdirSync(ws);
    gitInit(ws, true);
    const r = validateWorkspaceFolder(projectRoot, ws);
    expect(r).toMatchObject({ ok: true, isGitRepo: true, hasCommit: true, needsInit: false });
  });
});

describe("isSameOrInside", () => {
  it("等于 / 内部 / 外部 / 前缀碰撞", () => {
    const base = path.join(tmp, "base");
    expect(isSameOrInside(base, base)).toBe(true);
    expect(isSameOrInside(path.join(base, "sub"), base)).toBe(true);
    expect(isSameOrInside(tmp, base)).toBe(false);
    // 前缀碰撞:/base-evil 不在 /base 内
    expect(isSameOrInside(`${base}-evil`, base)).toBe(false);
  });
});
