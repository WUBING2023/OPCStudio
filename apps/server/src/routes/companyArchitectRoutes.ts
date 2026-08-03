import type { Express } from "express";
import {
  CompanyEditTargetSchema, CompanyEditOperationSchema,
  type CompanyEditTarget, type CompanyEditOperation,
} from "@opc/shared";
import { type ChatMessage } from "../runtime/modelGateway.js";
import { invokeSystemModel } from "../runtime/systemModelInvoke.js";
import { buildCompanyEditSystemPrompt } from "../runtime/companyArchitectSkill.js";
import {
  validateCompanyEditOperations, applyCompanyEditOperations,
  buildCompanyEditLedger, summarizeCompanyEditLedger,
  hashCompanyEditTarget, collectHighRiskFlags, stableHash,
} from "../runtime/companyArchitect.js";
import {
  saveCompanyEditProposal, getCompanyEditProposal, markCompanyEditProposalApplied,
  markCompanyEditProposalRolledBack,
  issueConfirmationToken, consumeConfirmationToken,
} from "../storage/companyEditProposalStore.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";

// D7 · AI 架构师 —— CompanyEditProposal(指南 11.11)。三个端点,严格对应指南要求的三段式:
// ① /api/company-architect/proposal  AI 出方案(只读当前草稿 + 用户诉求 → 结构化 CompanyEditProposal,
//    不碰任何持久化的公司/agent 数据——操作对象是 TemplateWorkshop.tsx 里的草稿,不是活公司)。
// ② /api/company-architect/validate  Studio Core 校验 + 生成 diff preview(agent_id 冲突/组织成环/
//    A2A policy 合法/权限扩张),不落地,供前端展示给用户确认。
// ③ /api/company-architect/apply     用户确认后落地(仍是"返回新的草稿状态给前端"而非直接写 companyStore
//    ——草稿本来就没有落盘,真正的"保存"仍是 TemplateWorkshop 现有的 POST /community/templates)。
//    AI 从不调用这个端点;这里也从不调用 callModel——落地是纯规则计算,不是模型推理。
//
// 与 architectRoutes.ts/architectAssistant.ts(面向"活公司"、AI 直接对话该公司真实 CEO)是两套不同场景
// 共存,不是重复实现:详见 apps/server/src/runtime/companyArchitect.ts 顶部注释的评估结论。
export function register(app: Express, projectRoot: string) {
  function mapHistory(history: unknown): ChatMessage[] {
    if (!Array.isArray(history)) return [];
    return history
      .filter((h: unknown): h is { role: unknown; content: unknown } => !!h && typeof (h as any).content === "string")
      .slice(-20)
      .map((h: { role: unknown; content: unknown }) => ({
        role: h.role === "assistant" ? "assistant" : "user",
        content: String(h.content).slice(0, 4000),
      }));
  }

  function parseTarget(body: unknown): { target: CompanyEditTarget } | { error: string } {
    const r = CompanyEditTargetSchema.safeParse(body);
    if (!r.success) return { error: `草稿结构不合法:${r.error.issues.slice(0, 3).map(i => i.message).join("; ")}` };
    return { target: r.data };
  }

  // AI 出方案(/proposal)侧:模型输出的 operations 逐条 zod 校验,丢弃不合法条目(AI 偶尔多产一条
  // 坏结构不该拖累整份方案),硬上限 20 条兜底。这是"清洗模型输出",不是"处理用户请求"——用户请求
  // 侧(/validate、/apply)一律走下面的 strict 版本(令三.1)。
  function parseOperationsLenient(raw: unknown): CompanyEditOperation[] {
    if (!Array.isArray(raw)) return [];
    const out: CompanyEditOperation[] = [];
    for (const item of raw) {
      const r = CompanyEditOperationSchema.safeParse(item);
      if (r.success) out.push(r.data);
    }
    return out.slice(0, 20);
  }

  // 令三.1 · 用户请求侧严格解析:请求中任何 operation 非法(schema 不识别 / 字段缺失 / 超上限)→ 整批
  // 拒绝并返回逐条错误清单,禁止静默 drop / truncate / 部分应用。空数组是合法输入(不需要任何改动)。
  type StrictOpsResult = { ok: true; operations: CompanyEditOperation[] } | { ok: false; invalid: { index: number; error: string }[] };
  function parseOperationsStrict(raw: unknown): StrictOpsResult {
    if (raw === undefined || raw === null) return { ok: true, operations: [] };
    if (!Array.isArray(raw)) return { ok: false, invalid: [{ index: -1, error: "operations 必须是数组" }] };
    if (raw.length > 20) return { ok: false, invalid: [{ index: -1, error: `operations 共 ${raw.length} 条,超过上限 20 条,整批拒绝` }] };
    const operations: CompanyEditOperation[] = [];
    const invalid: { index: number; error: string }[] = [];
    raw.forEach((item, i) => {
      const r = CompanyEditOperationSchema.safeParse(item);
      if (r.success) operations.push(r.data);
      else invalid.push({ index: i, error: r.error.issues.slice(0, 3).map(x => `${x.path.join(".") || "op"}: ${x.message}`).join("; ") });
    });
    if (invalid.length > 0) return { ok: false, invalid };
    return { ok: true, operations };
  }

  // apply 真正落地前,对这批 operations 里"会被新写入草稿的自由文本"做乱码检测——与
  // architectRoutes.ts newlyWrittenTextFields 同一防线,换成这套 operation 的字段。
  function newlyWrittenTextFields(op: CompanyEditOperation): string[] {
    if (op.op === "add_agent") return [op.agent.name];
    if (op.op === "update_agent" && op.patch.name) return [op.patch.name];
    if (op.op === "rename_company") return [op.name];
    if (op.op === "update_description") return [op.description];
    if (op.op === "update_a2a_policy" && op.purpose) return [op.purpose];
    return [];
  }

  app.post("/api/company-architect/proposal", async (req, res) => {
    try {
      const parsed = parseTarget(req.body?.target);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { target } = parsed;

      const { message, history } = req.body ?? {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message required" });
      }
      const integrity = checkTextIntegrity(message);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });

      // 用系统级"creative"档模型(孵化设计场景)——这里操作的是尚未落盘的草稿,不存在一个可以归因
      // 记账的"真实 CEO"(与 architectRoutes.ts 操作活公司、必须用该公司真实 CEO 的 provider/model
      // 是不同场景;那边是"和已存在的员工对话",这边更接近 skillRoutes.ts /incubate 的"设计阶段")。
      const system = buildCompanyEditSystemPrompt(target);
      const messages: ChatMessage[] = [...mapHistory(history), { role: "user", content: message.trim().slice(0, 4000) }];

      const record = await invokeSystemModel(projectRoot, "creative", {
        agentId: "company-architect",
        system, messages, maxTokens: 2600, agentRole: "advisor",
      });
      const raw = (record.content ?? "").replace(/^\s*DIRECT_ANSWER:\s*/, "");
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(400).json({ error: "方案输出无法解析", raw: raw.slice(0, 400) });
      let parsedJson: any;
      try { parsedJson = JSON.parse(m[0]); } catch { return res.status(400).json({ error: "方案输出 JSON 解析失败", raw: raw.slice(0, 400) }); }

      const summary = typeof parsedJson?.summary === "string" ? parsedJson.summary.slice(0, 2000) : "";
      const risks = Array.isArray(parsedJson?.risks)
        ? parsedJson.risks.filter((r: unknown): r is string => typeof r === "string").slice(0, 12).map((r: string) => r.slice(0, 500))
        : [];
      const operations = parseOperationsLenient(parsedJson?.operations);

      const nowIso = new Date().toISOString();
      // 令三.2 · proposal 绑定五元组:companyId / targetId / operationsHash / beforeHash / expiresAt。
      // operationsHash = operations 的确定性序列化 sha256;beforeHash = 生成时草稿目标的确定性 sha256;
      // expiresAt 建议 30 分钟。apply 侧(令三.3)据此严格消费。companyId 缺省取 target.id(草稿无独立
      // companyId 时以草稿 id 为归属键)。
      const companyId = typeof req.body?.companyId === "string" && req.body.companyId.trim() ? req.body.companyId.trim() : target.id;
      const operationsHash = stableHash(operations);
      const beforeHash = hashCompanyEditTarget(target);
      const expiresAt = new Date(Date.parse(nowIso) + 30 * 60 * 1000).toISOString();
      const rec = saveCompanyEditProposal(projectRoot, { targetId: target.id, summary, operations, risks, companyId, operationsHash, beforeHash, expiresAt }, nowIso);

      res.json({
        proposal: {
          proposal_id: rec.proposal_id, summary: rec.summary, operations: rec.operations,
          risks: rec.risks, requires_user_confirmation: true as const,
        },
        usage: { tokens: record.totalTokens, costUsd: record.estimatedCostUsd ?? 0 },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "company-architect proposal failed" });
    }
  });

  app.post("/api/company-architect/validate", async (req, res) => {
    try {
      const parsed = parseTarget(req.body?.target);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      // 令三.1:任何非法 operation → 整批 422 + 逐条错误清单(空数组合法)。
      const opsParsed = parseOperationsStrict(req.body?.operations);
      if (!opsParsed.ok) return res.status(422).json({ error: "operations 中存在非法操作,整批拒绝", invalid: opsParsed.invalid });

      const report = validateCompanyEditOperations(parsed.target, opsParsed.operations);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "company-architect validate failed" });
    }
  });

  // 用户确认后真正落地——从不调用 callModel,纯规则计算(applyCompanyEditOperations/
  // validateCompanyEditOperations)。这是"AI 不得直接 apply"的端点级硬保证:AI 唯一能触达的入口是
  // 上面的 /proposal,它只产出方案、从不调用这个端点;这个端点也不读取/信任任何"AI 说已经确认过"的
  // 声明,只认这次请求本身携带的 operations——调用方是谁、有没有真的给用户看过 diff,由前端 UX 保证
  // (与 architectRoutes.ts 的 /architect-decompose 与 /architect-apply 分离成两个端点是同一防线)。
  app.post("/api/company-architect/apply", async (req, res) => {
    try {
      const parsed = parseTarget(req.body?.target);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const { target } = parsed;

      // 令三.1:任何非法 operation → 整批 422 + 逐条错误清单。
      const opsParsed = parseOperationsStrict(req.body?.operations);
      if (!opsParsed.ok) return res.status(422).json({ error: "operations 中存在非法操作,整批拒绝", invalid: opsParsed.invalid });
      const operations = opsParsed.operations;

      // 令三.3:apply 必须携带 proposalId,只消费 pending proposal 且所有 hash 完全匹配。不存在 → 404;
      // 非 pending(applied/rolled_back)→ 409;过期 → 410;operationsHash 不符 → 409;beforeHash 不符 → 409。
      // 不再有"手工拼 operations 直接 apply / operations 不符就默默改道 direct-apply"的宽容路径。
      const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId : undefined;
      if (!proposalId) return res.status(400).json({ error: "proposalId required —— apply 必须凭一个 pending proposal 落地" });
      const existing = getCompanyEditProposal(projectRoot, proposalId);
      if (!existing) return res.status(404).json({ error: "未找到对应的编辑提案(proposal)" });
      if (existing.status !== "pending") return res.status(409).json({ error: `该提案当前状态为「${existing.status}」,只有 pending 状态可以应用` });
      const nowMs = Date.now();
      if (existing.expiresAt && Date.parse(existing.expiresAt) <= nowMs) return res.status(410).json({ error: "该提案已过期,请重新生成方案后再应用" });

      const operationsHash = stableHash(operations);
      if (existing.operationsHash && existing.operationsHash !== operationsHash) {
        return res.status(409).json({ error: "提交的 operations 与提案存档不一致,拒绝应用(请勿在确认前改动方案)", expected: existing.operationsHash, got: operationsHash });
      }
      const requestBeforeHash = hashCompanyEditTarget(target);
      if (existing.beforeHash && existing.beforeHash !== requestBeforeHash) {
        return res.status(409).json({ error: "当前草稿目标与提案生成时不一致,拒绝应用(草稿已被改动,请重新生成方案)", expected: existing.beforeHash, got: requestBeforeHash });
      }

      const report = validateCompanyEditOperations(target, operations);
      if (!report.apply_allowed) {
        return res.status(400).json({ error: "校验未通过,拒绝应用", errors: report.errors, warnings: report.warnings, opResults: report.opResults });
      }

      // 令三.4 · 高危一次性 confirmation token 门(替换客户端布尔 confirmHighRisk):删除员工 / 变更 A2A /
      // 变更 MCP 能力需求 / 权限面扩大 → 后端签发一枚绑定 proposalId+operationsHash+dangerFlags 的一次性
      // token(10 分钟过期)。前端二次确认时带 confirmationToken 重发;后端校验存在+未消费+未过期+绑定全符
      // → 放行并即刻失效。重放/过期/绑定不符(如中途换了 operations)→ 428 重新签发。
      const highRisk = collectHighRiskFlags(operations, report);
      if (highRisk.length > 0) {
        const bindingHash = stableHash({ purpose: "company-edit-apply", proposalId, operationsHash, danger: highRisk.map(f => f.kind).sort() });
        const consumed = consumeConfirmationToken("company-edit-apply", req.body?.confirmationToken, bindingHash, nowMs);
        if (consumed !== "ok") {
          const issued = issueConfirmationToken("company-edit-apply", bindingHash, nowMs);
          return res.status(428).json({
            error: "本批修改包含高危操作,请二次确认后再应用", requiresConfirmation: true, highRisk,
            confirmationToken: issued.token, tokenExpiresAt: issued.expiresAt, reason: consumed,
          });
        }
      }

      for (const op of operations) {
        for (const val of newlyWrittenTextFields(op)) {
          const integrity = checkTextIntegrity(val);
          if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
        }
      }

      // C11 fidelity ledger 接线:对 before/after 跑 buildLedger,lost>0(本该保真的字段静默漂移)时拒绝 apply。
      const { target: after, results } = applyCompanyEditOperations(target, operations);
      const ledger = buildCompanyEditLedger(target, after, results);
      if (ledger.lost.length > 0) {
        return res.status(400).json({
          error: "fidelity ledger 检测到字段静默丢失,拒绝应用",
          lost: ledger.lost.map(v => v.field),
          ledger: summarizeCompanyEditLedger(ledger),
        });
      }
      const ledgerSummary = summarizeCompanyEditLedger(ledger);
      const targetBeforeHash = hashCompanyEditTarget(target);
      const targetAfterHash = hashCompanyEditTarget(after);

      // 令三.6:proposal 台账只在应用真实成功后写 committed(applied)态。草稿侧无公司写盘,持久化即
      // markApplied 本身——它排在 hash/token/ledger 全部校验通过之后,任何失败路径都在此之前 return,
      // 台账绝不会先于成功变 applied。
      const nowIso = new Date().toISOString();
      markCompanyEditProposalApplied(projectRoot, proposalId, nowIso, { targetBefore: target, ledger: ledgerSummary, targetBeforeHash, targetAfterHash });

      res.json({ target: report.template, results: report.opResults, warnings: report.warnings, ledger: ledgerSummary, targetBeforeHash, targetAfterHash });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "company-architect apply failed" });
    }
  });

  // C11 rollback:撤销一次已 applied 的 AI 修改——返还落地前的 targetBefore 快照给前端写回草稿,
  // 并把 proposal 台账标记 rolled_back(应用过又撤销了)。草稿本活在前端状态,rollback 的实质就是把
  // targetBefore 交回前端覆盖当前草稿(与社区 install 的 tx 快照回滚同一思路,只是这里落点是草稿而非公司)。
  app.post("/api/company-architect/rollback", async (req, res) => {
    try {
      const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId : undefined;
      if (!proposalId) return res.status(400).json({ error: "proposalId required" });
      const existing = getCompanyEditProposal(projectRoot, proposalId);
      if (!existing) return res.status(404).json({ error: "未找到对应的编辑记录" });
      if (existing.status !== "applied") {
        return res.status(400).json({ error: `该记录当前状态为「${existing.status}」,只有 applied 状态可以撤销` });
      }
      if (!existing.targetBefore) {
        return res.status(400).json({ error: "该记录未保存落地前快照,无法撤销(可能为旧版本记录)" });
      }

      // 令三.5 · hash 一致性守卫(force 已删,无任何绕过参数):rollback 必须携带 currentHash(草稿当前
      // 目标的确定性 hash;前端可直接算好传 currentHash,或传 currentTarget 由服务端计算)。与记录存档的
      // targetAfterHash 不符 → 409(响应带双 hash 供 UI 展示差异),前端提示"目标已被后续修改,请重新审阅"
      // 并终止,不再有强制撤销路径。旧记录无 targetAfterHash 时无从校验,但仍要求携带 currentHash(不放行
      // 无凭据回滚)。
      let currentHash: string | undefined;
      if (typeof req.body?.currentHash === "string" && req.body.currentHash) {
        currentHash = req.body.currentHash;
      } else if (req.body?.currentTarget !== undefined) {
        const curParsed = parseTarget(req.body.currentTarget);
        if (!("error" in curParsed)) currentHash = hashCompanyEditTarget(curParsed.target);
      }
      if (!currentHash) {
        return res.status(400).json({ error: "rollback 必须携带 currentHash(或 currentTarget)以确认目标未被改动" });
      }
      if (existing.targetAfterHash && currentHash !== existing.targetAfterHash) {
        return res.status(409).json({
          error: "目标已被后续修改,请重新审阅",
          currentHash, appliedHash: existing.targetAfterHash,
        });
      }
      const nowIso = new Date().toISOString();
      const updated = markCompanyEditProposalRolledBack(projectRoot, proposalId, nowIso);
      if (!updated) return res.status(409).json({ error: "撤销失败:记录状态已变更" });
      res.json({ target: existing.targetBefore, status: "rolled_back", rolledBackAt: nowIso });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "company-architect rollback failed" });
    }
  });
}
