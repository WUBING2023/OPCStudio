import { useEffect, useState } from "react";
import { FilePlus2, FilePen, FileMinus2, ChevronRight } from "lucide-react";
import type { FileChange } from "@opc/shared";
import * as api from "../api/client.js";

interface Props {
  runId: string;
}

const TYPE_META: Record<FileChange["changeType"], { label: string; color: string; Icon: typeof FilePlus2 }> = {
  create: { label: "新增", color: "var(--color-success)", Icon: FilePlus2 },
  modify: { label: "修改", color: "var(--color-warning)", Icon: FilePen },
  delete: { label: "删除", color: "var(--color-error)", Icon: FileMinus2 },
};

export default function DiffReviewPanel({ runId }: Props) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<"approve" | "reject" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/runs/${runId}/changes`).then(r => r.json()).then(d => d.changes ?? []).catch(() => []),
      fetch(`/api/runs/${runId}/diff`).then(r => r.json()).then(d => d.diff ?? "").catch(() => ""),
    ]).then(([c, d]) => { setChanges(c); setDiff(d); setLoading(false); });
  }, [runId]);

  const act = async (kind: "approve" | "reject") => {
    setActionLoading(kind);
    setMessage(null);
    try {
      // 令五.6:经 api.post 走 client.ts 统一注入 X-OPC-Session-Token(变更型请求服务端强校验)。
      await api.post(`/runs/${runId}/${kind}`, {});
      setMessage(kind === "approve" ? "已批准并提交。" : "已丢弃改动。"); setDiff("");
    } catch (e: any) {
      setMessage(`错误: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return null;
  if (changes.length === 0 && !diff) return null;

  const counts = changes.reduce((acc, c) => { acc[c.changeType] = (acc[c.changeType] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="mt-3 border border-border rounded-xl overflow-hidden">
      <div className="px-3 py-2 bg-bg-hover text-text-secondary text-xs font-semibold flex items-center gap-3">
        <span>文件改动</span>
        {changes.length > 0 && (
          <span className="flex gap-2 text-[11px] font-normal">
            {(["create", "modify", "delete"] as const).map(t => counts[t] ? (
              <span key={t} style={{ color: TYPE_META[t].color }}>{TYPE_META[t].label} {counts[t]}</span>
            ) : null)}
          </span>
        )}
      </div>

      {/* Structured, grouped file changes (primary) */}
      {changes.length > 0 && (
        <div className="divide-y divide-border">
          {changes.map((c) => {
            const meta = TYPE_META[c.changeType];
            const open = expanded === c.path;
            const body = c.after ?? c.before ?? "";
            return (
              <div key={c.path}>
                <button
                  onClick={() => setExpanded(open ? null : c.path)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover transition-colors cursor-pointer">
                  <ChevronRight size={13} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`} />
                  <meta.Icon size={14} style={{ color: meta.color }} className="shrink-0" />
                  <span className="text-[13px] font-mono text-text-primary truncate">{c.path}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide shrink-0" style={{ color: meta.color }}>{meta.label}</span>
                </button>
                {open && body && (
                  <pre className="m-0 px-3 py-2 bg-bg text-text-secondary font-mono text-[11px] max-h-[260px] overflow-auto whitespace-pre-wrap break-all border-t border-border">
                    {body}
                  </pre>
                )}
                {open && !body && (
                  <div className="px-3 py-2 text-[11px] text-text-muted border-t border-border">（无内容预览）</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Raw working-tree diff + approve/reject (backward compat for uncommitted changes) */}
      {diff && (
        <>
          <pre className="m-0 p-3 bg-bg text-text-secondary font-mono text-[11px] max-h-[260px] overflow-auto whitespace-pre-wrap break-all border-t border-border">
            {diff}
          </pre>
          <div className="flex gap-2 px-3 py-2 bg-bg-hover border-t border-border">
            <button onClick={() => act("approve")} disabled={actionLoading !== null}
              className="border-none rounded-full px-4 py-1.5 text-white cursor-pointer text-[13px] font-medium bg-green hover:opacity-90 disabled:opacity-60 disabled:cursor-default">
              {actionLoading === "approve" ? "提交中..." : "批准并提交"}
            </button>
            <button onClick={() => act("reject")} disabled={actionLoading !== null}
              className="border-none rounded-full px-4 py-1.5 text-white cursor-pointer text-[13px] font-medium bg-red hover:opacity-90 disabled:opacity-60 disabled:cursor-default">
              {actionLoading === "reject" ? "丢弃中..." : "丢弃改动"}
            </button>
          </div>
        </>
      )}

      {message && (
        <div className={`px-3 py-1.5 text-xs border-t border-border ${message.startsWith("错误") ? "text-red" : "text-green"}`}>
          {message}
        </div>
      )}
    </div>
  );
}
