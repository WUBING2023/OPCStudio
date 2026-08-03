import { useState } from "react";
import { X, GitBranch, ShieldCheck, Share2 } from "lucide-react";
import type { AgentNodeConfig, Company, VerificationMethod } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { pushToast } from "../common/Toast.js";

// 公司架构 · 可视化子模式的画布连线交互:从一个节点的 Handle 拖拽连到另一个节点(onConnect 触发)后,
// 弹出这个小弹窗,让用户选这条边到底代表什么——三选一,分别落到三套完全不同的持久化语义:
//   ① 上下级汇报关系:目标节点的 parentId 改成源节点(等价于"移动"这个 agent 的汇报对象)。
//   ② 验证边:PATCH company.workflow.verificationEdges(producer=源节点 role,verifier=目标节点 role)。
//   ③ A2A 协作边:PATCH company.presetChannels(from/to = 两个节点的真实 agent id)。
// 只在「公司架构」模式下可达(OrgPage 的 nodesConnectable 跟着 canEditStructure 走,日常模式下
// onConnect 根本不会触发)。

type EdgeKind = "hierarchy" | "verify" | "a2a";
const METHODS: VerificationMethod[] = ["llm-review", "code-review", "fact-check"];

// 目标节点(descId)是否已经是源节点(ancId)的祖先——如果是,再把 descId.parentId 设成
// ancId 会兜回一个环(A 的上级链里有 B,又把 B 挂到 A 下面)。
function isDescendantOf(descId: string, ancId: string, agents: AgentNodeConfig[]): boolean {
  const byId = new Map(agents.map(a => [a.id, a]));
  let cur = byId.get(descId);
  cur = cur?.parentId ? byId.get(cur.parentId) : undefined;
  let guard = 0;
  while (cur && guard++ < 50) {
    if (cur.id === ancId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

export default function ConnectEdgeModal({
  company, sourceAgent, targetAgent, onClose, onCompanyUpdated,
}: {
  company: Company;
  sourceAgent: AgentNodeConfig;
  targetAgent: AgentNodeConfig;
  onClose: () => void;
  onCompanyUpdated: (c: Company) => void;
}) {
  const tr = useT();
  const [kind, setKind] = useState<EdgeKind>("hierarchy");
  const [method, setMethod] = useState<VerificationMethod>("llm-review");
  const [saving, setSaving] = useState(false);

  const applyHierarchy = async () => {
    const agents = useAgentStore.getState().agents;
    if (targetAgent.role === "ceo") { pushToast("error", tr("org.connect.cannotReparentCeo")); return; }
    if (targetAgent.id === sourceAgent.id) { onClose(); return; }
    if (isDescendantOf(sourceAgent.id, targetAgent.id, agents)) { pushToast("error", tr("org.connect.cycleError")); return; }
    if (targetAgent.parentId === sourceAgent.id) { pushToast("info", tr("org.connect.alreadyReports")); onClose(); return; } // 已经是这个汇报关系,无需重复写
    setSaving(true);
    try {
      const update = useAgentStore.getState().update;
      const oldParentId = targetAgent.parentId;
      if (oldParentId) {
        const oldParent = agents.find(a => a.id === oldParentId);
        if (oldParent) await update(oldParentId, { childrenIds: oldParent.childrenIds.filter(id => id !== targetAgent.id) });
      }
      await update(targetAgent.id, { parentId: sourceAgent.id });
      const newParent = agents.find(a => a.id === sourceAgent.id);
      if (newParent && !newParent.childrenIds.includes(targetAgent.id)) {
        await update(sourceAgent.id, { childrenIds: [...newParent.childrenIds, targetAgent.id] });
      }
      pushToast("success", tr("org.connect.hierarchyApplied", { name: targetAgent.name, lead: sourceAgent.name }));
      onClose();
    } catch (e: any) {
      pushToast("error", tr("org.connect.applyFailed") + (e.message || ""));
    } finally {
      setSaving(false);
    }
  };

  const applyVerify = async () => {
    setSaving(true);
    try {
      const edges = [
        ...(company.workflow?.verificationEdges ?? []),
        { producer: sourceAgent.role, verifier: targetAgent.role, method, onReject: "redo" as const, maxRounds: 1 },
      ];
      const updated = await api.patch<Company>(`/companies/${company.id}`, { workflow: { ...company.workflow, verificationEdges: edges } });
      onCompanyUpdated(updated);
      pushToast("success", tr("org.connect.verifyApplied"));
      onClose();
    } catch (e: any) {
      pushToast("error", tr("org.connect.applyFailed") + (e.message || ""));
    } finally {
      setSaving(false);
    }
  };

  const applyA2A = async () => {
    setSaving(true);
    try {
      const channels = [...(company.presetChannels ?? []), { from: sourceAgent.id, to: targetAgent.id }];
      const updated = await api.patch<Company>(`/companies/${company.id}`, { presetChannels: channels });
      onCompanyUpdated(updated);
      pushToast("success", tr("org.connect.a2aApplied"));
      onClose();
    } catch (e: any) {
      pushToast("error", tr("org.connect.applyFailed") + (e.message || ""));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = () => {
    if (kind === "hierarchy") return applyHierarchy();
    if (kind === "verify") return applyVerify();
    return applyA2A();
  };

  const OPTIONS: { key: EdgeKind; icon: typeof GitBranch; label: string; desc: string }[] = [
    { key: "hierarchy", icon: GitBranch, label: tr("org.connect.hierarchy"), desc: tr("org.connect.hierarchyDesc", { source: sourceAgent.name, target: targetAgent.name }) },
    { key: "verify", icon: ShieldCheck, label: tr("org.connect.verify"), desc: tr("org.connect.verifyDesc", { source: sourceAgent.name, target: targetAgent.name }) },
    { key: "a2a", icon: Share2, label: tr("org.connect.a2a"), desc: tr("org.connect.a2aDesc", { source: sourceAgent.name, target: targetAgent.name }) },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1300]" onClick={onClose}>
      <div className="w-[380px] rounded-2xl bg-surface-1 border border-hairline p-4" style={{ boxShadow: "var(--shadow-md)" }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[14px] font-semibold text-ink">{tr("org.connect.title")}</div>
          <button onClick={onClose} className="border-none bg-transparent cursor-pointer text-ink-muted hover:text-ink"><X size={16} /></button>
        </div>
        <div className="text-[12px] text-ink-subtle mb-3 truncate">{sourceAgent.name} → {targetAgent.name}</div>
        <div className="flex flex-col gap-2 mb-3">
          {OPTIONS.map(o => (
            <button key={o.key} onClick={() => setKind(o.key)}
              className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-left cursor-pointer transition-colors ${
                kind === o.key ? "border-accent bg-accent/10" : "border-hairline bg-surface-0 hover:border-text-muted"
              }`}>
              <o.icon size={15} className={`shrink-0 mt-0.5 ${kind === o.key ? "text-accent" : "text-ink-muted"}`} />
              <div className="min-w-0">
                <div className={`text-[13px] font-medium ${kind === o.key ? "text-accent" : "text-ink"}`}>{o.label}</div>
                <div className="text-[11px] text-ink-subtle mt-0.5">{o.desc}</div>
              </div>
            </button>
          ))}
        </div>
        {kind === "verify" && (
          <div className="mb-3">
            <label className="block text-[11px] text-ink-muted mb-1">{tr("tw.method")}</label>
            <select value={method} onChange={e => setMethod(e.target.value as VerificationMethod)}
              className="w-full border border-hairline rounded-lg bg-surface-0 text-[13px] py-1.5 px-2 outline-none text-ink cursor-pointer">
              {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">{tr("common.cancel")}</button>
          <button onClick={handleConfirm} disabled={saving} className="btn-primary">{saving ? "…" : tr("common.confirm")}</button>
        </div>
      </div>
    </div>
  );
}
