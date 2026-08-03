import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, Trash2, UserCheck } from "lucide-react";
import * as api from "../../api/client.js";
import HelpTip from "../HelpTip.js";
import { pushToast } from "../common/Toast.js";

// 波6 · 合并冲突人类决裁台。列出该 run 未决冲突(pending)、拉真实 git diff、执行决裁:
//   采纳分支(take_branch)/放弃(discard)/人工已处理(mark_manual)。
// 决裁成功后触发重新验收(后端绝不自动 verified),回调 onResolved 让上层刷新 run 状态。
// 文案暂用中文字面量(i18n 键归 i18n 泳道补,见 crossLaneNotes)。

type ConflictResolution = "take_branch" | "discard" | "mark_manual";

interface ConflictRecord {
  id: string;
  runId: string;
  taskId?: string;
  agentId?: string;
  branch: string;
  dir: string;
  conflictFiles: string[];
  createdAt: string;
  status: "pending" | "resolved";
  resolution?: ConflictResolution;
  resolvedBy?: string;
}

interface DiffEntry { file: string; diff: string; }

export default function ConflictResolutionPanel({ runId, onResolved }: { runId: string; onResolved?: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ conflicts: ConflictRecord[] }>(`/conflicts?runId=${encodeURIComponent(runId)}`)
      .then((r) => setConflicts(r.conflicts || []))
      .catch(() => setConflicts([]));
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (rec: ConflictRecord, resolution: ConflictResolution) => {
    if (busyId) return;
    setBusyId(rec.id);
    try {
      const r = await api.post<{ resolved?: boolean; reverify?: { finalState?: string; forcedDowngrade?: boolean } }>(
        `/conflicts/${encodeURIComponent(rec.id)}/resolve`,
        { resolution, resolvedBy: "human" },
      );
      if (r.resolved) {
        const fs = r.reverify?.finalState;
        pushToast("success", fs ? `冲突已决裁,重新验收终态:${fs}(未自动 verified)` : "冲突已决裁");
        load();
        onResolved?.();
      } else {
        pushToast("error", "决裁未成功");
      }
    } catch (e: any) {
      pushToast("error", `决裁失败:${e?.message || ""}`);
    } finally {
      setBusyId(null);
    }
  };

  if (conflicts === null) {
    return <div className="text-[12px] text-ink-subtle flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" /> 加载冲突…</div>;
  }
  const pending = conflicts.filter((c) => c.status === "pending");
  if (pending.length === 0) {
    return <div className="text-[12px] text-ink-subtle">无未决合并冲突。</div>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[12px] text-amber flex items-center gap-1.5">
        <AlertTriangle size={13} className="shrink-0" />
        {pending.length} 处未决合并冲突需人工决裁
        <HelpTip text="决裁后交付将重新验收(不会自动沿用旧的 verified)" />
      </div>
      {pending.map((c) => (
        <ConflictCard key={c.id} rec={c} busy={busyId === c.id} disabled={!!busyId} onResolve={resolve} />
      ))}
    </div>
  );
}

function ConflictCard({
  rec, busy, disabled, onResolve,
}: {
  rec: ConflictRecord;
  busy: boolean;
  disabled: boolean;
  onResolve: (rec: ConflictRecord, resolution: ConflictResolution) => void;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffs, setDiffs] = useState<DiffEntry[] | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const toggleDiff = async () => {
    if (diffOpen) { setDiffOpen(false); return; }
    setDiffOpen(true);
    if (diffs) return;
    setLoadingDiff(true);
    try {
      const r = await api.get<{ diffs: DiffEntry[] }>(`/conflicts/${encodeURIComponent(rec.id)}/diff`);
      setDiffs(r.diffs || []);
    } catch {
      setDiffs([]);
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div className="rounded-md border border-hairline bg-surface-1 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-2 text-ink-muted">{rec.branch}</span>
        {rec.agentId && <span className="text-[11px] text-ink-muted font-mono">@{rec.agentId}</span>}
        {rec.taskId && <span className="text-[11px] text-ink-subtle">{rec.taskId}</span>}
      </div>
      <div className="flex flex-col gap-0.5">
        {rec.conflictFiles.map((f) => (
          <div key={f} className="text-[12px] text-ink-muted font-mono break-all flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-red shrink-0" /> {f}
          </div>
        ))}
      </div>

      <div>
        <button
          onClick={toggleDiff}
          className="flex items-center gap-1 text-[11px] text-ink-subtle bg-transparent border-none cursor-pointer p-0 hover:text-ink"
        >
          <ChevronDown size={11} className={diffOpen ? "rotate-180 transition-transform" : "transition-transform"} />
          {diffOpen ? "隐藏 diff" : "查看 diff"}
        </button>
        {diffOpen && (
          <div className="mt-1.5">
            {loadingDiff ? (
              <div className="text-[11px] text-ink-subtle flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> 读取 diff…</div>
            ) : diffs && diffs.length > 0 ? (
              diffs.map((d) => (
                <div key={d.file} className="mb-2">
                  <div className="text-[11px] text-ink-subtle font-mono mb-0.5">{d.file}</div>
                  <pre className="text-[11px] text-ink-muted whitespace-pre-wrap break-words max-h-[30vh] overflow-auto font-mono m-0 bg-surface-2 rounded p-2">{d.diff}</pre>
                </div>
              ))
            ) : (
              <div className="text-[11px] text-ink-subtle">无 diff 可展示。</div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-0.5">
        <ActionBtn label="采纳分支" title="把该 worker 分支合入(冲突处取分支侧)" disabled={disabled} busy={busy} icon={Check} tone="accent" onClick={() => onResolve(rec, "take_branch")} />
        <ActionBtn label="放弃" title="放弃该分支,不采纳其改动" disabled={disabled} busy={busy} icon={Trash2} tone="danger" onClick={() => onResolve(rec, "discard")} />
        <ActionBtn label="人工已处理" title="我已在工作副本手动合并,只标记决裁完成" disabled={disabled} busy={busy} icon={UserCheck} tone="muted" onClick={() => onResolve(rec, "mark_manual")} />
      </div>
    </div>
  );
}

function ActionBtn({
  label, title, disabled, busy, icon: Icon, tone, onClick,
}: {
  label: string;
  title: string;
  disabled: boolean;
  busy: boolean;
  icon: typeof Check;
  tone: "accent" | "danger" | "muted";
  onClick: () => void;
}) {
  const toneCls = tone === "accent"
    ? "text-accent border-accent/40 hover:border-accent"
    : tone === "danger"
      ? "text-red border-red/40 hover:border-red"
      : "text-ink-muted border-hairline hover:border-hairline-light hover:text-ink";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border bg-transparent cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${toneCls}`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {label}
    </button>
  );
}
