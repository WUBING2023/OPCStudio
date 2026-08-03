import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 审计 P1-6 / P2 · 参与者计账确定性回归守卫。
//
// 背景:后置 verification-edge 的 verifier(llm-review / code-review)会真正发起一次引擎调用
// (产生 model_call + 成本 + review artifact)。它一旦跑了就必须计入 run.participatingAgents——
// 否则"本次参与 N 个 agent"这条交付证据会被少算(实测出现过把 CEO+lead+dev+reviewer 误报成 3 人)。
//
// 为什么是源码结构守卫而非活体全跑:该计账点埋在 startRun(千行主循环)最深处的 verifyWorker 闭包里,
// 且 G2 缩编策略会把非 expand run 的 verifier 直接裁掉——要活体触发一次 reviewer 引擎调用需要非常特定
// 的 company/edge/scale 组合,慢且脆。本仓库对"关键接线绝不可被静默删除"的既有惯例就是源码守卫
// (repositorySeam.guard / globalDoctor 绝不起子进程),这里沿用同一范式,锁死三条不变量:
//   1. 计账发生在【确实要跑 verifier 的分支内部】(分支跳过 = 不计账,不虚报);
//   2. 计账在 verifier 引擎调用【之前】(承诺要跑就先记名,调用抛错也已计入);
//   3. push 被 includes 幂等守卫(同一 verifier 审多份产出不会重复计数)。

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "orchestrator.ts"), "utf-8");

// 分支开口:只有 method 命中 llm-review/code-review 且 verifierAgent 存在才进——即"确实要跑 verifier"。
const BRANCH_OPEN = 'if ((edge.method === "llm-review" || edge.method === "code-review") && verifierAgent) {';
// 幂等计账:includes 守卫 + push(verifierAgent.id)。
const ACCOUNT_GUARD = "if (!run.participatingAgents.includes(verifierAgent.id)) { run.participatingAgents.push(verifierAgent.id);";
// verifier 引擎调用(真正在飞的审查节点)。
const VERIFIER_CALL = "vr = await runViaEngine(";

describe("参与者计账守卫 · verifier 跑了必计入 participatingAgents(审计 P1-6)", () => {
  it("三个锚点都存在(接线未被删)", () => {
    expect(SRC).toContain(BRANCH_OPEN);
    expect(SRC).toContain(ACCOUNT_GUARD);
    expect(SRC).toContain(VERIFIER_CALL);
  });

  it("计账 push 在【verifier 分支内部】且在【引擎调用之前】(跳过分支不计账 / 承诺跑就先记名)", () => {
    const branchIdx = SRC.indexOf(BRANCH_OPEN);
    const accountIdx = SRC.indexOf(ACCOUNT_GUARD);
    const callIdx = SRC.indexOf(VERIFIER_CALL, branchIdx);
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(accountIdx).toBeGreaterThan(branchIdx); // 分支开口之后 → 在分支体内
    expect(callIdx).toBeGreaterThan(accountIdx);    // 引擎调用之前 → 先记名再发起
  });

  it("push 被 includes 幂等守卫(同一 verifier 审多份产出不重复计数)", () => {
    // ACCOUNT_GUARD 本身即"includes 取反才 push"的合体断言;这里显式再钉一次守卫措辞,防止有人只留裸 push。
    expect(SRC).toMatch(/if \(!run\.participatingAgents\.includes\(verifierAgent\.id\)\)\s*\{\s*run\.participatingAgents\.push\(verifierAgent\.id\)/);
  });
});
