import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// 收口③ · 工作目录设置 V0 —— 公司主工作目录的全套安全检查(绑定端点与 run 起跑共用同一份口径):
//   ① 路径穿越:词法拒绝含 ".." 段的输入(realpath 之前的防御纵深);
//   ② realpath:目录必须真实存在,软链归一成 canonical 绝对路径(冻结进 task.json 的就是它);
//   ③ 允许根:禁盘符/文件系统根、禁系统目录(Windows/Program Files 或 /etc /usr 等)及其内部、
//      禁家目录本身(子目录允许)、禁 app 自己的 .opc 元数据库内部;
//   ④ 读写:一次性探针文件真写真删(同 globalDoctor.checkDirWritable 思路);
//   ⑤ 可用磁盘:statfsSync 可用时要求 ≥ MIN_FREE_DISK_BYTES(API 缺失/失败按 best-effort 跳过,
//      磁盘检查是辅助护栏,不能因为平台差异把合法目录全拒掉)。
// 检查通过后如实报告 Git 状态:needsInit=true(无自有 .git,或有 .git 但没有首个 commit)时,
// 绑定/起跑侧**必须**要求用户显式确认"初始化为 OPC 托管工作区"——本模块只探测、绝不 git init。

export type FolderRejectCode =
  | "empty"
  | "not_absolute"
  | "traversal"
  | "not_found"
  | "not_directory"
  | "forbidden_root"
  | "not_writable"
  | "low_disk";

export interface FolderCheck {
  ok: boolean;
  /** canonical 绝对路径(realpathSync 归一后);ok=true 时必有 */
  realPath?: string;
  /** 目录有**自己的** .git(不认父仓库,语义同 workspace.ts ensureGitRepo 的自有 .git 判定) */
  isGitRepo?: boolean;
  /** isGitRepo 且有 HEAD(至少一个 commit,worktree 隔离的前提) */
  hasCommit?: boolean;
  /** true = 需要用户显式确认"初始化为 OPC 托管工作区"后才能作为工作目录使用 */
  needsInit?: boolean;
  code?: FolderRejectCode;
  error?: string;
}

// 最低可用磁盘:低于此值连一次编码 run 的 worktree + 产物都放不下,拒绝绑定比中途写盘失败诚实。
export const MIN_FREE_DISK_BYTES = 200 * 1024 * 1024;

const isWin = process.platform === "win32";

function normKey(p: string): string {
  const n = path.resolve(p).replace(/[\\/]+$/, "");
  return isWin ? n.toLowerCase() : n;
}

// target 是否等于 base 或位于 base 内部(大小写按平台语义,词法比较,输入应已 realpath 归一)。
export function isSameOrInside(target: string, base: string): boolean {
  const t = normKey(target);
  const b = normKey(base);
  return t === b || t.startsWith(b + path.sep);
}

// 禁止"等于或位于其内部"的系统目录清单(平台相关,允许根黑名单式口径:本地单用户桌面工具,
// 除系统敏感面外全盘可绑,与 fileRoutes 的 D5 浏览口径一致)。
function forbiddenSystemDirs(): string[] {
  if (isWin) {
    return [
      process.env.WINDIR || "C:\\Windows",
      process.env.ProgramFiles || "C:\\Program Files",
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      process.env.ProgramData || "C:\\ProgramData",
    ];
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/proc", "/sys", "/dev", "/var"];
}

function reject(code: FolderRejectCode, error: string): FolderCheck {
  return { ok: false, code, error };
}

export function validateWorkspaceFolder(projectRoot: string, rawFolder: string): FolderCheck {
  const raw = (rawFolder ?? "").trim();
  if (!raw) return reject("empty", "工作目录不能为空");
  if (!path.isAbsolute(raw)) return reject("not_absolute", "工作目录必须是绝对路径");
  // 词法穿越防御:realpath 之前先拒 ".."(防御纵深,不依赖后续解析)。
  if (raw.split(/[\\/]+/).includes("..")) return reject("traversal", "路径不允许包含 .. 段");

  let st: fs.Stats;
  try {
    st = fs.statSync(raw);
  } catch {
    return reject("not_found", `目录不存在:${raw}`);
  }
  if (!st.isDirectory()) return reject("not_directory", `不是目录:${raw}`);

  let realPath: string;
  try {
    realPath = fs.realpathSync(raw);
  } catch {
    return reject("not_found", `无法解析真实路径:${raw}`);
  }

  // 允许根检查(都基于 realpath 后的 canonical 路径,软链指进系统目录同样拦得住)。
  const parsedRoot = path.parse(realPath).root;
  if (normKey(realPath) === normKey(parsedRoot)) {
    return reject("forbidden_root", "不允许把文件系统根/盘符根设为工作目录");
  }
  if (normKey(realPath) === normKey(os.homedir())) {
    return reject("forbidden_root", "不允许把用户主目录本身设为工作目录(请选择其中的子目录)");
  }
  // 系统临时区豁免系统目录黑名单:macOS 的 os.tmpdir() 在 /var 下,实验/演练把工作区放 tmp 是
  // 合法用法(也是测试基建的落点),不能被 /var 这类粗粒度黑名单误伤。
  let inTmp = false;
  try { inTmp = isSameOrInside(realPath, fs.realpathSync(os.tmpdir())); } catch { /* best effort */ }
  if (!inTmp) {
    for (const sys of forbiddenSystemDirs()) {
      if (isSameOrInside(realPath, sys)) {
        return reject("forbidden_root", `不允许把系统目录设为工作目录:${sys}`);
      }
    }
  }
  const appMetaDir = path.join(projectRoot, ".opc");
  if (isSameOrInside(realPath, appMetaDir)) {
    return reject("forbidden_root", "不允许把 OPC 元数据目录(.opc)设为工作目录");
  }

  // 读写探针:真写真删一次(探针名刻意不含 ".opc",与元数据库无关)。
  const probe = path.join(realPath, `.workspace-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
  } catch {
    try { fs.rmSync(probe, { force: true }); } catch { /* 清理失败不影响判定 */ }
    return reject("not_writable", `目录不可写:${realPath}`);
  }

  // 可用磁盘(best-effort:statfsSync Node ≥18.15;不可用/失败不拦——护栏不能变成新的失败面)。
  try {
    const statfsSync = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync;
    if (typeof statfsSync === "function") {
      const sfs = statfsSync(realPath);
      const free = Number(sfs.bavail) * Number(sfs.bsize);
      if (Number.isFinite(free) && free < MIN_FREE_DISK_BYTES) {
        return reject("low_disk", `磁盘可用空间不足(剩余 ${(free / 1024 / 1024).toFixed(0)}MB,至少需要 ${(MIN_FREE_DISK_BYTES / 1024 / 1024).toFixed(0)}MB)`);
      }
    }
  } catch { /* best effort */ }

  // Git 状态探测(只探测,绝不初始化)。自有 .git 判定同 ensureGitRepo:不认父仓库。
  const isGitRepo = fs.existsSync(path.join(realPath, ".git"));
  let hasCommit = false;
  if (isGitRepo) {
    try {
      execSync("git rev-parse HEAD", { cwd: realPath, stdio: "pipe" });
      hasCommit = true;
    } catch { hasCommit = false; }
  }

  return { ok: true, realPath, isGitRepo, hasCommit, needsInit: !isGitRepo || !hasCommit };
}
