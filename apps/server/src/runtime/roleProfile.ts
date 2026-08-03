// WS1 · 执行边界 / Role Profile（§8 Phase 1）
// 将角色契约编译成可执行 profile：写入范围 / shell 权限 / 网络 / 工作区配额 / 停止前 flush。
// 独立 dormant 模块，不改 parallelExecutor / worktree；Phase 1 再接入 engineRouter / workspace 侧。

// shell 执行权限档位：none = 完全禁止；allowlist = 只允许预定义指令集；full = 无限制。
export type ShellMode = "none" | "allowlist" | "full";

// 网络访问档位：off = 完全断网；limited = 只允许 DDG /白名单 API；on = 完全开放。
export type NetworkMode = "off" | "limited" | "on";

// 进程停止前 flush 配置。防止"超时 → 零产出"。
export interface PreStopFlush {
  // 软超时（毫秒）：到期后 orchestrator 强制写 finalize.md；agent 在此之前可自主完成。
  softTimeoutMs: number;
  // 硬超时（毫秒）：到期前 salvage 最后 stdout/partial → partial.md，然后杀子进程。
  // 必须 > softTimeoutMs。
  hardTimeoutMs: number;
  // 是否在 flush 时把 output/ 下所有工件提交到 ArtifactStore。
  flushArtifacts: boolean;
}

// 角色执行边界契约。字段含义见 PLAN WS1 §8。
export interface RoleProfile {
  id: string;
  // 允许写入的文件后缀白名单（以 "." 开头，如 ".md"）；空数组 = 禁止任何写入。
  allowedExtensions: string[];
  // 宿主侧强制禁止读写的路径 glob 模式列表（如 "**/.env" / "**/secrets/**"）。
  blockedGlobs: string[];
  // 工作区磁盘上限（字节）。
  maxWorkspaceBytes: number;
  // 工作区文件数量上限（含子目录下所有文件）。
  maxFiles: number;
  // 目录最大深度（根 = 0）。防止深路径 ENAMETOOLONG（§4 根因）。
  maxDepth: number;
  // 单个文件名最大字节数（UTF-8 编码长度）。Windows MAX_PATH=260 的保护层之一。
  maxFilenameBytes: number;
  shellMode: ShellMode;
  networkMode: NetworkMode;
  // 允许注入给 agent 子进程的环境变量名单；其余全过滤，防凭据泄漏。
  envAllowlist: string[];
  preStopFlush: PreStopFlush;
  // 该角色单个任务的硬时限(毫秒)。通宵实验实证:深度研究 worker 200s 全灭、360s 仍 3/5 超时 → 研究类需要
  // 显著长于全局默认;而 fact_checker/verifier 拖太久反而拖垮主 run。当 config/env 未显式统一指定超时(
  // OPC_TASK_TIMEOUT_MS / budget.taskTimeoutMs)时,parallelExecutor 按角色取此值。
  taskTimeoutMs: number;
}

// ── 预设 profile 表 ───────────────────────────────────────────────────────────

// §4 首个 profile：研究 worker 专用。
// 只能写 output/*.md 和 output/*.json；禁建环境；短路径严控磁盘。
export const research_profile_v1: RoleProfile = {
  id: "research_profile_v1",
  allowedExtensions: [".md", ".json"],
  blockedGlobs: [
    "**/.env",
    "**/secrets/**",
    "**/keys/**",
    "**/.git/**",
    "**/node_modules/**",
    // 防止研究 worker 建 Python / Node 环境（§4 根因路径）
    "**/*.py",
    "**/*.sh",
    "**/*.exe",
    "**/*.bat",
  ],
  maxWorkspaceBytes: 32 * 1024 * 1024,   // 32 MB
  maxFiles: 500,
  maxDepth: 6,
  maxFilenameBytes: 128,
  shellMode: "allowlist",
  networkMode: "limited",
  envAllowlist: ["HOME", "TMPDIR", "TMP", "TEMP", "PATH", "LANG", "LC_ALL"],
  preStopFlush: {
    softTimeoutMs: 120_000,   // 2 min：到期强制写 finalize.md
    hardTimeoutMs: 170_000,   // ~2.8 min：到期前 salvage partial → partial.md
    flushArtifacts: true,
  },
  taskTimeoutMs: 600_000,     // 10 min：深度研究实测单 worker 常 >360s(通宵实验)
};

// 事实核查 profile：写入范围同研究，但 shell 全禁、磁盘更小。
// 设计意图：fact_checker 只需网络检索 + 文本产出，不应执行任何系统命令。
export const fact_check_profile_v1: RoleProfile = {
  id: "fact_check_profile_v1",
  allowedExtensions: [".md", ".json"],
  blockedGlobs: [
    "**/.env",
    "**/secrets/**",
    "**/keys/**",
    "**/.git/**",
    "**/node_modules/**",
    "**/*.py",
    "**/*.sh",
    "**/*.exe",
    "**/*.bat",
  ],
  maxWorkspaceBytes: 16 * 1024 * 1024,   // 16 MB
  maxFiles: 300,
  maxDepth: 5,
  maxFilenameBytes: 128,
  shellMode: "none",                       // 完全禁止 shell，防建环境
  networkMode: "limited",
  envAllowlist: ["HOME", "TMPDIR", "TMP", "TEMP", "PATH", "LANG", "LC_ALL"],
  preStopFlush: {
    softTimeoutMs: 90_000,    // 1.5 min
    hardTimeoutMs: 150_000,   // 2.5 min
    flushArtifacts: true,
  },
  // Bug 修复(端到端验证抓出):研究团队真实验证里,单一事实核查员顺序审 4-5 份产出撑不住 6 分钟预算,
  // 超时后有产出未被核查(判定"verifier 无产出")→ lead 无实质产出可综合 → 整体降级归零。适度上调到 7 分钟
  // (不是取消"核查要比研究快"这条设计取舍——受现有排序契约约束,必须严格小于 lead_profile_v1 的 8 分钟,
  // 已在 timeoutSalvage.test.ts 里断言;7 分钟仍比原 6 分钟有实质余量,也仍明显快于研究员的 10 分钟)。
  taskTimeoutMs: 420_000,     // 7 min:核查不该拖垮主 run,但审多个producer需要余量(通宵实验后的新证据)
};

// Lead profile：读全 run workspace，有限写计划文件（.md / .json / .yaml）。
// 负责拆解 / 汇总 / revision，需要联网查 OPC 社区 / 外部 API。
export const lead_profile_v1: RoleProfile = {
  id: "lead_profile_v1",
  allowedExtensions: [".md", ".json", ".txt", ".yaml", ".yml"],
  blockedGlobs: [
    "**/.env",
    "**/secrets/**",
    "**/keys/**",
    "**/node_modules/**",
  ],
  maxWorkspaceBytes: 64 * 1024 * 1024,   // 64 MB
  maxFiles: 2_000,
  maxDepth: 10,
  maxFilenameBytes: 200,
  shellMode: "allowlist",
  networkMode: "on",
  envAllowlist: [
    "HOME", "TMPDIR", "TMP", "TEMP", "PATH", "LANG", "LC_ALL",
    "NODE_ENV",
  ],
  preStopFlush: {
    softTimeoutMs: 150_000,   // 2.5 min
    hardTimeoutMs: 200_000,   // 3.3 min
    flushArtifacts: true,
  },
  taskTimeoutMs: 480_000,     // 8 min：拆解/汇总层,允许比核查略久
};

// 代码任务 profile：可改 workspace/ 代码、跑测试。磁盘最宽松。
// 对应后续代码任务角色（dev / coder）；shell 权限最高。
export const code_profile_v1: RoleProfile = {
  id: "code_profile_v1",
  allowedExtensions: [
    ".ts", ".js", ".tsx", ".jsx",
    ".json", ".jsonc",
    ".md", ".txt",
    ".yaml", ".yml",
    ".py", ".sh", ".toml", ".lock",
    ".css", ".html",
  ],
  blockedGlobs: [
    "**/.env",
    "**/secrets/**",
    "**/keys/**",
  ],
  maxWorkspaceBytes: 256 * 1024 * 1024,  // 256 MB
  maxFiles: 10_000,
  maxDepth: 20,
  maxFilenameBytes: 240,                  // 接近 Windows MAX_PATH 单段上限留裕量
  shellMode: "full",
  networkMode: "on",
  envAllowlist: [
    "HOME", "TMPDIR", "TMP", "TEMP", "PATH", "LANG", "LC_ALL",
    "NODE_ENV", "NODE_PATH", "npm_config_cache",
    "PNPM_HOME", "CARGO_HOME", "GOPATH",
  ],
  preStopFlush: {
    softTimeoutMs: 180_000,   // 3 min
    hardTimeoutMs: 250_000,   // ~4.2 min
    flushArtifacts: true,
  },
  taskTimeoutMs: 720_000,     // 12 min：写码+跑测试合法地慢,但须有 diff/测试进展(质量门把关)
};

// 所有预设 profile 的索引表（id → profile）。方便按 id 快速查找。
export const PROFILES: Record<string, RoleProfile> = {
  research_profile_v1,
  fact_check_profile_v1,
  lead_profile_v1,
  code_profile_v1,
};

// ── 角色映射 ──────────────────────────────────────────────────────────────────

// role 名 → profile id 映射表。单向确定性映射，便于单测和静态分析。
const ROLE_PROFILE_MAP: Record<string, string> = {
  // 研究相关
  researcher:    "research_profile_v1",
  research:      "research_profile_v1",
  worker:        "research_profile_v1",   // 通用 worker 走最严格的研究 profile

  // 事实核查
  fact_checker:  "fact_check_profile_v1",
  fact_check:    "fact_check_profile_v1",
  "fact-check":  "fact_check_profile_v1",

  // 编排 / 汇总层
  lead:          "lead_profile_v1",
  ceo:           "lead_profile_v1",       // CEO 和 lead 同属编排层
  integrator:    "lead_profile_v1",

  // 代码任务层
  dev:           "code_profile_v1",
  coder:         "code_profile_v1",
  code:          "code_profile_v1",

  // Stage 7 · Product/Coding 团队角色
  test:            "code_profile_v1",   // 跑测试需 shell
  tester:          "code_profile_v1",
  reviewer:        "code_profile_v1",   // 读码做评审
  code_reviewer:   "code_profile_v1",
  "code-reviewer": "code_profile_v1",
  security:        "code_profile_v1",
  security_reviewer: "code_profile_v1",
  pm:              "research_profile_v1", // 写 PRD/规格,无需 shell
  product:         "research_profile_v1",
  architect:       "code_profile_v1",   // 出 scaffold
};

// 未知角色的兜底 profile（最保守）。
const FALLBACK_PROFILE_ID = "research_profile_v1";

// 根据角色名返回对应 RoleProfile。未知角色兜底为 research_profile_v1（最保守）。
// 调用方不应依赖 ROLE_PROFILE_MAP 内部结构；统一走此函数。
export function getProfileForRole(role: string): RoleProfile {
  const profileId = ROLE_PROFILE_MAP[role] ?? FALLBACK_PROFILE_ID;
  // PROFILES 中一定存在（静态注册），此处 ! 断言安全。
  return PROFILES[profileId]!;
}

// ── A1-V3 运行时护栏:文件写入判定 ────────────────────────────────────────────
// 把 allowedExtensions / blockedGlobs 从"纯数据定义"变成可执行判定。调用方(parallelExecutor)
// 在 worker 产出进入交付链(commit / merge / scratch 读回)之前用它筛掉违规文件——拦截而非事后警告。
// 纯函数、无 IO,方便单测。向后兼容铁则:字段缺省(undefined)= 全放行。

export type FileBlockRule = "blocked_glob" | "extension_not_allowed";

export interface FileGuardVerdict {
  allowed: boolean;
  rule?: FileBlockRule;
  detail?: string; // 命中的 glob / 后缀白名单说明(给结构化事件用,人类可读)
}

// 极简 glob → RegExp:只支持 ** / * / ?,足以覆盖 profile 里用到的全部模式。
// 统一 posix 分隔符;大小写不敏感(Windows 主场,.PY 与 .py 同罪)。"**/" 匹配零个或多个目录层。
export function globToRegExp(glob: string): RegExp {
  const norm = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

// 单文件判定:① blockedGlobs 命中即拦(deny 优先;缺省/空数组 = 不设禁区)。
// ② allowedExtensions:undefined = 全放行(缺省);空数组 = 禁止任何写入(见字段注释);
//    否则按后缀白名单,无后缀文件(如 Dockerfile)不在白名单内 → 拦。
export function checkFileAllowed(
  profile: Pick<RoleProfile, "allowedExtensions" | "blockedGlobs">,
  relPath: string,
): FileGuardVerdict {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  for (const glob of profile.blockedGlobs ?? []) {
    if (globToRegExp(glob).test(norm)) {
      return { allowed: false, rule: "blocked_glob", detail: `命中禁写模式 ${glob}` };
    }
  }
  const exts = profile.allowedExtensions;
  if (exts == null) return { allowed: true };
  const m = norm.match(/(\.[^./]+)$/);
  const ext = m ? m[1].toLowerCase() : "";
  if (!exts.some((e) => e.toLowerCase() === ext)) {
    return {
      allowed: false,
      rule: "extension_not_allowed",
      detail: ext ? `后缀 ${ext} 不在写入白名单 [${exts.join(", ")}]` : `无后缀文件不在写入白名单 [${exts.join(", ")}]`,
    };
  }
  return { allowed: true };
}

// ── A1-V3 运行时护栏:shell 指令判定 ─────────────────────────────────────────
// 把 shellMode 从"纯数据定义"变成可执行判定。调用方(tools.runShell)在全局 allowShell
// 开关之外叠加角色档位:none 全禁;allowlist 只放行预定义指令首词;full 不限。
// 注意:首词判定是治理护栏,不是安全沙箱——node/python 一旦放行即可执行任意逻辑;
// 凭据隔离靠 envAllowlist(filteredSpawnEnv),文件落地靠 checkFileAllowed,各司其职。

export interface ShellGuardVerdict {
  allowed: boolean;
  detail?: string;
}

// allowlist 档位放行的指令首词(大小写不敏感)。保守起步:解释器/包管理器/只读检索类。
// 需要扩面时改这份数据,不要松 checkShellAllowed 的逻辑。
export const SHELL_ALLOWLIST_COMMANDS: readonly string[] = [
  "node", "npx", "python", "python3", "pip",
  "git", "ls", "dir", "cat", "type", "echo", "pwd",
  "grep", "findstr", "head", "tail", "wc",
];

// 复合命令按 && / || / ; / | / 换行拆段,每段首词都要过白名单(防 `echo x && del y` 搭车)。
export function checkShellAllowed(
  profile: Pick<RoleProfile, "shellMode">,
  command: string,
): ShellGuardVerdict {
  if (profile.shellMode === "full") return { allowed: true };
  if (profile.shellMode === "none") {
    return { allowed: false, detail: "角色 shell 档位为 none,禁止一切 shell 执行" };
  }
  const segments = command.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { allowed: false, detail: "空命令" };
  for (const seg of segments) {
    const head = seg.split(/\s+/)[0]!.toLowerCase();
    if (!SHELL_ALLOWLIST_COMMANDS.includes(head)) {
      return { allowed: false, detail: `指令 ${head} 不在 allowlist 档位白名单内` };
    }
  }
  return { allowed: true };
}
