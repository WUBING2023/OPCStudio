import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isValidLesson, commitLesson, retrieveLessons, retrieveLessonsForAgent, loadLessons, revokeLesson, bindLessonToAgent, type FailureMode } from "../storage/reflectionStore.js";
import { collectReflectionSignals, classifyTaskType, parseLessonProposals, reflectOnRun, type ReflectionSignal } from "./runCritic.js";

const NOW = "2026-07-01T12:00:00.000Z";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "refl-"));
  // validInput().evidence.runId 指向一个干净成功 run:补 task.json(done/verified)。fail-closed 硬化后,
  // 自动反思 lesson(sourceType 未标、无 user/import lifecycle)按 run 证据要求判定,缺 task.json 会被排除。
  // 本文件测的是角色/team 隔离、hits 衰减、绑定加权,不是 run 终态门 → 让来源 run 成为可证的干净 run。
  const runDir = path.join(root, ".opc", "runs", "aabf097d");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "task.json"), JSON.stringify({ id: "aabf097d", status: "done", finalState: "verified" }));
});

const validInput = (): Parameters<typeof commitLesson>[1] => ({
  kind: "failure_lesson" as const,
  scope: { companyId: "research-pro", teamId: "rp-lead", role: "test", agentId: "rp-factcheck", taskType: "fact_check" },
  trigger: { eventTypes: ["worker_timeout"], failureMode: "timeout" as FailureMode, conditionText: "多来源核查一次调用超 200s" },
  diagnosis: "核查任务一次吃下全部来源,单次调用过大",
  lesson: "多来源核查应按来源拆分,不要一次核查全部",
  recommendedChange: "每子任务限 3-5 条 claim 或单来源;超时前先写 partial.md",
  injection: { strength: "warning" as const, promptText: "上次多来源核查一次调用超时,这次按来源拆小步并提前写 partial" },
  evidence: { runId: "aabf097d", agentId: "rp-factcheck", metrics: { timeoutMs: 200000, deferredCount: 1 } },
  confidence: 0.7,
});

describe("reflectionStore · 硬过滤 isValidLesson", () => {
  it("完整可执行 → 通过", () => { expect(isValidLesson(validInput())).toBe(true); });
  it("缺角色 → 拒", () => { const l = validInput(); l.scope.role = undefined as any; expect(isValidLesson(l)).toBe(false); });
  it("缺证据 runId → 拒", () => { const l = validInput(); l.evidence.runId = "" as any; expect(isValidLesson(l)).toBe(false); });
  it("recommendedChange 太短 → 拒", () => { const l = validInput(); l.recommendedChange = "改一下"; expect(isValidLesson(l)).toBe(false); });
  it("空泛口号(要更认真/be careful)→ 拒", () => {
    const l = validInput(); l.recommendedChange = "下次要更认真更严谨地核查"; expect(isValidLesson(l)).toBe(false);
    const l2 = validInput(); l2.lesson = "be more careful and rigorous"; expect(isValidLesson(l2)).toBe(false);
  });
});

describe("reflectionStore · commit 去重版本化", () => {
  it("有效 → committed v1", () => {
    const r = commitLesson(root, validInput(), NOW);
    expect(r).not.toBeNull();
    expect(r!.version).toBe(1); expect(r!.status).toBe("committed");
    expect(loadLessons(root).length).toBe(1);
  });
  it("无效 → null,不落盘", () => {
    const bad = validInput(); bad.recommendedChange = "认真点";
    expect(commitLesson(root, bad, NOW)).toBeNull();
    expect(loadLessons(root).length).toBe(0);
  });
  it("同 role+taskType+failureMode → version+1 更新,而非新增", () => {
    commitLesson(root, validInput(), NOW);
    const again = validInput(); again.confidence = 0.9; again.recommendedChange = "改进版:按来源拆分且并发核查";
    const r2 = commitLesson(root, again, "2026-07-02T00:00:00.000Z");
    expect(r2!.version).toBe(2);
    expect(r2!.confidence).toBe(0.9); // 取高
    expect(loadLessons(root).length).toBe(1); // 仍是 1 条,版本更新
  });
});

describe("reflectionStore · 角色精准检索 retrieveLessons", () => {
  beforeEach(() => { commitLesson(root, validInput(), NOW); });
  it("角色匹配 + 同 taskType → 命中", () => {
    const got = retrieveLessons(root, { role: "test", taskType: "fact_check", teamId: "rp-lead" });
    expect(got.length).toBe(1); expect(got[0].scope.role).toBe("test");
  });
  it("**别的角色 → 一条不注入**(角色记忆纯粹)", () => {
    expect(retrieveLessons(root, { role: "dev", taskType: "fact_check" }).length).toBe(0);
    expect(retrieveLessons(root, { role: "pm", taskType: "coding" }).length).toBe(0);
  });
  it("撤销后不再检索到", () => {
    const id = loadLessons(root)[0].id;
    revokeLesson(root, id);
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
  });
});

describe("runCritic · 信号收集 + 分类 + 解析", () => {
  it("collectReflectionSignals:超时 deferred → timeout 信号带 timeoutMs", () => {
    const sigs = collectReflectionSignals({
      deferred: [{ agentId: "rp-factcheck", reason: "timeout", attempts: 1, lastError: "timeout after 200000ms" }],
      roleOf: (id) => (id === "rp-factcheck" ? "test" : undefined),
    });
    expect(sigs.length).toBe(1);
    expect(sigs[0]).toMatchObject({ role: "test", failureMode: "timeout" });
    expect(sigs[0].metrics?.timeoutMs).toBe(200000);
  });
  it("collectReflectionSignals:降级 → lead 信号", () => {
    const sigs = collectReflectionSignals({ deferred: [], degraded: true, degradedReason: "worker 全失败", roleOf: () => undefined });
    expect(sigs.some((s) => s.failureMode === "degraded" && s.role === "lead")).toBe(true);
  });
  it("classifyTaskType 稳定", () => {
    expect(classifyTaskType("核查这些来源是否属实")).toBe("fact_check");
    expect(classifyTaskType("写一个 python 函数实现排序")).toBe("coding");
    expect(classifyTaskType("写一份快排 vs 归并的技术对比报告")).toBe("research_report");
  });
  // 核心B+C:目标显式禁代码 → 永远不判 coding(与 taskRequiresCode 同用 goalForbidsCode 单一事实源),
  // 否则"不要编写代码"里的"代码"命中 coding 正则、误报 team_mismatch。
  it("classifyTaskType:显式禁代码的研究目标 → research_report(不被'代码'两字误判 coding)", () => {
    expect(classifyTaskType("研究量子计算进展并写报告，不要编写任何代码")).toBe("research_report");
    expect(classifyTaskType("分析密码学趋势，无需代码，只输出研究报告")).toBe("research_report");
  });
  it("parseLessonProposals 容忍 ```json 围栏 + 前后废话", () => {
    const a = parseLessonProposals('前言\n```json\n[{"role":"test"}]\n```\n结尾');
    expect(a.length).toBe(1); expect(a[0].role).toBe("test");
    expect(parseLessonProposals('[{"role":"dev"},{"role":"pm"}]').length).toBe(2);
    expect(parseLessonProposals("模型没给 json").length).toBe(0);
  });
});

describe("runCritic · reflectOnRun(mock 模型)端到端", () => {
  const signals = [{ agentId: "rp-factcheck", role: "test", failureMode: "timeout" as const, detail: "timeout after 200000ms", metrics: { timeoutMs: 200000, attempts: 1 } }];
  it("好教训成为治理候选;空泛内容被过滤;provenance 用真实 runId", async () => {
    const model = async () => JSON.stringify([
      { role: "TEST", conditionText: "多来源核查一次调用", diagnosis: "任务过大", lesson: "按来源拆分核查", recommendedChange: "每子任务限单来源并提前写 partial.md", promptText: "上次核查超时,这次按来源拆小步、提前写 partial", confidence: 0.7 },
      { role: "test", diagnosis: "x", lesson: "要更认真", recommendedChange: "认真点", promptText: "认真", confidence: 0.9 }, // 空泛 → 应被拒
    ]);
    const committed = await reflectOnRun({ projectRoot: root, runId: "REAL-RUN-123", goal: "多来源事实核查报告", signals, callModel: model, nowIso: NOW });
    expect(committed.length).toBe(1); // 只有好的那条
    const l = committed[0];
    expect(l.origin.role).toBe("test");
    expect(l.sourceRunId).toBe("REAL-RUN-123");
    expect(l.origin.failureMode).toBe("timeout");
    expect(l.origin.taskType).toBe("fact_check");
    expect(l.origin.metrics?.timeoutMs).toBe(200000);
    expect(loadLessons(root)).toEqual([]); // critic 不再旁路写 legacy store
  });
  it("模型抛错 → 静默返回空,不炸", async () => {
    const boom = async () => { throw new Error("model down"); };
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "g", signals, callModel: boom, nowIso: NOW });
    expect(committed).toEqual([]);
  });
  it("无信号 → 不调用模型、返回空", async () => {
    let called = false;
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "g", signals: [], callModel: async () => { called = true; return "[]"; }, nowIso: NOW });
    expect(committed).toEqual([]); expect(called).toBe(false);
  });
});

describe("对抗审查修复 · 强化项", () => {
  it("[#6] promptText(真正被注入的字段)空泛/太短 → 拒", () => {
    const short = validInput(); short.injection.promptText = "注意"; expect(isValidLesson(short)).toBe(false);
    const vague = validInput(); vague.injection.promptText = "下次要更认真严谨一点"; expect(isValidLesson(vague)).toBe(false);
  });

  it("[#8] 已注入过(hits>0)仍复现 → ineffective+1 且置信度**衰减**(不再 Math.max 反向抬高)", () => {
    const first = commitLesson(root, validInput(), NOW)!;
    retrieveLessons(root, { role: "test", taskType: "fact_check", bumpHits: true }); // 模拟被注入
    expect(loadLessons(root)[0].hits).toBeGreaterThan(0);
    const again = validInput(); again.confidence = 0.9;
    const r2 = commitLesson(root, again, "2026-07-03T00:00:00.000Z")!;
    expect(r2.ineffective).toBe(1);
    expect(r2.confidence).toBeLessThan(first.confidence); // 衰减
  });

  it("[#8] 连续无效 3 次 → 自动 revoke,不再被检索/注入", () => {
    commitLesson(root, validInput(), NOW);
    for (let i = 0; i < 3; i++) {
      retrieveLessons(root, { role: "test", taskType: "fact_check", bumpHits: true });
      commitLesson(root, validInput(), NOW);
    }
    expect(loadLessons(root)[0].status).toBe("revoked");
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
  });

  it("[#7] team 设了 → 硬隔离(别的 team 不注入;未标 team 的通用教训仍注入)", () => {
    const a = validInput(); a.scope.teamId = "team-A"; commitLesson(root, a, NOW);
    const generic = validInput(); generic.scope.teamId = undefined; generic.trigger.failureMode = "verifier_reject"; commitLesson(root, generic, NOW);
    const gotB = retrieveLessons(root, { role: "test", taskType: "fact_check", teamId: "team-B" });
    expect(gotB.some((l) => l.scope.teamId === "team-A")).toBe(false); // 别的 team 被隔离
    expect(gotB.some((l) => !l.scope.teamId)).toBe(true);              // 通用教训仍在
  });

  it("[#1] 单一失败 + 模型自报别的角色(ceo)→ 归到真实失败角色(test),绝不投毒 ceo", async () => {
    const signals = [{ agentId: "rp-factcheck", role: "test", failureMode: "timeout" as const, detail: "timeout after 200000ms", metrics: { timeoutMs: 200000 } }];
    const model = async () => JSON.stringify([{ role: "ceo", conditionText: "x", diagnosis: "y", lesson: "拆分核查子任务", recommendedChange: "以后按来源拆分核查并提前写 partial", promptText: "上次核查超时,这次按来源拆小步", confidence: 0.8 }]);
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "多来源核查", signals, callModel: model, nowIso: NOW });
    expect(committed.length).toBe(1);
    expect(committed[0].origin.role).toBe("test");                // 归到真实失败角色,不是模型自选的 ceo
    expect(retrieveLessons(root, { role: "ceo" }).length).toBe(0); // CEO 绝不被投毒
  });

  it("[#1/#10] 多角色失败 + 模型自报都不匹配 → 丢弃(不张冠李戴)", async () => {
    const signals: ReflectionSignal[] = [
      { agentId: "a1", role: "test", failureMode: "timeout", detail: "t" },
      { agentId: "a2", role: "dev", failureMode: "quality_gate_failed", detail: "q" },
    ];
    const model = async () => JSON.stringify([{ role: "pm", conditionText: "x", diagnosis: "y", lesson: "拆分处理子任务", recommendedChange: "以后按来源拆分处理并提前写 partial", promptText: "拆小步、提前写 partial", confidence: 0.8 }]);
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "g", signals, callModel: model, nowIso: NOW });
    expect(committed.length).toBe(0); // pm 不匹配 test/dev,多信号无法安全归属 → 丢弃
  });

  it("[#9] parseLessonProposals:单对象 + 字段含方括号 不再被误切", () => {
    const one = parseLessonProposals('{"role":"test","recommendedChange":"拆成子任务[3]批处理"}');
    expect(one.length).toBe(1); expect(one[0].role).toBe("test");
  });
});

describe("P0 · 补全项(规范化去重 / telemetry / antiPattern)", () => {
  it("dedup 按规范化 diagnosis:**不同根因**(同 role/taskType/failureMode)不再误并", () => {
    const a = validInput(); a.diagnosis = "一次核查全部来源导致超时";
    const b = validInput(); b.diagnosis = "网络检索接口不稳定导致超时";
    commitLesson(root, a, NOW);
    commitLesson(root, b, NOW);
    expect(loadLessons(root).length).toBe(2); // 不同根因 → 两条,不覆盖
  });

  it("dedup 规范化:**同根因不同数字**(200000ms vs 300000ms)→ 合并成一条(version+1)", () => {
    const a = validInput(); a.diagnosis = "单次核查耗时 200000ms 超上限";
    const b = validInput(); b.diagnosis = "单次核查耗时 300000ms 超上限";
    commitLesson(root, a, NOW);
    const r2 = commitLesson(root, b, "2026-07-03T00:00:00.000Z")!;
    expect(loadLessons(root).length).toBe(1); // 数字被归一 → 同 key → 合并
    expect(r2.version).toBe(2);
    expect(r2.support).toBe(2); // 又被一条信号支持
  });

  it("reflectOnRun 发候选 telemetry 且不直接持久化 legacy lesson", async () => {
    const events: Array<{ type: string }> = [];
    const signals: ReflectionSignal[] = [{ agentId: "rp-factcheck", role: "test", failureMode: "timeout", detail: "timeout after 200000ms", metrics: { timeoutMs: 200000 } }];
    const model = async () => JSON.stringify([{ role: "test", conditionText: "x", diagnosis: "一次核查全部来源", lesson: "按来源拆分核查", recommendedChange: "每子任务限单来源并提前写 partial", antiPattern: "禁止一次核查所有来源", promptText: "上次核查超时,这次按来源拆小步", confidence: 0.7 }]);
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "多来源核查", signals, callModel: model, nowIso: NOW, emitEvent: (type) => events.push({ type }) });
    expect(committed.length).toBe(1);
    expect(committed[0].antiPattern).toBe("禁止一次核查所有来源");
    expect(events.some((e) => e.type === "lesson_proposed")).toBe(true);
    expect(events.some((e) => e.type === "lesson_candidates_extracted")).toBe(true);
    expect(events.some((e) => e.type === "lesson_committed")).toBe(false);
    expect(loadLessons(root)).toEqual([]);
  });
});

describe("P1 · policy_candidate 不自动生效", () => {
  it("policy_candidate 存为 proposed、不被检索注入(留人工批准)", () => {
    const l = validInput(); l.injection.strength = "policy_candidate";
    const saved = commitLesson(root, l, NOW);
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe("proposed");
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
  });
  it("普通 warning lesson 仍自动 committed", () => {
    expect(commitLesson(root, validInput(), NOW)!.status).toBe("committed");
  });
});

describe("P0 · 系统/基础设施失败模式的教训只 proposed(不自动污染记忆)", () => {
  it("quality_gate_failed / degraded / provider_unavailable / rate_limited / quota_exceeded / no_account → proposed 留人工批准", () => {
    for (const fm of ["quality_gate_failed", "degraded", "provider_unavailable", "rate_limited", "quota_exceeded", "no_account"] as const) {
      const l = validInput(); l.trigger.failureMode = fm;
      const saved = commitLesson(root, l, NOW);
      expect(saved).not.toBeNull();
      expect(saved!.status, `${fm} 应为 proposed`).toBe("proposed"); // 系统自责/基础设施故障不自动 committed
    }
  });
  it("内容质量类失败(verifier_reject / artifact_rejected)仍自动 committed(agent 产出确有问题,是合法教训)", () => {
    for (const fm of ["verifier_reject", "artifact_rejected"] as const) {
      const l = validInput(); l.trigger.failureMode = fm;
      const saved = commitLesson(root, l, NOW);
      expect(saved!.status, `${fm} 应为 committed`).toBe("committed");
    }
  });
  it("timeout / retry_budget_exhausted 不在系统集里(真实执行失败,可为合法自动教训)→ committed", () => {
    for (const fm of ["timeout", "retry_budget_exhausted"] as const) {
      const l = validInput(); l.trigger.failureMode = fm;
      expect(commitLesson(root, l, NOW)!.status).toBe("committed");
    }
  });
});

describe("P0-P2 审查修复", () => {
  it("[fix1] collectReflectionSignals 用 teamIdOf 给每个信号绑各自 lead", () => {
    const sigs = collectReflectionSignals({
      deferred: [{ agentId: "wA", reason: "timeout" }, { agentId: "wB", reason: "timeout" }],
      roleOf: () => "dev",
      teamIdOf: (id) => (id === "wA" ? "lead-A" : "lead-B"),
    });
    expect(sigs.find((s) => s.agentId === "wA")?.teamId).toBe("lead-A");
    expect(sigs.find((s) => s.agentId === "wB")?.teamId).toBe("lead-B");
  });

  it("[fix1] reflectOnRun 用 signal 的 teamId,不再统一绑 input.teamId", async () => {
    const signals: ReflectionSignal[] = [{ agentId: "a1", role: "test", teamId: "lead-A", failureMode: "timeout", detail: "t" }];
    const model = async () => JSON.stringify([{ role: "test", conditionText: "x", diagnosis: "y", lesson: "拆分核查处理", recommendedChange: "按来源拆分并提前写 partial", promptText: "上次超时,这次按来源拆小步", confidence: 0.7 }]);
    const committed = await reflectOnRun({ projectRoot: root, runId: "r", goal: "多来源核查", teamId: "lead-Z", signals, callModel: model, nowIso: NOW });
    expect(committed[0].scope).toBe("team");
    expect(committed[0].scopeId).toBe("lead-A"); // 用信号自己的 lead,不是 input 的 lead-Z
  });

  it("[fix8] 撤销是终态:同类失败不再复活成新 committed", () => {
    const l = commitLesson(root, validInput(), NOW)!;
    revokeLesson(root, l.id); // 手动撤销
    const again = commitLesson(root, validInput(), "2026-07-06T00:00:00.000Z"); // 同 dedupeKey 再来
    expect(again?.status).toBe("revoked"); // 返回 revoked 原条,不新建
    expect(loadLessons(root).filter((x) => x.status === "committed").length).toBe(0);
    expect(loadLessons(root).length).toBe(1); // 没堆新条
  });

  it("[fix1] collectReflectionSignals:dropUnresolvedRole 跳过解析不到角色的信号;companyIdOf 绑公司", () => {
    const sigs = collectReflectionSignals({
      deferred: [{ agentId: "known", reason: "timeout" }, { agentId: "ghost", reason: "timeout" }],
      roleOf: (id) => (id === "known" ? "test" : undefined),
      companyIdOf: (id) => (id === "known" ? "co-1" : undefined),
      dropUnresolvedRole: true,
    });
    expect(sigs.length).toBe(1); // ghost 被跳过,不塌缩成 worker
    expect(sigs[0].role).toBe("test");
    expect(sigs[0].companyId).toBe("co-1");
  });

  it("[fix3] schema 不认的行在 commit 重写后被保留(不静默丢数据)", () => {
    const dir = path.join(root, ".opc", "memory");
    fs.mkdirSync(dir, { recursive: true });
    commitLesson(root, validInput(), NOW); // 合法一行
    fs.appendFileSync(path.join(dir, "lessons.jsonl"), JSON.stringify({ id: "x", weird: true }) + "\n"); // schema 不认
    commitLesson(root, validInput(), "2026-07-05T00:00:00.000Z"); // 触发 write-all
    expect(fs.readFileSync(path.join(dir, "lessons.jsonl"), "utf-8")).toContain('"weird":true'); // 仍在
  });
});

describe("C6 · bindLessonToAgent + retrieveLessonsForAgent(一键应用到员工训练)", () => {
  it("绑定后 boundAgentIds 追加去重,lifecycle 留痕;committed lesson 才有意义,revoked 不可绑", () => {
    const l = commitLesson(root, validInput(), NOW)!;
    const bound = bindLessonToAgent(root, l.id, "agent-1", "human", "2026-07-02T00:00:00.000Z")!;
    expect(bound.boundAgentIds).toEqual(["agent-1"]);
    expect(bound.lifecycle?.at(-1)).toMatchObject({ status: "bound:agent-1", by: "human" });
    // 幂等:同一员工再绑一次不重复
    const again = bindLessonToAgent(root, l.id, "agent-1", "human", "2026-07-03T00:00:00.000Z")!;
    expect(again.boundAgentIds).toEqual(["agent-1"]);
    // 可绑给第二个员工
    const two = bindLessonToAgent(root, l.id, "agent-2", "human", "2026-07-04T00:00:00.000Z")!;
    expect(two.boundAgentIds?.sort()).toEqual(["agent-1", "agent-2"]);
    // revoked 终态不可再绑
    revokeLesson(root, l.id);
    expect(bindLessonToAgent(root, l.id, "agent-3", "human", NOW)).toBeNull();
    // 不存在的 lesson
    expect(bindLessonToAgent(root, "lesson-nope", "agent-1", "human", NOW)).toBeNull();
  });

  it("retrieveLessons 的命中集合/排序不受绑定影响(不改动既有函数的检索行为——绑定只改被绑那条自己的字段)", () => {
    commitLesson(root, validInput(), NOW);
    const beforeIds = retrieveLessons(root, { role: "test", taskType: "fact_check" }).map((l) => l.id);
    const id = loadLessons(root)[0].id;
    bindLessonToAgent(root, id, "agent-1", "human", NOW);
    const afterIds = retrieveLessons(root, { role: "test", taskType: "fact_check" }).map((l) => l.id);
    expect(afterIds).toEqual(beforeIds);
  });

  it("retrieveLessonsForAgent:绑定给该员工的经验加权,挤进 limit 内(未绑定的普通检索排不进去)", () => {
    // 三条同角色候选:a(高置信度)/ b(低置信度,绑定给 agent-1)/ c(高置信度)——limit=2 时
    // 普通 retrieveLessons 会挑 a、c(置信度更高);retrieveLessonsForAgent(agent-1) 应该把 b 挤进来。
    const a = validInput(); a.diagnosis = "根因A"; a.confidence = 0.9; commitLesson(root, a, NOW);
    const b = validInput(); b.diagnosis = "根因B"; b.confidence = 0.5; commitLesson(root, b, NOW);
    const c = validInput(); c.diagnosis = "根因C"; c.confidence = 0.85; commitLesson(root, c, NOW);
    const all = loadLessons(root);
    const lessonB = all.find((x) => x.diagnosis === "根因B")!;
    bindLessonToAgent(root, lessonB.id, "agent-1", "human", NOW);

    const plain = retrieveLessons(root, { role: "test", taskType: "fact_check", limit: 2 });
    expect(plain.some((l) => l.diagnosis === "根因B")).toBe(false); // 置信度太低,普通检索挤不进 top2

    const boosted = retrieveLessonsForAgent(root, "agent-1", { role: "test", taskType: "fact_check", limit: 2 });
    expect(boosted[0].diagnosis).toBe("根因B"); // 绑定加权后排第一
  });

  it("retrieveLessonsForAgent 对没绑定过的员工:结果与 retrieveLessons 等价(不额外加权)", () => {
    commitLesson(root, validInput(), NOW);
    const id = loadLessons(root)[0].id;
    bindLessonToAgent(root, id, "agent-1", "human", NOW);
    const plain = retrieveLessons(root, { role: "test", taskType: "fact_check" });
    const forOther = retrieveLessonsForAgent(root, "agent-2", { role: "test", taskType: "fact_check" });
    expect(forOther.map((l) => l.id)).toEqual(plain.map((l) => l.id));
  });
});

describe("P0(用户要求)· 失败/降级 run 的反思一律只 proposed", () => {
  it("commitLesson runOutcome=failed_or_degraded → 即便低风险(timeout)也 proposed,不自动生效", () => {
    const r = commitLesson(root, validInput(), NOW, "failed_or_degraded");
    expect(r!.status).toBe("proposed");
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0); // 未生效不注入
  });
  it("commitLesson runOutcome=clean_verified → 低风险仍自动 committed", () => {
    const r = commitLesson(root, validInput(), NOW, "clean_verified");
    expect(r!.status).toBe("committed");
  });
  it("commitLesson 缺省 runOutcome → 旧行为 committed(零回归)", () => {
    expect(commitLesson(root, validInput(), NOW)!.status).toBe("committed");
  });
  it("已 committed 的教训被失败 run 反思复现更新 → 不降级回 proposed(clean run 立的教训稳定)", () => {
    const first = commitLesson(root, validInput(), NOW, "clean_verified");
    expect(first!.status).toBe("committed");
    const again = commitLesson(root, validInput(), NOW, "failed_or_degraded"); // 同 dedupeKey,失败 run 复现
    expect(again!.status).toBe("committed"); // 不被降级
  });
  it("reflectOnRun 传 runOutcome=failed_or_degraded → 产出的教训 status=proposed(不自动污染记忆)", async () => {
    const signals: ReflectionSignal[] = [{ agentId: "a1", role: "test", failureMode: "timeout", detail: "timeout after 200000ms", metrics: { timeoutMs: 200000 } }];
    const model = async () => JSON.stringify([{ role: "test", conditionText: "x", diagnosis: "y", lesson: "拆分核查子任务", recommendedChange: "按来源拆分并提前写 partial", promptText: "上次超时按来源拆小步", confidence: 0.8 }]);
    const saved = await reflectOnRun({ projectRoot: root, runId: "r", goal: "多来源核查", signals, callModel: model, nowIso: NOW, runOutcome: "failed_or_degraded" });
    expect(saved).toHaveLength(1);
    expect(saved[0].autoApprove).toBe(false);
    expect(loadLessons(root)).toEqual([]);
  });
});
