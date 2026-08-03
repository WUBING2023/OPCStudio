import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileChange } from "@opc/shared";

// stdio 全 pipe:预期内的失败(非 git 目录等)stderr 进异常对象被吞,不再把 51 处
// "fatal: not a git repository" 噪声刷到测试/服务日志。
function git(workdir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workdir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).toString();
}

// HEAD sha of the workdir (empty string if not a git repo) — taken before an agent runs.
export function snapshotGit(workdir: string): string {
  try {
    return git(workdir, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "";
  }
}

// P0 · run 级基线:本 run 从 baseCommit(起跑时的 HEAD)到当前 HEAD 之间**真实改动的文件**(相对 workRoot,
// POSIX)。这是"本 run 交付合同"的 git-truthful 权威来源——独立于 orchestrator 的 allChanges 记账,即便后者
// 有遗漏也能兜住。base 空/非 git/命令失败 → 返回 []。仅取名字(--name-only),含增/改/删/改名。
export function gitChangedSince(workdir: string, baseCommit: string): string[] {
  if (!/^[0-9a-f]{4,64}$/i.test(baseCommit)) return [];
  try {
    const out = git(workdir, ["diff", "--name-only", baseCommit, "HEAD"]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Structured working-tree changes (staged + unstaged + untracked) via `git status --porcelain`.
export function diffFileChanges(workdir: string): FileChange[] {
  let out = "";
  try {
    out = git(workdir, ["status", "--porcelain", "-uall"]);
  } catch {
    // Non-git workdir (rare — worktrees are git): best-effort filesystem listing so a CLI engine's
    // real output isn't silently reported as "no changes".
    return fsSnapshotChanges(workdir);
  }
  const changes: FileChange[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    // renames look like "old -> new" — take the new path
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4);

    let changeType: FileChange["changeType"] = "modify";
    if (code.includes("?") || code.trim() === "A") changeType = "create";
    else if (code.includes("D")) changeType = "delete";

    let after: string | undefined;
    if (changeType !== "delete") {
      try { after = fs.readFileSync(path.join(workdir, file), "utf-8").slice(0, 20000); } catch { /* binary/large */ }
    }
    changes.push({ path: file, changeType, after });
  }
  return changes;
}

// Fallback for a non-git workdir: walk the tree (skipping vcs/deps/build dirs), reporting files as
// "create". Bounded to 200 entries; reads content for small text files only.
function fsSnapshotChanges(workdir: string): FileChange[] {
  const SKIP = new Set([".git", "node_modules", ".opc", "dist", ".next", ".cache"]);
  const out: FileChange[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= 200) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 200) return;
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        let after: string | undefined;
        try { if (fs.statSync(abs).size <= 65536) after = fs.readFileSync(abs, "utf-8").slice(0, 20000); } catch { /* binary/large */ }
        out.push({ path: r, changeType: "create", after });
      }
    }
  };
  walk(workdir, "");
  return out;
}

// Revert a set of changes (used when a worker's diff fails the quality gate).
export function discardFileChanges(workdir: string, files: FileChange[]): void {
  for (const f of files) {
    try {
      if (f.changeType === "create") {
        fs.rmSync(path.join(workdir, f.path), { force: true });
      } else {
        git(workdir, ["checkout", "--", f.path]);
      }
    } catch { /* best effort */ }
  }
}
