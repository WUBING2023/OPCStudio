import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { Company } from "@opc/shared";

export function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

// The company's root workspace folder: explicit company.folder, else <projectRoot>/.opc-studio/<slug>.
export function companyRootDir(projectRoot: string, company: Company): string {
  return company.folder && company.folder.trim() ? company.folder : path.join(projectRoot, ".opc-studio", slug(company.name || company.id));
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).toString();
}

// 五.2(收口作战令)· 脏树预检(纯函数,便于单测):解析 `git status --porcelain` 输出,排除 .opc 元数据
// (OPC 运行库,永远不该被当成用户脏文件),得到用户未提交/未跟踪文件清单。编码团队任务遇脏树须干净失败
// (block=true),避免 merge-back 覆盖用户未入库改动;非编码任务只如实记录、不拦(block=false)。
// rename 记录("XY old -> new")取目标路径;带引号的路径(core.quotepath)去引号。
export function evaluateDirtyPreflight(porcelain: string, requiresCode: boolean): {
  dirty: boolean;
  block: boolean;
  files: string[];
  fileCount: number;
} {
  const files = (porcelain || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      // porcelain 行: 2 位状态码 + 空格 + 路径。防御性地兼容无前导状态码的裸路径行。
      let p = /^[ MADRCU?!]{2}\s/.test(l) ? l.slice(3) : l.trim();
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      p = p.trim().replace(/^"(.*)"$/, "$1");
      return p;
    })
    .filter((p) => p.length > 0 && p !== ".opc" && !p.startsWith(".opc/"));
  const dirty = files.length > 0;
  return { dirty, block: dirty && requiresCode, files, fileCount: files.length };
}

// V0 · 曾有的 resolveWorkspace(agent.workspaceDir → 角色默认目录)已删除:它从无任何调用方(worker 执行路径
// 从不据 agent.workspaceDir 定 cwd,真实工作根是公司 workRoot + 每 worker 的 git worktree),留着只会让
// workspaceDir 看起来"已生效"实则是死代码。收口 workspaceDir 的产品含义:字段保留为声明式可移植配置(见
// types.ts 注释),但绝不再有伪装成"已生效"的解析器。未来做员工级目录须在 parallelExecutor 显式接线。

// Ensure a directory exists and is a git repo with at least one commit (so worktrees can branch).
// 收口③ V0 · 两种模式:
//   managed(缺省)= OPC 托管沙箱(.opc-studio/<slug>,或用户已显式确认"初始化为 OPC 托管工作区"
//     的目录):mkdir / git init / .gitignore / README / 首 commit。
//     MUP D3 收窄:首 commit **只 stage OPC 本次自建的文件**(README/.gitignore),绝不 `git add -A`
//     卷入目录里已有的用户文件;目录已有内容且无 OPC 新建文件可提交时,用空提交拿到 HEAD
//     (worktree 需要至少一个 commit 才能分支),用户文件保持未跟踪原样。
//   bound = 用户绑定的既有目录(Company.folder),零隐式初始化硬约束:目录必须已存在且有**自己的
//     .git + 首个 commit**,否则如实返回 false(调用方拒跑并引导用户显式确认初始化)。bound 模式
//     绝不 mkdir / git init / 写 .gitignore / 写 README / 建 commit;仅做两处 .git 目录内的本地
//     调整(不触碰工作树、不产生任何提交):① core.autocrlf/safecrlf=false(见下方幻影冲突注释);
//     ② .git/info/exclude 追加 .opc/(等价 .gitignore 的仓库本地私有版,不污染用户工作树)。
export function ensureGitRepo(dir: string, opts?: { mode?: "managed" | "bound" }): boolean {
  if ((opts?.mode ?? "managed") === "bound") return ensureBoundGitRepo(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // v4 E4 修隔离 bug：必须判断"本目录是否有自己的 .git"，而非 --is-inside-work-tree。
    // 后者在工作区嵌套于父仓库（如 M:\OPC）工作树内时会向上命中父仓库 → 跳过 init →
    // 工作区无独立 .git → 运行的 git 操作落到父仓库（污染风险）。改为检测自身 .git。
    const ownRepo = fs.existsSync(path.join(dir, ".git"));
    if (!ownRepo) {
      gitIn(dir, ["init", "-q"]);
      try {
        gitIn(dir, ["config", "user.email", "opc@studio.local"]);
        gitIn(dir, ["config", "user.name", "OPC"]);
      } catch { /* may be set globally */ }
    }
    // v4 #deliverable：关掉 CRLF 规范化。否则 Windows 上 autocrlf 会让已提交文件在 per-worker
    // worktree 里被视为"换行符已改"，与主检出 merge-back 时产生**幻影冲突** → 合法交付物被当冲突丢弃。
    // 同时把 .opc/（运行元数据 + worktree 目录）排除出版本控制，避免污染 git 操作。
    try {
      gitIn(dir, ["config", "core.autocrlf", "false"]);
      gitIn(dir, ["config", "core.safecrlf", "false"]);
    } catch { /* best effort */ }
    const opcCreated: string[] = [];
    try {
      const gi = path.join(dir, ".gitignore");
      const giExisted = fs.existsSync(gi);
      if (!giExisted || !fs.readFileSync(gi, "utf-8").includes(".opc/")) {
        // 收口③(安全):首次托管初始化的 .gitignore 除 .opc/ 外预置常见密钥/依赖/构建产物模式——目录里的
        // .env/密钥绝不进 git 历史。默认沙箱(.opc-studio)本就无这些文件,预置无害;用户目录则受保护。
        const block = [".opc/", ".env", ".env.*", "*.key", "*.pem", "*.p12", "*.pfx", "id_rsa", "id_ed25519", "node_modules/", ".DS_Store"].join("\n");
        fs.appendFileSync(gi, (giExisted ? "\n" : "") + block + "\n");
        // 用户已有的 .gitignore 只追加不 stage(不代用户提交其文件);OPC 全新创建的才进首 commit。
        if (!giExisted) opcCreated.push(".gitignore");
      }
    } catch { /* best effort */ }
    // ensure at least one commit —— MUP D3:绝不 add -A,首 commit 只含 OPC 自建文件。
    try { gitIn(dir, ["rev-parse", "HEAD"]); }
    catch {
      const readme = path.join(dir, "README.md");
      if (!fs.existsSync(readme)) { fs.writeFileSync(readme, "# OPC Studio workspace\n", "utf-8"); opcCreated.push("README.md"); }
      if (opcCreated.length) gitIn(dir, ["add", "--", ...opcCreated]);
      const staged = gitIn(dir, ["diff", "--cached", "--name-only"]).trim();
      gitIn(dir, staged
        ? ["commit", "-q", "-m", "OPC: init workspace"]
        : ["commit", "-q", "--allow-empty", "-m", "OPC: init workspace"]);
    }
    return true;
  } catch {
    return false;
  }
}

// bound 模式实现(见 ensureGitRepo 头注释)。所有写入都限定在 .git 目录内部,best-effort;
// 判定失败(目录不存在 / 无自有 .git / 无首 commit)如实返回 false,绝不代替用户初始化。
function ensureBoundGitRepo(dir: string): boolean {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    const gitDir = path.join(dir, ".git");
    if (!fs.existsSync(gitDir)) return false;
    try { gitIn(dir, ["rev-parse", "HEAD"]); } catch { return false; }

    try {
      // .git 是文件形式(worktree/submodule)时没有本仓库私有的 info/exclude 可写,跳过(best-effort)。
      if (fs.statSync(gitDir).isDirectory()) {
        const exclude = path.join(gitDir, "info", "exclude");
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
        if (!cur.includes(".opc/")) {
          fs.appendFileSync(exclude, (cur && !cur.endsWith("\n") ? "\n" : "") + ".opc/\n");
        }
      }
    } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}
