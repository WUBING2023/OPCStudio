import { useEffect, useState } from "react";
import { AlertTriangle, Trash2, Users, Building2, User, UserCheck } from "lucide-react";
import * as api from "../api/client.js";
import type { MemoryPackItem, MemoryPackScope } from "../api/client.js";
import { useT } from "../i18n.js";
import { pushToast } from "./common/Toast.js";
import { confirmDialog } from "./common/ConfirmDialog.js";
import { openMemoryItem } from "../lib/navigation.js";

interface Lesson {
  id: string;
  scope: { role?: string; taskType?: string; companyId?: string };
  trigger: { failureMode: string; conditionText: string };
  lesson: string; recommendedChange: string;
  injection: { promptText: string };
  evidence: { runId: string };
  confidence: number; status: string; version: number; hits: number; ineffective: number; updatedAt: string;
  boundAgentIds?: string[]; // C6 · 一键应用到员工训练:已强绑定给哪些员工
}

type TFunc = (key: string, params?: Record<string, string | number>) => string;

// 记忆条目 kind → i18n key(lesson 单独走"失败教训"小节,不在这里,避免同一条教训重复展示两遍)。
const KIND_LABEL_KEYS: Record<string, string> = {
  conclusion: "memory.pack.kind.conclusion",
  procedural_skill: "memory.pack.kind.proceduralSkill",
  plan_template: "memory.pack.kind.planTemplate",
  md_company: "memory.pack.kind.mdCompany",
  md_team: "memory.pack.kind.mdTeam",
  md_project: "memory.pack.kind.mdProject",
  md_agent: "memory.pack.kind.mdAgent",
  memory_entry: "memory.pack.kind.memoryEntry",
  committed: "memory.pack.kind.committed",
};
function kindLabel(kind: string, tr: TFunc): string {
  const key = KIND_LABEL_KEYS[kind];
  return key ? tr(key) : kind;
}

// confidence(0~1)→ 小进度条 + 百分比文字。
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={`${pct}%`}>
      <span className="w-9 h-1 rounded-full bg-bg-hover overflow-hidden inline-block align-middle">
        <span className="h-full block bg-accent rounded-full" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[10px] text-text-muted tabular-nums">{pct}%</span>
    </span>
  );
}

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
      {icon}{label}
    </div>
  );
}

function PackItemCard({ item, tr }: { item: MemoryPackItem; tr: TFunc }) {
  return (
    <button
      type="button"
      onClick={() => openMemoryItem({
        memoryId: item.memoryId,
        kind: item.kind,
        content: item.content,
        sourceRunId: item.sourceRunId,
        whySelected: item.whySelected,
      })}
      title={tr("memory.title")}
      className="w-full text-left rounded-lg border border-border bg-bg-card p-2.5 cursor-pointer hover:border-accent/50 hover:bg-bg-hover transition-colors"
    >
      <div className="flex items-center gap-2 text-[11px] flex-wrap">
        <span className="text-text-muted">{kindLabel(item.kind, tr)}</span>
        <div className="flex-1" />
        {item.confidence != null && <ConfidenceBar value={item.confidence} />}
      </div>
      <div className="text-[13px] text-text-primary mt-1 leading-snug">{item.content}</div>
      {item.whySelected && <div className="text-[11px] text-text-muted mt-1">{item.whySelected}</div>}
    </button>
  );
}

function PackSection({ icon, titleKey, items, tr }: { icon: React.ReactNode; titleKey: string; items: MemoryPackItem[]; tr: TFunc }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader icon={icon} label={tr(titleKey)} />
      {items.map((it) => <PackItemCard key={it.memoryId} item={it} tr={tr} />)}
    </div>
  );
}

// Layer E · 该角色的失败反思教训 + Memory Pack(部门/公司/个人三层组织架构记忆)——员工页"记忆"面板。
// 一次性加载 getAgentMemories(agentId) 拿完整投影,前端按 scope 字段分组渲染;失败教训单独一路走
// 原有 /memory/lessons 接口,且从 pack 分组里剔除 kind==="lesson",避免同一条教训
// 在"失败教训"小节和 scope 小节里重复出现两遍。
export default function MemoryLessons({ agentId, role, companyId }: { agentId: string; role: string; companyId?: string }) {
  const tr = useT();
  const [lessons, setLessons] = useState<Lesson[] | null>(null); // null = 加载中
  const [packItems, setPackItems] = useState<MemoryPackItem[] | null>(null); // null = 加载中

  const loadLessons = () => api.get<Lesson[]>(`/memory/lessons?role=${encodeURIComponent(role)}${companyId ? `&company=${encodeURIComponent(companyId)}` : ""}`).then(setLessons).catch(() => setLessons([]));
  const loadPack = () => api.getAgentMemories(agentId).then((r) => setPackItems(r.items)).catch(() => setPackItems([]));
  useEffect(() => { loadLessons(); loadPack(); }, [agentId, role, companyId]);
  // 撤销在服务端是终态(同内容重建会被 409 拒),必须先过确认弹窗——与 MemoryPage.handleRevoke 同款。
  const revoke = async (id: string) => {
    const ok = await confirmDialog({
      title: tr("memory.lessons.revokeConfirmTitle"),
      body: tr("memory.lessons.revokeConfirmBody"),
      danger: true,
      confirmLabel: tr("memory.lessons.revoke"),
    });
    if (!ok) return;
    try {
      await api.post(`/memory/lessons/${id}/revoke`, {});
      pushToast("success", tr("memory.lessons.revokeSuccess"));
      loadLessons();
    } catch (e: any) {
      pushToast("error", tr("memory.lessons.revokeFailed") + (e?.message || ""));
    }
  };
  // C6 · 一键应用到员工训练:把这条经验强绑定到当前正在看的这个员工(检索加权,不隔离原有检索规则)。
  const applyToAgent = async (id: string) => {
    try {
      await api.post(`/memory/lessons/${id}/bind-agent`, { agentId });
      pushToast("success", tr("memory.lessons.applySuccess"));
      loadLessons();
    } catch (e: any) {
      pushToast("error", tr("memory.lessons.applyFailed") + (e?.message || ""));
    }
  };

  if (lessons === null || packItems === null) return <div className="text-[12px] text-text-muted">{tr("memory.loading")}</div>;

  const byScope = (scope: MemoryPackScope) => packItems.filter((it) => it.scope === scope && it.kind !== "lesson");
  const departmentItems = byScope("department");
  const companyItems = byScope("company");
  const employeeItems = byScope("employee");
  const isEmpty = departmentItems.length === 0 && companyItems.length === 0 && employeeItems.length === 0 && lessons.length === 0;

  if (isEmpty) return <div className="text-[12px] text-text-muted">{tr("memory.pack.empty")}</div>;

  return (
    <div className="flex flex-col gap-4">
      <PackSection icon={<Users size={11} />} titleKey="memory.pack.sectionDepartment" items={departmentItems} tr={tr} />
      <PackSection icon={<Building2 size={11} />} titleKey="memory.pack.sectionCompany" items={companyItems} tr={tr} />
      <PackSection icon={<User size={11} />} titleKey="memory.pack.sectionEmployee" items={employeeItems} tr={tr} />

      {lessons.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeader icon={<AlertTriangle size={11} />} label={tr("memory.pack.sectionLessons")} />
          {lessons.map((l) => (
            <div
              key={l.id}
              role="button"
              tabIndex={0}
              onClick={() => openMemoryItem({
                memoryId: l.id,
                kind: "lesson",
                content: l.injection.promptText,
                companyId: l.scope.companyId,
                sourceRunId: l.evidence.runId,
              })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openMemoryItem({ memoryId: l.id, kind: "lesson", content: l.injection.promptText, companyId: l.scope.companyId, sourceRunId: l.evidence.runId });
                }
              }}
              className={`rounded-lg border p-2.5 cursor-pointer hover:border-accent/50 transition-colors ${l.status === "revoked" ? "border-border opacity-50" : l.status === "proposed" ? "border-amber/30 bg-amber/5" : "border-border bg-bg-card"}`}
            >
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                <span className="inline-flex items-center gap-1 text-amber"><AlertTriangle size={11} /> {l.trigger.failureMode}</span>
                <span className="text-text-muted">v{l.version} · {tr("memory.lessons.injected", { n: l.hits })}{l.ineffective ? ` · ${tr("memory.lessons.ineffective", { n: l.ineffective })}` : ""}</span>
                {l.status !== "committed" && <span className="text-text-muted">· {tr(`memory.lessons.status.${l.status}`)}</span>}
                <div className="flex-1" />
                <ConfidenceBar value={l.confidence} />
                {/* C6 · 一键应用到员工训练:只对已生效(committed)的经验有意义——proposed/revoked 从不会
                    被 retrieveLessons 命中,绑定了也不会真的被检索到,不给用户一个没有效果的按钮。 */}
                {l.status === "committed" && (
                  l.boundAgentIds?.includes(agentId) ? (
                    <span title={tr("memory.lessons.appliedToAgent")} className="text-accent inline-flex items-center"><UserCheck size={12} /></span>
                  ) : (
                    <button onClick={(event) => { event.stopPropagation(); void applyToAgent(l.id); }} title={tr("memory.lessons.applyToAgent")} className="text-text-muted hover:text-accent cursor-pointer bg-transparent border-none p-0 inline-flex"><UserCheck size={12} /></button>
                  )
                )}
                {l.status !== "revoked" && <button onClick={(event) => { event.stopPropagation(); void revoke(l.id); }} title={tr("memory.lessons.revoke")} className="text-text-muted hover:text-red cursor-pointer bg-transparent border-none p-0 inline-flex"><Trash2 size={12} /></button>}
              </div>
              <div className="text-[13px] text-text-primary mt-1 leading-snug">{l.injection.promptText}</div>
              <div className="text-[11px] text-text-muted mt-1">{tr("memory.lessons.sourceRun", { id: l.evidence.runId.slice(0, 8) })} · {l.scope.taskType || "-"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
