import { useEffect, useMemo, useState } from "react";
import { CornerDownRight, Building2, Users, User, ShieldAlert, AlertTriangle } from "lucide-react";
import type { AgentNodeConfig, Company } from "@opc/shared";
import * as api from "../api/client.js";

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO", lead: "Lead", architect: "架构师", dev: "开发", test: "测试",
  security: "安全", ops: "运维", docs: "文档",
};
const roleLabel = (r: string) => ROLE_LABELS[r] || r;

interface PreviewAgent { id: string; name: string; role: string; parentId?: string; }

// Team/worker import: pick which CEO/Lead to attach under (never a worker), with an org-copy-graph
// preview of the subtree being added. Reuses rerootAgents on the server to wire ids.
interface ImportPrecheck { unsigned?: boolean; dangerFlags?: string[]; contentWarnings?: string[] }

export default function ImportToOrgDialog({
  kind, title, previewAgents, loading, onCancel, onConfirm, sourceId,
}: {
  kind: "team" | "worker";
  title: string;
  previewAgents: PreviewAgent[];
  loading: boolean;
  onCancel: () => void;
  onConfirm: (parentId: string) => void;
  // C10-P1:社区团队/Worker 无完整性指纹,安装前需一次性确认——传 sourceId(teamId/workerId)后
  // 自动拉取 precheck(unsigned 徽标 + 危险旗标 + persona 内容扫描告警)。不传则只展示固定 unsigned 徽标。
  sourceId?: string;
}) {
  const [agents, setAgents] = useState<AgentNodeConfig[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [parentId, setParentId] = useState<string>("");
  const [precheck, setPrecheck] = useState<ImportPrecheck>({ unsigned: true });

  useEffect(() => {
    Promise.all([
      api.get<AgentNodeConfig[]>("/agents").catch(() => []),
      api.get<Company[]>("/companies").catch(() => []),
    ]).then(([a, c]) => { setAgents(a); setCompanies(c); });
  }, []);

  useEffect(() => {
    if (!sourceId) return;
    const body = kind === "team" ? { teamId: sourceId } : { workerId: sourceId };
    api.post<ImportPrecheck>(`/community/install/${kind}/precheck`, body)
      .then(p => setPrecheck({ unsigned: p.unsigned ?? true, dangerFlags: p.dangerFlags, contentWarnings: p.contentWarnings }))
      .catch(() => setPrecheck({ unsigned: true }));
  }, [kind, sourceId]);

  const companyName = (id?: string) => companies.find(c => c.id === (id || "default"))?.name || id || "default";

  // valid attach targets: CEO/Lead only, grouped by company
  const targets = useMemo(
    () => agents.filter(a => a.role === "ceo" || a.role === "lead"),
    [agents],
  );
  useEffect(() => {
    if (!parentId && targets.length) setParentId(targets[0].id);
  }, [targets, parentId]);

  // build the preview tree (roots = agents whose parent is outside the imported set)
  const idSet = useMemo(() => new Set(previewAgents.map(a => a.id)), [previewAgents]);
  const childrenOf = (pid: string | undefined) => previewAgents.filter(a => a.parentId === pid);
  const roots = previewAgents.filter(a => !a.parentId || !idSet.has(a.parentId));

  const renderNode = (a: PreviewAgent, depth: number): React.ReactNode => (
    <div key={a.id}>
      <div className="flex items-center gap-1.5 py-0.5 text-[12px]" style={{ paddingLeft: depth * 16 }}>
        {depth > 0 && <CornerDownRight size={11} className="text-text-muted" />}
        {a.role === "ceo" ? <Building2 size={12} className="text-accent" /> : a.role === "lead" ? <Users size={12} className="text-accent" /> : <User size={12} className="text-text-muted" />}
        <span className="text-text-primary">{a.name}</span>
        <span className="text-[10px] text-text-muted">{roleLabel(a.role)}</span>
      </div>
      {childrenOf(a.id).map(c => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1100]" onClick={onCancel}>
      <div className="bg-bg-card rounded-2xl w-[460px] max-h-[85vh] overflow-auto p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <b className="text-base text-text-primary">导入{kind === "team" ? "团队" : " Worker"}「{title}」</b>
        <p className="text-[12px] text-text-muted mt-1 mb-3">
          选择接入到哪个 CEO / Lead 之下（不能接到 worker）。导入后会复制下面的结构到你的组织。
        </p>

        {/* C10:未签名(完整性 hash 缺失)徽标 + 危险权限/内容告警,安装前一次性确认 */}
        {precheck.unsigned && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber/40 bg-amber/10 px-2.5 py-1.5 mb-2">
            <ShieldAlert size={13} className="text-amber shrink-0" />
            <span className="text-[12px] text-text-secondary">未签名 · 社区内容无完整性指纹(hash),请确认来源可信后再导入</span>
          </div>
        )}
        {(precheck.dangerFlags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {precheck.dangerFlags!.map(f => (
              <span key={f} className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ${f === "shell-access" ? "bg-red/10 text-red" : "bg-amber/10 text-amber"}`}>
                <AlertTriangle size={10} /> {f}
              </span>
            ))}
          </div>
        )}
        {(precheck.contentWarnings?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-red/40 bg-red/10 px-2.5 py-1.5 mb-2">
            <div className="text-[11px] text-red font-medium mb-0.5">内容安全告警</div>
            <ul className="m-0 pl-4">
              {precheck.contentWarnings!.map((w, i) => <li key={i} className="text-[11px] text-text-secondary">{w}</li>)}
            </ul>
          </div>
        )}

        {/* attach-target selector */}
        <label className="block text-[11px] text-text-muted mb-1">接入到</label>
        <select value={parentId} onChange={e => setParentId(e.target.value)}
          className="w-full border border-border rounded-lg bg-bg-card text-[13px] py-2 px-2.5 mb-4 outline-none focus:border-accent text-text-primary">
          {targets.length === 0 && <option value="">（没有可用的 CEO/Lead）</option>}
          {targets.map(t => (
            <option key={t.id} value={t.id}>
              {companyName(t.companyId)} · {roleLabel(t.role)}：{t.name}
            </option>
          ))}
        </select>

        {/* org-copy-graph preview */}
        <label className="block text-[11px] text-text-muted mb-1">将复制的结构（{previewAgents.length} 个 Agent）</label>
        <div className="rounded-xl border border-border bg-bg-hover p-3 mb-4 max-h-[220px] overflow-auto">
          {roots.map(r => renderNode(r, 0))}
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-secondary">取消</button>
          <button onClick={() => parentId && onConfirm(parentId)} disabled={loading || !parentId}
            className="px-4 py-1.5 text-[13px] font-medium btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? "导入中…" : "导入到组织"}
          </button>
        </div>
      </div>
    </div>
  );
}
