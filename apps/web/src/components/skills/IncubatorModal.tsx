import { useState } from "react";
import { FlaskConical, User, Users, Building2, Sparkles, ChevronDown, ChevronRight, Loader2, CheckCircle2, X, GitBranch, ArrowRight, AlertTriangle } from "lucide-react";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { pushToast } from "../common/Toast.js";
import ImportToOrgDialog from "../ImportToOrgDialog.js";
import HelpTip from "../HelpTip.js";

// Skill 孵化器(Fable 手作):技能 → 一名员工 / 一支专家小组(默认推荐) / 一支完整团队。
// 流程:选形态 → LLM 真实设计(消耗用户 tokens,诚实计量)→ 预览可改名 → 落地
// (员工=挑上级入职;专家小组=2-4 名纯 worker 挑上级一次性入职;团队=存本地模板库 → 一键建司 / 去社区分享,
//  全部复用既有链)。命名策略:AI 设计一律用职能角色描述命名,不编造人名。

interface SkillLike { id: string; title: string }

interface WorkerDesign { name?: string; roleLabel?: string; persona?: string }
interface TeamMember { id?: string; name?: string; role?: string; persona?: string; reportsToId?: string }
interface TeamDesign {
  teamName?: string;
  description?: string;
  members?: TeamMember[];
  verificationEdges?: Array<{ producerId: string; verifierId: string; method: string; onReject?: "redo" }>;
}
interface SquadDesign { squadName?: string; description?: string; members?: TeamMember[] }
interface ExecutionBinding {
  framework: string;
  provider: string;
  model: string;
  source?: string;
  substituted?: boolean;
  reason?: string;
}

type Mode = "worker" | "squad" | "team";
type Phase = "pick" | "generating" | "preview" | "pickParent" | "done";

const ROLE_BADGE: Record<string, string> = {
  ceo: "#7c8aff", lead: "#957bc1", dev: "#5bae7a", test: "#bc9b62", security: "#c37979", ops: "#b67c5d", docs: "#a3839c", pm: "#b87a96",
};

function PersonaBox({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tr = useT();
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-ink-subtle hover:text-ink cursor-pointer bg-transparent border-none p-0">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}{tr("skills.inc.persona")}
      </button>
      {open && (
        <div className="mt-1 max-h-[140px] overflow-y-auto rounded-lg px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap"
          style={{ background: "var(--color-surface-0)", border: "1px solid var(--color-hairline)", color: "var(--color-ink-muted)" }}>
          {text}
        </div>
      )}
    </div>
  );
}

function TeamStructurePreview({ design }: { design: TeamDesign }) {
  const tr = useT();
  const members = design.members ?? [];
  const byId = new Map(members.map((member) => [member.id, member]));
  const depthOf = (member: TeamMember): number => {
    let depth = 0;
    let current = member;
    const visited = new Set<string>();
    while (current.reportsToId && depth < 3 && !visited.has(current.reportsToId)) {
      visited.add(current.reportsToId);
      const parent = byId.get(current.reportsToId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  };

  return (
    <>
      <div className="mt-3 rounded-lg border border-hairline bg-surface-1 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          <Building2 size={13} className="text-accent" />{tr("skills.inc.teamStructure")}
        </div>
        <div className="flex flex-col gap-1.5">
          {members.map((member, index) => {
            const manager = member.reportsToId ? byId.get(member.reportsToId) : undefined;
            const depth = depthOf(member);
            return (
              <div key={member.id || index} className="rounded-md border border-hairline/70 bg-surface-0 px-2.5 py-2" style={{ marginLeft: depth * 18 }}>
                <div className="flex items-center gap-2">
                  {depth > 0 && <ChevronRight size={11} className="shrink-0 text-ink-subtle" />}
                  <span className="px-1.5 py-[1px] rounded-full text-[10px] font-bold"
                    style={{ background: `color-mix(in srgb, ${ROLE_BADGE[String(member.role)] ?? "#8b8e99"} 22%, transparent)`, color: ROLE_BADGE[String(member.role)] ?? "var(--color-ink-muted)" }}>
                    {String(member.role || "worker")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{String(member.name || member.id || tr("skills.inc.unnamedMember"))}</span>
                  <span className="shrink-0 text-[10px] text-ink-subtle">
                    {manager ? tr("skills.inc.reportsTo", { name: String(manager.name || manager.id || "") }) : tr("skills.inc.topLevel")}
                  </span>
                </div>
                {member.persona && <PersonaBox text={String(member.persona)} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-surface-1 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          <GitBranch size={13} className="text-accent" />{tr("skills.inc.verificationChain")}
        </div>
        {(design.verificationEdges ?? []).length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {(design.verificationEdges ?? []).map((edge, index) => {
              const producer = byId.get(edge.producerId);
              const verifier = byId.get(edge.verifierId);
              return (
                <div key={`${edge.producerId}:${edge.verifierId}:${index}`} className="rounded-md bg-surface-0 px-2.5 py-2 text-[11px]">
                  <div className="flex min-w-0 items-start gap-2 font-medium text-ink">
                    <span className="min-w-0 flex-1 break-words">{String(producer?.name || edge.producerId)}</span>
                    <ArrowRight size={12} className="mt-0.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 break-words">{String(verifier?.name || edge.verifierId)}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="badge whitespace-normal bg-accent/10 text-accent">{edge.method}</span>
                    <span className="text-ink-subtle">{tr("skills.inc.rejectRedo")}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 rounded-md bg-amber/10 px-2.5 py-2 text-[11px] text-amber">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />{tr("skills.inc.noVerificationChain")}
          </div>
        )}
      </div>
    </>
  );
}
export default function IncubatorModal({ skill, onClose }: { skill: SkillLike; onClose: () => void }) {
  const tr = useT();
  const [phase, setPhase] = useState<Phase>("pick");
  const [mode, setMode] = useState<Mode>("squad");
  const [design, setDesign] = useState<any>(null);
  const [binding, setBinding] = useState<ExecutionBinding | null>(null);
  const [usage, setUsage] = useState<{ tokens: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "worker" | "squad" | "template"; label: string; templateId?: string } | null>(null);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  const cancelGenerate = () => {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setPhase("pick");
  };

  const generate = async (m: Mode) => {
    setMode(m);
    setPhase("generating");
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    try {
      const r = await api.post<{ design: any; binding: ExecutionBinding; usage: { tokens: number } }>(`/skills/${skill.id}/incubate`, { mode: m }, { signal: ctrl.signal });
      setDesign(r.design);
      setBinding(r.binding);
      setUsage(r.usage);
      setPhase("preview");
    } catch (e: any) {
      if (ctrl.signal.aborted) { setPhase("pick"); return; }
      pushToast("error", tr("skills.inc.genFailed") + (e?.message ? `: ${String(e.message).slice(0, 80)}` : ""));
      setPhase("pick");
    } finally {
      setAbortCtrl(null);
    }
  };

  const installWorker = async (parentId: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ agentId: string; name: string }>(`/skills/${skill.id}/incubate/install`, { mode: "worker", design, parentId, binding });
      await useAgentStore.getState().load();
      setResult({ kind: "worker", label: r.name });
      setPhase("done");
    } catch (e: any) {
      pushToast("error", tr("skills.inc.installFailed") + (e?.message ? `: ${String(e.message).slice(0, 80)}` : ""));
      setPhase("preview");
    } finally { setBusy(false); }
  };

  const installSquad = async (parentId: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ members: Array<{ agentId: string; name: string }>; squadName: string }>(`/skills/${skill.id}/incubate/install`, { mode: "squad", design, parentId, binding });
      await useAgentStore.getState().load();
      setResult({ kind: "squad", label: `${r.squadName}(${r.members.length} 人)` });
      setPhase("done");
    } catch (e: any) {
      pushToast("error", tr("skills.inc.installFailed") + (e?.message ? `: ${String(e.message).slice(0, 80)}` : ""));
      setPhase("preview");
    } finally { setBusy(false); }
  };

  const installTeam = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ templateId: string; title: string; memberCount: number }>(`/skills/${skill.id}/incubate/install`, { mode: "team", design, binding });
      setResult({ kind: "template", label: `${r.title}(${r.memberCount} 人)`, templateId: r.templateId });
      setPhase("done");
    } catch (e: any) {
      pushToast("error", tr("skills.inc.installFailed") + (e?.message ? `: ${String(e.message).slice(0, 80)}` : ""));
    } finally { setBusy(false); }
  };

  const buildCompany = async () => {
    if (!result?.templateId) return;
    setBusy(true);
    try {
      const r = await api.post<{ companyId: string; agentCount: number; safeInstall?: { applied: boolean; stripped: Array<{ id: string; detail: string }> } }>("/community/install/company", { templateId: result.templateId });
      await useAgentStore.getState().load();
      // D1 · Safe Install:服务端对社区来源模板默认剥离高危授权——剥离了什么必须如实告知,不能静默。
      const strippedCount = r.safeInstall?.stripped?.length ?? 0;
      pushToast("success", tr("skills.inc.companyBuilt", { n: r.agentCount })
        + (strippedCount > 0 ? ` · ${tr("skills.inc.safeStripped", { n: strippedCount })}` : ""));
      onClose();
    } catch (e: any) {
      pushToast("error", tr("skills.inc.installFailed") + (e?.message ? `: ${String(e.message).slice(0, 80)}` : ""));
    } finally { setBusy(false); }
  };

  if (phase === "pickParent" && mode === "worker") {
    return (
      <ImportToOrgDialog
        kind="worker"
        title={String(design?.name || skill.title)}
        previewAgents={[{ id: skill.id, name: String(design?.name || skill.title), role: String(design?.roleLabel || "worker") }]}
        loading={busy}
        onCancel={() => setPhase("preview")}
        onConfirm={installWorker}
      />
    );
  }

  if (phase === "pickParent" && mode === "squad") {
    const sd = design as SquadDesign | null;
    const squadMembers = sd?.members ?? [];
    return (
      <ImportToOrgDialog
        kind="worker"
        title={String(sd?.squadName || skill.title)}
        previewAgents={squadMembers.map((mb, i) => ({ id: `${skill.id}-sq-${i}`, name: String(mb.name || mb.role || "成员"), role: String(mb.role || "worker") }))}
        loading={busy}
        onCancel={() => setPhase("preview")}
        onConfirm={installSquad}
      />
    );
  }

  const wd = design as WorkerDesign | null;
  const sd = design as SquadDesign | null;
  const td = design as TeamDesign | null;

  return (
    <div className="modal-overlay z-[120]" onClick={onClose}>
      <div className="rounded-2xl w-[520px] max-w-[92vw] max-h-[84vh] overflow-y-auto p-5 text-left"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-hairline-light)", boxShadow: "var(--shadow-md)" }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical size={16} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink">{tr("skills.inc.title")}</span>
          <span className="text-[11px] text-ink-subtle truncate">· {skill.title}</span>
          <HelpTip text={tr("skills.inc.intro")} />
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-2 cursor-pointer border-none bg-transparent"><X size={14} /></button>
        </div>

        {phase === "pick" && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <button onClick={() => generate("worker")}
                className="group text-left rounded-xl p-4 cursor-pointer transition-all"
                style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-hairline)" }}>
                <User size={20} className="text-accent mb-2" />
                <div className="text-[13px] font-semibold text-ink">{tr("skills.inc.asWorker")}</div>
                <div className="text-[11px] text-ink-muted mt-1 leading-snug">{tr("skills.inc.asWorkerDesc")}</div>
              </button>
              <button onClick={() => generate("squad")}
                className="group text-left rounded-xl p-4 cursor-pointer transition-all relative"
                style={{ background: "color-mix(in srgb, var(--color-accent) 10%, var(--color-surface-2))", border: "1.5px solid var(--color-accent)" }}>
                <span className="absolute -top-2 right-3 px-1.5 py-0.5 rounded-full text-[10px] font-bold text-white" style={{ background: "var(--color-accent)" }}>
                  {tr("skills.inc.recommended")}
                </span>
                <Users size={20} className="text-accent mb-2" />
                <div className="text-[13px] font-semibold text-ink">{tr("skills.inc.asSquad")}</div>
                <div className="text-[11px] text-ink-muted mt-1 leading-snug">{tr("skills.inc.asSquadDesc")}</div>
              </button>
              <button onClick={() => generate("team")}
                className="group text-left rounded-xl p-4 cursor-pointer transition-all"
                style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-hairline)" }}>
                <Building2 size={20} className="text-accent mb-2" />
                <div className="text-[13px] font-semibold text-ink">{tr("skills.inc.asTeam")}</div>
                <div className="text-[11px] text-ink-muted mt-1 leading-snug">{tr("skills.inc.asTeamDesc")}</div>
              </button>
            </div>
            <div className="mt-3 inline-flex items-center gap-1 text-ink-subtle"><Sparkles size={11} /><HelpTip text={tr("skills.inc.costNote")} /></div>
          </>
        )}

        {phase === "generating" && (
          <div className="py-12 flex flex-col items-center gap-3">
            <Loader2 size={26} className="animate-spin text-accent" />
            <div className="text-[13px] text-ink-muted">
              {mode === "worker" ? tr("skills.inc.designingWorker") : mode === "squad" ? tr("skills.inc.designingSquad") : tr("skills.inc.designingTeam")}
            </div>
            <button onClick={cancelGenerate} className="btn-secondary text-[12px]">{tr("common.cancel")}</button>
          </div>
        )}

        {phase === "preview" && usage && (
          <>
            <div className="mt-1 mb-3 text-[11px] text-ink-subtle">{tr("skills.inc.usage", { tokens: usage.tokens })}</div>
            {binding && (
              <div
                className="mb-3 flex items-center gap-2 rounded-lg border border-hairline bg-surface-1 px-3 py-2 text-[11px]"
                title={binding.reason}
              >
                <Sparkles size={12} className="shrink-0 text-accent" />
                <span className="text-ink-muted">{tr("settings.defaultModel")}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {binding.provider} / {binding.model}
                </span>
                {binding.substituted && <span className="shrink-0 text-amber">{tr("org.panel.substituted")}</span>}
              </div>
            )}
            {mode === "worker" && wd && (
              <div className="rounded-xl p-4" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-hairline)" }}>
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-[11px] flex items-center justify-center" style={{ background: "linear-gradient(150deg, var(--color-accent-hover), var(--color-accent))" }}><User size={18} className="text-white" /></div>
                  <div className="min-w-0 flex-1">
                    <input value={String(wd.name || "")} onChange={e => setDesign({ ...wd, name: e.target.value })}
                      className="w-full bg-transparent border-0 border-b border-hairline focus:border-accent text-[14px] font-semibold text-ink outline-none py-0.5" />
                    <div className="text-[11px] text-ink-subtle mt-1">{String(wd.roleLabel || "")}</div>
                  </div>
                </div>
                <PersonaBox text={String(wd.persona || "")} />
                <button onClick={() => setPhase("pickParent")} disabled={busy}
                  className="btn-primary w-full mt-4 justify-center">{tr("skills.inc.hire")}</button>
              </div>
            )}
            {mode === "squad" && sd && (
              <div className="rounded-xl p-4" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-hairline)" }}>
                <input value={String(sd.squadName || "")} onChange={e => setDesign({ ...sd, squadName: e.target.value })}
                  className="w-full bg-transparent border-0 border-b border-hairline focus:border-accent text-[14px] font-semibold text-ink outline-none py-0.5" />
                <div className="text-[11px] text-ink-muted mt-1.5 leading-snug">{String(sd.description || "")}</div>
                <div className="mt-3 flex flex-col gap-2">
                  {(sd.members || []).map((mb, i) => (
                    <div key={i} className="rounded-lg px-2.5 py-2" style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-hairline)" }}>
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-[1px] rounded-full text-[10px] font-bold"
                          style={{ background: `color-mix(in srgb, ${ROLE_BADGE[String(mb.role)] ?? "#8b8e99"} 22%, transparent)`, color: ROLE_BADGE[String(mb.role)] ?? "var(--color-ink-muted)" }}>{String(mb.role)}</span>
                        <span className="text-[13px] font-medium text-ink truncate">{String(mb.name || "")}</span>
                      </div>
                      {mb.persona && <PersonaBox text={String(mb.persona)} />}
                    </div>
                  ))}
                </div>
                <button onClick={() => setPhase("pickParent")} disabled={busy}
                  className="btn-primary w-full mt-4 justify-center">{tr("skills.inc.hireSquad")}</button>
              </div>
            )}
            {mode === "team" && td && (
              <div className="rounded-xl p-4" style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-hairline)" }}>
                <input value={String(td.teamName || "")} onChange={e => setDesign({ ...td, teamName: e.target.value })}
                  className="w-full bg-transparent border-0 border-b border-hairline focus:border-accent text-[14px] font-semibold text-ink outline-none py-0.5" />
                <div className="text-[11px] text-ink-muted mt-1.5 leading-snug">{String(td.description || "")}</div>
                <TeamStructurePreview design={td} />
                <button onClick={installTeam} disabled={busy}
                  className="btn-primary w-full mt-4 justify-center">{busy ? "…" : tr("skills.inc.saveTemplate")}</button>
              </div>
            )}
          </>
        )}

        {phase === "done" && result && (
          <div className="py-6 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 size={30} style={{ color: "var(--color-success)" }} />
            <div className="text-[13px] text-ink font-medium">
              {result.kind === "worker" ? tr("skills.inc.doneWorker", { name: result.label })
                : result.kind === "squad" ? tr("skills.inc.doneSquad", { name: result.label })
                : tr("skills.inc.doneTeam", { name: result.label })}
            </div>
            {result.kind === "template" ? (
              <div className="flex gap-2 mt-1">
                <button onClick={buildCompany} disabled={busy} className="btn-primary">{tr("skills.inc.buildCompany")}</button>
                <button onClick={() => { window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "community" } })); onClose(); }}
                  className="btn-secondary">{tr("skills.inc.goShare")}</button>
              </div>
            ) : (
              <button onClick={() => { window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "org" } })); onClose(); }}
                className="btn-primary mt-1">{tr("skills.inc.viewOrg")}</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
