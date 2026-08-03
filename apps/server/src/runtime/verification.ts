import type { VerificationEdge, VerificationMethod } from "@opc/shared";
import { validateArtifact, factCheckContract, reviewContract } from "./artifactContract.js";
import { Semaphore } from "./pool/semaphore.js";

// Stage 6 · 交叉验证纯逻辑(可单测,不碰 IO/LLM)。orchestrator 的 verifier gate 用这些函数,
// 否决则把 producer 产出从合成输入剔除 —— "verifier 意见真影响最终交付",非仅日志。

export interface VerificationResultRecord {
  reviewArtifactId: string;     // review artifact 在 artifactStore 的 id
  reviewedArtifactId: string;   // 被审 producer 的 agentId(registry 按 worker-output.producer===此值 回标;非 artifactStore id)
  producerId: string;
  verifierId: string;
  verifierRole?: string;
  method: VerificationMethod;
  accept: boolean;
  summary: string;
  createdAt: string;
  skipped?: boolean; // P1#4:验证边因无可用 verifier 被跳过——记录在案而非"无痕 accept"(诚实可观测)
}

// 找出该 producer(agentId/role)命中的验证边。producer 字段支持 agentId / role / "*"。
export function matchEdgesForProducer(
  edges: VerificationEdge[] | undefined,
  agentId: string,
  role: string | undefined,
): VerificationEdge[] {
  if (!edges?.length) return [];
  return edges.filter(e => e.producer === "*" || e.producer === agentId || (!!role && e.producer === role));
}

// 程序化核查(确定性,Economy 兜底 / 无 LLM verifier 时用)。基于已有 artifactContract。
export function programmaticVerify(content: string, method: VerificationMethod): { accept: boolean; failures: string[] } {
  if (method === "fact-check") {
    const r = validateArtifact(content, factCheckContract);
    return { accept: r.passed, failures: r.failures };
  }
  if (method === "code-review" || method === "llm-review") {
    const r = validateArtifact(content, reviewContract);
    return { accept: r.passed, failures: r.failures };
  }
  return { accept: true, failures: [] }; // custom:无程序化规则 → 不拦(交给 LLM verifier 或默认通过)
}

// 编码型 run:公司声明了 code-review 验证边 → worker 应"真写代码"(不强加研究/NO_CODE 框架),
// 且 trivial 收敛到 1 人时应优先选验证边的 producer(让 dev 产出能被 code-review 核查)。研究型公司无此边 → false,行为不变。
export function isCodingVerificationRun(edges: VerificationEdge[] | undefined): boolean {
  return !!edges?.some(e => e.method === "code-review");
}

// trivial 任务收敛到单 worker 时:编码型 run 优先选"code-review 验证边 producer 对应的成员"(按 role 或 id 匹配),
// 再退而求其次按常见工程师角色名匹配;都找不到 → null(调用方退回原行为=第一个成员)。worker 形状只需 {id, role}。
export function pickCodeReviewProducer(
  workers: Array<{ id: string; role: string }>,
  edges: VerificationEdge[] | undefined,
): string | null {
  const producers = new Set((edges ?? []).filter(e => e.method === "code-review").map(e => e.producer));
  for (const w of workers) {
    if (producers.has(w.role) || producers.has(w.id)) return w.id;
  }
  for (const w of workers) {
    if (/\b(dev|engineer|coder|backend|frontend|developer)\b/i.test(w.role)) return w.id;
  }
  return null;
}

// Stage 6 并行验证 · 并发上限设计(架构修法:核查员并行审多个 producer,而非排队一个接一个调)。
//
// 背景:orchestrator.ts 的 verifier gate 跨 producer 并行(Promise.all,已在 961febb 落地)——同一个
// verifier agent(如 "事实核查员")若被多条边命中多个 producer(常见形态:producer 按 role 匹配,如
// "producer: dev" 同时匹配 4 个团队成员),这些审查会同时并发发起。但驱动这些调用的 runViaEngine 是
// orchestrator.ts 里"Serial wrapper for the CEO / Lead / summary paths"的通道——刻意不走 accountPool
// 的租约/并发钳制(设计假设是这条路径每次只有一个调用在飞)。并行化之后,如果不额外设界,N 个 producer
// 会对同一个 verifier 账号造成无界并发:
//   - 对订阅制 CLI 框架(claude-code/codex):accountPool.ts 的 effectiveCap 把这类账号并发硬钳到 1
//     ("Subscription CLIs are ban-prone under concurrency"),原因是同一订阅登录态开多个并发会话有
//     被风控封号的真实风险。Stage 6 的并行 fan-out 完全绕开这条防线,必须自己补上,否则"审得快"
//     可能变成"账号被封,审查全灭"。
//   - 对 hermes/API-key 账号:虽无封号风险,但瞬时把 N 份审查全部糊到同一账号,仍可能撞见 provider
//     侧的并发限速,得不到并行的实际收益,还可能相互挤占导致更多超时/空产出。
//
// 按 verifier agent 的 id 分桶:同一 verifier 命中的所有边共享一个上限,不同 verifier(不同账号)各自
// 独立、互不排队。
const CLI_SUBSCRIPTION_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
// 3-4 之间取 3:留出真实并行收益(4 个 producer 并行审,墙钟约等于审 1 份,而非审 4 份的总和),
// 同时不会让"一次审查全部糊上同一账号"的瞬时压力过大。可通过 VerifierConcurrencyGate 的 capFor 回调
// 按运行时账号信息进一步收紧(如按 provider 剩余容量),此函数只负责"框架层面"的保守默认值。
export const DEFAULT_VERIFIER_CONCURRENCY = 3;

export function verifierConcurrencyCap(framework: string | undefined, defaultCap: number = DEFAULT_VERIFIER_CONCURRENCY): number {
  if (framework && CLI_SUBSCRIPTION_FRAMEWORKS.has(framework)) return 1;
  return Math.max(1, defaultCap);
}

// 按 verifierId 分桶的并发闸门:同一 verifier 的并行审查请求共享一个 Semaphore(容量由 capFor 决定,
// 首次用到某个 verifierId 时惰性创建),不同 verifierId 各自独立、互不影响。调用方必须在 finally 里
// 调用 release(),确保某次审查异常/超时也不会永久占用槽位。
export class VerifierConcurrencyGate {
  private pools = new Map<string, Semaphore>();
  constructor(private capFor: (verifierId: string) => number) {}

  acquire(verifierId: string): Promise<() => void> {
    let sem = this.pools.get(verifierId);
    if (!sem) {
      sem = new Semaphore(Math.max(1, this.capFor(verifierId)));
      this.pools.set(verifierId, sem);
    }
    return sem.acquire();
  }
}

// 解析 LLM verifier 的判定(ACCEPT/REJECT/PASS/FAIL/通过/拒绝;含明确否决词则 reject)。
// A1-V1 增量:返回值补 parsed / contradictory 两个上下文字段(accept 判定逻辑逐字不变):
//   - parsed=false:空产出或全无明确判定(分支③保守接受)——verdict 不是解析出来的,是兜底猜的;
//   - contradictory=true:首行同时给出通过与拒绝措辞(现状 reject 优先,accept 仍为 false)。
// 供 reviewCommit.ts 的 Core 裁决把这两类情况显式标成 requires_human_review(行为面不变)。
export function parseVerifierVerdict(output: string): { accept: boolean; feedback?: string; parsed: boolean; contradictory?: boolean } {
  const t = (output || "").trim();
  if (!t) return { accept: false, feedback: "verifier 无产出", parsed: false };
  const rejectRe = /\b(reject|rejected|not\s+verified)\b|拒绝|未通过|不通过|核查失败|verdict\s*[:：]?\s*(false|unverified)/i;
  const acceptRe = /\b(accept|pass|approved|verified)\b|通过|核查通过|verdict\s*[:：]?\s*true/i;
  // ① 优先只看**首个非空行**(prompt 明确要求"先给一行判定")——叙事型评审(如"我会核对……失败案例")
  //   在 400 字全文里扫拒绝词会误杀想通过的 producer(A/B 实验实测:dev 连续两轮被过程独白误拒)。
  const firstLine = (t.split("\n").find((l) => l.trim()) || "").slice(0, 160);
  if (rejectRe.test(firstLine)) {
    // 自相矛盾检测:剔除"未通过/不通过/not verified"这类**本身含接受词素**的拒绝短语后,
    // 首行若仍含独立的接受措辞(如"拒绝。但整体通过")→ 标 contradictory。仅标注,判定仍按现状 reject 优先。
    const strippedOfRejectPhrases = firstLine.replace(/未通过|不通过|not\s+verified/gi, "");
    const contradictory = acceptRe.test(strippedOfRejectPhrases);
    return { accept: false, feedback: t.slice(0, 300), parsed: true, ...(contradictory ? { contradictory } : {}) };
  }
  if (acceptRe.test(firstLine)) return { accept: true, parsed: true };
  // ② 首行无判定 → 兜底扫前 400 字,但**先认接受**再认拒绝(叙述里"通过"与"失败案例"并存时不误杀),
  //   且拒绝词已收窄(去掉裸 fail/false/存在错误这类叙述高频词)。此分支不标 contradictory——
  //   叙述里判定词并存是常态,刻意不误杀(见上一行注释)。
  const head = t.slice(0, 400);
  if (acceptRe.test(head)) return { accept: true, parsed: true };
  if (rejectRe.test(head)) return { accept: false, feedback: t.slice(0, 300), parsed: true };
  // ③ 全无明确判定 → 保守接受(避免误杀;真否决需明确措辞)。parsed=false:这不是解析出的判定。
  return { accept: true, parsed: false };
}
