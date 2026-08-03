import type { TraceEvent } from "@opc/shared";

// A1-V1(重构指南 Track A):拆分 AI Reviewer 的"判断权"与"状态提交权"。
// verifier 只产出 review proposal(AI proposes);Core 侧由本模块的纯规则裁决四态
// accepted / needs_revision / failed / requires_human_review(Core commits)。
// orchestrator 的副作用(剔除合成输入/标记延后)一律由 ReviewDecision.effect 驱动,
// verifier 的 accept 布尔值不再直接改状态。纯函数,不碰 IO/LLM,可单测。

// verifier 的审查提议 + 它是如何得出的上下文(解析是否成功/是否自相矛盾/执行是否异常)。
export interface ReviewProposal {
  accept: boolean;
  confidence?: number; // 现有 verifier 输出不含置信度,先留位(prompt 升级后接入),payload 透传
  reason?: string;
  parsed?: boolean;          // verdict 是否从 verifier 产出中明确解析出来(缺省视为 true)
  contradictory?: boolean;   // verifier 产出自相矛盾(同一判定行同时给出通过与拒绝)
  verifierErrored?: boolean; // verifier 执行本身异常/超时——没有拿到任何有效判定
  // A3 返工循环专用:重试次数耗尽仍被拒 → 终态 "failed"。本次(A1)orchestrator **不设置**此字段,
  // 即 "failed" 分支只定义类型与规则、不接自动触发器——见 decideReview 内注释。
  attemptsExhausted?: boolean;
}

export type ReviewVerdict = "accepted" | "needs_revision" | "failed" | "requires_human_review";

export interface ReviewDecision {
  status: ReviewVerdict;
  reason: string;
  // 本次 run 内要执行的效果:pass=产出进入合成;defer=标记"已延后"并剔除出合成输入。
  // requires_human_review 目前**没有**人工审查队列可挂起(A1 只把状态显式化,不改行为面),
  // 其 effect 按现状的降级路径走——详见 decideReview 内注释。
  effect: "pass" | "defer";
}

// Core 侧裁决规则(纯函数)。策略与现状外部行为逐分支等价:
//   accept===true  → accepted(产出进入合成,同现状)
//   accept===false → needs_revision(同现状"已延后/deferred"处理)
//   无有效判定(执行异常/解析失败/自相矛盾)→ requires_human_review,但 effect 先按现状降级路径走。
export function decideReview(p: ReviewProposal): ReviewDecision {
  // ── requires_human_review:没拿到可信判定,该由人看一眼。A1 阶段行为面保持现状
  // (先把状态显式化,不改执行效果),effect 完全跟随现状的布尔降级路径:
  //   - verifier 执行异常/空产出 → 现状按拒绝处理("异常不放行"铁律)→ defer;
  //   - 全无明确判定的保守接受(parseVerifierVerdict 分支③)→ 现状放行 → pass;
  //   - 自相矛盾 → 现状 reject 优先(accept=false)→ defer。
  // 等人工审查队列(后续里程碑)接上后,此分支的 effect 才改为挂起等待人工。
  if (p.verifierErrored) {
    return { status: "requires_human_review", effect: "defer", reason: p.reason ?? "verifier 执行失败,无有效判定" };
  }
  if (p.contradictory) {
    return { status: "requires_human_review", effect: p.accept ? "pass" : "defer", reason: p.reason ?? "verifier 判定自相矛盾(同时给出通过与拒绝)" };
  }
  if (p.parsed === false) {
    return { status: "requires_human_review", effect: p.accept ? "pass" : "defer", reason: p.reason ?? "verifier 产出无法解析出明确判定" };
  }
  // ── failed:返工重试耗尽仍被拒的终态。本次(A1)只定义类型与此分支,orchestrator 不设置
  // attemptsExhausted(无自动触发器)——A3 返工循环(needs_revision 回边)落地时才启用。
  if (p.attemptsExhausted && !p.accept) {
    return { status: "failed", effect: "defer", reason: p.reason ?? "返工重试耗尽,仍未通过审查" };
  }
  if (p.accept) return { status: "accepted", effect: "pass", reason: p.reason ?? "verifier 通过" };
  return { status: "needs_revision", effect: "defer", reason: p.reason ?? "verifier 拒绝" };
}

// review_committed 事件 payload(落 events.jsonl 的结构化裁决记录)。
export interface ReviewCommittedPayload {
  agentId: string; // 被审 producer
  verdict: ReviewVerdict;
  proposal: { accept: boolean; confidence?: number; reason?: string };
  decidedBy: "core";
}

type EmitFn = (type: TraceEvent["type"], agentId?: string, payload?: unknown) => void;

// 裁决 + 落一条结构化 review_committed 事件(事件挂在 verifierId 名下,payload.agentId 指被审 producer)。
// emit 由调用方注入。review_committed 是成功判定的耐久证据，写入失败必须向上抛出。
export function commitReview(
  proposal: ReviewProposal,
  ctx: { agentId: string; verifierId?: string; emit: EmitFn },
): ReviewDecision {
  const decision = decideReview(proposal);
  const payload: ReviewCommittedPayload = {
    agentId: ctx.agentId,
    verdict: decision.status,
    proposal: { accept: proposal.accept, confidence: proposal.confidence, reason: proposal.reason },
    decidedBy: "core",
  };
  ctx.emit("review_committed", ctx.verifierId, payload);
  return decision;
}
