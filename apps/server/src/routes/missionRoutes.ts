import type { Express } from "express";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { AgentNodeConfig, TaskGraph, TaskNode } from "@opc/shared";
import {
  loadMissions, getMission, upsertMission, applyMissionPatch, generateMissionBrief,
  type MissionBrief, type SuggestedRunType, type SuggestedTeamMode,
} from "../runtime/missionBrief.js";
import { startRun, isRunInFlight, type RunType, type TeamMode } from "../runtime/orchestrator.js";
import { startGoal } from "../runtime/goalRunner.js";
import { invokeSystemModel } from "../runtime/systemModelInvoke.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { markPrecreatedRunFailed, precreateRunTask, decideAndRecordRunGovernance, approveGovernanceForRun } from "../runtime/runLifecycle.js";
import { estimateTaskComplexity } from "../runtime/taskComplexityEstimator.js";
import { taskRequiresCode } from "../runtime/deliveryAcceptance.js";
import { loadAgents, loadRunReport, bindRunObservability } from "../storage/projectStore.js";
import { writeJSON, readJSON } from "../storage/jsonFile.js";
import { generateTaskGraphProposal, validateProposal, executeGraph, parseReviewVerdict } from "../runtime/taskGraphScheduler.js";
import { isRunInFlightError, configureDispatchCoordinator, dispatchOrEnqueue, type DispatchQueueItem } from "../runtime/runMutex.js";
import { listDispatchQueue, removeDispatchItem } from "../storage/dispatchQueueStore.js";
import { resumeDispatchQueueOnStartup } from "../runtime/startupReconcile.js";
import { upsertTaskGraph, getTaskGraphByMission } from "../storage/taskGraphStore.js";
import { emit } from "../runtime/eventBus.js";
import { loadArtifactRegistry } from "../runtime/artifactRegistry.js";
import { loadEvidenceManifest } from "../runtime/evidenceManifest.js";

// 跨源撞闸缓解:图执行(maxConcurrency=1 已消化同图并发)期间,用户手动发起的 run 仍会让节点派发
// 撞上 orchestrator 单 run 互斥闸(直接抛错不排队)。这不是节点本身的失败——有限重试+递增退避等它
// 让路,而不是让节点瞬间 failed 并 taint 整条下游。仅对互斥闸错误重试;其余错误原样抛出。
export const RUN_MUTEX_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
export async function dispatchWithMutexRetry<T>(
  attempt: () => Promise<T>,
  opts: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, delayMs: number) => void } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? RUN_MUTEX_RETRY_DELAYS_MS;
  const doSleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= delays.length || !isRunInFlightError(e)) throw e;
      opts.onRetry?.(i + 1, delays[i]);
      await doSleep(delays[i]);
    }
  }
}

// P1-5 · 真实"起 run"函数,注入给派发协调器(configureDispatchCoordinator)。协调器在无活 run 时
// (立即派发)与 run 结束出队派发下一单时都调这里 —— 两条路径共用同一起跑逻辑,保证语义一致。
// fire-and-forget:自带 .catch,失败把预建 run 标 failed(与旧 else 分支的错误处理逐字节一致)。
function launchDispatchItem(projectRoot: string, item: DispatchQueueItem): void {
  // 缺口①配套守卫(2026-07-18):队列项可能已过时——governance 重打 approve 已直派、run 已被拒绝
  // 收尾 cancelled、或经其他路径起跑/完结。只有仍处 pending 的预建 run 才允许出队起跑;对非 pending
  // 残单如实跳过丢弃,绝不二次起跑覆盖真实终态(不造假宪法:终态只能由真实执行产生一次)。
  try {
    const task = readJSON<{ status?: string } | null>(path.join(projectRoot, ".opc", "runs", item.runId, "task.json"), null);
    if (task && task.status && task.status !== "pending") {
      console.warn(`Dispatch queue run ${item.runId} 已处 ${task.status}(非 pending),跳过出队起跑`);
      return;
    }
  } catch { /* task.json 读不到 → 维持旧行为照常起跑 */ }
  startRun(item.goal, item.runId, item.companyId, {
    runType: item.runType as RunType | undefined,
    teamMode: item.teamMode as TeamMode | undefined,
    targetAgentId: item.targetAgentId,
  }).catch((e: any) => {
    markPrecreatedRunFailed(projectRoot, item.runId, e);
    console.error(`Dispatch queue run ${item.runId} failed:`, e?.message ?? e);
  });
}

// E1 复杂度预估:从 mission 结构取估算输入(公司 agent 数从 agents.json 按 companyId 过滤;
// permissionNeeds 映射代码/MCP/shell 信号:write_code→代码信号,external_actions→MCP+shell)。
// 纯规则估算见 runtime/taskComplexityEstimator.ts;这里只做取数与快照,不做任何判断逻辑。
function buildMissionEstimate(projectRoot: string, mission: MissionBrief) {
  const companyId = mission.companyId ?? "default";
  const agentCount = loadAgents(projectRoot, []).filter(a => (a.companyId ?? "default") === companyId).length;
  return estimateTaskComplexity({
    goalText: mission.interpretedGoal || mission.originalIdea,
    agentCount,
    expectedArtifactCount: mission.expectedArtifacts.length,
    hasCodeSignals: mission.permissionNeeds === "write_code" ? true : undefined,
    involvesMcp: mission.permissionNeeds === "external_actions" ? true : undefined,
    involvesShell: mission.permissionNeeds === "external_actions" ? true : undefined,
  });
}

// 令五.4 · 观测任务图生成(Chat 英雄回路 + 普通 mission 派发共用):
// team/编码 run → CEO 真实拆解(generateTaskGraphProposal → Core 六项校验),得到含角色/依赖的拆解树;
// quick 直答 / 拆解失败 → 单节点占位图(仍承接到真实 agent),让详情页有据可查而非黑箱。
// 图为"计划视图":Chat 英雄回路是单 orchestrator run 整体执行(worktree/交叉验证/交付验收都在这一个 run 内),
// 不像 mission task-graph 那样逐节点各起一个 run;因此节点级实时状态不逐个驱动,run 收尾时由 orchestrator
// 的 reconcileObservabilityGraph 把整图收敛到 completed/failed 终态(诚实,不伪造逐节点完成)。
export async function generateRunTaskGraph(
  projectRoot: string,
  mission: MissionBrief,
  effRunType: SuggestedRunType,
): Promise<TaskGraph | null> {
  const agents = loadAgents(projectRoot, []);
  const isTeam = effRunType === "team" || taskRequiresCode(mission.interpretedGoal);
  if (isTeam) {
    try {
      const { proposal } = await generateTaskGraphProposal(projectRoot, mission, agents);
      if (proposal) {
        const verdict = validateProposal(proposal, agents, {
          companyId: mission.companyId ?? "default",
          missionId: mission.id,
          goal: mission.interpretedGoal,
        });
        if (verdict.ok && verdict.graph) return upsertTaskGraph(projectRoot, verdict.graph);
      }
    } catch { /* 拆解失败(模型无法解析 / 校验不过)→ 落单节点占位,绝不因可观测性拦 run */ }
  }
  return upsertTaskGraph(projectRoot, buildSingleNodeGraph(mission, agents));
}

function buildSingleNodeGraph(mission: MissionBrief, agents: AgentNodeConfig[]): TaskGraph {
  const companyId = mission.companyId ?? "default";
  const roster = agents.filter(a => (a.companyId ?? "default") === companyId && a.enabled !== false);
  // 承接者优先非 CEO(实际动手的人),独苗公司退回 CEO,再退任意成员;都没有则空 id(校验侧不经过此路)。
  const primary = roster.find(a => a.role !== "ceo") ?? roster.find(a => a.role === "ceo") ?? roster[0];
  const now = new Date().toISOString();
  const goal = (mission.interpretedGoal || mission.originalIdea || "任务").trim();
  const node: TaskNode = {
    id: "n1",
    title: goal.slice(0, 60),
    goal,
    assignedAgentId: primary?.id ?? "",
    assignedRole: primary?.role,
    dependsOn: [],
    expectedArtifacts: mission.expectedArtifacts?.length ? mission.expectedArtifacts.slice(0, 3) : ["result.md"],
    status: "planned",
    statusHistory: [{ status: "planned", at: now, by: "core" }],
    kind: "work",
  };
  return {
    id: `tg-${randomUUID().slice(0, 8)}`,
    missionId: mission.id,
    companyId,
    goal,
    nodes: [node],
    status: "committed",
    createdAt: now,
    updatedAt: now,
    schemaVersion: "1",
  };
}

// Mission Brief API(Plan 阶段:模糊 idea → 结构化简报 → 用户确认/编辑 → approve 才真正调度执行)。
// POST  /api/missions              {ideaText, companyId?} → 201 MissionBrief(approvalStatus="draft")
// PATCH /api/missions/:id          部分可编辑字段 → 200 更新后的 MissionBrief
// POST  /api/missions/:id/approve  {runType?, teamMode?} → 200 { approved, dispatched: {kind, id} }
//                                  {dispatchMode:"task-graph"} → 200 { approved, taskGraphId, graph } / 422 { errors }(A2)
// GET   /api/missions/:id/task-graph → TaskGraph(A2,C2 拆解树消费)
// POST  /api/missions/:id/stop     草稿阶段直接标记 stopped(approved 之后走各自的 run/goal/loop stop)
// GET   /api/missions/:id          → MissionBrief
// GET   /api/missions?companyId=   → MissionBrief[]
// POST  /api/intent/classify       {text} → { mode: chat|plan|execute, confidence }
export function register(app: Express, projectRoot: string) {
  // P1-5:接线派发协调器(注入真实起 run 函数 + 单 run 探针),并在启动时恢复盘上遗留的派发队列
  // (重启后队列仍在盘上,此处出队派发队首,后续依次由 run 结束自动串起)。
  configureDispatchCoordinator({ start: (item) => launchDispatchItem(projectRoot, item), isInFlight: isRunInFlight });
  try { resumeDispatchQueueOnStartup(projectRoot); } catch (e) { console.warn("[OPC] 派发队列启动恢复失败(不影响启动):", e); }

  // P1-5 · 队列可查:GET /api/dispatch-queue[?companyId=] → 排队中的派发项(带 1 基位次)。
  app.get("/api/dispatch-queue", (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const items = listDispatchQueue(projectRoot);
    const withPos = items.map((it, idx) => ({ ...it, position: idx + 1 }));
    res.json(companyId ? withPos.filter(it => (it.companyId ?? "default") === companyId) : withPos);
  });

  // P1-5 · 队列可撤:DELETE /api/dispatch-queue/:id(:id 可为队列项 id 或 runId)。撤单后把预建的
  // run 占位标记为失败(注明用户撤销),避免留下永久 pending 僵尸 run。
  app.delete("/api/dispatch-queue/:id", (req, res) => {
    const removed = removeDispatchItem(projectRoot, req.params.id);
    if (!removed) return res.status(404).json({ error: "queue item not found" });
    try { markPrecreatedRunFailed(projectRoot, removed.runId, new Error("用户撤销了排队中的任务")); } catch { /* 占位清理失败不阻塞撤单 */ }
    res.json({ removed: true, item: removed });
  });

  app.get("/api/missions", (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const all = loadMissions(projectRoot);
    res.json(companyId ? all.filter(m => m.companyId === companyId) : all);
  });

  app.get("/api/missions/:id", (req, res) => {
    const mission = getMission(projectRoot, req.params.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    res.json(mission);
  });

  app.post("/api/missions", async (req, res) => {
    try {
      const { ideaText, companyId } = (req.body ?? {}) as { ideaText?: string; companyId?: string };
      if (!ideaText || typeof ideaText !== "string" || !ideaText.trim()) {
        return res.status(400).json({ error: "ideaText required" });
      }
      const integrity = checkTextIntegrity(ideaText);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
      const brief = await generateMissionBrief(projectRoot, ideaText.trim(), typeof companyId === "string" ? companyId : undefined);
      brief.complexityEstimate = buildMissionEstimate(projectRoot, brief); // E1:Plan 阶段就给面板预估
      upsertMission(projectRoot, brief);
      res.status(201).json(brief);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "mission brief generation failed" });
    }
  });

  app.patch("/api/missions/:id", (req, res) => {
    const mission = getMission(projectRoot, req.params.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    const patch = (req.body ?? {}) as Record<string, unknown>;
    // interpretedGoal 等字段会直接成为后续 startGoal/startRun 的 goal 文本(approve 路由里的
    // mission.interpretedGoal)——patch 里任何字符串字段都按同一道防线校验,不只挑 interpretedGoal
    // 一个字段(白名单以外的字段 applyMissionPatch 本来就会忽略,这里只是防线前置,不重复其白名单逻辑)。
    for (const [key, val] of Object.entries(patch)) {
      if (typeof val !== "string") continue;
      const integrity = checkTextIntegrity(val);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: `字段「${key}」${integrity.reason}` });
    }
    const next = applyMissionPatch(mission, patch);
    upsertMission(projectRoot, next);
    res.json(next);
  });

  app.post("/api/missions/:id/stop", (req, res) => {
    const mission = getMission(projectRoot, req.params.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    if (mission.approvalStatus !== "draft") {
      return res.status(409).json({ error: "只能停止草稿阶段的 mission;已 approve 的请用对应 run/goal/loop 的 stop 接口" });
    }
    mission.approvalStatus = "stopped";
    upsertMission(projectRoot, mission);
    res.json({ stopped: true });
  });

  app.post("/api/missions/:id/approve", async (req, res) => {
    const mission = getMission(projectRoot, req.params.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    if (mission.approvalStatus !== "draft") {
      return res.status(409).json({ error: `mission 已处于 ${mission.approvalStatus} 状态,不能重复 approve` });
    }

    const body = (req.body ?? {}) as { runType?: string; teamMode?: string; dispatchMode?: string };
    if (body.teamMode !== undefined && !["configured", "economy", "balanced", "maxQuality"].includes(body.teamMode)) {
      return res.status(400).json({ error: "teamMode must be configured, economy, balanced, or maxQuality" });
    }
    const effRunType: SuggestedRunType = body.runType === "quick" || body.runType === "team" ? body.runType : mission.suggestedRunType;
    const effTeamMode: SuggestedTeamMode | undefined =
      body.teamMode === "configured" ? undefined
        : ["economy", "balanced", "maxQuality"].includes(body.teamMode as string) ? (body.teamMode as SuggestedTeamMode)
          : mission.suggestedTeamMode;


    // 调度判断:team 型 + 有 >=2 条明确成功标准 → 更适合 Harness 语义(验收官逐条核对、达成即停),
    // 走 goalRunner.startGoal(acceptanceCriteria = successCriteria);否则走 orchestrator.startRun
    // 单轮直出(quick 恒走这条,team 但标准不明确的也走这条,不强行套 Harness)。
    const useHarness = effRunType === "team" && mission.successCriteria.length >= 2;

    // E1:派发前重算一次预估(interpretedGoal 可能在 Plan 阶段被 PATCH 过,创建时的快照会过期;
    // 旧 mission 本来就没有 complexityEstimate 字段,这里重算即天然兼容)。
    mission.complexityEstimate = buildMissionEstimate(projectRoot, mission);

    // A2 · 第三条派发路径:dispatchMode="task-graph" → CEO 结构化提案 → Core 六项校验 →
    // commit 图 + 异步按拓扑序串行执行。校验失败 422(mission 停留 draft,可改后重试);
    // 旧两条路径(useHarness/startRun)不受任何影响。
    if (body.dispatchMode === "task-graph") {
      try {
        const agents = loadAgents(projectRoot, []);
        const { proposal, reason } = await generateTaskGraphProposal(projectRoot, mission, agents);
        if (!proposal) {
          return res.status(422).json({ error: "CEO task_graph_proposal 解析失败", errors: [reason ?? "无法解析提案"] });
        }
        const verdict = validateProposal(proposal, agents, {
          companyId: mission.companyId ?? "default",
          missionId: mission.id,
          goal: mission.interpretedGoal,
        });
        if (!verdict.ok || !verdict.graph) {
          return res.status(422).json({ error: "task graph 校验失败", errors: verdict.errors });
        }
        const graph = upsertTaskGraph(projectRoot, verdict.graph);
        mission.approvalStatus = "approved";
        upsertMission(projectRoot, mission);
        // 先响应再起跑:executeGraph 同步段就会把同一个 graph 对象置为 running,
        // 先 res.json 保证响应体是 committed 时刻的快照。
        res.json({ approved: true, taskGraphId: graph.id, graph, complexityEstimate: mission.complexityEstimate });
        // 异步执行:节点派发复用 quick run + targetAgentId 定向。orchestrator 的单 run 互斥对
        // 并发到达的 startRun 是直接抛错而不是排队,所以必须 maxConcurrency=1:同批就绪节点
        // 由调度器串行派发,并行分支不会撞互斥闸瞬间失败。
        executeGraph(projectRoot, graph, {
          maxConcurrency: 1,
          dispatch: async ({ node, goal }) => {
            const runId = uuid();
            precreateRunTask(projectRoot, { runId, goal, companyId: mission.companyId });
            // E3/E4:mission approve 本身就是紧邻本次派发的人工批准动作 → L3 record 直接标批准留痕,
            // 不对同一个用户动作要求二次审批(L0-L2 只落 record,无审批语义)。
            try {
              const rec = decideAndRecordRunGovernance(projectRoot, { runId, goal, companyId: mission.companyId });
              if (rec.approvalRequired) approveGovernanceForRun(projectRoot, runId, "mission-approve");
            } catch { /* 治理是加性防线,判级失败不拦派发 */ }
            try {
              const r = await dispatchWithMutexRetry(
                () => startRun(goal, runId, mission.companyId, { runType: "quick", targetAgentId: node.assignedAgentId }),
                {
                  onRetry: (attempt, delayMs) => emit("info", node.assignedAgentId, {
                    message: `任务图节点 ${node.id} 派发撞上单 run 互斥闸(可能有手动 run 正在进行),${Math.round(delayMs / 1000)}s 后重试(第 ${attempt}/${RUN_MUTEX_RETRY_DELAYS_MS.length} 次)`,
                  }),
                },
              );
              // 节点成功不能只等于"startRun 没抛错":quick 路径引擎失败会以 "(no output)" 正常 resolve,
              // 空产出标 completed 会把空摘要喂给下游节点(对抗验收问题#2)。空/无产出一律判节点失败。
              const summary = (r?.summary ?? "").trim();
              if (!summary || summary === "(no output)") {
                return { ok: false, runId, error: "节点产出为空(引擎无输出),不计为完成" };
              }
              const artifactRefs = (loadArtifactRegistry(projectRoot, runId)?.artifacts ?? [])
                .map(artifact => artifact.id)
                .filter(Boolean)
                .slice(0, 100);
              const evidenceRefs = loadEvidenceManifest(path.join(projectRoot, ".opc", "runs", runId))
                ? [`run:${runId}:evidence-manifest.json`]
                : [];
              // A3:审查节点(kind="review")的产出要解析出 verdict,交给 executeGraph 触发被审节点返工。
              // startRun 返回的 summary 被截到 500 字符,按审查指令写在末行的 VERDICT 多半被切掉
              // (解析不到会保守误判 needs_revision)——裁决必须从落盘的完整报告(report.md)解析,
              // summary 只作展示/下游摘要用。
              if (node.kind === "review") {
                let verdictSource = summary;
                const full = loadRunReport(projectRoot, runId);
                if (full && full.trim()) verdictSource = full; // 报告缺失时回退截断 summary:最坏是保守多返工一轮,不会误放行
                return { ok: true, runId, summary, artifactRefs, evidenceRefs, verdict: parseReviewVerdict(verdictSource) };
              }
              return { ok: true, runId, summary, artifactRefs, evidenceRefs };
            } catch (e: any) {
              markPrecreatedRunFailed(projectRoot, runId, e);
              return { ok: false, runId, error: e?.message ?? String(e) };
            }
          },
          emit: (type, agentId, payload) => emit(type, agentId, payload),
        }).catch(e => console.error(`Mission ${mission.id} task graph ${graph.id} 执行异常:`, e?.message ?? e));
        return;
      } catch (e: any) {
        return res.status(422).json({ error: e?.message ?? "task graph 派发失败", errors: [String(e?.message ?? e)] });
      }
    }

    try {
      let dispatched: { kind: "run" | "goal" | "loop"; id: string };
      let queued = false;
      let queuePosition = 0;
      if (useHarness) {
        const rec = startGoal(projectRoot, mission.interpretedGoal, {
          companyId: mission.companyId,
          acceptanceCriteria: mission.successCriteria,
        });
        dispatched = { kind: "goal", id: rec.id };
      } else {
        const runId = uuid();
        dispatched = { kind: "run", id: runId };
        // P1-5:预建占位用 pending(不是 running)—— 撞忙入队的 run 会以此状态在盘上等待,启动对账只降级
        // running 僵尸,pending 占位天然幸存;立即起跑的那单 startRun 内 createRun 会马上覆写为 running。
        precreateRunTask(projectRoot, { runId, goal: mission.interpretedGoal, companyId: mission.companyId, status: "pending" });
        // 令五.4:普通 startRun 分支也让本 mission 拥有可观测任务图(详情页反查用)。missionId 同步绑到
        // task.json(startRun 起跑时磁盘合并保留),任务图异步生成后回填 taskGraphId,均不阻塞派发。
        try { bindRunObservability(projectRoot, runId, { missionId: mission.id }); } catch { /* 加性 */ }
        void generateRunTaskGraph(projectRoot, mission, effRunType)
          .then(g => { if (g) { try { bindRunObservability(projectRoot, runId, { taskGraphId: g.id }); } catch { /* 加性 */ } } })
          .catch(() => { /* 可观测性是加性防线,失败绝不影响 run */ });
        // E1:run 建立即落估算快照(独立文件,不动 Run 类型/runLifecycle,对现有代码零侵入)。
        writeJSON(path.join(projectRoot, ".opc", "runs", runId, "complexity-estimate.json"), mission.complexityEstimate);
        // E3/E4:mission approve 即人工批准 → L3 record 直接标批准留痕(见 task-graph 分支同款注释)。
        // permissionNeeds=external_actions 映射 shell/MCP 信号,与上方 buildMissionEstimate 同口径。
        try {
          const rec = decideAndRecordRunGovernance(projectRoot, {
            runId, goal: mission.interpretedGoal, companyId: mission.companyId,
            involvesShell: mission.permissionNeeds === "external_actions" ? true : undefined,
            involvesMcp: mission.permissionNeeds === "external_actions" ? true : undefined,
          });
          if (rec.approvalRequired) approveGovernanceForRun(projectRoot, runId, "mission-approve");
        } catch { /* 治理是加性防线,判级失败不拦派发 */ }
        // P1-5:撞上单 run 互斥闸不再直接抛错 → 入持久化队列;无活 run 才立即起跑。run 结束会自动出队派发下一单。
        const decision = dispatchOrEnqueue(projectRoot, {
          id: uuid(), runId, goal: mission.interpretedGoal, companyId: mission.companyId,
          runType: effRunType as "quick" | "team", teamMode: effTeamMode as DispatchQueueItem["teamMode"],
          enqueuedAt: new Date().toISOString(),
        });
        queued = decision.queued;
        queuePosition = decision.position;
      }

      mission.approvalStatus = "approved";
      upsertMission(projectRoot, mission);
      res.json({ approved: true, dispatched, complexityEstimate: mission.complexityEstimate, queued, queuePosition });
    } catch (e: any) {
      res.status(409).json({ error: e?.message ?? "dispatch failed" });
    }
  });

  // A2:任务图查询(C2 拆解树消费;一个 mission 多次提案时返回最新一份)。本批只出 API,不做 UI。
  app.get("/api/missions/:id/task-graph", (req, res) => {
    const graph = getTaskGraphByMission(projectRoot, req.params.id);
    if (!graph) return res.status(404).json({ error: "task graph not found" });
    res.json(graph);
  });

  app.post("/api/intent/classify", async (req, res) => {
    try {
      const { text } = (req.body ?? {}) as { text?: string };
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text required" });
      }
      const integrity = checkTextIntegrity(text);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
      const prompt = `判断用户这句输入属于哪种意图模式,只输出 JSON,不要其他文字。

模式定义:
- chat:闲聊或就已有内容提问/答疑,不需要规划或执行(例:"解释一下这个文件"、"你好"、"这是什么意思")
- plan:有一个模糊 idea 想先展开成方案,或想讨论评估某个方案(例:"帮我看看这个方案怎么样"、"我有个idea帮我想成产品"、"这个功能该怎么设计")
- execute:已经想清楚,要求直接开始执行(例:"按照这个方案开始实现"、"跑一个完整研究任务"、"帮我把这个功能写出来")

用户输入:
${text.trim().slice(0, 500)}

只输出:{"mode": "chat|plan|execute", "confidence": 0到1之间的小数}`;

      const record = await invokeSystemModel(projectRoot, "judge", {
        agentId: "intent-classifier",
        messages: [{ role: "user", content: prompt }], maxTokens: 100, agentRole: "classifier",
      });
      const raw = (record.content ?? "").replace(/^\s*DIRECT_ANSWER:\s*/, "");
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(400).json({ error: "意图分类输出无法解析为 JSON", raw: raw.slice(0, 200) });
      let parsed: any;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return res.status(400).json({ error: "意图分类输出 JSON 解析失败", raw: raw.slice(0, 200) });
      }
      const mode = ["chat", "plan", "execute"].includes(parsed?.mode) ? parsed.mode : undefined;
      if (!mode) return res.status(400).json({ error: "意图分类输出 mode 无效", raw: raw.slice(0, 200) });
      const confidence = typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
      res.json({ mode, confidence });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "intent classify failed" });
    }
  });
}
