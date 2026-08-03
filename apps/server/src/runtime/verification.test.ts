import { describe, it, expect } from "vitest";
import type { VerificationEdge } from "@opc/shared";
import {
  matchEdgesForProducer, programmaticVerify, parseVerifierVerdict, isCodingVerificationRun, pickCodeReviewProducer,
  verifierConcurrencyCap, VerifierConcurrencyGate, DEFAULT_VERIFIER_CONCURRENCY,
} from "./verification.js";
import { buildRunArtifactCollection } from "./artifactRegistry.js";
import type { Artifact } from "@opc/shared";

const edges: VerificationEdge[] = [
  { producer: "researcher", verifier: "fact_checker", method: "fact-check", onReject: "redo" },
  { producer: "rp-data", verifier: "rp-fc", method: "llm-review", onReject: "flag" },
  { producer: "*", verifier: "rp-fc", method: "custom", onReject: "flag" },
];

describe("Stage 6 · matchEdgesForProducer", () => {
  it("按 role / agentId / 通配匹配", () => {
    expect(matchEdgesForProducer(edges, "x", "researcher").map(e => e.method)).toEqual(["fact-check", "custom"]);
    expect(matchEdgesForProducer(edges, "rp-data", "dev").map(e => e.method)).toEqual(["llm-review", "custom"]);
    expect(matchEdgesForProducer(edges, "other", "writer").map(e => e.method)).toEqual(["custom"]); // 仅通配
    expect(matchEdgesForProducer(undefined, "x", "y")).toEqual([]);
  });
});

describe("Stage 6 · programmaticVerify(基于 artifactContract,确定性)", () => {
  it("fact-check:缺三段/无判定 → 拒;齐全 → 通过", () => {
    expect(programmaticVerify("随便一段没结构的文字", "fact-check").accept).toBe(false);
    const good = "## Claims\n地球是圆的\n\n## Verdict\nTrue\n\n## Sources\nhttps://example.com";
    expect(programmaticVerify(good, "fact-check").accept).toBe(true);
  });
  it("custom → 无程序化规则,默认通过", () => {
    expect(programmaticVerify("任意", "custom").accept).toBe(true);
  });
});

describe("Stage 6 · parseVerifierVerdict", () => {
  it("明确拒绝词 → reject 带反馈", () => {
    expect(parseVerifierVerdict("拒绝。存在事实错误,第2段数据不实。").accept).toBe(false);
    expect(parseVerifierVerdict("Verdict: False — unsupported claim").accept).toBe(false);
  });
  it("通过词 → accept;无明确判定 → 保守接受;空 → 拒", () => {
    expect(parseVerifierVerdict("通过,内容准确").accept).toBe(true);
    expect(parseVerifierVerdict("这段写得还行吧").accept).toBe(true);
    expect(parseVerifierVerdict("").accept).toBe(false);
  });
});

// A1-V1 增量:parsed/contradictory 解析上下文(accept 判定逐字不变,上面既有断言即回归证明)。
// 供 reviewCommit.ts 把"解析失败/自相矛盾"显式裁决为 requires_human_review。
describe("A1-V1 · parseVerifierVerdict 解析上下文(parsed/contradictory)", () => {
  it("明确判定(首行/兜底扫)→ parsed=true", () => {
    expect(parseVerifierVerdict("通过,内容准确").parsed).toBe(true);
    expect(parseVerifierVerdict("拒绝。存在事实错误").parsed).toBe(true);
    expect(parseVerifierVerdict("先说明背景。\n经复核,整体通过。").parsed).toBe(true); // 首行无判定,兜底扫命中
  });
  it("空产出 / 全无明确判定(保守接受)→ parsed=false", () => {
    expect(parseVerifierVerdict("").parsed).toBe(false);
    expect(parseVerifierVerdict("这段写得还行吧").parsed).toBe(false);
  });
  it("首行同时含拒绝与独立接受措辞 → contradictory=true(判定仍按现状 reject 优先)", () => {
    const v = parseVerifierVerdict("拒绝,虽然多数段落可以通过。理由:核心数据无来源。");
    expect(v.accept).toBe(false);
    expect(v.contradictory).toBe(true);
  });
  it("'未通过/不通过'这类含接受词素的拒绝短语 → 不误标 contradictory", () => {
    expect(parseVerifierVerdict("未通过:缺少来源。").contradictory).toBeFalsy();
    expect(parseVerifierVerdict("不通过,核查失败。").contradictory).toBeFalsy();
    expect(parseVerifierVerdict("not verified — sources missing").contradictory).toBeFalsy();
  });
});

describe("Block B · 编码型 run 检测 + trivial producer 选择(让 dev 真产出、验证边能触发)", () => {
  const codeEdges: VerificationEdge[] = [{ producer: "dev", verifier: "code_reviewer", method: "code-review", onReject: "redo" }];
  const researchEdges: VerificationEdge[] = [{ producer: "researcher", verifier: "fc", method: "fact-check", onReject: "redo" }];

  it("isCodingVerificationRun:有 code-review 边 → true;研究/空 → false", () => {
    expect(isCodingVerificationRun(codeEdges)).toBe(true);
    expect(isCodingVerificationRun(researchEdges)).toBe(false);
    expect(isCodingVerificationRun([])).toBe(false);
    expect(isCodingVerificationRun(undefined)).toBe(false);
  });

  it("pickCodeReviewProducer:优先选验证边 producer 角色对应的成员(而非第一个 child=pm)", () => {
    const workers = [{ id: "pm-2", role: "pm" }, { id: "dev-3", role: "dev" }, { id: "test-4", role: "test" }];
    expect(pickCodeReviewProducer(workers, codeEdges)).toBe("dev-3"); // 不是第一个的 pm-2
  });
  it("pickCodeReviewProducer:producer 也可按 agentId 匹配", () => {
    const workers = [{ id: "pm-2", role: "pm" }, { id: "eng-x", role: "implementer" }];
    expect(pickCodeReviewProducer(workers, [{ producer: "eng-x", verifier: "r", method: "code-review", onReject: "redo" }])).toBe("eng-x");
  });
  it("pickCodeReviewProducer:边里没匹配 → 退而按常见工程师角色名匹配", () => {
    const workers = [{ id: "pm-2", role: "pm" }, { id: "be-9", role: "backend" }];
    expect(pickCodeReviewProducer(workers, [{ producer: "dev", verifier: "r", method: "code-review", onReject: "redo" }])).toBe("be-9");
  });
  it("pickCodeReviewProducer:全无工程师角色 → null(调用方退回第一个)", () => {
    const workers = [{ id: "pm-2", role: "pm" }, { id: "w-1", role: "writer" }];
    expect(pickCodeReviewProducer(workers, codeEdges)).toBeNull();
  });
});

function wout(id: string, producedBy: string): Artifact {
  return { id, runId: "r", producedBy, kind: "text", name: `${producedBy} 产出`, type: "report", createdAt: "2026-06-30T00:00:00Z" } as Artifact;
}

describe("Stage 6 · registry review-result + 否决回标", () => {
  it("verifier 否决 → review-result(rejected,lineage reviewed-by)+ 被审产出回标 rejected 踢出交付", () => {
    const col = buildRunArtifactCollection({
      runId: "r1",
      artifacts: [wout("art-1", "rp-data"), wout("art-2", "rp-research")],
      deferred: [], degraded: false, hasReport: true, reportProducer: "rp-lead",
      verificationResults: [
        { reviewArtifactId: "rev-1", reviewedArtifactId: "rp-data", producerId: "rp-data", verifierId: "rp-fc", verifierRole: "test", method: "fact-check", accept: false, summary: "缺来源", createdAt: "2026-06-30T01:00:00Z" },
        { reviewArtifactId: "rev-2", reviewedArtifactId: "rp-research", producerId: "rp-research", verifierId: "rp-fc", verifierRole: "test", method: "fact-check", accept: true, summary: "通过", createdAt: "2026-06-30T01:00:00Z" },
      ],
    });
    // review-result artifacts
    const rev1 = col.artifacts.find(a => a.id === "rev-1");
    expect(rev1?.kind).toBe("review-result");
    expect(rev1?.status).toBe("rejected");
    expect(rev1?.producer).toBe("rp-fc");
    expect(rev1?.lineage?.[0]).toMatchObject({ sourceId: "art-1", relationship: "reviewed-by", via: "rp-fc" });
    expect(col.artifacts.find(a => a.id === "rev-2")?.status).toBe("accepted");
    // 被否决的 worker 产出回标 rejected、踢出交付(真影响交付)
    const reviewed = col.artifacts.find(a => a.id === "art-1");
    expect(reviewed?.status).toBe("rejected");
    expect(reviewed?.inFinalDeliverable).toBe(false);
    // 通过的不受影响
    expect(col.artifacts.find(a => a.id === "art-2")?.status).toBe("accepted");
    expect(col.artifacts.find(a => a.id === "art-2")?.inFinalDeliverable).toBe(true);
  });
});

// 架构修法(真实测试实锤):研究团队旗舰模板里"事实核查员"对 4 个 producer 逐份核查,3/4 被拒或"verifier
// 无产出"——orchestrator.ts 的 Stage 6 gate 本身已跨 producer 并行(Promise.all),但两处结构性缺口
// 没堵上:①并发无上限(同一 verifier 命中多个 producer 时对同一账号无界并发)②taskTimeoutMs 从未传给
// 这条调用链(角色画像的预算调整形同虚设)。下面覆盖新增的并发钳制机制本身。
describe("Stage 6 · verifierConcurrencyCap(并发上限设计)", () => {
  it("订阅制 CLI 框架(claude-code/codex)钳到 1——镜像 accountPool.ts 的 CLI_MAX_CONCURRENT,避免并行验证撞见风控封号风险", () => {
    expect(verifierConcurrencyCap("claude-code")).toBe(1);
    expect(verifierConcurrencyCap("codex")).toBe(1);
  });
  it("hermes / 未声明 framework → 默认上限(允许真并行,而非钳到 1)", () => {
    expect(verifierConcurrencyCap("hermes")).toBe(DEFAULT_VERIFIER_CONCURRENCY);
    expect(verifierConcurrencyCap(undefined)).toBe(DEFAULT_VERIFIER_CONCURRENCY);
    expect(DEFAULT_VERIFIER_CONCURRENCY).toBeGreaterThanOrEqual(3);
  });
  it("可传自定义默认上限,但下限钳到 1(0/负数不会造成死锁式的零并发)", () => {
    expect(verifierConcurrencyCap("hermes", 5)).toBe(5);
    expect(verifierConcurrencyCap("hermes", 0)).toBe(1);
    expect(verifierConcurrencyCap("hermes", -3)).toBe(1);
  });
});

describe("Stage 6 · VerifierConcurrencyGate(同一 verifier 并发钳制,不同 verifier 互不影响)", () => {
  it("同一 verifierId:超过上限的第 N+1 个请求排队,直到前面 release 才拿到槽位", async () => {
    const gate = new VerifierConcurrencyGate(() => 2);
    const release1 = await gate.acquire("fact-5");
    const release2 = await gate.acquire("fact-5");
    let acquired3 = false;
    const p3 = gate.acquire("fact-5").then((r) => { acquired3 = true; return r; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(acquired3).toBe(false); // cap=2 已占满,第 3 个应排队
    release1();
    const release3 = await p3;
    expect(acquired3).toBe(true);
    release2(); release3();
  });

  it("不同 verifierId 各自独立上限,互不排队(不同账号不该互相阻塞)", async () => {
    const gate = new VerifierConcurrencyGate(() => 1);
    const releaseA = await gate.acquire("verifier-A");
    let acquiredB = false;
    const releaseB = await gate.acquire("verifier-B").then((r) => { acquiredB = true; return r; });
    expect(acquiredB).toBe(true); // verifier-B 不受 verifier-A 占用影响
    releaseA(); releaseB();
  });

  it("某次持有者异常/超时后仍 release → 不占死槽位,下一个请求正常拿到", async () => {
    const gate = new VerifierConcurrencyGate(() => 1);
    const release1 = await gate.acquire("fact-5");
    try {
      throw new Error("verifier 无产出(模拟超时/异常)");
    } catch { /* 调用方(orchestrator.ts)用 try/finally 兜底,异常不吞并发槽位 */ }
    finally { release1(); }
    const release2 = await gate.acquire("fact-5");
    expect(typeof release2).toBe("function");
    release2();
  });
});

describe("Stage 6 · 并行验证的隔离(N 个 producer 共享同一 verifier,真并发、互不阻塞、判定互不传染)", () => {
  it("cap 足够容纳全部 producer 时,4 份审查真并发完成(而非排队顺序跑),各自判定互不影响", async () => {
    // 对应真实场景:研究团队 4 个 "producer: dev" worker 共享同一个"事实核查员"verifier。
    const gate = new VerifierConcurrencyGate(() => 4);
    const acquiredOrder: string[] = [];
    async function reviewProducer(id: string, ticks: number, verdict: "accept" | "reject" | "throw"): Promise<{ id: string; accept: boolean }> {
      const release = await gate.acquire("fact-5");
      try {
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        acquiredOrder.push(id);
        if (verdict === "throw") throw new Error(`${id}: verifier 无产出`);
        return { id, accept: verdict === "accept" };
      } finally {
        release();
      }
    }
    const results = await Promise.all([
      reviewProducer("dev-2", 3, "accept"),
      reviewProducer("dev-3", 1, "reject").catch(() => ({ id: "dev-3", accept: false })),
      reviewProducer("dev-4", 2, "throw").catch(() => ({ id: "dev-4", accept: false })), // 模拟超时/异常,不阻塞他人
      reviewProducer("dev-6", 1, "accept"),
    ]);
    // 全部 4 个 producer 都跑完了(无一被彼此永久阻塞)
    expect(results.map(r => r.id).sort()).toEqual(["dev-2", "dev-3", "dev-4", "dev-6"]);
    // dev-3 的拒绝、dev-4 的异常,都不影响 dev-2 / dev-6 各自算出的判定结果
    expect(results.find(r => r.id === "dev-2")!.accept).toBe(true);
    expect(results.find(r => r.id === "dev-6")!.accept).toBe(true);
    expect(results.find(r => r.id === "dev-3")!.accept).toBe(false);
    expect(results.find(r => r.id === "dev-4")!.accept).toBe(false);
    // 真并发的证据:ticks 少的(dev-3/dev-6,1 tick)比 ticks 多的(dev-2,3 ticks)先完成——
    // 若是顺序 await 一个个跑,完成顺序会严格等于派发顺序(dev-2 先于 dev-3),这里应相反。
    expect(acquiredOrder.indexOf("dev-3")).toBeLessThan(acquiredOrder.indexOf("dev-2"));
  });

  it("cap 小于 producer 数时,超额的请求排队,但仍会在前面完成后被处理到(无饿死)", async () => {
    const gate = new VerifierConcurrencyGate(() => 2); // 4 个 producer 共享 cap=2
    const completed: string[] = [];
    async function reviewProducer(id: string): Promise<void> {
      const release = await gate.acquire("fact-5");
      try {
        await Promise.resolve();
        completed.push(id);
      } finally {
        release();
      }
    }
    await Promise.all(["dev-2", "dev-3", "dev-4", "dev-6"].map((id) => reviewProducer(id)));
    expect(completed.sort()).toEqual(["dev-2", "dev-3", "dev-4", "dev-6"]);
  });
});
