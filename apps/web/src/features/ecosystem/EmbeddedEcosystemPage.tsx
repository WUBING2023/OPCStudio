import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  ChevronRight,
  ExternalLink,
  FileText,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { RunArtifact, RunStatus } from "@opc/shared";
import ExecutionPermissionPosture from "../../components/trace/ExecutionPermissionPosture.js";
import {
  ecosystemHttpClient,
  loadArtifactPreview,
  loadEmbeddedEcosystemSnapshot,
  submitCompanyPlanApply,
  submitGovernanceDecision,
  type EcosystemHttpClient,
} from "./api.js";
import {
  RUN_STATUS_LABEL,
  companyPlanBindingError,
  compareCompanyPlan,
  runStatusTone,
  summarizeCompanyPlan,
} from "./model.js";
import { formatEmbeddedEcosystemRoute } from "./routes.js";
import type {
  ArtifactPreviewDto,
  BoundCompanyPlanProposal,
  CompanyPlanApplyOutcome,
  EmbeddedEcosystemRoute,
  EmbeddedEcosystemSnapshot,
  EcosystemConfirmationIntent,
  GovernanceRecordDto,
} from "./types.js";

export interface EmbeddedEcosystemPageProps {
  route: EmbeddedEcosystemRoute;
  onOpenRun: (runId: string, companyId?: string) => void;
  client?: EcosystemHttpClient;
  companyPlanProposal?: BoundCompanyPlanProposal;
  onConfirmCompanyPlan?: (
    intent: Extract<EcosystemConfirmationIntent, { kind: "company-plan-apply" }>,
    confirmationReceipt?: string,
  ) => Promise<void | CompanyPlanApplyOutcome>;
}

function compactNumber(value: number | undefined): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`shrink-0 rounded px-2 py-1 text-[11px] font-medium ${runStatusTone(status)}`}>
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export function EmbeddedRunCard({
  snapshot,
  onOpenRun,
}: {
  snapshot: EmbeddedEcosystemSnapshot;
  onOpenRun: EmbeddedEcosystemPageProps["onOpenRun"];
}) {
  const selected = snapshot.selectedRun;
  if (!selected) {
    return <div className="py-10 text-center text-[13px] text-ink-muted">还没有可展示的 Run</div>;
  }
  const run = selected.run;
  return (
    <section className="border-b border-hairline px-5 py-4 min-w-0" aria-label="Run 状态">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase text-ink-subtle">Run</span>
            <StatusBadge status={selected.status} />
            <span className="truncate font-mono text-[11px] text-ink-subtle">{run.id}</span>
          </div>
          <h2 className="break-words text-[17px] font-semibold leading-6 text-ink">{selected.goal || "未命名任务"}</h2>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-muted">
            <span>{compactNumber(run.totalTokens)} tokens</span>
            <span>{run.participatingAgents.length} 位参与者</span>
            {run.degraded && <span className="text-warning">存在降级</span>}
          </div>
        </div>
        <button
          type="button"
          title="在 OPC Studio 正式 Run 详情中打开"
          onClick={() => onOpenRun(run.id, run.companyId)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-2.5 text-[12px] text-ink hover:bg-surface-2"
        >
          <ExternalLink size={14} />
          打开详情
        </button>
      </div>
    </section>
  );
}

function approvalStatus(record: GovernanceRecordDto): "pending" | "approved" | "rejected" {
  return record.approval?.status ?? "pending";
}

export function ApprovalCards({
  approvals,
  onOpenRun,
  onDecision,
}: {
  approvals: GovernanceRecordDto[];
  onOpenRun: EmbeddedEcosystemPageProps["onOpenRun"];
  onDecision?: (intent: Extract<EcosystemConfirmationIntent, { kind: "governance-decision" }>) => Promise<void>;
}) {
  const [armed, setArmed] = useState<{ runId: string; decision: "approve" | "reject" } | null>(null);
  const [busyRunId, setBusyRunId] = useState<string>();
  const [decisionError, setDecisionError] = useState("");
  const visible = approvals.filter((record) => record.approvalRequired).slice(0, 4);
  const confirmDecision = async (runId: string, decision: "approve" | "reject") => {
    if (!onDecision || busyRunId) return;
    setBusyRunId(runId);
    setDecisionError("");
    try {
      await onDecision({ kind: "governance-decision", runId, decision, createsRun: false });
      setArmed(null);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "审批失败");
    } finally {
      setBusyRunId(undefined);
    }
  };
  return (
    <section className="min-w-0 px-5 py-4" aria-label="审批摘要">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={16} className="text-ink-muted" />
        <h3 className="text-[13px] font-semibold text-ink">审批</h3>
        <span className="text-[11px] text-ink-subtle">{onDecision ? "需二次确认" : "只读"}</span>
      </div>
      {decisionError && <p role="alert" className="mb-2 text-[11px] text-danger">{decisionError}</p>}
      {visible.length === 0 ? (
        <p className="text-[12px] text-ink-muted">没有需要展示的审批记录</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-2">
          {visible.map((record) => {
            const status = approvalStatus(record);
            return (
              <div key={record.runId} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenRun(record.runId, record.inputs?.companyId)}
                className="flex min-w-0 items-center gap-3 rounded-md border border-hairline bg-surface-1 p-3 text-left hover:bg-surface-2"
                title="打开正式 Run 详情处理审批"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  status === "approved" ? "bg-success" : status === "rejected" ? "bg-danger" : "bg-warning"
                }`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-ink">
                    {record.inputs?.goalPreview || record.runId}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-subtle">
                    {record.level} · {status}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-ink-subtle" />
              </button>
              {status === "pending" && onDecision && (
                <div className="mt-1 flex min-w-0 flex-wrap items-center justify-end gap-1.5 rounded-md bg-surface-2 px-2 py-1.5">
                  {armed?.runId !== record.runId ? (
                    <>
                      <button type="button" onClick={() => setArmed({ runId: record.runId, decision: "reject" })} className="h-7 rounded px-2 text-[11px] text-danger hover:bg-danger/10">拒绝</button>
                      <button type="button" onClick={() => setArmed({ runId: record.runId, decision: "approve" })} className="h-7 rounded bg-ink px-2 text-[11px] text-white">批准</button>
                    </>
                  ) : (
                    <>
                      <span className="mr-auto text-[10px] text-warning">更新现有 Run，不会新建 Run</span>
                      <button type="button" onClick={() => setArmed(null)} className="h-7 rounded px-2 text-[11px] text-ink-muted">取消</button>
                      <button
                        type="button"
                        disabled={busyRunId === record.runId}
                        onClick={() => void confirmDecision(record.runId, armed.decision)}
                        className={"h-7 rounded px-2 text-[11px] text-white disabled:opacity-50 " + (armed.decision === "approve" ? "bg-ink" : "bg-danger")}
                      >
                        {busyRunId === record.runId ? "提交中" : "确认" + (armed.decision === "approve" ? "批准" : "拒绝")}
                      </button>
                    </>
                  )}
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function EvidenceSummary({ snapshot }: { snapshot: EmbeddedEcosystemSnapshot }) {
  const evidence = snapshot.evidence;
  const fileCount = evidence?.files.length ?? 0;
  const changeCount = evidence?.workspaceChanges?.length ?? 0;
  const tests = evidence?.tests ?? [];
  const passedTests = tests.filter((test) => test.passed).length;
  return (
    <section className="border-t border-hairline px-5 py-4" aria-label="Evidence 摘要">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={16} className="text-ink-muted" />
        <h3 className="text-[13px] font-semibold text-ink">Evidence</h3>
      </div>
      {!evidence ? (
        <p className="text-[12px] text-ink-muted">当前 Run 没有 Evidence manifest</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ["证据文件", fileCount],
            ["工作区变更", changeCount],
            ["测试通过", `${passedTests}/${tests.length}`],
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 rounded-md bg-surface-2 px-2 py-3">
              <div className="truncate text-[16px] font-semibold text-ink">{value}</div>
              <div className="mt-1 truncate text-[10px] text-ink-subtle">{label}</div>
            </div>
          ))}
          </div>
          <ExecutionPermissionPosture posture={evidence.permissionPosture} compact />
        </>
      )}
    </section>
  );
}

export function CompanyPlanPreview({ snapshot }: { snapshot: EmbeddedEcosystemSnapshot }) {
  const company = snapshot.selectedCompany;
  const summary = summarizeCompanyPlan(company, snapshot.agents);
  return (
    <section className="border-t border-hairline px-5 py-4" aria-label="公司方案预览">
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Building2 size={16} className="shrink-0 text-ink-muted" />
        <h3 className="truncate text-[13px] font-semibold text-ink">公司方案 · {company?.name ?? "未选择"}</h3>
        <span className="shrink-0 text-[10px] text-ink-subtle">当前快照</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        <span className="text-ink-muted">员工 <b className="text-ink">{summary.agentCount}</b></span>
        <span className="text-ink-muted">角色 <b className="text-ink">{summary.roleCount}</b></span>
        <span className="text-ink-muted">验证边 <b className="text-ink">{summary.verificationEdgeCount}</b></span>
        <span className="text-ink-muted">A2A 通道 <b className="text-ink">{summary.a2aChannelCount}</b></span>
        <span className="col-span-2 text-ink-muted">必需 Skill <b className="text-ink">{summary.requiredSkillCount}</b></span>
      </div>
    </section>
  );
}

export function CompanyPlanComparisonCard({
  proposal,
  expectedCompanyId,
  onConfirm,
}: {
  proposal: BoundCompanyPlanProposal;
  expectedCompanyId?: string;
  onConfirm?: EmbeddedEcosystemPageProps["onConfirmCompanyPlan"];
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmationReceipt, setConfirmationReceipt] = useState<string>();
  const bindingError = companyPlanBindingError(proposal, expectedCompanyId);
  const differences = compareCompanyPlan(proposal);

  const confirm = async () => {
    if (!onConfirm || bindingError || busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await onConfirm({
        kind: "company-plan-apply",
        proposalId: proposal.proposalId,
        companyId: proposal.companyId,
        beforeHash: proposal.beforeHash,
        actionsHash: proposal.actionsHash,
        expiresAt: proposal.expiresAt,
        createsRun: false,
      }, confirmationReceipt);
      if (outcome?.requiresConfirmation && outcome.confirmationReceipt) {
        setConfirmationReceipt(outcome.confirmationReceipt);
        setArmed(false);
        setError(`该方案包含高风险修改${outcome.highRisk?.length ? `：${outcome.highRisk.join("、")}` : ""}。请再次审阅并确认应用。`);
        return;
      }
      setConfirmationReceipt(undefined);
      setArmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "公司方案应用失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-t border-hairline px-5 py-4" aria-label="公司方案对比确认">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Building2 size={16} className="shrink-0 text-ink-muted" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">公司方案对比</h3>
        <span className="shrink-0 font-mono text-[10px] text-ink-subtle">{proposal.proposalId}</span>
      </div>
      <p className="mb-3 break-words text-[11px] text-ink-muted">{proposal.summary}</p>
      <div className="overflow-hidden rounded-md border border-hairline">
        <div className="grid grid-cols-[minmax(0,1fr)_48px_48px] bg-surface-2 px-2 py-1.5 text-[10px] text-ink-subtle">
          <span>结构</span><span className="text-right">当前</span><span className="text-right">方案</span>
        </div>
        {differences.map((item) => (
          <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_48px_48px] border-t border-hairline px-2 py-1.5 text-[11px]">
            <span className="truncate text-ink-muted">{item.label}</span>
            <span className="text-right text-ink-subtle">{item.before}</span>
            <span className="text-right font-medium text-ink">{item.after}</span>
          </div>
        ))}
      </div>
      {(bindingError || error) && <p role="alert" className="mt-2 text-[11px] text-danger">{bindingError || error}</p>}
      {proposal.risks?.length ? <p className="mt-2 line-clamp-2 text-[10px] text-warning">风险：{proposal.risks.join("；")}</p> : null}
      {onConfirm && !bindingError && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {armed && <span className="mr-auto text-[10px] text-warning">{confirmationReceipt ? "确认高风险修改并使用短期凭据应用" : "确认绑定 hash 后应用；中途变更将由服务端拒绝"}</span>}
          {armed && <button type="button" onClick={() => setArmed(false)} className="h-7 rounded px-2 text-[11px] text-ink-muted">取消</button>}
          <button
            type="button"
            disabled={busy}
            onClick={() => armed ? void confirm() : setArmed(true)}
            className="h-7 rounded bg-ink px-2 text-[11px] text-white disabled:opacity-50"
          >
            {busy ? "应用中" : armed ? (confirmationReceipt ? "确认高风险应用" : "确认应用") : (confirmationReceipt ? "再次审阅" : "审阅并应用")}
          </button>
        </div>
      )}
    </section>
  );
}

function ArtifactPanel({
  snapshot,
  client,
}: {
  snapshot: EmbeddedEcosystemSnapshot;
  client: EcosystemHttpClient;
}) {
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<ArtifactPreviewDto | null>(null);
  const [previewError, setPreviewError] = useState("");
  const runId = snapshot.selectedRun?.run.id;
  const artifacts = snapshot.artifacts?.artifacts ?? [];

  const openPreview = async (artifact: RunArtifact) => {
    if (!runId) return;
    setSelected(artifact.id);
    setPreview(null);
    setPreviewError("");
    try { setPreview(await loadArtifactPreview(client, runId, artifact.id)); }
    catch (error) { setPreviewError(error instanceof Error ? error.message : "产物不可预览"); }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-l border-hairline max-[900px]:border-l-0 max-[900px]:border-t" aria-label="Artifact 预览">
      <div className="shrink-0 border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-ink-muted" />
          <h3 className="text-[13px] font-semibold text-ink">Artifacts</h3>
          <span className="text-[11px] text-ink-subtle">{artifacts.length}</span>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)] max-[760px]:grid-cols-1">
        <div className="min-h-0 overflow-auto border-r border-hairline p-3 max-[760px]:max-h-44 max-[760px]:border-r-0 max-[760px]:border-b">
          {artifacts.length === 0 ? (
            <p className="p-2 text-[12px] text-ink-muted">没有可展示的产物</p>
          ) : artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => void openPreview(artifact)}
              title={artifact.title}
              className={`mb-1 flex w-full min-w-0 items-center gap-2 rounded-md border-none px-2 py-2 text-left ${
                selected === artifact.id ? "bg-surface-2" : "bg-transparent hover:bg-surface-2"
              }`}
            >
              <FileText size={13} className="shrink-0 text-ink-subtle" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{artifact.title}</span>
              {!artifact.inFinalDeliverable && <AlertTriangle size={12} className="shrink-0 text-warning" />}
            </button>
          ))}
        </div>
        <div className="min-h-0 min-w-0 overflow-auto bg-surface-0 p-4">
          {preview ? (
            <>
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <span className="truncate text-[12px] font-medium text-ink">{preview.filename}</span>
                {preview.truncated && <span className="shrink-0 text-[10px] text-warning">已截断</span>}
              </div>
              <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-ink-muted">
                {preview.content}
              </pre>
            </>
          ) : (
            <p className={`text-[12px] ${previewError ? "text-danger" : "text-ink-muted"}`}>
              {previewError || "选择产物查看只读文本预览"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function EmbeddedEcosystemPage({
  route,
  onOpenRun,
  client = ecosystemHttpClient,
  companyPlanProposal,
  onConfirmCompanyPlan,
}: EmbeddedEcosystemPageProps) {
  const [snapshot, setSnapshot] = useState<EmbeddedEcosystemSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const routeKey = `${route.runId ?? ""}:${route.companyId ?? ""}:${route.proposalId ?? ""}`;

  useEffect(() => {
    let active = true;
    setError("");
    loadEmbeddedEcosystemSnapshot(client, route)
      .then((value) => { if (active) setSnapshot(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); });
    return () => { active = false; };
  }, [client, routeKey, refreshKey]);

  const recentRuns = useMemo(() => snapshot?.runs.slice(0, 5) ?? [], [snapshot]);
  const decideApproval = client.post ? async (intent: Extract<EcosystemConfirmationIntent, { kind: "governance-decision" }>) => {
    await submitGovernanceDecision(client, intent.runId, intent.decision);
    setRefreshKey((value) => value + 1);
  } : undefined;
  const applyCompanyPlan = onConfirmCompanyPlan ?? (client.post ? async (
    intent: Extract<EcosystemConfirmationIntent, { kind: "company-plan-apply" }>,
    confirmationReceipt?: string,
  ) => {
    const outcome = await submitCompanyPlanApply(client, intent, confirmationReceipt);
    if (outcome.applied) setRefreshKey((value) => value + 1);
    return outcome;
  } : undefined);
  if (!snapshot && !error) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ink-muted">正在加载只读协作视图...</div>;
  }
  if (!snapshot) {
    return <div className="flex h-full items-center justify-center text-[13px] text-danger">{error}</div>;
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-canvas">
      <header className="sticky top-0 z-10 flex h-12 min-w-0 items-center gap-3 border-b border-hairline bg-canvas/95 px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold text-ink">嵌入式协作摘要</h1>
          <p className="truncate text-[10px] text-ink-subtle">{client.post ? "只读摘要 · 写操作必须二次确认" : "只读视图 · 最终操作在 OPC Studio 中完成"}</p>
        </div>
        <button
          type="button"
          title="刷新"
          onClick={() => setRefreshKey((value) => value + 1)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface-1 text-ink-muted hover:bg-surface-2"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      <div className="grid min-h-[calc(100%-3rem)] min-w-0 grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)] max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <EmbeddedRunCard snapshot={snapshot} onOpenRun={onOpenRun} />
          {recentRuns.length > 1 && (
            <nav className="border-b border-hairline px-5 py-3" aria-label="最近 Run">
              <div className="mb-2 text-[11px] font-medium text-ink-muted">最近 Run</div>
              <div className="flex min-w-0 gap-1 overflow-x-auto pb-1">
                {recentRuns.map((run) => (
                  <a
                    key={run.id}
                    href={formatEmbeddedEcosystemRoute({ runId: run.id, companyId: run.companyId })}
                    title={run.goal || run.id}
                    className="max-w-40 shrink-0 truncate rounded bg-surface-2 px-2 py-1.5 text-[11px] text-ink-muted hover:text-ink"
                  >
                    {run.goal || run.id}
                  </a>
                ))}
              </div>
            </nav>
          )}
          <ApprovalCards approvals={snapshot.approvals} onOpenRun={onOpenRun} onDecision={decideApproval} />
          <EvidenceSummary snapshot={snapshot} />
          {(companyPlanProposal ?? snapshot.companyPlan) ? (
            <CompanyPlanComparisonCard
              proposal={(companyPlanProposal ?? snapshot.companyPlan)!}
              expectedCompanyId={snapshot.selectedCompany?.id}
              onConfirm={applyCompanyPlan}
            />
          ) : <CompanyPlanPreview snapshot={snapshot} />}
        </div>
        <ArtifactPanel snapshot={snapshot} client={client} />
      </div>
    </div>
  );
}
