import type { AgentNodeConfig, FileChange, DeferredTask, ExecContext, ExecTask, ExecResult, QualityGateResult } from "@opc/shared";
import { validateAgentWorkingDirectory } from "@opc/shared";
import { resolveSafe, resolveSafeRead, resolveSafeWrite } from "../security/pathGuard.js";
import { Semaphore } from "./pool/semaphore.js";
import type { Scheduler } from "./pool/accountTypes.js";
import { runQualityGate, type GateBaseline } from "./qualityGate.js";
import type { QualityGateResultEventPayload } from "./qualityGateOrchestrator.js";
import { createWorktree, createScratchDir, commitWorktree, mergeWorktree, removeWorktree, resetWorktree, isGitRepo, type Worktree } from "./worktree.js";
import { recordConflict } from "../storage/conflictStore.js";
import { loadConfig } from "../storage/projectStore.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProfileForRole, checkFileAllowed, type FileBlockRule } from "./roleProfile.js";
import { diffFileChanges, discardFileChanges } from "./fileChanges.js";
import { parseResetTime } from "./rateLimitCooldown.js";
import { appendWorkerStartupDiagnostic } from './workerStartupDiagnostics.js';

// P0-4 · 声明式测试路径:*.test.* / *.spec.* / (tests|__tests__)/**。verifier 的新建【仅】允许这类路径,
// 新建其它路径(=创造被验证的源码)与改/删已存在文件同判自证违规。
const TEST_PATH_RE = /(\.(test|spec)\.[a-z0-9]+$)|(^|\/)(tests?|__tests__)\//i;
const SUBSCRIPTION_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);

// 五.1(收口作战令)· 非 Git 多写者阻断:工作根不是 Git 仓库时,无法为多个并行写入 worker 提供
// worktree 隔离(commit/merge/回滚全不可用),多写者直写同一根目录会互相踩踏。V0 明确拒绝多写者模式——
// 该批 >1 个写(编码)worker 时整 run 干净失败(与 CapabilityBlockedError 同型),由 orchestrator 转成
// 干净的 run 失败并留 governance 痕。单写者允许(串行安全),走 isolation:"none" 直写工作根并如实标注。
export class NonGitMultiWriterError extends Error {
  readonly code = "non_git_multi_writer";
  constructor(public readonly writerCount: number, public readonly workRoot: string) {
    super(`non_git_multi_writer: 工作目录不是 Git 仓库,无法为 ${writerCount} 个并行写入 worker 提供隔离——请在公司架构页把该目录初始化为 OPC 管理的 Git 工作区后重试(${workRoot})`);
    this.name = "NonGitMultiWriterError";
  }
}

/**
 * Resolve a worker cwd to an existing canonical directory inside its worktree.
 * Missing ordinary directories are created through the mutation guard; dangling
 * links, files, and links/junctions that resolve outside the worktree fail closed.
 */
export function resolveCanonicalWorkerDirectory(worktreeRoot: string, configured: string): string {
  const checked = validateAgentWorkingDirectory(configured);
  if (!checked.ok) throw new Error(`invalid workingDirectory: ${checked.code}`);

  const lexical = resolveSafe(checked.normalized, worktreeRoot);
  try {
    fs.lstatSync(lexical);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    const safeTarget = resolveSafeWrite(checked.normalized, worktreeRoot);
    fs.mkdirSync(safeTarget, { recursive: true });
  }

  const canonical = resolveSafeRead(checked.normalized, worktreeRoot);
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error("invalid workingDirectory: target is not a directory");
  }
  return canonical;
}

export function responseTokenLimitForWorker(noCode: boolean, maxTokensPerTask: number): number {
  const ceiling = noCode ? 4096 : 8192;
  return maxTokensPerTask > 0 ? Math.max(1, Math.min(ceiling, maxTokensPerTask)) : ceiling;
}

export interface WorkerSpec {
  agent: AgentNodeConfig;
  leaseAgent?: AgentNodeConfig;
  systemPrompt: string;
  userMessage: string;
  taskId: string;
  noCode?: boolean; // RC1:研究/无代码 worker → 跑在干净短路径 scratch 目录(不进 monorepo worktree)
  // P0-3:验证者(test/tester/qa/reviewer 或纯核验任务)。runWorkersParallel 把 verifier 排到 producer
  // merge 之后作为第二批执行,其 worktree 从【已 merge 的 workRoot】新建(能看到 dev 产物);且零文件
  // 变更对 verifier 合法(它只跑测试,不落盘),不判 no_file_changes。
  isVerifier?: boolean;
  // #1 · 文本依赖型 worker(综合/事实核查):输入是其他 producer worker 的【文本产出】。runWorkersParallel
  // 为其单开一批,排在 producer 批之后,把 producer 文本注入 userMessage,且不受"无文件产物就跳过"文件门约束。
  dependsOnText?: boolean;
}

// RC1:把 scratch 短路径目录里 worker 写的 .md/.txt 交付内容读回(scratch 随后被清,orchestrator 用
// activeWorkRoot 读不到)。安全:只读文档型扩展、排除环境/vendor 目录、限深度与总量(防误抓误建的 Python 文档)。
function readScratchDeliverables(dir: string): string {
  const ENV_RE = /(^|[\\/])(\.?venv|site-packages|node_modules|pythoncore[^\\/]*|__pycache__|[^\\/]*\.dist-info|_static)([\\/]|$)/i;
  const parts: string[] = [];
  let budget = 60000;
  const scan = (rel: string, depth: number): void => {
    if (depth > 2 || budget <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) break;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (ENV_RE.test(r)) continue;
      if (e.isDirectory()) scan(r, depth + 1);
      // 读回 scratch 里的交付文件:研究 .md/.txt + 编码 worker 的真实代码(对抗审查 #1:scratch 代码原本不被读回 → verifier 审散文不审代码)。
      else if (/\.(md|markdown|txt|py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|vue|svelte|sh|sql|json|ya?ml|toml)$/i.test(e.name)) {
        try {
          let body = fs.readFileSync(path.join(dir, r), "utf-8").trim();
          if (!body) continue;
          if (body.length > 40000) body = body.slice(0, 40000) + "…(截断)";
          parts.push(`\n\n--- 产出文件 ${r} ---\n${body}`);
          budget -= body.length;
        } catch { /* skip */ }
      }
    }
  };
  scan("", 0);
  return parts.join("");
}

export interface ParallelDeps {
  projectRoot: string;
  scheduler: Scheduler;
  semaphore: Semaphore;
  baseline: GateBaseline;
  maxAttempts: number;
  // 效率闸 · 编码无进展停:一个编码 worker(!noCode && !isVerifier)连续 N 轮产出【零文件变更】(未落盘,
  // 无新增 fileChanges)→ 提前停止重试、判 no_file_changes,不把 maxAttempts 预算空耗在明显卡死的 worker 上
  // (用户"dev 83k/11 调用"的直接对治)。默认 3;≥maxAttempts 时等价于沿用 maxAttempts(不改变旧行为)。
  maxNoProgressAttempts?: number;
  taskTimeoutMs: number;
  // true = 用户显式统一指定了超时(env/config)→ 全角色用 taskTimeoutMs;false = 按 roleProfile.taskTimeoutMs 分角色。
  taskTimeoutExplicit?: boolean;
  maxTokensPerTask: number;
  /** Remaining token allowance for this invocation, keyed by agent id. */
  maxTokensPerAgent?: Record<string, number>;
  /** Shared run cancellation. Engines must stop before another model/tool call. */
  abortSignal?: AbortSignal;
  runId: string;
  accountUsage: Record<string, number>;
  emit: (type: string, agentId: string | undefined, payload: unknown) => void;
  // Runs the agent with the given task + ctx (ctx.workdir = the worker's worktree) and returns the
  // ExecResult. Injected so token/cost/CallRecord/status bookkeeping stays in the orchestrator.
  execFn: (agent: AgentNodeConfig, task: ExecTask, ctx: ExecContext) => Promise<ExecResult>;
  // P0 · 本 run 此前各轮已累积的交付合同(变更文件相对路径)。verifier 批的合同 = 本批 producer 变更 ∪ 此。
  // round≥2 的 verifier-only 返工靠它拿到 round1 的合同(此时本批无 producer);round1 传 [] 即可(producer 在同批)。
  priorContractFiles?: string[];
  /** Test files previously created by each verifier during this run. */
  verifierOwnedTestPathsByAgent?: Record<string, string[]>;
}

export interface WorkerResult {
  taskId: string;
  agentId: string;
  ok: boolean;
  content?: string;
  fileChanges?: FileChange[];
  deferred?: DeferredTask;
  accountId?: string;
  partial?: boolean; // ⏱️ 超时抢救产物:可用但可能不完整,content 已带显式标头,合成侧应诚实标注
  // MUP Gate A#3 · merge 冲突:文件改动未落地(绝不 -X theirs 强并),worker 分支/worktree 保留待人工决裁。
  // requiresReview 的 worker 绝不以 ok:true 收录;文本产出仍保留在 content(部分结果,不进纯净合成)。
  requiresReview?: boolean;
  conflictFiles?: string[];
  /** Tokens spent by this worker invocation, including internal retries. */
  tokensUsed?: number;
}

// ⏱️ 超时抢救兜底(外层):最后一次尝试超时的 worker,不立即毁尸灭迹——保留 worktree + detached promise,
// finalize 前统一抢救(迟到完成的完整产出 / scratch 里已写的文件),够料(≥SALVAGE_MIN_CHARS)就以 partial 并入。
interface SalvageEntry {
  spec: WorkerSpec;
  wt: Worktree;
  accountId: string;
  result?: ExecResult; // detached promise 若最终 resolve,由 .then 填充
}
const SALVAGE_MIN_CHARS = 300;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// A1-V3 权限护栏:roleProfile.allowedExtensions / blockedGlobs 在文件写入路径上真实拦截。
// 违规文件在进入任何交付路径(scratch 读回 / 质量门 / commit / merge)之前就被物理丢弃
// (create→删除,modify/delete→git 还原,复用 fileChanges.discardFileChanges),并 emit 结构化
// permission_block 事件——拦截而非事后警告,绝不静默。字段缺省 = 全放行(checkFileAllowed 内部保证),
// 现有 profile 均定义了这两个字段,worker 角色因此真正受限。返回过滤后的 fileChanges。
function enforceFileGuards(spec: WorkerSpec, wt: Worktree, fileChanges: FileChange[], deps: ParallelDeps): FileChange[] {
  if (fileChanges.length === 0) return fileChanges;
  if (!loadConfig(deps.projectRoot).permissions.allowFileWrite) {
    discardFileChanges(wt.dir, fileChanges.map((fc) => ({ path: fc.path, changeType: fc.changeType })));
    deps.emit("info", spec.agent.id, {
      kind: "permission_block",
      taskId: spec.taskId,
      blockedFiles: fileChanges.map((fc) => ({ path: fc.path, rule: "file_write_disabled", detail: "permissions.allowFileWrite=false" })),
      message: `文件写入权限已关闭：拦截 ${fileChanges.length} 个文件变更，不进入交付`,
    });
    return [];
  }
  const profile = getProfileForRole(spec.agent.role);
  const blocked: Array<{ path: string; rule: FileBlockRule; detail: string; changeType: FileChange["changeType"] }> = [];
  const allowed: FileChange[] = [];
  for (const fc of fileChanges) {
    const v = checkFileAllowed(profile, fc.path);
    if (v.allowed) allowed.push(fc);
    else blocked.push({ path: fc.path, rule: v.rule!, detail: v.detail ?? "", changeType: fc.changeType });
  }
  if (blocked.length === 0) return fileChanges;
  discardFileChanges(wt.dir, blocked.map((b) => ({ path: b.path, changeType: b.changeType })));
  deps.emit("info", spec.agent.id, {
    kind: "permission_block",
    taskId: spec.taskId,
    profileId: profile.id,
    blockedFiles: blocked.map(({ path: p, rule, detail }) => ({ path: p, rule, detail })),
    message: `🛡️ 权限护栏(${profile.id}):拦截 ${blocked.length} 个违规文件,不进产出 — ${blocked.slice(0, 5).map((b) => `${b.path}(${b.detail})`).join("; ")}${blocked.length > 5 ? " …" : ""}`,
  });
  return allowed;
}

function gateSummary(g: QualityGateResult): string {
  const parts: string[] = [];
  if (g.typeCheck.ran && !g.typeCheck.passed) parts.push(`类型检查: ${g.typeCheck.output.slice(0, 200)}`);
  if (g.tests.ran && !g.tests.passed) parts.push(`测试: ${g.tests.output.slice(0, 200)}`);
  return parts.join(" | ") || "质量门未通过";
}

function deferredResult(spec: WorkerSpec, reason: DeferredTask["reason"], attempts: number, lastError?: string, tokensUsed = 0): WorkerResult {
  return { taskId: spec.taskId, agentId: spec.agent.id, ok: false, tokensUsed, deferred: { taskId: spec.taskId, agentId: spec.agent.id, goal: spec.userMessage, reason, attempts, lastError } };
}

interface Accepted {
  spec: WorkerSpec;
  wt: Worktree;
  content: string;
  fileChanges: FileChange[];
  accountId: string;
  partial?: boolean; // ⏱️ 超时抢救的部分产物标志,随 merge-back 透传到 WorkerResult
  tokensUsed: number;
}

// Run workers concurrently: each leases a least-busy account (scheduler), runs in its own git
// worktree (isolated edits + gate), and on a passing diff is committed. After all finish, accepted
// worktrees are merged back serially (disjoint → clean; conflict → deferred). Stuck workers defer,
// never block. Concurrency is bounded by the global Semaphore + per-account maxConcurrent.
//
// P0-3 · 真实依赖序:把一批 spec 分成 producer(编码/写作)与 verifier(test/tester/qa/reviewer 或纯核验)。
// producer 先并行跑 + commit + merge 回真实 workRoot(deps.projectRoot);merge 完成后 verifier 才跑——
// 此时 createWorktree 从【已 merge 的 workRoot 的新 HEAD】新建 worktree,verifier 因此能看到 producer 落盘
// 的文件(如 dev 的 sum.js/sum.test.js)并真正跑 `node sum.test.js`/`npm test`,而不是在看不到 dev 文件的
// 隔离 worktree 里"验证成功"。无 verifier → 单批执行,与改造前逐字节等价。
export async function runWorkersParallel(specs: WorkerSpec[], deps: ParallelDeps): Promise<WorkerResult[]> {
  // 五.1 · 非 Git 多写者阻断(与 CapabilityBlockedError 同型的干净失败):工作根非 git 且本批有 >1 个写
  // (编码)worker 时,整 run 干净失败——无 worktree 隔离,多写者并发直写同一根目录会互相踩踏。写 worker =
  // 编码 worker(!noCode && !isVerifier);verifier/研究 worker 不直写工作根(verifier 只跑测试、研究走 scratch),
  // 不计入多写者。单写编码 worker 允许,走 isolation:"none"(见 runOne 的 non_git_isolation_none 标注)。
  if (!isGitRepo(deps.projectRoot)) {
    const writerCount = specs.filter((s) => !s.noCode && !s.isVerifier).length;
    if (writerCount > 1) throw new NonGitMultiWriterError(writerCount, deps.projectRoot);
  }
  // #1 · 三类 worker:producer(研究/编码,并行第一批)、text-dependent(综合/核查,依赖 producer 文本,
  // 第二批)、verifier(测试/审查,依赖 producer 文件,最后一批)。text-dependent + verifier 都为空时,
  // 单批执行,与改造前【逐字节等价】(保住既有研究/编码团队路径)。
  const dependents = specs.filter((s) => s.dependsOnText && !s.isVerifier);
  const producers = specs.filter((s) => !s.isVerifier && !s.dependsOnText);
  const verifiers = specs.filter((s) => s.isVerifier);
  if (verifiers.length === 0 && dependents.length === 0) return runBatch(specs, deps);
  // producer 批:跑完并把 accepted worktree merge 回 deps.projectRoot(runBatch 尾部)。
  const producerResults = await runBatch(producers, deps);

  // #1 · 文本依赖批(综合/事实核查):排在 producer 之后,把 producer 的【文本产出】注入其 prompt,再并行跑。
  // 不受下方"无文件产物就跳过"的文件合同门约束——它依赖文本、不依赖文件。无 dependents 时该段完全跳过。
  let dependentResults: WorkerResult[] = [];
  if (dependents.length > 0) {
    const upstream = producerResults
      .filter((r) => (r.content || "").trim().length > 0)
      .map((r, i) => `--- 上游产出 #${i + 1}(${r.agentId}${r.ok ? "" : " · 部分/未完成"}) ---\n${(r.content || "").trim()}`)
      .join("\n\n");
    const BUDGET = 40000;
    const upstreamBlock = "\n\n## 上游 worker 的产出(这是你的输入:请基于以下各成员的产出做综合/事实核查,不要重新从零研究)\n" +
      (upstream ? (upstream.length > BUDGET ? upstream.slice(0, BUDGET) + "\n…(超预算截断)" : upstream) : "(上游无有效文本产出)");
    const injected = dependents.map((d) => ({ ...d, userMessage: d.userMessage + upstreamBlock }));
    dependentResults = await runBatch(injected, deps);
  }
  if (verifiers.length === 0) return [...producerResults, ...dependentResults];
  // P0 · 本 run 交付合同 = 此前累积(priorContractFiles)∪ 本批 producer 已 merge 的变更文件。verifier 批据此把
  // 独立测试证据【绑定到本 run 产物】:snapshot 只跑属于合同/直接测试合同源文件的测试,拒跑共享工作目录里历次
  // 遗留的无关测试。空合同(本 run 零变更)→ verifier 无可绑定测试可跑 → 独立门诚实判 missing_independent。
  const contractFiles = [...new Set([
    ...(deps.priorContractFiles ?? []),
    ...producerResults.flatMap((r) => (r.fileChanges ?? []).map((fc) => fc.path)),
    ...dependentResults.flatMap((r) => (r.fileChanges ?? []).map((fc) => fc.path)),
  ])];
  // P0 · 无产物不启动 tester/reviewer:合同为空(本 run 零产物且无历史产物)= 没有任何可独立验证的东西 →
  // 跳过 verifier 批,不发 LLM 调用、不空跑烧 token。run 级 DeliveryAcceptance 仍兜底判 no_delivery,诚实失败终态不变。
  // 注意 gate 在【合同/producer 有无产物】上,不在 verifier 自身零变更(那是合法的,verifier 只跑测试不落盘代码)。
  if (contractFiles.length === 0 && verifiers.length > 0) {
    // Fix2:研究/写作(producer 全 noCode)任务本就产文本不产文件,"无文件产物 → 跳过 verifier"是**预期**行为,
    // 绝不当作降级性 deferred(否则每个带核查/审查边的研究 run 必然被判降级、评分被降级横幅稀释——实测 DRACO
    // 研究题评分被拖低的直接根因之一)。编码任务无产物仍如实 deferred(no_producer_output),run 级
    // DeliveryAcceptance 兜底 no_delivery,诚实性不变。
    const noFileWorkers = [...producers, ...dependents];
    const producersAllNoCode = noFileWorkers.length > 0 && noFileWorkers.every((p) => p.noCode);
    for (const v of verifiers) {
      deps.emit("info", v.agent.id, {
        kind: "verifier_skipped_no_producer", taskId: v.taskId, benign: producersAllNoCode,
        message: producersAllNoCode
          ? "⏭️ 研究/写作任务无文件产物(正常)→ 跳过独立验证,不计入降级"
          : "⏭️ producer 无任何文件产物 → 跳过独立验证（不空跑烧 token）",
      });
    }
    if (producersAllNoCode) return [...producerResults, ...dependentResults]; // 研究 run:返回 producer+综合 文本结果,verifier 跳过不产生降级 deferred
    const skipped = verifiers.map((v) => deferredResult(v, "no_producer_output", 0, "producer 无任何文件产物,跳过独立验证"));
    return [...producerResults, ...dependentResults, ...skipped];
  }
  // verifier 批:此刻 projectRoot HEAD 已含 producer 的 merge 提交 → verifier worktree 新建即带上产物。
  const verifierResults = await runBatch(verifiers, deps, contractFiles);
  return [...producerResults, ...dependentResults, ...verifierResults];
}

// 单批并行执行 + 超时抢救 + accepted worktree 串行 merge-back(原 runWorkersParallel 主体,原样保留)。
// batchContractFiles(可选):本批(verifier 批)的交付合同,下沉到 ctx.deliveryContractFiles 供快照测试绑定。
async function runBatch(specs: WorkerSpec[], deps: ParallelDeps, batchContractFiles?: string[]): Promise<WorkerResult[]> {
  const accepted: Accepted[] = [];
  const results: WorkerResult[] = [];
  const rawPromises: Promise<unknown>[] = [];
  const salvage: SalvageEntry[] = [];
  if (specs.length === 0) return results;

  await Promise.all(specs.map((spec) => runOne(spec, deps, accepted, results, rawPromises, salvage, batchContractFiles)));
  // P1-5: a timed-out attempt's execFn keeps running detached — await it so its late token push
  // (callRecords / run totals) lands before the run finalizes, otherwise spent tokens leak uncounted.
  await Promise.allSettled(rawPromises);

  // ⏱️ 超时抢救兜底:既然 P1-5 反正要等 detached run 结束,等待就该变得有产出——迟到完成的完整内容 > scratch
  // 已写文件,够料就把该 worker 的 deferred 记录替换成 ok+partial,喂进合成(带显式"部分产物"标头,诚实降级)。
  for (const s of salvage) {
    let text = "";
    let source = "";
    if (s.result && s.result.status === "done" && (s.result.content || "").trim().length >= SALVAGE_MIN_CHARS) {
      text = s.result.content.trim(); source = "迟到完成的产出";
    }
    if (!text && s.wt.scratch) {
      // A1-V3:抢救读回同样要过权限护栏——先物理清掉违规文件(scratch 非 git,diffFileChanges 走 fs
      // 快照),再读回;否则超时路径会成为绕过 allowedExtensions/blockedGlobs 的后门。
      enforceFileGuards(s.spec, s.wt, diffFileChanges(s.wt.dir), deps);
      const t = readScratchDeliverables(s.wt.dir).trim();
      if (t.length >= SALVAGE_MIN_CHARS) { text = t; source = "工作区已写文件"; }
    }
    if (text) {
      const content = `【⏱️ 部分产物】该 worker 达到时间上限被终止,以下为抢救回的${source},可能不完整——合成时请如实标注缺口。\n\n${text}`;
      const rec: WorkerResult = { taskId: s.spec.taskId, agentId: s.spec.agent.id, ok: true, content, fileChanges: [], accountId: s.accountId, partial: true };
      const idx = results.findIndex((x) => x.taskId === s.spec.taskId && !x.ok);
      if (idx >= 0) results[idx] = rec; else results.push(rec);
      deps.emit("info", s.spec.agent.id, { kind: "timeout_salvage", message: `⏱️ 超时后从「${source}」抢救出 ${text.length} 字部分产出,已并入合成(标记 partial)` });
    }
    removeWorktree(deps.projectRoot, s.wt); // 抢救完才清(runOne 的 finally 对 salvage 挂起的 worktree 不删)
  }

  // Serial merge-back of accepted worktrees into the project's current branch.
  // MUP Gate A#3 / D3:protectPaths = 本 run 此前已接受的变更路径(prior 轮合同 ∪ 本批合同 ∪ 本批已 merge),
  // mergeWorktree 只按这些精确路径 stage 保护(防覆盖上一环节刚落地的未提交产出);用户脏/未跟踪文件绝不
  // 入库。conflict 绝不 -X theirs 强并:该 worker 不以 ok:true 收录(requiresReview + conflictFiles),
  // 文本产出保留在 content 作部分结果;worker 分支与 worktree 保留供人工决裁(绝不 removeWorktree)。
  const protectPaths = [...new Set([...(batchContractFiles ?? []), ...(deps.priorContractFiles ?? [])])];
  for (const a of accepted) {
    const verdict = mergeWorktree(deps.projectRoot, a.wt, protectPaths);
    if (verdict.outcome === "conflict") {
      // 波6 · 冲突落盘(经 store 层):分支/worktree 保留 + 持久记录,供冲突决裁 API 列出/拉 diff/决裁。
      // 落盘失败绝不阻断 run 收尾(best-effort):最坏退化回旧行为(仅事件流有记录)。
      try {
        recordConflict(deps.projectRoot, {
          runId: deps.runId,
          taskId: a.spec.taskId,
          agentId: a.spec.agent.id,
          branch: a.wt.branch,
          dir: a.wt.dir,
          conflictFiles: verdict.conflictFiles,
        });
      } catch { /* best-effort:记录失败不影响冲突事件与分支保留 */ }
      deps.emit("info", a.spec.agent.id, {
        kind: "merge_conflict_requires_review",
        taskId: a.spec.taskId,
        conflictFiles: verdict.conflictFiles,
        branch: a.wt.branch,
        message: `⛔ 合并冲突:${a.spec.taskId} 的文件改动未落地(不强并),分支 ${a.wt.branch} 与 worktree 已保留待人工决裁${verdict.conflictFiles.length ? `: ${verdict.conflictFiles.slice(0, 5).join(", ")}` : ""}`,
      });
      results.push({ taskId: a.spec.taskId, agentId: a.spec.agent.id, ok: false, content: a.content, fileChanges: [], accountId: a.accountId, partial: a.partial, tokensUsed: a.tokensUsed, requiresReview: true, conflictFiles: verdict.conflictFiles });
      continue; // 冲突分支/worktree 保留供人工决裁
    }
    for (const fc of a.fileChanges) if (!protectPaths.includes(fc.path)) protectPaths.push(fc.path);
    results.push({ taskId: a.spec.taskId, agentId: a.spec.agent.id, ok: true, content: a.content, fileChanges: a.fileChanges, accountId: a.accountId, partial: a.partial, tokensUsed: a.tokensUsed });
    removeWorktree(deps.projectRoot, a.wt);
  }
  return results;
}

async function runOne(spec: WorkerSpec, deps: ParallelDeps, accepted: Accepted[], results: WorkerResult[], rawPromises: Promise<unknown>[], salvage: SalvageEntry[], batchContractFiles?: string[]): Promise<void> {
  const releaseSem = await deps.semaphore.acquire();
  let lease: Awaited<ReturnType<Scheduler["acquire"]>> | null = null;
  let wt: Worktree | null = null;
  let isAccepted = false;
  let salvagePending = false; // ⏱️ 最后一次尝试超时 → 保留 worktree,finalize 前统一抢救后再清
  let deferRelease = false;   // P0#4:salvage 路径租约/信号量延迟到 detached run settle 后释放(防击穿账号并发防线)
  const invocationTokenBudget = Math.max(0, deps.maxTokensPerAgent?.[spec.agent.id] ?? deps.maxTokensPerTask);
  let tokensUsed = 0;
  // ⏱️ 按角色时限:显式统一配置(env/config)优先;否则按 roleProfile(研究 10min / 核查 6min / 代码 12min…)。
  const timeoutMs = deps.taskTimeoutExplicit ? deps.taskTimeoutMs : (getProfileForRole(spec.agent.role).taskTimeoutMs || deps.taskTimeoutMs);
  const leaseAgent = spec.leaseAgent ?? spec.agent;
  const leaseFramework = leaseAgent.framework ?? "hermes";
  try {
    if (invocationTokenBudget <= 0) {
      results.push(deferredResult(spec, "run_budget_exhausted", 0, "worker cumulative token allowance exhausted", tokensUsed));
      return;
    }
    try {
      // pinnedConfigDir:节点显式钉定订阅账号时,租约必须落在该账号上(记账=真实执行账号,防封号并发
      // 才数得准;engineRegistry 会把该目录注进 CLAUDE_CONFIG_DIR/CODEX_HOME,执行侧一定用它)。
      lease = await deps.scheduler.acquire({ providerId: leaseAgent.provider, framework: leaseFramework, allowFailover: true, pinnedConfigDir: spec.agent.cliConfigDir });
    } catch (e: any) {
      results.push(deferredResult(spec, "no_account", deps.maxAttempts, e?.message || String(e), tokensUsed));
      return;
    }
    deps.accountUsage[lease.account.id] = (deps.accountUsage[lease.account.id] ?? 0) + 1;
    deps.emit("info", spec.agent.id, { accountId: lease.account.id, taskId: spec.taskId });

    // P0-3:verifier 必须进真 git worktree(从已 merge 的 workRoot 的 HEAD 新建,才能看到 producer 产物),
    // 即便它被标了 noCode 也不走 scratch 短路径(scratch 是空目录,看不到任何 dev 文件)。
    wt = (spec.noCode && !spec.isVerifier)
      ? createScratchDir(`${deps.runId.slice(0, 8)}-${spec.taskId}`)
      : createWorktree(deps.projectRoot, `${deps.runId.slice(0, 8)}-${spec.taskId}`);

    // 五.1 · 单写编码 worker 落在非 git 工作根(isolation:"none"):无 worktree 隔离,产物直写工作根、
    // 不做 git 合并/回滚。此前静默,现在如实标注(run 记录/报告据此声明 isolation:"none")。多写者已在
    // runWorkersParallel 入口被 NonGitMultiWriterError 拦死,能走到这里的编码 worker 必是单写者。
    if (wt.isolation === "none" && !spec.noCode && !spec.isVerifier) {
      deps.emit("info", spec.agent.id, {
        kind: "non_git_isolation_none",
        taskId: spec.taskId,
        workRoot: wt.dir,
        message: `⚠️ 工作目录非 Git 仓库,本编码 worker 无 worktree 隔离(单写者模式:产物直接落工作根,不做 git 合并/回滚)`,
      });
    }

    // MUP Gate A#4 · 员工级相对工作子目录真接线:agent.workingDirectory(相对 POSIX)→ 该 worker 的
    // ctx.workdir = worktreeRoot/workingDirectory。只对非 scratch、非 verifier worker 生效——verifier 必须
    // 以 worktree 根为视野验证交付合同(testedFile/合同路径口径相对 worktree 根),scratch 是一次性短路径
    // 临时目录无子目录语义。resolveSafe 断言解析结果仍在 worktree 内(词法校验之外的第二道防线);
    // 非法值不 fail 整个 worker——emit 显式 warning 后退回 worktree 根(诚实降级,不静默)。
    // git/fileChanges 收集、质量门、merge-back 口径仍以 worktree 根(wt.dir)为准,见下方 done 分支。
    let workdir = wt.dir;
    if (spec.agent.workingDirectory && !wt.scratch && !spec.isVerifier) {
      const wdCheck = validateAgentWorkingDirectory(spec.agent.workingDirectory);
      let resolved: string | null = null;
      if (wdCheck.ok) {
        try { resolved = resolveCanonicalWorkerDirectory(wt.dir, wdCheck.normalized); } catch { resolved = null; }
      }
      // 五.3(收口作战令)· workdir 运行时阻断:workingDirectory 非法(语义校验失败或 resolveSafe 判定越界)时,
      // 该 worker【干净失败】(deferred 类别 invalid_working_directory + emit error 事件),【绝不静默退回工作根
      // 执行】——静默回退根目录会让"员工个人子目录"看起来生效实则错位,产物落错地方还宣称成功。
      if (!resolved) {
        deps.emit("error", spec.agent.id, {
          kind: "invalid_working_directory",
          taskId: spec.taskId,
          workingDirectory: spec.agent.workingDirectory,
          reason: wdCheck.ok ? "escape" : wdCheck.code,
          message: `⛔ 员工 workingDirectory「${spec.agent.workingDirectory}」非法(须为 worktree 内的相对路径)——本 worker 干净失败,绝不退回工作根执行`,
        });
        results.push(deferredResult(spec, "invalid_working_directory", 0, `invalid workingDirectory: ${spec.agent.workingDirectory}`, tokensUsed));
        return;
      }
      workdir = resolved;
    }

    // CLI engines (claude-code/codex) read their subscription credentials from cliConfigDir
    // (CLAUDE_CONFIG_DIR). Flow the leased account's configDir into the node when the node didn't
    // pin its own — node-explicit > lease account > global default. Copy so the shared node isn't mutated.
    const execAgent = (lease.account.configDir && !spec.agent.cliConfigDir)
      ? { ...spec.agent, cliConfigDir: lease.account.configDir }
      : spec.agent;

    // 多账号自动切换(hermes/API 框架):把这次租到的具体账号的 apiKey(连同它的 providerId)透传给
    // 执行引擎,让"accountPool 选中了另一个账号"这件事真正改变本次调用用哪把 key ——而不仅仅是并发计数
    // 的账面租约(此前 lease.account.apiKey 从未被下游读取,加了第二个账号也不会影响真实执行用哪把
    // key)。claude-code/codex 已有各自专属的 apiKey 解析路径(apiKeyAccount.ts,按 configDir/开关走),
    // 这里刻意跳过,避免两套机制打架。
    const leasedAccount = (!SUBSCRIPTION_FRAMEWORKS.has(leaseFramework) && lease.account.apiKey)
      ? { providerId: lease.account.providerId, apiKey: lease.account.apiKey }
      : undefined;

    let lastError = "";
    let lastReason: DeferredTask["reason"] = "retry_budget_exhausted";
    // 效率闸 · 无进展停:编码 worker 连续零文件变更(未落盘)的轮数;达上限提前判 no_file_changes,不空耗预算。
    const maxNoProgress = Math.max(1, deps.maxNoProgressAttempts ?? 3);
    let noProgressStreak = 0;
    // P0 · no_file_changes 针对性纠正重试:上一轮编码 worker 零落盘时,把"未检测到文件、必须调用写文件工具"的
    // 明确反馈注入下一轮 prompt(治 producer——尤其 DeepSeek——只在回复里贴代码、不真正调用 writeFile 的高发失败)。
    let correctiveNote = "";
    for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
      const remainingTokenBudget = Math.max(0, invocationTokenBudget - tokensUsed);
      if (remainingTokenBudget <= 0) {
        lastReason = "run_budget_exhausted";
        lastError = "worker cumulative token allowance exhausted";
        break;
      }
      // MUP A#4:子目录不存在则 mkdir(resetWorktree 的 clean -fd 会清掉上一轮建的未跟踪空目录,故每轮补建)。
      if (spec.agent.workingDirectory && !wt.scratch && !spec.isVerifier) {
        try {
          workdir = resolveCanonicalWorkerDirectory(wt.dir, spec.agent.workingDirectory);
        } catch (error: any) {
          deps.emit("error", spec.agent.id, {
            kind: "invalid_working_directory",
            taskId: spec.taskId,
            workingDirectory: spec.agent.workingDirectory,
            reason: "canonical_path_guard",
            message: error?.message || "workingDirectory failed canonical path validation",
          });
          results.push(deferredResult(spec, "invalid_working_directory", attempt - 1, error?.message, tokensUsed));
          return;
        }
      }
      let workerActivityObserved = false;
      const emitStartupDiagnostic = (error: unknown, phase: 'launch' | 'handshake' | 'prompt' = 'launch'): void => {
        if (workerActivityObserved) return;
        const diagnostic = appendWorkerStartupDiagnostic({
          projectRoot: deps.projectRoot,
          runId: deps.runId,
          agentId: spec.agent.id,
          taskId: spec.taskId,
          attempt,
          framework: spec.agent.framework ?? 'api',
          error,
          phase,
        });
        deps.emit('error', spec.agent.id, { kind: 'worker_startup_diagnostic', ...diagnostic });
      };
      const ctx: ExecContext = {
        runId: deps.runId,
        projectRoot: deps.projectRoot,
        workdir,
        emit: (t: string, a: string | undefined, p: unknown) => {
          if (t === 'tool_call' || t === 'tool_result' || t === 'model_call_finished' || t === 'assistant_message') {
            workerActivityObserved = true;
          }
          deps.emit(t, a, p);
        },
        budget: { maxTokensPerTask: remainingTokenBudget },
        // P6 真隔离:noCode/研究 worker → 用其 roleProfile 的磁盘配额;超出 runHermesNative 看门狗物理 kill。
        workspaceQuotaBytes: spec.noCode ? getProfileForRole(spec.agent.role).maxWorkspaceBytes : undefined,
        abortSignal: deps.abortSignal,
        taskTimeoutMs: timeoutMs, // ⏱️ 引擎在 (时限-宽限) 自行收尾/杀子进程+抢救 stdout,先于下方外层 race
        leasedAccount,
        isVerifier: spec.isVerifier, // P0-3:下沉到 ctx,供 ACP 引擎据此建 Verifier Snapshot + 产独立测试证据
        // P0:verifier 批携带本 run 交付合同 → 快照测试绑定到本 run 产物,拒跑遗留无关测试(producer 批为 undefined,不影响)。
        ...(spec.isVerifier && batchContractFiles !== undefined ? { deliveryContractFiles: batchContractFiles } : {}),
      };
      // Code-producing tool calls embed file contents in function arguments. A 4096
      // completion ceiling can truncate an otherwise valid writeFile call mid-JSON.
      // Give producers 8k while still respecting the configured per-task token cap;
      // text-only workers keep the smaller response surface.
      const maxTokens = responseTokenLimitForWorker(!!spec.noCode, remainingTokenBudget);
      const task: ExecTask = { taskId: spec.taskId, goal: spec.userMessage + correctiveNote, systemPrompt: spec.systemPrompt, maxTokens };

      let result;
      const raw = deps.execFn(execAgent, task, ctx);
      rawPromises.push(raw.catch(() => {})); // ensure detached (timed-out) runs settle before finalize
      try {
        result = await withTimeout(raw, timeoutMs);
        tokensUsed += Math.max(0, result.tokens?.total ?? 0);
      } catch (e: any) {
        lastError = e?.message || "timeout";
        lastReason = "timeout";
        emitStartupDiagnostic('prompt acceptance timeout: ' + lastError, 'prompt');
        if (attempt < deps.maxAttempts) { resetWorktree(wt); continue; }
        // ⏱️ 最后一次尝试超时 → 抢救路径:不 reset(保留已写文件)、不删 worktree,登记 detached promise,
        // finalize 前(allSettled 后)统一抢救——迟到完成的产出/scratch 文件够料就以 partial 并入,不再全损。
        const entry: SalvageEntry = { spec, wt, accountId: lease.account.id };
        raw.then((r) => { entry.result = r as ExecResult; }, () => { /* 失败无可救 */ });
        salvage.push(entry);
        salvagePending = true;
        // P0#4 审计(确认):detached 进程还活着时就释放账号租约/信号量,会击穿 per-account 并发防线
        // (CLI 订阅账号 max=1 防封号)。改为等 raw 真正 settle 后再释放;finally 见 deferRelease 不再重复释放。
        deferRelease = true;
        const _lease = lease;
        raw.catch(() => {}).finally(() => { try { _lease?.release(); } catch { /* */ } releaseSem(); });
        break;
      }
      // ⏱️ in-band 超时抢救(引擎层已杀子进程并带回截断前 stdout):加显式标头按"部分产物"进正常交付链。
      if (result.status === "done" && result.partial) {
        result = { ...result, content: `【⏱️ 部分产物】该 worker 达到时间上限被终止,以下为截断前的产出,可能不完整——合成时请如实标注缺口。\n\n${result.content}` };
        deps.emit("info", spec.agent.id, { kind: "timeout_salvage", message: `⏱️ 达到 ${Math.round(timeoutMs / 60000)}min 上限被终止,抢救 ${result.content.length} 字部分产出并入交付` });
      }

      if (result.status === "restricted") {
        emitStartupDiagnostic(result.error || 'provider unavailable before worker activity', 'handshake');
        results.push(deferredResult(spec, "provider_unavailable", attempt, result.error, tokensUsed));
        return;
      }
      if (result.status === "failed") {
        lastError = result.error || "failed";
        emitStartupDiagnostic(lastError, 'launch');
        // ⏱️ 引擎层任务超时(子进程被杀且 stdout 太薄没救回)→ 如实记 timeout,不再混进 retry_budget_exhausted;
        // A7:apiToolLoop 磁盘配额超限 throw 的错误文案含 "quota exceeded" → 如实归因 workspace_quota_exceeded。
        lastReason = /quota exceeded/i.test(lastError) ? "workspace_quota_exceeded"
          : /token budget exhausted/i.test(lastError) ? "run_budget_exhausted"
          : /tool loop made no progress/i.test(lastError) ? "no_progress"
          : /timed out|timeout/i.test(lastError) ? "timeout" : "retry_budget_exhausted";
        if (lastReason === "run_budget_exhausted" || lastReason === "no_progress") {
          try { deps.scheduler.reportOutcome(lease.account.id, leaseFramework, "success"); } catch { /* provider responded; this is a task efficiency stop */ }
          results.push(deferredResult(spec, lastReason, attempt, lastError, tokensUsed));
          return;
        }
        // 多账号自动切换(所有框架统一,见 accountPool.reportOutcome):这次失败记进账号级熔断——
        // 连续 3 次自动判不健康,跨 run 存活。引擎打了 `[overloaded]` 标记(CLI 的 spawnCliWithRetry
        // 已耗尽自身重试后才会打,见 cliEngineBase.ts)→ 额外尝试从错误文案解析出"几点恢复"作为精确
        // 冷却时长(复用 rateLimitCooldown.ts 的同一套解析,不新起一套);解析不出就是它的保守默认(30min)。
        try {
          const overloaded = lastError.startsWith("[overloaded]");
          deps.scheduler.reportOutcome(lease.account.id, leaseFramework, "failure", {
            error: lastError,
            forceCooldownUntil: overloaded ? parseResetTime(lastError).epochMs : undefined,
          });
        } catch { /* best-effort:健康记账失败不阻塞已有的重试/降级路径 */ }
        resetWorktree(wt);
        continue;
      }
      // done — 账号这次是健康的(哪怕产出后续没过质量门,那是代码质量问题,不是账号/引擎调用本身的问题)。
      try { deps.scheduler.reportOutcome(lease.account.id, leaseFramework, "success"); } catch { /* best-effort */ }
      // MUP A#4:子目录 worker 的 fileChanges 一律以 worktree 根重新收集——引擎在 ctx.workdir(子目录)
      // 现算 diff 时,git porcelain 路径仍相对仓库根但 content 读取会以子目录错位拼接;统一在这里以
      // wt.dir 重算,保证"路径+内容都相对 worktree 根"的冻结口径(merge/合同/protectPaths 依赖它)。
      if (workdir !== wt.dir) result = { ...result, fileChanges: diffFileChanges(wt.dir) };
      // A1-V3:角色权限护栏——违规文件此刻起不进任何交付路径(scratch 读回/质量门/commit/merge)。
      result = { ...result, fileChanges: enforceFileGuards(spec, wt, result.fileChanges, deps) };
      // P0-4 · A verifier may create tests and may revise only tests it created in an
      // earlier review round. It can never create non-test files or modify/delete
      // producer-owned source/tests. Ownership comes from the accepted change ledger,
      // not from a model claim, so the exception preserves independent verification.
      const normalizeVerifierPath = (value: string): string =>
        value.replaceAll(String.fromCharCode(92), "/").replace(/^\.\//, "");
      const ownedTests = new Set(
        (deps.verifierOwnedTestPathsByAgent?.[spec.agent.id] ?? [])
          .map(normalizeVerifierPath)
          .filter((filePath) => TEST_PATH_RE.test(filePath)),
      );
      const verifierIllegit = spec.isVerifier
        ? result.fileChanges.filter((change) => {
            const filePath = normalizeVerifierPath(change.path);
            if (!TEST_PATH_RE.test(filePath)) return true;
            if (change.changeType === "create") return false;
            return !ownedTests.has(filePath);
          })
        : [];
      if (verifierIllegit.length > 0) {
        deps.emit("info", spec.agent.id, {
          kind: "verifier_changes_discarded",
          taskId: spec.taskId,
          message: "⛔ 验证者只能新建测试，或返修自己在本 run 中创建的测试；producer 源码和 producer 测试不可修改。违规批次已整体回滚。",
          files: verifierIllegit.map((f) => f.path + "(" + f.changeType + ")").slice(0, 10),
        });
        resetWorktree(wt);
        result = { ...result, fileChanges: [] };
      }      if (result.fileChanges.length === 0) {
        // P0-2:编码 worker(!spec.noCode,由任务合同+角色判定)零文件变更 = 未真交付,绝不当成功 accept——
        // 判失败重试;耗尽尝试则 deferred(诚实失败)。研究/写作 worker(noCode)零 git 变更合法(产出是文本)→ 照常 accept。
        // P0-3:verifier 零文件变更同样合法——它只跑测试/评审(产出是 TestEvidence + 文本),不落盘代码,
        // 不能按"编码零变更"判 no_file_changes(否则 tester 每次都被误 defer)。
        // run 级 DeliveryAcceptance(orchestrator)是最终兜底门,此处是早失败早重试的第一道防线。
        if (!spec.noCode && !spec.isVerifier) {
          lastError = "编码任务未产生任何文件变更(产出未落盘到工作区 worktree)";
          lastReason = "no_file_changes";
          // P0 · 针对性纠正重试:给下一轮 prompt 注入明确纠正反馈(必须调用写文件工具真正落盘,而非只贴代码文本)。
          // 只在首次零落盘时 emit 一次观测事件(避免重复);correctiveNote 一旦设置,后续重试都带上。
          if (!correctiveNote) {
            deps.emit("info", spec.agent.id, {
              kind: "no_file_changes_corrective_retry",
              taskId: spec.taskId,
              attempt,
              message: "⚠️ 未检测到文件落盘 → 下一轮注入'必须调用写文件工具落盘'纠正反馈重试",
            });
          }
          correctiveNote = "\n\n---\n⚠️ 上一轮未检测到任何文件写入工作目录(no_file_changes:git 在工作目录检测到零文件变更)。"
            + "这几乎总是因为你只在回复文本里贴了代码,却没有真正调用【写文件工具(writeFile)】把文件落盘。"
            + "必须纠正:现在立刻调用写文件工具,把本任务要求的每一个文件真正写入当前工作目录(而不是把代码贴在消息里)。"
            + "先写文件、再作简短说明;若你认为已写过,请重新确认路径正确并再次写入。";
          // 效率闸 · 无进展停:连续零变更累计到上限 → 提前跳出重试循环(落到循环后的 deferred),
          // 不把剩余 maxAttempts 预算空耗在明显没在落盘的 worker 上(诚实失败,不虚标)。
          if (++noProgressStreak >= maxNoProgress) {
            deps.emit("info", spec.agent.id, {
              kind: "no_progress_stop",
              taskId: spec.taskId,
              streak: noProgressStreak,
              message: `⛔ 编码 worker 连续 ${noProgressStreak} 轮无新增文件变更,停止重试判 no_file_changes(不空耗预算)`,
            });
            break;
          }
          resetWorktree(wt);
          continue;
        }
        accepted.push({ spec, wt, content: result.content, fileChanges: [], accountId: lease.account.id, partial: result.partial, tokensUsed });
        isAccepted = true;
        return;
      }
      // 本轮有真实文件变更 = 有进展 → 清零无进展计数(即使随后质量门失败,也是"代码质量"问题而非"没落盘")。
      noProgressStreak = 0;
      // W4 修复:文档型产出(研究 worker 只写 .md/.json/.txt 等)无需代码质量门——对它跑整个 monorepo 的
      // tsc+test 既慢又错位(综合撰写员实测因此被反复 defer)。仅当改动含真实代码文件时才过门。
      const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|vue|svelte)$/i;
      const hasCode = result.fileChanges.some((fc) => CODE_EXT.test(fc.path));
      // 对抗审查 #1 修正:scratch worker(无论写 .md 还是真代码)都走"读回"路径——scratch 不是 git worktree、不与 activeWorkRoot
      // 合并,质量门在无依赖的 scratch 里跑也无意义。把交付文件(含代码)读回 content,verifier/合成才拿到真实产出。
      // 非 scratch 的代码 worker(真 worktree)仍走下方质量门 + merge,行为不变。
      if (!hasCode || wt.scratch) {
        commitWorktree(wt, `${spec.agent.id} ${spec.taskId}`);
        let content = result.content;
        if (wt.scratch) {
          const deliv = readScratchDeliverables(wt.dir);
          if (deliv) content = (content ? content + "\n\n" : "") + deliv;
        }
        accepted.push({ spec, wt, content, fileChanges: wt.scratch ? [] : result.fileChanges, accountId: lease.account.id, partial: result.partial, tokensUsed });
        isAccepted = true;
        const _profile = getProfileForRole(spec.agent.role); // WS1 roleProfile:该角色的执行画像
        deps.emit("info", spec.agent.id, { message: `${hasCode ? "代码" : "文档"}型产出读回 (${result.fileChanges.length} 文件)${wt.scratch ? ` · scratch(${_profile.id})` : ""}` });
        return;
      }
      const gate = runQualityGate(wt.dir, deps.baseline);
      // A8 · TestEvidence:质量门内真实跑过测试(gate.tests.ran)就如实记账——pass/fail 都发,
      // 只记 worker 在其 worktree 真实执行过的命令(零推断,绝不从 OPC Studio 仓库自身推断);
      // 纯加性 emit,绝不改变 gate 判定。deriveTestEvidence(runtimeContract.ts)以此为权威来源。
      if (gate.tests.ran) {
        deps.emit("info", spec.agent.id, {
          kind: "test_evidence",
          taskId: spec.taskId,
          source: "quality_gate",
          command: gate.tests.command ?? "unknown",
          cwd: wt.dir,
          ...(typeof gate.tests.exitCode === "number" ? { exitCode: gate.tests.exitCode } : {}),
          passed: gate.tests.passed,
          output: gate.tests.output.slice(0, 500),
        });
      }
      if (gate.passed) {
        commitWorktree(wt, `${spec.agent.id} ${spec.taskId}`);
        accepted.push({ spec, wt, content: result.content, fileChanges: result.fileChanges, accountId: lease.account.id, partial: result.partial, tokensUsed });
        isAccepted = true;
        deps.emit("info", spec.agent.id, { message: `质量门通过 (尝试 ${attempt}, ${result.fileChanges.length} 文件)` });
        return;
      }
      lastError = gateSummary(gate);
      lastReason = "quality_gate_failed";
      // A5:代码质量门(tsc/test)失败也落结构化 quality_gate_result(此前只有 gateSummary 文本塞 lastError)。
      // 只在最后一次尝试发——中途失败会被下一次尝试推翻,发了会让下游按次记账的消费方(如 XP 扣分)重复计罚。
      if (attempt === deps.maxAttempts) {
        deps.emit("quality_gate_result", spec.agent.id, {
          passed: false,
          failedLayer: 1,
          layerResults: [
            { layer: 1, name: "mechanical", passed: false, reason: lastError, details: gate },
            { layer: 2, name: "structural", passed: true, skipped: true, reason: "跳过:L1 未通过" },
            { layer: 3, name: "semantic", passed: true, skipped: true, reason: "跳过:L1 未通过" },
          ],
          overallReason: lastError,
          producer: spec.agent.id,
          stage: "admission",
        } satisfies QualityGateResultEventPayload);
      }
      resetWorktree(wt);
    }
    results.push(deferredResult(spec, lastReason, deps.maxAttempts, lastError, tokensUsed));
  } catch (e: any) {
    // 健壮性(审查抓出):runOne 内任何意外抛错(createScratchDir/createWorktree/其它)绝不能让
    // Promise.all 拒绝 → 崩整个 run(CEO 那类教训)。降级为 defer 该 worker,run 继续。
    results.push(deferredResult(spec, "retry_budget_exhausted", deps.maxAttempts, `worker 执行异常: ${e?.message || e}`, tokensUsed));
  } finally {
    if (!deferRelease) { // salvage 路径已把释放挂在 raw.settle 上(P0#4),此处不重复
      if (lease) lease.release();
      releaseSem();
    }
    // accepted 的 merge 后删;salvage 挂起的等 finalize 前抢救完再删(runWorkersParallel 尾部)
    if (wt && !isAccepted && !salvagePending) removeWorktree(deps.projectRoot, wt);
  }
}
