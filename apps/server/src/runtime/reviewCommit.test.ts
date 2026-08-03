import { describe, it, expect, beforeEach } from "vitest";
import { decideReview, commitReview, type ReviewProposal, type ReviewCommittedPayload } from "./reviewCommit.js";
import { parseVerifierVerdict } from "./verification.js";
import { emit, setRunId, getRunHistory } from "./eventBus.js";

// A1-V1:拆分 AI Reviewer 的判断权(verifier 产出 proposal)与状态提交权(Core 裁决四态)。
// 铁律:决策策略必须与现状外部行为等价——accept→合成 / reject→延后 / 无有效判定→按现状降级路径,
// 只是把状态显式化为四态并落 review_committed 事件。

describe("A1-V1 · decideReview 四态裁决(Core commits)", () => {
  it("proposal.accept===true → accepted,effect=pass(产出进入合成,同现状)", () => {
    const d = decideReview({ accept: true });
    expect(d.status).toBe("accepted");
    expect(d.effect).toBe("pass");
  });

  it("proposal.accept===false → needs_revision,effect=defer(同现状'已延后'处理),reason 透传", () => {
    const d = decideReview({ accept: false, reason: "第2段数据不实" });
    expect(d.status).toBe("needs_revision");
    expect(d.effect).toBe("defer");
    expect(d.reason).toBe("第2段数据不实");
  });

  it("verifier 执行异常(verifierErrored)→ requires_human_review,effect=defer(现状'异常不放行')", () => {
    const d = decideReview({ accept: false, verifierErrored: true, reason: "verifier 执行失败(不静默通过): timeout" });
    expect(d.status).toBe("requires_human_review");
    expect(d.effect).toBe("defer");
  });

  it("解析失败+现状判拒(空产出:accept=false, parsed=false)→ requires_human_review,effect=defer(行为面不变)", () => {
    const d = decideReview({ accept: false, parsed: false, reason: "verifier 无产出" });
    expect(d.status).toBe("requires_human_review");
    expect(d.effect).toBe("defer");
  });

  it("解析失败+现状保守放行(无明确判定:accept=true, parsed=false)→ requires_human_review,但 effect=pass(行为面不变)", () => {
    const d = decideReview({ accept: true, parsed: false });
    expect(d.status).toBe("requires_human_review");
    expect(d.effect).toBe("pass");
  });

  it("自相矛盾(contradictory)→ requires_human_review,effect 跟随现状 reject 优先(accept=false → defer)", () => {
    const d = decideReview({ accept: false, contradictory: true, reason: "拒绝。但整体通过" });
    expect(d.status).toBe("requires_human_review");
    expect(d.effect).toBe("defer");
  });

  it("failed 分支已定义:attemptsExhausted+被拒 → failed(本次无自动触发器,A3 返工循环才接)", () => {
    const d = decideReview({ accept: false, attemptsExhausted: true, reason: "三轮返工仍未通过" });
    expect(d.status).toBe("failed");
    expect(d.effect).toBe("defer");
  });

  it("attemptsExhausted 但 verifier 通过 → 仍是 accepted(耗尽只对'仍被拒'才成终态)", () => {
    const d = decideReview({ accept: true, attemptsExhausted: true });
    expect(d.status).toBe("accepted");
    expect(d.effect).toBe("pass");
  });

  it("边界:缺全部可选字段的最小 proposal 也能裁决(不抛),reason 有兜底文案", () => {
    expect(decideReview({ accept: true } as ReviewProposal).reason).toBeTruthy();
    expect(decideReview({ accept: false } as ReviewProposal).reason).toBeTruthy();
  });

  it("优先级:verifierErrored 压过 parsed/attemptsExhausted(执行异常时先要人看,不误判 failed)", () => {
    const d = decideReview({ accept: false, verifierErrored: true, parsed: false, attemptsExhausted: true });
    expect(d.status).toBe("requires_human_review");
  });
});

// 与 parseVerifierVerdict 的真实输出串起来:现状布尔行为(verification.test.ts 既有断言)在四态下的显式化。
describe("A1-V1 · parseVerifierVerdict → proposal → 四态(行为面与现状布尔判定逐例等价)", () => {
  function decideFromRaw(raw: string) {
    const v = parseVerifierVerdict(raw);
    return { v, d: decideReview({ accept: v.accept, reason: v.feedback, parsed: v.parsed, contradictory: v.contradictory }) };
  }

  it("明确通过 → accepted/pass;明确拒绝 → needs_revision/defer", () => {
    expect(decideFromRaw("通过,内容准确").d).toMatchObject({ status: "accepted", effect: "pass" });
    expect(decideFromRaw("拒绝。存在事实错误,第2段数据不实。").d).toMatchObject({ status: "needs_revision", effect: "defer" });
  });

  it("空产出 → requires_human_review 但仍 defer(= 现状 accept=false 的效果)", () => {
    expect(decideFromRaw("").d).toMatchObject({ status: "requires_human_review", effect: "defer" });
  });

  it("全无明确判定 → requires_human_review 但仍 pass(= 现状保守接受的效果)", () => {
    expect(decideFromRaw("这段写得还行吧").d).toMatchObject({ status: "requires_human_review", effect: "pass" });
  });

  it("首行自相矛盾(拒绝+通过并存)→ requires_human_review 但仍 defer(= 现状 reject 优先的效果)", () => {
    const { v, d } = decideFromRaw("拒绝,虽然多数段落可以通过。理由:核心数据无来源。");
    expect(v.contradictory).toBe(true);
    expect(d).toMatchObject({ status: "requires_human_review", effect: "defer" });
  });
});

describe("A1-V1 · commitReview 落 review_committed 结构化事件", () => {
  it("mock emit:事件挂 verifier 名下,payload 含 {agentId, verdict, proposal{accept,confidence,reason}, decidedBy:'core'}", () => {
    const events: Array<{ type: string; agentId?: string; payload: ReviewCommittedPayload }> = [];
    const d = commitReview(
      { accept: false, confidence: 0.8, reason: "缺来源" },
      { agentId: "rp-data", verifierId: "rp-fc", emit: (type, agentId, payload) => events.push({ type, agentId, payload: payload as ReviewCommittedPayload }) },
    );
    expect(d.status).toBe("needs_revision");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("review_committed");
    expect(events[0].agentId).toBe("rp-fc");
    expect(events[0].payload).toEqual({
      agentId: "rp-data",
      verdict: "needs_revision",
      proposal: { accept: false, confidence: 0.8, reason: "缺来源" },
      decidedBy: "core",
    });
  });

  it("propagates a durable review event failure", () => {
    expect(() => commitReview(
      { accept: true },
      { agentId: "w-1", emit: () => { throw new Error("bus down"); } },
    )).toThrow("bus down");
  });
});

// 端到端(真实 eventBus,同 eventBus.ephemeral.test.ts 的模式):orchestrator 把 eventBus.emit 原样注入
// commitReview——这里走同一条真实链路,断言 review_committed 进入 RunHistory(即会落 events.jsonl/SSE)。
// (orchestrator.test.ts 是被 vitest 排除的手动冒烟,全链 run 无法在单测里跑,故 e2e 锚定在 eventBus 层。)
describe("A1-V1 · review_committed 经真实 eventBus 可观测(端到端)", () => {
  beforeEach(() => setRunId("test-run-review-commit"));

  it("commitReview(注入真实 emit)→ RunHistory 出现 review_committed,payload 完整", () => {
    const before = getRunHistory().length;
    const d = commitReview(
      { accept: true, reason: "核查通过" },
      { agentId: "backend-engineer", verifierId: "code-reviewer", emit },
    );
    expect(d.status).toBe("accepted");
    const events = getRunHistory().getEvents();
    expect(events.length).toBe(before + 1);
    const last = events.at(-1)!;
    expect(last.type).toBe("review_committed");
    expect(last.agentId).toBe("code-reviewer");
    expect(last.payload).toMatchObject({
      agentId: "backend-engineer",
      verdict: "accepted",
      proposal: { accept: true, reason: "核查通过" },
      decidedBy: "core",
    });
  });
});
