import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { ExecutionPermissionPostureDto } from "./evidencePermissionTypes.js";

function approvalLabel(mode: string): string {
  return mode === "run-governance" ? "Run 治理审批" : mode === "not-required" ? "无需额外审批" : mode;
}

export default function ExecutionPermissionPosture({
  posture,
  compact = false,
}: {
  posture?: ExecutionPermissionPostureDto | null;
  compact?: boolean;
}) {
  const incomplete = !posture || posture.completeness === "incomplete";
  const notApplicable = posture?.completeness === "not_applicable";
  const wrapper = compact ? "mt-3 border-t border-hairline pt-3" : "card";

  return (
    <section className={wrapper} aria-label="执行权限事实">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-ink">
          {incomplete ? <AlertTriangle size={15} className="text-amber" /> : <ShieldCheck size={15} className="text-accent" />}
          执行权限事实
        </h3>
        <span className={`shrink-0 text-[11px] ${incomplete ? "text-amber" : "text-ink-muted"}`}>
          {incomplete ? "权限证据不完整" : notApplicable ? "未启动外部 Worker" : "已绑定提交凭据"}
        </span>
      </div>

      {!posture ? (
        <p className="mb-0 mt-2 text-[12px] text-amber">缺少权限清单，不能宣称 Evidence 完整。</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            <span className={`rounded px-2 py-1 ${posture.fullHostAccess ? "bg-error/10 text-error" : "bg-surface-2 text-ink-muted"}`}>
              {posture.fullHostAccess ? "完整宿主权限" : "受限宿主权限"}
            </span>
            <span className={`rounded px-2 py-1 ${posture.noOsSandbox ? "bg-error/10 text-error" : "bg-surface-2 text-ink-muted"}`}>
              {posture.noOsSandbox ? "无 OS sandbox" : "存在执行沙箱"}
            </span>
            <span className="rounded bg-surface-2 px-2 py-1 text-ink-muted">
              审批方式：{posture.approvalModes.length ? posture.approvalModes.map(approvalLabel).join("、") : "未知"}
            </span>
          </div>

          {posture.unsupportedConstraints.length > 0 && (
            <div className="mt-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
              <div className="text-[11px] font-semibold text-amber">未执行的约束</div>
              <ul className="mb-0 mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
                {posture.unsupportedConstraints.map((item) => <li key={item} className="break-words">{item}</li>)}
              </ul>
            </div>
          )}

          {posture.missingReceiptAgentIds.length > 0 && (
            <p className="mb-0 mt-2 break-words text-[11px] text-amber">
              缺少 WorkerLaunchReceipt：{posture.missingReceiptAgentIds.join("、")}
            </p>
          )}

          {!compact && posture.workers.length > 0 && (
            <div className="mt-3 max-h-64 space-y-2 overflow-auto">
              {posture.workers.map((worker) => (
                <div key={`${worker.agentId}:${worker.taskId}:${worker.attempt}`} className="rounded-md border border-hairline px-2.5 py-2 text-[11px] text-ink-muted">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <b className="break-all text-ink">{worker.agentId}</b>
                    <span>{worker.engine} / {worker.adapter}</span>
                    <span>{worker.sandboxBackend}</span>
                    <span>{worker.fullHostAccess ? "完整宿主权限" : "非完整宿主权限"}</span>
                  </div>
                  <div className="mt-1 break-words">
                    网络 {worker.network.requested} → {worker.network.effective}；
                    Shell {worker.shell.requested} → {worker.shell.effective}；
                    文件 {worker.file.requestedWrite === null ? "未知" : worker.file.requestedWrite ? "请求写入" : "只读请求"} → {worker.file.effective}；
                    审批方式 {approvalLabel(worker.approvalMode)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
