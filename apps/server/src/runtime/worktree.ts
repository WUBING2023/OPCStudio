import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { hasPendingConflictForDir } from "../storage/conflictStore.js";

// 波6 · 决裁现场保护:createWorktree 复用同 id 时会 `worktree remove --force` + `branch -D`。若该目录仍挂着
// 未决合并冲突记录(pending),销毁会丢掉待人工决裁的分支/现场——此时干净失败(抛此错),逼调用方先决裁。
export class PendingConflictWorktreeError extends Error {
  readonly code = "pending_conflict_worktree";
  constructor(public readonly dir: string) {
    super(`pending_conflict_worktree: worktree 目录 ${dir} 仍有未决合并冲突待人工决裁,拒绝销毁(请先在冲突决裁台处理)`);
    this.name = "PendingConflictWorktreeError";
  }
}

// Per-task git worktree isolation. Each parallel worker runs in its own worktree off HEAD, so
// concurrent file edits + quality gates never collide. Accepted worktrees are merged back into
// the project's current branch (disjoint changes merge cleanly; conflicts are reported, not forced).
// No-git projects fall back to operating directly on projectRoot (isolation disabled, serial-safe).

export interface Worktree {
  dir: string;
  branch: string;
  isGit: boolean;
  scratch?: boolean; // RC1:研究/无代码 worker 用的干净短路径临时目录(非 git),清理时整目录 rm
  // 五.1(收口作战令)· 隔离级别显式化:"git"=真 worktree(可 commit/merge/回滚);"none"=非 git 工作根,
  // worker 直接写共用工作根、无 worktree 隔离(单写者才允许,见 parallelExecutor 的 non_git_multi_writer 阻断);
  // "scratch"=一次性短路径隔离目录(noCode/研究 worker,不 merge、按文件读回)。此前非 git 分支静默回退共用
  // projectRoot 而不留任何标记,下游误以为"已隔离"——现在如实标注,run 记录/报告据此声明 isolation:"none"。
  isolation: "git" | "none" | "scratch";
}

function git(root: string, args: string[], timeout = 15000): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export function isGitRepo(root: string): boolean {
  try { git(root, ["rev-parse", "--is-inside-work-tree"]); return true; } catch { return false; }
}

// dir 当前 HEAD 的 commit sha(P0-3 verifier:被测代码的 testedCommit 证据)。非 git / 失败 → undefined,不虚构。
export function gitHeadCommit(dir: string): string | undefined {
  try { return git(dir, ["rev-parse", "HEAD"]).trim() || undefined; } catch { return undefined; }
}

// P0-3 · Verifier Snapshot 播种:把 fromDir 的**已跟踪文件**拷进 toDir,让 verifier 在一份独立快照里
// 看到 producer 已 merge 的产物再跑真实测试。关键假设(锁死):fromDir 是 verifier worktree,刚从 HEAD
// 新建、index==HEAD,故 `checkout-index -a` 导出的正是 HEAD 快照——**天然排除未跟踪文件**(.opc 元数据 /
// tester 临时产物 / node_modules 都未跟踪,不会进快照,也就绝不会被 merge 回公司 worktree)。
// 非 git 项目走 best-effort fs 递归拷贝,并显式跳过 .opc/node_modules/.git(手工兜底"只拷业务文件")。
// 返回是否播种成功(失败让调用方降级)。
export function seedSnapshotFromWorktree(fromDir: string, toDir: string): boolean {
  if (isGitRepo(fromDir)) {
    try {
      // checkout-index 只吐 index(==HEAD)里的已跟踪文件到 --prefix 目录;prefix 需以 / 结尾(git 内部按
      // 正斜杠拼路径,Windows 上用反斜杠会拼错——统一正斜杠 + 末尾 /)。toDir 须已存在(mkdtemp 已建)。
      const prefix = toDir.replace(/\\/g, "/").replace(/\/?$/, "/");
      git(fromDir, ["checkout-index", "-a", `--prefix=${prefix}`], 30000);
      return true;
    } catch { return false; }
  }
  // 非 git:递归拷业务文件,跳过隔离/vendor/git 目录。fs.cpSync 不在缝隙守卫的 fs 读写正则内、也不碰 .opc 库。
  const SKIP = new Set([".opc", "node_modules", ".git"]);
  const copyDir = (relSrc: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(relSrc, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const src = path.join(relSrc, e.name);
      const dst = path.join(toDir, path.relative(fromDir, src));
      if (e.isDirectory()) { try { fs.mkdirSync(dst, { recursive: true }); } catch { /* best-effort */ } copyDir(src); }
      else if (e.isFile()) { try { fs.copyFileSync(src, dst); } catch { /* best-effort */ } }
    }
  };
  try { fs.mkdirSync(toDir, { recursive: true }); copyDir(fromDir); return true; } catch { return false; }
}

export function createWorktree(projectRoot: string, id: string): Worktree {
  // 五.1:非 git 根不再静默回退成"看起来已隔离"的共用 projectRoot——如实标注 isolation:"none"。
  // 多写者并发直写同一非 git 根会互相踩(无 worktree/merge/回滚),故 parallelExecutor 对"非 git + 该批>1 个写
  // worker"整 run 干净失败(NonGitMultiWriterError);单写者才走到这里,允许但下游据 isolation 声明无隔离。
  if (!isGitRepo(projectRoot)) return { dir: projectRoot, branch: "", isGit: false, isolation: "none" };
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const branch = `opc-wt-${safe}`;
  const dir = path.join(projectRoot, ".opc", "wt", safe);
  // 波6 · 决裁现场保护:同 id 目录若仍挂未决冲突,拒绝无条件销毁(否则待人工决裁的分支被 -D 静默丢失)。
  if (hasPendingConflictForDir(projectRoot, dir)) throw new PendingConflictWorktreeError(dir);
  // Clean any stale worktree/branch from a prior crashed run.
  try { git(projectRoot, ["worktree", "remove", "--force", dir]); } catch { /* none */ }
  try { git(projectRoot, ["branch", "-D", branch]); } catch { /* none */ }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(projectRoot, ["worktree", "add", "--quiet", "-b", branch, dir, "HEAD"]);
  return { dir, branch, isGit: true, isolation: "git" };
}

// RC1:给研究/无代码 worker 一个干净的**短路径**临时目录(不是整份 monorepo 的 git worktree)。
// 好处:① 它即便误建 Python 也只在这隔离短路径里(不污染 monorepo、短路径避免 ENAMETOOLONG);
// ② 不跑 git/quality gate(研究 worker 不需要)。注意:scratch 随后会被清,worker 写的 .md 交付内容
// 必须在清理前由 parallelExecutor 读回(见 runOne 的 noCode 分支),否则丢失。
let scratchSeq = 0;
export function createScratchDir(id: string): Worktree {
  // 唯一性后缀:同一 lead 下并行 noCode worker 的 id 经 sanitize+slice 后可能撞名(runId(8)+leadId
  // 已占满前缀、workerId 被截断)→ 落到同一 ~/opcwt/<dir> → 并发 rmSync 互删对方在写的 .md 交付物 →
  // defer/降级。用进程内单调计数器(base36)保证唯一;人类可读部分压到 18 字符留出后缀,整体仍是短路径。
  const base = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 18);
  const safe = `${base}-${(scratchSeq++).toString(36)}`;
  const dir = path.join(os.homedir(), "opcwt", safe);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  fs.mkdirSync(dir, { recursive: true });
  return { dir, branch: "", isGit: false, scratch: true, isolation: "scratch" };
}

// Commit the worktree's working changes. Returns true if a commit was created (false if clean).
// 消息格式契约(冻结):调用方传 `${agent.id} ${taskId}`,提交主题原样保留(截 200 字符)——
// 事后归因/测试(parallelExecutor.guards 等)按 "<agentId> <taskId>" 解析。add -A 只发生在
// OPC 自建的隔离 worktree 内(从 HEAD 新建,不含用户未跟踪文件),不触碰用户主检出。
export function commitWorktree(wt: Worktree, message: string): boolean {
  if (!wt.isGit) return false;
  git(wt.dir, ["add", "-A"]);
  const staged = git(wt.dir, ["diff", "--cached", "--name-only"]).trim();
  if (!staged) return false;
  git(wt.dir, ["commit", "-q", "-m", message.slice(0, 200)]);
  return true;
}

// MUP Gate A#3 · 冻结接口:merge-back 只有两种结局。conflict = 一个字节都没进 workRoot
// (merge --abort 保干净),worker 分支与 worktree 保留供人工决裁(调用方不得 removeWorktree)。
export type WorktreeMergeResult = { outcome: "merged" | "conflict"; conflictFiles: string[] };

const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

// status --porcelain -z:NUL 分隔的原始路径(不受 core.quotepath 转义影响,中文文件名安全)。
// rename/copy 记录后跟一个"来源路径"token,跳过。
function dirtyPaths(root: string): string[] {
  const out = git(root, ["status", "--porcelain", "-z", "-uall"]);
  const tokens = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 4) continue;
    const code = t.slice(0, 2);
    paths.push(t.slice(3));
    if (code.includes("R") || code.includes("C")) i++;
  }
  return paths;
}

// Merge an accepted worktree's branch into projectRoot's current branch.
// D3(脏工作树)契约:绝不 `git add -A`、绝不自动打包用户游离文件。仅 protectPaths(调用方声明的
// 本 run 已接受产出的精确路径)会被 stage+提交保护(防止 merge 覆盖上一个 worker 刚落地的未提交产出);
// 其余脏/未跟踪文件绝不入库——merge 将触碰它们时直接判 conflict(不动用户文件)。
// 冲突语义:不再 -X theirs 强并;merge --abort 后 workRoot 保持干净,返回冲突文件清单。
export function mergeWorktree(projectRoot: string, wt: Worktree, protectPaths?: string[]): WorktreeMergeResult {
  if (!wt.isGit) return { outcome: "merged", conflictFiles: [] };
  try {
    const ahead = git(projectRoot, ["rev-list", "--count", wt.branch, "^HEAD"]).trim();
    if (ahead === "0") return { outcome: "merged", conflictFiles: [] };
  } catch { /* fall through to attempt merge */ }
  let dirty: string[] = [];
  try { dirty = dirtyPaths(projectRoot); } catch { /* non-git state handled by merge attempt */ }
  const protect = new Set((protectPaths ?? []).map(normPath));
  const protectedDirty = dirty.filter((p) => protect.has(normPath(p)));
  const unprotectedDirty = dirty.filter((p) => !protect.has(normPath(p)));
  if (protectedDirty.length) {
    try {
      git(projectRoot, ["add", "--", ...protectedDirty]);
      if (git(projectRoot, ["diff", "--cached", "--name-only"]).trim()) {
        git(projectRoot, ["commit", "-q", "-m", "OPC: protect run outputs before merge"]);
      }
    } catch { /* best effort:保护失败最多退化成下面的 conflict 判定 */ }
  }
  if (unprotectedDirty.length) {
    let touched: string[] = [];
    // 三点 diff:只列 worker 分支相对 merge-base 改的文件(= merge 真正会写入工作树的文件),
    // 避免把"HEAD 侧先行改动"误算成会覆盖脏文件。
    try { touched = git(projectRoot, ["diff", "--name-only", `HEAD...${wt.branch}`]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch { /* best effort */ }
    const touchedSet = new Set(touched.map(normPath));
    const overlap = unprotectedDirty.filter((p) => touchedSet.has(normPath(p)));
    if (overlap.length) {
      console.error(`[worktree] merge ${wt.branch} 将覆盖用户未入库文件,判 conflict(不强并): ${overlap.slice(0, 5).join(", ")}`);
      return { outcome: "conflict", conflictFiles: overlap };
    }
  }
  try {
    git(projectRoot, ["merge", "--no-edit", "-q", wt.branch]);
    return { outcome: "merged", conflictFiles: [] };
  } catch (e: any) {
    const stderr = String(e?.stderr?.toString?.() || e?.message || "");
    let conflictFiles: string[] = [];
    try { conflictFiles = git(projectRoot, ["diff", "--name-only", "--diff-filter=U"]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch { /* best effort */ }
    try { git(projectRoot, ["merge", "--abort"]); } catch { /* nothing to abort */ }
    if (!conflictFiles.length) {
      // merge 拒绝启动(would be overwritten)时无 diff-filter=U 现场,从 stderr 的缩进文件行兜底解析。
      conflictFiles = stderr.split(/\r?\n/).map((l) => (/^\t(.+)$/.exec(l)?.[1] ?? "").trim()).filter(Boolean);
    }
    console.error(`[worktree] merge ${wt.branch} → conflict(已 abort,保留分支与 worktree 供人工决裁): ${stderr.slice(0, 200)}`);
    return { outcome: "conflict", conflictFiles };
  }
}

// Discard a worktree's uncommitted changes (used to drop a failed attempt before retrying).
export function resetWorktree(wt: Worktree): void {
  if (!wt.isGit) return;
  try { git(wt.dir, ["checkout", "--", "."]); } catch { /* nothing tracked */ }
  try { git(wt.dir, ["clean", "-fd"]); } catch { /* nothing untracked */ }
}

export function removeWorktree(projectRoot: string, wt: Worktree): void {
  if (wt.scratch) { try { fs.rmSync(wt.dir, { recursive: true, force: true }); } catch { /* already gone */ } return; }
  if (!wt.isGit) return;
  try { git(projectRoot, ["worktree", "remove", "--force", wt.dir]); } catch { /* already gone */ }
  try { git(projectRoot, ["branch", "-D", wt.branch]); } catch { /* already gone */ }
}

// ── 波6 · 合并冲突人类决裁的 git 原语(execFileSync git,参数数组,绝不拼 shell) ──────────────

// 读某个冲突文件在 worker 分支与当前 HEAD 之间的真实 diff(决裁台"看看两侧差在哪")。
// `git diff <branch> HEAD -- <file>`:左=分支,右=HEAD——+ 行是 HEAD 侧、- 行是分支侧(采纳分支即取 - 行内容)。
export function readWorktreeConflictDiff(projectRoot: string, branch: string, file: string): string {
  try {
    return git(projectRoot, ["diff", branch, "HEAD", "--", file], 30000);
  } catch (e: any) {
    // diff 本身失败(分支已不存在等)→ 返回可读错误文本,不抛(决裁台单文件失败不该炸整页)。
    return `# diff 读取失败(${branch} -- ${file}): ${String(e?.stderr?.toString?.() || e?.message || e).slice(0, 300)}`;
  }
}

// 采纳 worker 分支:把分支合并进当前 HEAD,冲突处取分支侧(-X theirs)。这是【人工决裁】的显式动作
// (不是自动强并——自动路径仍绝不 -X theirs),故允许。成功返回 ok:true;失败返回 stderr 供路由 500。
export function adoptWorktreeBranch(projectRoot: string, branch: string): { ok: boolean; error?: string } {
  try {
    const ahead = git(projectRoot, ["rev-list", "--count", branch, "^HEAD"]).trim();
    if (ahead === "0") return { ok: true }; // 分支无新提交,视为已并
  } catch { /* 分支缺失等,交给下方 merge 报错 */ }
  try {
    git(projectRoot, ["merge", "--no-edit", "-X", "theirs", branch], 30000);
    return { ok: true };
  } catch (e: any) {
    try { git(projectRoot, ["merge", "--abort"]); } catch { /* nothing to abort */ }
    return { ok: false, error: String(e?.stderr?.toString?.() || e?.message || e).slice(0, 300) };
  }
}

// 决裁完成后按 branch+dir 清理 worktree/分支(调用方须在冲突已 resolved 后才调,见 conflictRoutes)。
export function removeWorktreeByBranch(projectRoot: string, branch: string, dir: string): void {
  try { git(projectRoot, ["worktree", "remove", "--force", dir]); } catch { /* already gone */ }
  try { git(projectRoot, ["branch", "-D", branch]); } catch { /* already gone */ }
}
