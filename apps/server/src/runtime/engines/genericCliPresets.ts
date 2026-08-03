import type { AgentFramework } from "@opc/shared";
import type { GenericCliConfig } from "./GenericCliEngine.js";

// 9 份"12+1 CLI 框架"扩展的开箱即用预设。每份都对应研究阶段确认过的真实调用方式(见各注释),
// GenericCliEngine 本身完全通用,这里只声明"这个工具怎么调"。
//
// 诚实声明(贯穿全文件):本机没有安装这 9 个工具中的任何一个二进制,所有 buildArgs/parseOutput 只经过
// 单元测试(用手写的、依据研究阶段真实 JSON schema 片段构造的 fixture)验证,没有做过真实 spawn 活体
// 验证——这与 ClaudeCodeEngine/CodexEngine 不同(那两个是在装了真实 CLI 的机器上活体验证过的)。

const MODEL_ARG_RE = /^[\w.\/:-]+$/;

// 只有形如"字母数字/.:_-"的模型名才会被塞进 args——这批工具大多走 shell:true 的 .cmd/.sh 包装,
// 未经清洗的自由文本可能被解释成多个参数(同 ClaudeCodeEngine 里 --model 的清洗理由)。
function modelFlag(flag: string, model?: string): string[] {
  return model && MODEL_ARG_RE.test(model) ? [flag, model] : [];
}

function envKeyFor(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function numOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

// 宽松 JSON 解析:先整段 parse;失败再退而求其次,抓最外层 "{" 到最后一个 "}" 之间的子串重试一次
// (部分 CLI 会在 JSON 前后混入一行两行非 JSON 的日志/警告)。都失败返回 undefined,调用方各自兜底。
function parseJsonBlob(text: string): any | undefined {
  const trimmed = (text || "").trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* give up */ }
  }
  return undefined;
}

// ── gemini-cli ───────────────────────────────────────────────────────────────────────────
// npm i -g @google/gemini-cli；命令 `gemini -p "<prompt>" --output-format json`。
// 认证 GEMINI_API_KEY。JSON 含 response/stats(token 用量)/error。退出码:0 成功/1 错误/42 参数错误/
// 53 达轮次上限——趋势一致视为 trustExitCode:true。已知历史上有非 TTY 环境卡死的 bug(多数已修，
// 2026 年仍有相关 PR 在跟)——GenericCliEngine 的 spawnCliWithRetry 自带超时兜底,不再单独处理。
export const GEMINI_CLI_PRESET: GenericCliConfig = {
  framework: "gemini-cli",
  command: "gemini",
  buildArgs: (prompt, opts) => ["-p", prompt, "--output-format", "json", ...modelFlag("-m", opts.model)],
  authEnvVar: "GEMINI_API_KEY",
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  notes: ["历史上在非 TTY 环境有卡死 bug 记录(多数版本已修复)"],
  parseOutput(stdout, stderr, exitCode) {
    const obj = parseJsonBlob(stdout);
    if (!obj) return { content: stdout.trim() || stderr.trim(), ok: exitCode === 0 && !!stdout.trim() };
    const errVal = obj.error;
    const content = pickString(obj.response, obj.result) ?? (errVal ? (typeof errVal === "string" ? errVal : JSON.stringify(errVal)) : "");
    const stats = obj.stats ?? {};
    const prompt_ = numOr(stats.promptTokens, stats.input_tokens, stats.inputTokens);
    const completion = numOr(stats.completionTokens, stats.output_tokens, stats.outputTokens);
    return {
      content,
      ok: !errVal && exitCode === 0,
      tokensUsed: prompt_ !== undefined || completion !== undefined ? { prompt: prompt_, completion } : undefined,
    };
  },
};

// ── qwen-code ────────────────────────────────────────────────────────────────────────────
// npm i -g @qwen-code/qwen-code(Node22+)；命令 `qwen -p "<prompt>" --output-format json`。
// 认证 DASHSCOPE_API_KEY 或 OPENAI_API_KEY+OPENAI_BASE_URL——两个候选名都塞同一个解析出的 secret。
// JSON 含 usage/is_error/duration_ms。退出码 0/42/53/55——trustExitCode:true。
// 注意:env 里任何 CI_* 前缀的变量(如 CI_TOKEN)会被误判成 CI 环境导致行为异常——spawn 前必须剔除。
export const QWEN_CODE_PRESET: GenericCliConfig = {
  framework: "qwen-code",
  command: "qwen",
  buildArgs: (prompt, opts) => ["-p", prompt, "--output-format", "json", ...modelFlag("-m", opts.model)],
  authEnvVar: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY"],
  stripEnvPrefixes: ["CI_"],
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  parseOutput(stdout, stderr, exitCode) {
    const obj = parseJsonBlob(stdout);
    if (!obj) return { content: stdout.trim() || stderr.trim(), ok: exitCode === 0 && !!stdout.trim() };
    const isError = !!obj.is_error;
    const content = pickString(obj.response, obj.result, obj.text, obj.output) ?? (isError ? "qwen-code reported an error" : "");
    const usage = obj.usage ?? {};
    const prompt_ = numOr(usage.input_tokens, usage.prompt_tokens, usage.promptTokens);
    const completion = numOr(usage.output_tokens, usage.completion_tokens, usage.completionTokens);
    return {
      content,
      ok: !isError && exitCode === 0,
      tokensUsed: prompt_ !== undefined || completion !== undefined ? { prompt: prompt_, completion } : undefined,
    };
  },
};

// ── opencode ─────────────────────────────────────────────────────────────────────────────
// curl -fsSL https://opencode.ai/install | bash 或 npm i -g opencode-ai@latest(anomalyco/opencode,
// 不是已归档的 opencode-ai/opencode Go 实现)。命令 `opencode run "<prompt>" --format json --auto`
// (--auto 或等效自动批准配置是必需的,否则非交互环境下 write/edit 默认被拒——issue #13851)。
// 已知 bug(#26855):JSON 流可能在最终 step_finish 事件写出前进程就提前退出——trustExitCode:false,
// 事件 schema 未逐一核实,parseOutput 用宽松的多字段名匹配 + "没有终态事件就不算成功"的保守判定。
// 已知 SIGHUP/孤儿进程问题——依赖 GenericCliEngine 统一的超时 kill 兜底。
export const OPENCODE_PRESET: GenericCliConfig = {
  framework: "opencode",
  command: "opencode",
  buildArgs: (prompt, opts) => ["run", prompt, "--format", "json", "--auto", ...modelFlag("--model", opts.model)],
  authEnvVar: (provider) => envKeyFor(provider),
  trustExitCode: false,
  versionProbeArgs: ["--version"],
  notes: [
    "稳定性较弱:已知 JSON 流可能在完成前提前退出(#26855),退出码不可信,建议谨慎用于生产任务",
  ],
  parseOutput(stdout, stderr) {
    let content = "";
    let sawFinish = false;
    let sawError = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      const kind = ev.type ?? ev.event;
      const text = pickString(ev.text, ev.message, ev?.part?.text, ev?.content);
      if (text) content = content ? `${content}\n${text}` : text;
      if (kind === "step_finish" || kind === "session.idle" || kind === "done") sawFinish = true;
      if (kind === "error" || ev.error) { sawError = true; if (!text) content = content || pickString(ev.error?.message, ev.error) || "opencode error"; }
    }
    if (sawError) return { content, ok: false };
    if (sawFinish) return { content, ok: !!content };
    // 没读到清晰的终态事件(#26855 的已知症状):有部分文本就降级使用(标记为可能不完整),完全没有
    // 任何可用内容才判失败——不能因为流不完整就假装成功,也不该把已经拿到的产出白白丢弃。
    if (content.trim()) return { content: `${content}\n\n[警告:未读到完整的结束事件,以上内容可能不完整]`, ok: true };
    return { content: content || stderr.trim(), ok: false };
  },
};

// ── aider ────────────────────────────────────────────────────────────────────────────────
// pip install aider-chat；命令 `aider --message "<prompt>" --yes-always --no-pretty --no-stream`。
// 认证走各家 {PROVIDER}_API_KEY 环境变量(取决于选的模型)。无 JSON 输出,纯文本 stdout 即 content。
// 退出码文档未明确承诺,trustExitCode:true 但不细分错误类型——非 0 一律当失败。
export const AIDER_PRESET: GenericCliConfig = {
  framework: "aider",
  command: "aider",
  buildArgs: (prompt, opts) => ["--message", prompt, "--yes-always", "--no-pretty", "--no-stream", ...modelFlag("--model", opts.model)],
  authEnvVar: (provider) => envKeyFor(provider),
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  parseOutput(stdout, stderr, exitCode) {
    return { content: stdout.trim() || stderr.trim(), ok: exitCode === 0 };
  },
};

// ── goose ────────────────────────────────────────────────────────────────────────────────
// aaif-goose/goose(已从 block/goose 迁移)释出的 download_cli.sh。命令
// `goose run --no-session -t "<prompt>" --output-format json --max-turns 1`(必须显式给较小的
// --max-turns,默认 1000 太危险)。认证 GOOSE_PROVIDER + GOOSE_MODEL + 对应 {PROVIDER}_API_KEY。
// ⚠️ 已知确认的严重 bug(#4612):即使 LLM 报错,退出码依然是 0——trustExitCode 必须 false,
// parseOutput 必须去解析 JSON 内容本身有没有错误标志,绝不能信任 exitCode===0。
export const GOOSE_PRESET: GenericCliConfig = {
  framework: "goose",
  command: "goose",
  buildArgs: (prompt) => ["run", "--no-session", "-t", prompt, "--output-format", "json", "--max-turns", "1"],
  authEnvVar: (provider) => envKeyFor(provider),
  extraEnv: (node) => ({ GOOSE_PROVIDER: node.provider, ...(node.model ? { GOOSE_MODEL: node.model } : {}) }),
  trustExitCode: false,
  versionProbeArgs: ["--version"],
  notes: ["已知 bug #4612:即使 LLM 报错,进程退出码依然是 0——本引擎不信任退出码,只信 JSON 内容里的错误标志"],
  parseOutput(stdout, stderr) {
    const obj = parseJsonBlob(stdout);
    if (!obj) {
      // 解析不出 JSON 时没有任何可信的成功信号来源(退出码本就不可信)——保守判失败。
      return { content: stdout.trim() || stderr.trim(), ok: false };
    }
    const errorFlag = obj.error != null || obj.is_error === true || obj.success === false || obj.status === "error";
    const content = pickString(obj.response, obj.result, obj.output, obj.text) ?? JSON.stringify(obj).slice(0, 2000);
    return { content, ok: !errorFlag };
  },
};

// ── openhands ────────────────────────────────────────────────────────────────────────────
// pip install openhands(新包名,基于 Software Agent SDK 重写——不是强依赖 Docker 的旧包 openhands-ai)。
// 命令 `openhands --headless --task "<prompt>" --always-approve --json`。认证环境变量
// LLM_API_KEY/LLM_MODEL 默认被忽略,必须加 --override-with-envs 才生效(最容易踩的坑)。
// 退出码文档明确:0 成功/1 错误或任务失败/2 参数无效——trustExitCode:true。
export const OPENHANDS_PRESET: GenericCliConfig = {
  framework: "openhands",
  command: "openhands",
  buildArgs: (prompt) => ["--headless", "--task", prompt, "--always-approve", "--json", "--override-with-envs"],
  authEnvVar: "LLM_API_KEY",
  extraEnv: (node) => {
    const out: Record<string, string> = {};
    if (node.model) out.LLM_MODEL = node.model;
    return out;
  },
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  parseOutput(stdout, stderr, exitCode) {
    // JSONL 事件流;取最后一条能提取出文本的事件 + 扫描是否有显式 error 事件(即便 exitCode===0 也可能
    // 混有工具级错误事件,双重信号比单信任 exitCode 更稳妥)。
    let content = "";
    let sawError = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      const text = pickString(ev.content, ev.message, ev.text, ev?.observation, ev?.action);
      if (text) content = text; // 取最后一条(累计式事件流,后面的通常是更完整的汇总)
      if (ev.error || ev.type === "error" || ev.status === "error") sawError = true;
    }
    return { content: content || stdout.trim() || stderr.trim(), ok: exitCode === 0 && !sawError };
  },
};

// ── amp ──────────────────────────────────────────────────────────────────────────────────
// curl -fsSL https://ampcode.com/install.sh | bash。命令 `amp -x "<prompt>" --stream-json`
// (-x/--execute 是关键,不加会被当交互会话首条消息处理)。认证 AMP_API_KEY(优先于 OAuth 登录态)。
// NDJSON 流;result 类型消息里的 is_error 字段才是权威成功/失败判断——进程退出码本身未文档化,
// trustExitCode:false。result.usage 含 token 用量。
export const AMP_PRESET: GenericCliConfig = {
  framework: "amp",
  command: "amp",
  buildArgs: (prompt) => ["-x", prompt, "--stream-json"],
  authEnvVar: "AMP_API_KEY",
  trustExitCode: false,
  versionProbeArgs: ["--version"],
  parseOutput(stdout, stderr) {
    let textAccum = "";
    let resultContent: string | undefined;
    let isError = false;
    let sawResult = false;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      const kind = ev.type ?? ev.kind;
      if (kind === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block?.type === "text" && typeof block.text === "string") textAccum += block.text;
        }
      } else if (kind === "result") {
        sawResult = true;
        isError = !!ev.is_error;
        if (typeof ev.result === "string") resultContent = ev.result;
        const u = ev.usage;
        if (u) { promptTokens = numOr(u.input_tokens, u.prompt_tokens); completionTokens = numOr(u.output_tokens, u.completion_tokens); }
      }
    }
    const content = resultContent ?? textAccum;
    // 没有读到权威的 result 事件(流可能被截断)——trustExitCode 已经是 false,没有别的成功信号来源,
    // 不能假装成功;仍然把已抓到的文本带出去,方便排查,但状态标 failed。
    if (!sawResult) return { content: content || stderr.trim(), ok: false };
    return {
      content,
      ok: !isError,
      tokensUsed: promptTokens !== undefined || completionTokens !== undefined ? { prompt: promptTokens, completion: completionTokens } : undefined,
    };
  },
};

// ── plandex ──────────────────────────────────────────────────────────────────────────────
// curl -sL https://plandex.ai/install.sh | bash(Windows 需 WSL)。命令需要显式开全自动:
// `plandex tell "<prompt>" --apply --auto-exec --debug`。认证走各厂商 {PROVIDER}_API_KEY。
// ⚠️ 已知阻塞性问题(issue #297 未解决):首次运行有一个 TTY-only 的交互式登录/host 选择步骤,没有
// 文档化的命令行参数可以跳过——意味着这个框架第一次使用前需要用户手动跑一次 `plandex sign-in`
// 完成初始化,没法在 OPC 里做到"选中就能直接自动化跑"。无 JSON 输出,纯文本;退出码未文档化,保守
// 当 0/非 0 处理(不细分)。
export const PLANDEX_PRESET: GenericCliConfig = {
  framework: "plandex",
  command: "plandex",
  buildArgs: (prompt) => ["tell", prompt, "--apply", "--auto-exec", "--debug"],
  authEnvVar: (provider) => envKeyFor(provider),
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  notes: [
    "首次使用前需手动在终端运行一次「plandex sign-in」完成初始化(已知问题 #297,无文档化的非交互登录参数)",
    "Windows 上需要 WSL(官方安装脚本为 curl | bash)",
  ],
  parseOutput(stdout, stderr, exitCode) {
    return { content: stdout.trim() || stderr.trim(), ok: exitCode === 0 };
  },
};

// ── open-interpreter ─────────────────────────────────────────────────────────────────────
// PyPI 包 open-interpreter 已 20 个月未更新(项目主线已用 Rust 重写成完全不同的东西)。CLI 层面一次性
// 执行的确切语法没有查证到官方文档——这里用 `interpreter -y "<prompt>"` 作为尝试性命令行(-y 是文档
// 确认过的"跳过确认自动执行"参数,能确认的信息只到这里)。
// ⚠️ 风险:open-interpreter 默认真实执行本机代码/shell 命令,无沙箱——这不是"某个功能的风险"，
// 是这个工具的核心工作方式,必须在 UI 上给用户醒目提示(见 apps/web/src/lib/framework.ts)。
// 无 JSON 输出;认证机制未确认,不假设固定的 env var 名字(authEnvVar 留空——用户需要自行在系统里
// 配好该工具要求的环境变量,OPC 这边现阶段无法帮它注入)。
export const OPEN_INTERPRETER_PRESET: GenericCliConfig = {
  framework: "open-interpreter",
  command: "interpreter",
  buildArgs: (prompt, opts) => ["-y", prompt, ...modelFlag("--model", opts.model)],
  trustExitCode: true,
  versionProbeArgs: ["--version"],
  notes: [
    "CLI 接口未完全确认(项目 20 个月未更新,主线已转向 Rust 重写)——当前实现为尽力而为的保守版本",
    "⚠️ 默认真实执行本机代码/shell 命令,无沙箱隔离,谨慎用于生产任务",
  ],
  parseOutput(stdout, stderr, exitCode) {
    return { content: stdout.trim() || stderr.trim(), ok: exitCode === 0 };
  },
};

export const GENERIC_CLI_PRESETS: Partial<Record<AgentFramework, GenericCliConfig>> = {
  "gemini-cli": GEMINI_CLI_PRESET,
  "qwen-code": QWEN_CODE_PRESET,
  "opencode": OPENCODE_PRESET,
  "aider": AIDER_PRESET,
  "goose": GOOSE_PRESET,
  "openhands": OPENHANDS_PRESET,
  "amp": AMP_PRESET,
  "plandex": PLANDEX_PRESET,
  "open-interpreter": OPEN_INTERPRETER_PRESET,
};
