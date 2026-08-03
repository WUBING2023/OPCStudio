import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2, Users, ShieldCheck, Wrench, Radio, Share2, ClipboardCheck, Brain, Archive,
  ExternalLink, Download, Upload, RefreshCw, Trash2, AlertTriangle, CheckCircle2, XCircle, KeyRound,
  TerminalSquare, Plug, Sparkles, Zap, Loader2, type LucideIcon,
} from "lucide-react";
import type {
  Company, AgentNodeConfig, SkillMeta, CapabilityReport, CapabilityReportItem, CompanyTemplate,
} from "@opc/shared";
import { CompanyTemplateSchema, CompanyBundleSchema, bundleToTemplateShape, validateAgentWorkingDirectory } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { pushToast } from "../common/Toast.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { downloadJson } from "../../lib/download.js";
import HelpTip from "../HelpTip.js";
import InfoDisclosure from "../common/InfoDisclosure.js";
import WorkshopTeamEditor from "../community/WorkshopTeamEditor.js";
import WorkshopVerificationEditor from "../community/WorkshopVerificationEditor.js";
import WorkshopMcpEditor from "../community/WorkshopMcpEditor.js";
import WorkshopA2AEditor from "../community/WorkshopA2AEditor.js";
import { genKey, type WorkshopCard, type WorkshopEdge, type WorkshopMcpReq, type WorkshopA2AChannel } from "../community/workshopTypes.js";
import { companyToDraft, cardsToWorkshopCards, diffCardPatch, classifyCompanySkills, type NotExportedReason } from "../../lib/companyDraft.js";
import { API_FRAMEWORK } from "../../lib/framework.js";
import ExportConfirmDialog from "./ExportConfirmDialog.js";
import NativeExecutionPreferenceControl from "../NativeExecutionPreferenceControl.js";

// 公司架构 · 表单视图——原 CompanyManagementPage.tsx(独立页面,已废弃)的 9 个 Tab 原样迁移,只是
// 剥掉了"独立页面外壳"(返回按钮、路由级 companyId 查找/加载),改造成嵌进 OrgPage「公司架构」模式
// 直接渲染的组件:company/agents 由 OrgPage 就地提供,不再自己拉取公司列表。
export type Tab = "basic" | "team" | "verify" | "skills" | "mcp" | "a2a" | "capability" | "memory" | "backup";

const CAP_ICON: Record<CapabilityReportItem["kind"], LucideIcon> = {
  provider: KeyRound, cli: TerminalSquare, mcp: Plug, skill: Sparkles,
};

/* ────────── 1 · 基本信息 ────────── */

function BasicInfoTab({ company, onUpdated }: { company: Company; onUpdated: (c: Company) => void }) {
  const tr = useT();
  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description ?? "");
  useEffect(() => { setName(company.name); setDescription(company.description ?? ""); }, [company.id, company.name, company.description]);

  const patchCompany = useCallback(async (patch: Partial<Company>) => {
    try {
      const updated = await api.patch<Company>(`/companies/${company.id}`, patch);
      onUpdated(updated);
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
    }
  }, [company.id, onUpdated, tr]);

  // 收口③ · 主工作目录:设置/查看/变更/清除走专用端点 POST /companies/:id/folder(服务端全套安全
  // 检查:realpath/允许根/读写/磁盘/穿越;通用 PATCH 已封 folder 旁路)。非 Git 目录服务端回 409
  // needs_init_confirmation → 这里弹显式确认,用户点"初始化并绑定"才带 initAsManagedWorkspace
  // 重发——绝不静默 git init。导入/恢复的公司不携带本机路径(folder 恒空),未绑定态常显
  // "需重新绑定"提示。
  const [folderInput, setFolderInput] = useState(company.folder ?? "");
  const [folderBusy, setFolderBusy] = useState(false);
  useEffect(() => { setFolderInput(company.folder ?? ""); }, [company.id, company.folder]);

  async function bindFolder(initConfirmed: boolean): Promise<void> {
    const v = folderInput.trim();
    if (!v) return;
    setFolderBusy(true);
    try {
      const r = await api.post<{ company: Company; initialized?: boolean }>(
        `/companies/${company.id}/folder`,
        initConfirmed ? { folder: v, initAsManagedWorkspace: true } : { folder: v },
      );
      onUpdated(r.company);
      pushToast("success", tr("cmp.folder.bound"));
    } catch (e: any) {
      if (e?.status === 409 && !initConfirmed) {
        const yes = await confirmDialog({
          title: tr("cmp.folder.initConfirmTitle"),
          body: tr("cmp.folder.initConfirmBody"),
          confirmLabel: tr("cmp.folder.initConfirmOk"),
        });
        if (yes) { await bindFolder(true); return; }
      } else {
        pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
      }
    } finally {
      setFolderBusy(false);
    }
  }

  async function clearFolder(): Promise<void> {
    setFolderBusy(true);
    try {
      const r = await api.post<{ company: Company }>(`/companies/${company.id}/folder`, { folder: "" });
      onUpdated(r.company);
      setFolderInput("");
      pushToast("success", tr("cmp.folder.cleared"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
    } finally {
      setFolderBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-[520px]">
      <div>
        <label className="input-label">{tr("org.companyName")}</label>
        <input value={name} onChange={e => setName(e.target.value)}
          onBlur={() => { const v = name.trim(); if (v && v !== company.name) patchCompany({ name: v }); else setName(company.name); }}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="border-0 border-b-2 border-hairline bg-transparent text-[14px] py-1.5 w-full outline-none focus:border-accent transition-colors text-ink" />
      </div>
      <div>
        <label className="input-label">{tr("org.companyDesc")}</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={8}
          onBlur={() => { if (description !== (company.description ?? "")) patchCompany({ description }); }}
          className="border border-hairline rounded-lg bg-transparent text-[13px] p-2 w-full outline-none focus:border-accent transition-colors text-ink resize-y min-h-[160px]" />
      </div>
      <div>
        <label className="input-label">{tr("cmp.folder.title")}</label>
        {company.folder ? (
          <div className="flex items-center gap-2 mb-1.5">
            <code className="text-[12px] text-ink break-all flex-1">{company.folder}</code>
            <button onClick={clearFolder} disabled={folderBusy} className="btn-secondary shrink-0">
              {tr("cmp.folder.clear")}
            </button>
          </div>
        ) : (
          <div className="mb-1.5">
            <p className="text-[12px] text-ink-muted m-0">{tr("cmp.folder.unbound")}</p>
            <p className="text-[12px] text-ink-subtle m-0 mt-0.5">{tr("cmp.folder.rebindAfterImport")}</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input value={folderInput} onChange={e => setFolderInput(e.target.value)}
            placeholder={tr("cmp.folder.placeholder")}
            onKeyDown={e => { if (e.key === "Enter") bindFolder(false); }}
            className="border-0 border-b-2 border-hairline bg-transparent text-[13px] py-1.5 flex-1 outline-none focus:border-accent transition-colors text-ink" />
          <button onClick={() => bindFolder(false)} disabled={folderBusy || !folderInput.trim()}
            className="btn-secondary shrink-0">
            {folderBusy ? "…" : tr("cmp.folder.bind")}
          </button>
        </div>
        <InfoDisclosure className="mt-1">{tr("cmp.folder.hint")}</InfoDisclosure>
      </div>
      <NativeExecutionPreferenceControl
        scope="company"
        value={company.nativeExecution}
        onChange={async (nativeExecution) => { await patchCompany({ nativeExecution }); }}
      />
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input type="checkbox" checked={company.memoryExportEnabled ?? true}
          onChange={e => patchCompany({ memoryExportEnabled: e.target.checked })} />
        <span className="text-[13px] text-ink inline-flex items-center gap-1">
          {tr("cmp.memoryExportEnabled")}
          <HelpTip text={tr("cmp.memoryExportEnabledHint")} />
        </span>
      </label>
      <div>
        <label className="input-label">{tr("org.panel.createdAt")}</label>
        <div className="text-[13px] text-ink-muted">{new Date(company.createdAt).toLocaleString()}</div>
      </div>
    </div>
  );
}

/* ────────── 2 · 团队结构(真实 agent,增删改直接落到 /api/agents) ────────── */

// MUP Gate A#4 · 员工级相对工作子目录(workingDirectory):相对公司主工作目录/worktree 的 POSIX
// 相对路径。前端先做词法校验(validateAgentWorkingDirectory,拒绝绝对路径与 .. 逃逸)给即时反馈,
// runtime(parallelExecutor)侧同一口径再校验一次兜底。清空 = 回到 worktree 根(缺省行为)。
function AgentWorkdirEditor({ company, agents }: { company: Company; agents: AgentNodeConfig[] }) {
  const tr = useT();
  const list = useMemo(
    () => agents.filter(a => (a.companyId ?? "default") === company.id && a.enabled !== false),
    [agents, company.id],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { setDrafts({}); setErrors({}); }, [company.id]);

  const errText = (code: string) =>
    code === "absolute" ? tr("cmp.team.workdirErr.absolute")
    : code === "escape" ? tr("cmp.team.workdirErr.escape")
    : tr("cmp.team.workdirErr.root");

  const onInput = (a: AgentNodeConfig, value: string) => {
    setDrafts(d => ({ ...d, [a.id]: value }));
    const v = value.trim();
    if (!v) { setErrors(e => ({ ...e, [a.id]: "" })); return; }
    const check = validateAgentWorkingDirectory(v);
    setErrors(e => ({ ...e, [a.id]: check.ok ? "" : errText(check.code) }));
  };

  const commit = async (a: AgentNodeConfig) => {
    const raw = (drafts[a.id] ?? a.workingDirectory ?? "").trim();
    const current = a.workingDirectory ?? "";
    if (raw === current) return;
    let next = "";
    if (raw) {
      const check = validateAgentWorkingDirectory(raw);
      if (!check.ok) { setErrors(e => ({ ...e, [a.id]: errText(check.code) })); return; }
      next = check.normalized;
    }
    try {
      await useAgentStore.getState().update(a.id, { workingDirectory: next } as Partial<AgentNodeConfig>);
      setDrafts(d => ({ ...d, [a.id]: next }));
      setErrors(e => ({ ...e, [a.id]: "" }));
      pushToast("success", tr("cmp.team.workdirSaved"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e?.message || ""));
    }
  };

  if (list.length === 0) return null;
  return (
    <div className="rounded-xl border border-hairline p-3">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-2">
        {tr("cmp.team.workdirTitle")}
        <HelpTip text={tr("cmp.team.workdirHint")} />
      </div>
      <div className="flex flex-col gap-1.5">
        {list.map(a => (
          <div key={a.id} className="flex items-start gap-2">
            <span className="text-[12px] text-ink w-40 shrink-0 truncate pt-1" title={`${a.name} · ${a.role}`}>
              {a.name} <span className="text-ink-subtle text-[11px]">{a.role}</span>
            </span>
            <div className="flex-1 min-w-0">
              <input
                value={drafts[a.id] ?? a.workingDirectory ?? ""}
                onChange={e => onInput(a, e.target.value)}
                onBlur={() => commit(a)}
                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                placeholder={tr("cmp.team.workdirPlaceholder")}
                className={`border-0 border-b-2 bg-transparent text-[13px] py-1 w-full outline-none transition-colors text-ink font-mono ${
                  errors[a.id] ? "border-red" : "border-hairline focus:border-accent"
                }`}
              />
              {errors[a.id] && <p className="text-[11px] text-red m-0 mt-0.5">{errors[a.id]}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamTab({ company, agents, onSwitchToVisual }: { company: Company; agents: AgentNodeConfig[]; onSwitchToVisual: () => void }) {
  const tr = useT();
  const initialCards = useMemo(() => cardsToWorkshopCards(companyToDraft(company, agents).cards), [company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [teamCards, setTeamCards] = useState<WorkshopCard[]>(initialCards);
  // synced:最后一次确认已落地到服务端的快照(key=agentId),debounce 同步时用来跟当前 UI 状态做字段级
  // diff,只 PATCH 真正变了的字段/关系,不是整份覆盖式重发。
  const syncedRef = useRef<Map<string, WorkshopCard>>(new Map(initialCards.map(c => [c.key, c])));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const wc = cardsToWorkshopCards(companyToDraft(company, agents).cards);
    setTeamCards(wc);
    syncedRef.current = new Map(wc.map(c => [c.key, c]));
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // 只在切换公司时重置本地草稿——agents 后续的实时刷新(SSE/其它页面的操作)不应打断正在输入的编辑,
    // 与 CompanyPanel.tsx 验证边草稿"只在切公司时重置"是同一惯例。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  async function syncTeam(next: WorkshopCard[]) {
    const synced = syncedRef.current;
    const nextByKey = new Map(next.map(c => [c.key, c]));
    const store = useAgentStore.getState();

    // 1) 删除:synced 里有、next 里没有的 —— 软删(enabled:false)+ 从旧父节点 childrenIds 摘掉。
    for (const key of [...synced.keys()]) {
      if (nextByKey.has(key)) continue;
      const agent = store.agents.find(a => a.id === key);
      if (agent?.parentId) {
        const parent = store.agents.find(a => a.id === agent.parentId);
        if (parent) await store.update(parent.id, { childrenIds: parent.childrenIds.filter(id => id !== key) });
      }
      await store.update(key, { enabled: false });
      synced.delete(key);
    }

    // 2) 新增 + 3) 修改
    for (const c of next) {
      if (!synced.has(c.key)) {
        // 新卡片:name/role 填完整才真正建号(半填的先留在本地草稿里,下一轮 debounce 再试)。
        if (!c.name.trim() || !c.role.trim()) continue;
        const parentKey = c.reportsTo && synced.has(c.reportsTo) ? c.reportsTo : undefined;
        await store.update(c.key, {
          id: c.key, name: c.name.trim(), role: c.role.trim(),
          provider: c.provider.trim(), model: c.model.trim(), framework: c.framework || API_FRAMEWORK,
          parentId: parentKey, childrenIds: [], companyId: company.id, status: "idle",
          tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
          editable: true, deletable: true, enabled: true,
        } as Partial<AgentNodeConfig>);
        if (parentKey) {
          const parent = useAgentStore.getState().agents.find(a => a.id === parentKey);
          if (parent && !parent.childrenIds.includes(c.key)) {
            await store.update(parentKey, { childrenIds: [...parent.childrenIds, c.key] });
          }
        }
        synced.set(c.key, { ...c, reportsTo: parentKey ?? "" });
        continue;
      }

      const old = synced.get(c.key)!;
      const patch = diffCardPatch(old, c);
      if (old.reportsTo !== c.reportsTo) {
        const agent = useAgentStore.getState().agents.find(a => a.id === c.key);
        const oldParentId = agent?.parentId;
        const newParentId = c.reportsTo || undefined;
        if (oldParentId && oldParentId !== newParentId) {
          const oldParent = useAgentStore.getState().agents.find(a => a.id === oldParentId);
          if (oldParent) await store.update(oldParentId, { childrenIds: oldParent.childrenIds.filter(id => id !== c.key) });
        }
        if (newParentId && newParentId !== oldParentId) {
          const newParent = useAgentStore.getState().agents.find(a => a.id === newParentId);
          if (newParent && !newParent.childrenIds.includes(c.key)) {
            await store.update(newParentId, { childrenIds: [...newParent.childrenIds, c.key] });
          }
        }
        patch.parentId = newParentId;
      }
      if (Object.keys(patch).length) await store.update(c.key, patch);
      synced.set(c.key, c);
    }
  }

  const handleChange = (next: WorkshopCard[]) => {
    // CEO 是结构性角色(orchestrator 全量按 company.ceoId 找根)——这里拦在 UI 层,而不是等 debounce
    // 同步失败才提示,不然用户会先看到卡片消失、几百毫秒后又"诡异地飞回来"。
    if (company.ceoId) {
      const stillThere = next.find(c => c.key === company.ceoId);
      if (!stillThere) { pushToast("error", tr("cmp.team.cannotDeleteCeo")); return; }
      if (stillThere.role.trim().toLowerCase() !== "ceo") { pushToast("error", tr("cmp.team.ceoRoleLocked")); return; }
    }
    setTeamCards(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { syncTeam(next).catch(e => pushToast("error", tr("org.panel.saveFailed") + (e?.message || ""))); }, 700);
  };

  const errors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const c of teamCards) {
      if (!c.name.trim()) errs[`card:${c.key}:name`] = tr("cmp.team.nameRequired");
      if (!c.role.trim()) errs[`card:${c.key}:role`] = tr("cmp.team.roleRequired");
    }
    return errs;
  }, [teamCards, tr]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <HelpTip text={tr("cmp.team.hint")} />
        <button onClick={onSwitchToVisual}
          className="btn-secondary inline-flex items-center gap-1.5 shrink-0">
          <ExternalLink size={14} />{tr("cmp.team.openOrg")}
        </button>
      </div>
      <div className="px-3 py-1.5 rounded-lg bg-amber/10 border border-amber/20">
        <InfoDisclosure>{tr("cmp.team.systemPromptCaveat")}</InfoDisclosure>
      </div>
      <WorkshopTeamEditor cards={teamCards} onChange={handleChange} errors={errors} showErrors />
      <AgentWorkdirEditor company={company} agents={agents} />
    </div>
  );
}

/* ────────── 3 · 验证边 ────────── */

function VerifyTab({ company, cards, onUpdated }: { company: Company; cards: WorkshopCard[]; onUpdated: (c: Company) => void }) {
  const tr = useT();
  const seed = useCallback((): WorkshopEdge[] => (company.workflow?.verificationEdges ?? []).map(e => ({
    key: genKey(), producer: e.producer, verifier: e.verifier, method: e.method, onReject: e.onReject, maxRounds: e.maxRounds,
  })), [company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edges, setEdges] = useState<WorkshopEdge[]>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEdges(seed()); setDirty(false); }, [company.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const payload = edges.map(({ key, ...rest }) => rest);
      const updated = await api.patch<Company>(`/companies/${company.id}`, { workflow: { verificationEdges: payload } });
      onUpdated(updated);
      setDirty(false);
      pushToast("success", tr("org.panel.edgesSaved"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.edgesSaveFailed") + (e.message || ""));
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 提示文字不在这里重复——WorkshopVerificationEditor 内部本来就有同一句(tw.verifyHint),
          外层再包一遍会重复显示两次(用户实测发现),这里只保留保存按钮的定位容器。 */}
      <div className="flex items-center justify-end gap-2">
        {dirty && <button onClick={save} disabled={saving} className="btn-primary shrink-0">{saving ? "…" : tr("common.save")}</button>}
      </div>
      <WorkshopVerificationEditor edges={edges} cards={cards}
        onChange={next => { setEdges(next); setDirty(true); }} errors={{}} showErrors={false} />
    </div>
  );
}

/* ────────── 4 · 技能打包(只读反查,非模板打包语义——见 companyDraft.ts 顶部注释) ────────── */

function SkillsTab({ company, agents }: { company: Company; agents: AgentNodeConfig[] }) {
  const tr = useT();
  const [allSkills, setAllSkills] = useState<SkillMeta[]>([]);
  useEffect(() => {
    // /skills defaults to user-owned Skills; company packaging facts live in the
    // explicitly hidden bundled layer. Merge both so this view matches runtime
    // injection and company export instead of incorrectly reporting zero Skills.
    Promise.all([
      api.get<SkillMeta[]>("/skills"),
      api.get<SkillMeta[]>("/skills?origin=bundled"),
    ]).then(([userSkills, bundledSkills]) => setAllSkills([...userSkills, ...bundledSkills]))
      .catch(() => setAllSkills([]));
  }, [company.id]);

  // P0-B · 三态区分(不再是笼统的"只读反查"):真导出会带走的 / 关联但不会带走的 / 接收方安装后会注入的。
  // 口径镜像服务端 collectBundledSkills(见 companyDraft.classifyCompanySkills),诚实回答分享时到底会发生什么。
  const cls = useMemo(() => classifyCompanySkills(company, agents, allSkills), [company, agents, allSkills]);
  const reasonText = (r: NotExportedReason) =>
    r === "other-company" ? tr("cmp.skills.reason.otherCompany") : tr("cmp.skills.reason.noTemplateMatch");

  return (
    <div className="flex flex-col gap-3">
      <div className="px-3 py-1.5 rounded-lg bg-amber/10 border border-amber/20">
        <InfoDisclosure>{tr("cmp.skills.readonlyHint")}</InfoDisclosure>
      </div>

      {/* ① 已绑定且会导出 */}
      <div className="rounded-xl border border-border p-3 bg-bg-card">
        <div className="flex items-center gap-1.5 mb-2">
          <CheckCircle2 size={14} className="text-green shrink-0" />
          <h4 className="m-0 text-[13px] font-semibold text-text-primary">{tr("cmp.skills.exportedTitle")} ({cls.exported.length})</h4>
          <HelpTip text={tr("cmp.skills.exportedHint")} />
        </div>
        {cls.exported.length === 0 ? (
          <div className="text-[12px] text-text-muted">{tr("cmp.skills.none")}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cls.exported.map(s => (
              <div key={s.title} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-bg-hover border border-border">
                <b className="text-[12px] text-text-primary min-w-0 truncate">{s.title}</b>
                <span className="flex flex-wrap gap-1 justify-end shrink-0">
                  {s.roles.map(r => (
                    <span key={r} className="px-1.5 py-0.5 rounded-full text-[10px] bg-accent/10 text-accent border border-accent/20">{r}</span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ② 关联但不会导出 */}
      <div className="rounded-xl border border-border p-3 bg-bg-card">
        <div className="flex items-center gap-1.5 mb-2">
          <AlertTriangle size={14} className="text-amber shrink-0" />
          <h4 className="m-0 text-[13px] font-semibold text-text-primary">{tr("cmp.skills.notExportedTitle")} ({cls.notExported.length})</h4>
          <HelpTip text={tr("cmp.skills.notExportedHint")} />
        </div>
        {cls.notExported.length === 0 ? (
          <div className="text-[12px] text-text-muted">{tr("cmp.skills.none")}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cls.notExported.map(s => (
              <div key={s.skillId} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-bg-hover border border-border">
                <span className="min-w-0">
                  <b className="text-[12px] text-text-primary block truncate">{s.title}</b>
                  <span className="text-[10px] text-text-muted">{s.role} · {reasonText(s.reason)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ③ 社区安装后会实际注入 */}
      <div className="rounded-xl border border-border p-3 bg-bg-card">
        <div className="flex items-center gap-1.5 mb-2">
          <Download size={14} className="text-accent shrink-0" />
          <h4 className="m-0 text-[13px] font-semibold text-text-primary">{tr("cmp.skills.injectTitle")} ({cls.injected.length})</h4>
          <HelpTip text={tr("cmp.skills.injectHint")} />
        </div>
        {cls.injected.length === 0 ? (
          <div className="text-[12px] text-text-muted">{tr("cmp.skills.none")}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {cls.injected.map((s, i) => (
              <span key={`${s.title}-${s.role}-${i}`} className="px-2 py-1 rounded-md text-[11px] bg-bg-hover border border-border text-text-secondary">
                <b className="text-text-primary">{s.role}</b> ← {s.title}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────── 5 · MCP 需求 ────────── */

function McpTab({ company, onUpdated }: { company: Company; onUpdated: (c: Company) => void }) {
  const tr = useT();
  const seed = useCallback((): WorkshopMcpReq[] => (company.manifestMcpRequirements ?? []).map(m => ({
    key: genKey(), name: m.name, purpose: m.purpose ?? "", optional: !!m.optional,
  })), [company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reqs, setReqs] = useState<WorkshopMcpReq[]>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setReqs(seed()); setDirty(false); }, [company.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const payload = reqs.filter(r => r.name.trim()).map(r => ({
        name: r.name.trim(), purpose: r.purpose.trim() || undefined, optional: r.optional || undefined,
      }));
      const updated = await api.patch<Company>(`/companies/${company.id}`, { manifestMcpRequirements: payload });
      onUpdated(updated);
      setDirty(false);
      pushToast("success", tr("cmp.mcp.saved"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 提示文字不在这里重复——WorkshopMcpEditor 内部本来就有同一句(tw.mcpHint),外层再包一遍
          会重复显示两次(用户实测发现),这里只保留保存按钮的定位容器。 */}
      <div className="flex items-center justify-end gap-2">
        {dirty && <button onClick={save} disabled={saving} className="btn-primary shrink-0">{saving ? "…" : tr("common.save")}</button>}
      </div>
      <WorkshopMcpEditor requirements={reqs} onChange={next => { setReqs(next); setDirty(true); }} errors={{}} showErrors={false} />
    </div>
  );
}

/* ────────── 6 · A2A 预置通道 ────────── */

function A2ATab({ company, cards, onUpdated }: { company: Company; cards: WorkshopCard[]; onUpdated: (c: Company) => void }) {
  const tr = useT();
  const seed = useCallback((): WorkshopA2AChannel[] => (company.presetChannels ?? []).map(c => ({
    key: genKey(), from: c.from, to: c.to, purpose: c.purpose ?? "",
    direction: c.direction, authPolicy: c.authPolicy, enabled: c.enabled,
  })), [company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [channels, setChannels] = useState<WorkshopA2AChannel[]>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setChannels(seed()); setDirty(false); }, [company.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      const payload = channels
        .filter(c => c.from && c.to && c.from !== c.to)
        .map(c => ({
          from: c.from, to: c.to, purpose: c.purpose.trim() || undefined,
          ...(c.direction ? { direction: c.direction } : {}),
          ...(c.authPolicy ? { authPolicy: c.authPolicy } : {}),
          ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
        }));
      const updated = await api.patch<Company>(`/companies/${company.id}`, { presetChannels: payload });
      onUpdated(updated);
      setDirty(false);
      pushToast("success", tr("cmp.a2a.saved"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 提示文字不在这里重复——WorkshopA2AEditor 内部本来就有同一句(tw.a2aHint),外层再包一遍
          会重复显示两次(用户实测发现),这里只保留保存按钮的定位容器。 */}
      <div className="flex items-center justify-end gap-2">
        {dirty && <button onClick={save} disabled={saving} className="btn-primary shrink-0">{saving ? "…" : tr("common.save")}</button>}
      </div>
      <WorkshopA2AEditor channels={channels} cards={cards} onChange={next => { setChannels(next); setDirty(true); }} errors={{}} showErrors={false} />
    </div>
  );
}

/* ────────── 7 · 能力边界报告(只读;OrgPage 在两种模式下都提供一个入口——见 OrgPage 顶部按钮) ────────── */

// 固定契约(能力报告"测试连接"按钮 → POST /api/companies/:id/connectivity-test):对每个真实
// agent 用它当前配置的 provider/model 真发一次极简 prompt(或探测 CLI 登录态)测是否真的能调通。
// 本地镜像服务端 ConnectivityTestResult 形状,不跨包引入(与 MissionBrief 等既有做法一致)。
interface ConnectivityTestResult {
  agentId: string; name: string; role: string; provider: string; model: string;
  ok: boolean; latencyMs?: number; message?: string;
}

// 公司选择器旁的图标从"能力边界报告"换成"全量测试连接"(用户明确要求:点开直接看连通性,不用先
// 弹能力报告再找测试按钮)——独立抽出来,打开即自动跑一次,不需要用户先点一下"测试"。能力报告本身
// (readiness/missing 分析)还在,只是移到 CompanyStructureForms 自己的表单 tab 里(见下面 CapabilityTab),
// 不再是 OrgPage 顶部这个入口的默认内容。
export function ConnectivityTestPanel({ companyId }: { companyId: string }) {
  const tr = useT();
  const [connResults, setConnResults] = useState<ConnectivityTestResult[] | null>(null);
  const [connTesting, setConnTesting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const runConnectivityTest = useCallback(async () => {
    setConnTesting(true); setConnError(null);
    try {
      const r = await api.post<{ results: ConnectivityTestResult[] }>(`/companies/${companyId}/connectivity-test`, {});
      setConnResults(r.results);
    } catch (e: any) {
      setConnError(e.message || tr("org.panel.reportFailed"));
    } finally {
      setConnTesting(false);
    }
  }, [companyId, tr]);
  // 打开即测,不用户额外点一下——这是这个入口存在的唯一目的("全量测试连接"),不是先看报告再测。
  useEffect(() => { void runConnectivityTest(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-2 max-w-[640px] min-w-[320px]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-ink-subtle m-0">{tr("org.panel.connResultsTitle")}</p>
        <button onClick={runConnectivityTest} disabled={connTesting}
          className="flex items-center gap-1 text-[11px] text-accent hover:opacity-80 disabled:opacity-50 transition-colors bg-transparent border-none cursor-pointer">
          {connTesting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {connTesting ? tr("org.panel.connTesting") : tr("org.panel.refreshReport")}
        </button>
      </div>
      <div className="flex flex-col gap-1 rounded-lg border border-hairline p-2.5">
        {connTesting && !connResults && <div className="text-[12px] text-ink-muted py-1.5">{tr("org.panel.connTesting")}</div>}
        {connError && <div className="text-[12px] text-red py-1.5">{connError}</div>}
        {connResults && connResults.length === 0 && (
          <div className="text-[12px] text-ink-muted py-1.5">{tr("org.panel.connNoAgents")}</div>
        )}
        {connResults && connResults.map(r => (
          <div key={r.agentId} className="flex items-center gap-2 text-[12px] py-1 border-b border-hairline last:border-0">
            {r.ok ? <CheckCircle2 size={13} className="text-green shrink-0" /> : <XCircle size={13} className="text-red shrink-0" />}
            <span className="text-ink truncate">{r.name}</span>
            <span className="text-ink-subtle text-[11px] shrink-0">{r.role} · {r.provider}/{r.model}</span>
            {typeof r.latencyMs === "number" && <span className="text-ink-subtle text-[11px] shrink-0 tabular-nums">{r.latencyMs}ms</span>}
            {!r.ok && r.message && <span className="text-red/80 text-[11px] ml-auto truncate" title={r.message}>{r.message}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CapabilityTab({ companyId }: { companyId: string }) {
  const tr = useT();
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.get<CapabilityReport>(`/companies/${companyId}/capability-report`)
      .then(r => { if (!cancelled) setReport(r); })
      .catch(e => { if (!cancelled) setError(e.message || "error"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, nonce]);

  // "测试连接"按钮:独立于能力报告加载状态,点了才发(不阻塞界面/不随报告轮询自动重跑)。
  const [connResults, setConnResults] = useState<ConnectivityTestResult[] | null>(null);
  const [connTesting, setConnTesting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const runConnectivityTest = useCallback(async () => {
    setConnTesting(true); setConnError(null);
    try {
      const r = await api.post<{ results: ConnectivityTestResult[] }>(`/companies/${companyId}/connectivity-test`, {});
      setConnResults(r.results);
    } catch (e: any) {
      setConnError(e.message || tr("org.panel.reportFailed"));
    } finally {
      setConnTesting(false);
    }
  }, [companyId, tr]);

  return (
    <div className="flex flex-col gap-3 max-w-[640px]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-ink-subtle m-0">{tr("org.panel.capabilityReport")}</p>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={runConnectivityTest} disabled={connTesting}
            className="flex items-center gap-1 text-[11px] text-accent hover:opacity-80 disabled:opacity-50 transition-colors bg-transparent border-none cursor-pointer">
            {connTesting ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {connTesting ? tr("org.panel.connTesting") : tr("org.panel.connTest")}
          </button>
          <button onClick={() => setNonce(n => n + 1)} disabled={loading}
            className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50 transition-colors bg-transparent border-none cursor-pointer">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />{tr("org.panel.refreshReport")}
          </button>
        </div>
      </div>

      {/* 连通性测试结果——独立于下方能力报告(不需要先加载报告才能测),loading 态不卡界面。 */}
      {(connTesting || connResults || connError) && (
        <div className="flex flex-col gap-1 rounded-lg border border-hairline p-2.5">
          <div className="text-[11px] text-ink-muted mb-1">{tr("org.panel.connResultsTitle")}</div>
          {connTesting && !connResults && <div className="text-[12px] text-ink-muted py-1.5">{tr("org.panel.connTesting")}</div>}
          {connError && <div className="text-[12px] text-red py-1.5">{connError}</div>}
          {connResults && connResults.length === 0 && (
            <div className="text-[12px] text-ink-muted py-1.5">{tr("org.panel.connNoAgents")}</div>
          )}
          {connResults && connResults.map(r => (
            <div key={r.agentId} className="flex items-center gap-2 text-[12px] py-1 border-b border-hairline last:border-0">
              {r.ok ? <CheckCircle2 size={13} className="text-green shrink-0" /> : <XCircle size={13} className="text-red shrink-0" />}
              <span className="text-ink truncate">{r.name}</span>
              <span className="text-ink-subtle text-[11px] shrink-0">{r.role} · {r.provider}/{r.model}</span>
              {typeof r.latencyMs === "number" && <span className="text-ink-subtle text-[11px] shrink-0 tabular-nums">{r.latencyMs}ms</span>}
              {!r.ok && r.message && <span className="text-red/80 text-[11px] ml-auto truncate" title={r.message}>{r.message}</span>}
            </div>
          ))}
        </div>
      )}

      {loading && !report && <div className="text-[12px] text-ink-muted py-3">{tr("org.panel.reportLoading")}</div>}
      {error && <div className="text-[12px] text-red py-2">{tr("org.panel.reportFailed")}: {error}</div>}
      {report && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${report.canRun ? "bg-green/10 text-green" : "bg-red/10 text-red"}`}>
              {report.canRun ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
              {report.canRun ? tr("org.panel.canRun") : tr("org.panel.cannotRun")}
            </span>
            <span className="text-[11px] text-ink-subtle">{tr("org.panel.generatedAt", { time: new Date(report.generatedAt).toLocaleString() })}</span>
          </div>

          {report.ready.length > 0 && (
            <div>
              <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.ready")}</div>
              <div className="flex flex-wrap gap-1.5">
                {report.ready.map((it, i) => {
                  const Icon = CAP_ICON[it.kind] || CheckCircle2;
                  return (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-green/10 text-green border border-green/20">
                      <Icon size={11} />{it.name}{it.detail ? ` · ${it.detail}` : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {(report.substituted?.length ?? 0) > 0 && (
            <div>
              <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.substituted")}</div>
              <div className="flex flex-col gap-1.5">
                {report.substituted.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-accent/20 bg-accent/5">
                    <Sparkles size={13} className="text-accent mt-0.5 shrink-0" />
                    <div className="text-[12px] text-ink">{s.note}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.needsAuth.length > 0 && (
            <div>
              <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.needsAuth")}</div>
              <div className="flex flex-col gap-1.5">
                {report.needsAuth.map((n, i) => {
                  const Icon = CAP_ICON[n.item.kind] || AlertTriangle;
                  return (
                    <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-amber/20 bg-amber/5">
                      <Icon size={13} className="text-amber mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[12px] text-ink">
                          {n.item.name}
                          <span className={`ml-1.5 text-[10px] px-1 py-[1px] rounded-full ${n.required ? "bg-red/10 text-red" : "bg-surface-2 text-ink-subtle"}`}>
                            {n.required ? tr("org.panel.required") : tr("org.panel.optional")}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-muted mt-0.5">{n.howTo}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {report.authorAnnotated && report.notApplicable.length > 0 && (
            <div>
              <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.notApplicable")}</div>
              <ul className="list-none p-0 m-0 flex flex-col gap-1">
                {report.notApplicable.map((n, i) => <li key={i} className="text-[11px] text-ink-subtle">· {n.note}</li>)}
              </ul>
            </div>
          )}

          {report.suggestedTeam.length > 0 && (
            <div>
              <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.suggestedTeam")}</div>
              <div className="flex flex-col gap-1">
                {report.suggestedTeam.map(m => (
                  <div key={m.agentId} className="flex items-center gap-2 text-[12px] py-1">
                    {m.readyToRun ? <CheckCircle2 size={13} className="text-green shrink-0" /> : <XCircle size={13} className="text-red shrink-0" />}
                    <span className="text-ink truncate">{m.agentName}</span>
                    <span className="text-ink-subtle text-[11px] shrink-0">{m.role} · {m.provider}/{m.framework}</span>
                    {!m.readyToRun && m.blockedReason && <span className="text-red/80 text-[11px] ml-auto truncate">{m.blockedReason}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────── 8 · 记忆(company.md 只读展示 + 安全摘要导出) ────────── */

function MemoryTab({ companyId }: { companyId: string }) {
  const tr = useT();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true); setNotFound(false); setContent(null);
    // company.md 按公司隔离落在 .opc/knowledge/companies/<id>/company.md(见 mdMemory.ts)——目前没有
    // 专门的公司知识读写端点,借用已有的通用只读文件接口 GET /api/file(fileRoutes.ts:isSensitive 白名单
    // 明确放行 .opc/knowledge/ 下的 .md)。没有编辑端点,这里就只做只读展示,见页面返回说明里的已知缺口。
    const relPath = `.opc/knowledge/companies/${companyId}/company.md`;
    api.get<{ text: string }>(`/file?path=${encodeURIComponent(relPath)}`)
      .then(r => setContent(r.text))
      .catch((e: any) => {
        if (e?.status === 404) setNotFound(true);
        else pushToast("error", tr("cmp.memory.loadFailed") + (e?.message || ""));
      })
      .finally(() => setLoading(false));
  }, [companyId, tr]);

  const [digest, setDigest] = useState<api.MemoryDigestResult | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);
  const loadDigest = () => {
    setDigestLoading(true); setDigestError(null);
    api.getMemoryDigest(companyId, 3).then(setDigest).catch(e => setDigestError(e.message || "error")).finally(() => setDigestLoading(false));
  };

  return (
    <div className="flex flex-col gap-5 max-w-[640px]">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
            {tr("cmp.memory.companyMd")}
            <HelpTip text={tr("cmp.memory.readonlyHint")} />
          </div>
        </div>
        {loading ? (
          <div className="text-[12px] text-ink-muted py-2">{tr("c.loading")}</div>
        ) : notFound ? (
          <div className="text-[12px] text-ink-muted py-2">{tr("cmp.memory.empty")}</div>
        ) : (
          <textarea readOnly value={content ?? ""} rows={14}
            className="w-full border border-hairline rounded-lg bg-surface-0 text-[13px] p-3 outline-none text-ink font-mono resize-y" />
        )}
      </div>
      <div className="section-divider" />
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
            {tr("memory.digest.title")}
            <HelpTip text={tr("memory.digest.subtitle")} />
          </div>
          <button onClick={loadDigest} disabled={digestLoading} className="btn-secondary">
            {digestLoading ? tr("memory.digest.generating") : tr("memory.digest.generate")}
          </button>
        </div>
        {digestError && <div className="text-[12px] text-red mb-2">{digestError}</div>}
        {digest && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-ink font-semibold text-[13px] mb-1.5">{tr("memory.digest.practices")}</div>
              {digest.practices.length === 0 ? (
                <p className="m-0 text-[12px] text-ink-subtle">{tr("memory.digest.practicesEmpty")}</p>
              ) : (
                <ul className="m-0 pl-4 space-y-1">{digest.practices.map(p => <li key={p.id} className="text-[13px] text-ink-muted leading-snug">{p.text}</li>)}</ul>
              )}
            </div>
            <div>
              <div className="text-ink font-semibold text-[13px] mb-1.5">{tr("memory.digest.lessons")}</div>
              {digest.lessons.length === 0 ? (
                <p className="m-0 text-[12px] text-ink-subtle">{tr("memory.digest.lessonsEmpty")}</p>
              ) : (
                <ul className="m-0 pl-4 space-y-1.5">
                  {digest.lessons.map(l => (
                    <li key={l.id} className="text-[13px] text-ink-muted leading-snug">
                      {l.text}<span className="text-ink-subtle text-[11px] ml-1.5">{tr("memory.lessons.confidence", { pct: Math.round(l.confidence * 100) })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="text-[11px] text-ink-subtle">{tr("memory.digest.generatedAt", { time: new Date(digest.generatedAt).toLocaleString() })}</div>
            <button onClick={() => downloadJson(digest, `memory-digest-${companyId}-${Date.now()}.json`)}
              className="btn-secondary self-start inline-flex items-center gap-1.5"><Download size={13} />{tr("memory.digest.download")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────── 9 · 导入导出与备份 ────────── */

interface CompanyBackupEntry {
  filename: string;
  companyTitle: string;
  agentCount: number;
  originalCompanyId?: string;
  backedUpAt: string;
}

// 本地按 FileReader 读文件内容(不先上传到某个临时目录再处理,读完直接校验/POST)。
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}

function BackupTab({ company, onDeleted, onRestored, onUpdated }: { company: Company; onDeleted: () => void; onRestored: (companyId: string) => void; onUpdated: (c: Company) => void }) {
  const tr = useT();
  const [backups, setBackups] = useState<CompanyBackupEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringFile, setRestoringFile] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadBackups = useCallback(() => {
    setLoading(true);
    api.get<CompanyBackupEntry[]>("/companies/backups").then(setBackups).catch(() => setBackups([])).finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadBackups(); }, [loadBackups]);

  // 修复:之前 <a href="/api/.../export"> 直接导航,下载到的是服务端 res.json() 压缩成一整行的输出,
  // 难以阅读。改成 fetch 内容后本地生成带 2 格缩进的文件再下载(downloadJson,与「分享」草稿导出同款)。
  // P1-18:导出前先过 ExportConfirmDialog——用户看过"自动移除密钥/本地路径"的说明、就地确认
  // 「导出时一并带上记忆」开关(与公司当前设置不同才 PATCH 落盘,服务端按落盘后的值过滤 memory.records)
  // 后才真正发起导出;不做任何前端侧的脱敏("移除项"由服务端统一兜底,弹窗只负责透明告知)。
  const exportTemplate = async (memoryExportEnabled: boolean, profile: "full" | "share") => {
    setExporting(true);
    try {
      if (memoryExportEnabled !== (company.memoryExportEnabled ?? true)) {
        const updated = await api.patch<Company>(`/companies/${company.id}`, { memoryExportEnabled });
        onUpdated(updated);
      }
      // 分场景导出:profile=full(自己备份/迁移,保真)| share(社区分享,缺省)。服务端据此决定
      // genericCli/本机路径保留还是剥离、是否带员工个人记忆(见 companyRoutes GET .../export)。
      const tpl = await api.get<CompanyTemplate>(`/companies/${company.id}/export?profile=${profile}`);
      const suffix = profile === "full" ? ".full" : "";
      downloadJson(tpl, `${company.name || company.id}${suffix}.opc.bundle.json`);
      setExportConfirmOpen(false);
    } catch (e: any) {
      pushToast("error", tr("org.exportCompanyFailed") + (e.message || ""));
    } finally {
      setExporting(false);
    }
  };

  // 分享到社区:跳转到现成的模板工坊流程(TemplateWorkshop"从当前公司创建草稿"入口),不重新实现
  // 一套分享逻辑。跨页时机不确定(社区页可能还没挂载),sessionStorage 兜底 + 实时事件双保险,
  // 与 open-task-run 的既有跨页契约同一惯例(见 App.tsx/CommunityPage.tsx)。
  const shareToCommunity = () => {
    try { sessionStorage.setItem("opc-workshop-company", company.id); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("open-template-workshop", { detail: { companyId: company.id } }));
    window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "community" } }));
  };

  // 直接导入一份本地 JSON 文件(不要求它在 .opc/company-backups/ 目录里)——读取 → 按
  // CompanyTemplateSchema 校验(先本地校验给即时反馈,服务端 /companies/import 会再校验一次兜底)→
  // 校验通过后落地成新公司,复用现成的 install/company 语义(见 companyRoutes.ts installCompanyTemplate)。
  const handleImportFile = useCallback(async (file: File) => {
    setImporting(true);
    try {
      const text = await readFileAsText(file);
      let json: unknown;
      try { json = JSON.parse(text); } catch { pushToast("error", tr("cmp.backup.importInvalidJson")); return; }
      // P0-3:同时接受 canonical Company Bundle(带 schema_version)与旧 flat 模板。带 schema_version 的
      // 先桥接回扁平形状再本地校验给即时反馈;服务端 /companies/import 也会各自兜底(bundle-aware)。
      const asBundle = CompanyBundleSchema.safeParse(json);
      const candidate: unknown = asBundle.success ? bundleToTemplateShape(asBundle.data) : json;
      const parsed = CompanyTemplateSchema.safeParse(candidate);
      if (!parsed.success) {
        pushToast("error", tr("cmp.backup.importSchemaInvalid") + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
        return;
      }
      // 安全:文件自封 full 档(含本机命令+危险权限)不再由服务端自动免降权。检测到 full 时当场问
      // 用户是否完整还原;防陌生人发来的 JSON 在用户不知情下静默还原危险命令。
      // 令四.1(镜像 CommunityPage 两步流):客户端布尔 unsafeAcknowledged 已废——用户确认只是 UI 选择,
      // 真正的授权凭据是服务端 preview 分支签发的一次性 installConfirmationToken:先 mode:"preview" 拿
      // token,真装带回才保留高危授权;不带 token(用户选安全导入/未拿到 token)服务端恒走 Safe Install 剥离。
      let tokenField: { installConfirmationToken?: string } = {};
      if (asBundle.success && asBundle.data.export_profile === "full") {
        const fullRestore = await confirmDialog({
          title: tr("cmp.backup.fullImportTitle"),
          body: tr("cmp.backup.fullImportBody"),
          danger: true,
          confirmLabel: tr("cmp.backup.fullImportConfirm"),
          cancelLabel: tr("cmp.backup.fullImportSafe"),
        });
        if (fullRestore) {
          const pv = await api.post<{ installConfirmationToken?: string }>("/companies/import", { ...(json as object), mode: "preview" });
          if (pv.installConfirmationToken) tokenField = { installConfirmationToken: pv.installConfirmationToken };
        }
      }
      const r = await api.post<{ companyId: string }>("/companies/import", { ...(json as object), ...tokenField });
      pushToast("success", tr("cmp.backup.imported"));
      // 收口③:模板/备份永不携带本机路径(folder/workspaceDir 导出即剥),导入落地的公司必然未绑定
      // 主工作目录——就地提示用户去基本信息页重新绑定。
      pushToast("info", tr("cmp.folder.rebindAfterImport"));
      await useAgentStore.getState().load();
      onRestored(r.companyId);
    } catch (e: any) {
      pushToast("error", tr("cmp.backup.importFailed") + (e.message || ""));
    } finally {
      setImporting(false);
    }
  }, [tr, onRestored]);

  const restore = async (filename: string) => {
    setRestoringFile(filename);
    try {
      const r = await api.post<{ companyId: string }>(`/companies/backups/${encodeURIComponent(filename)}/restore`, {});
      pushToast("success", tr("cmp.backup.restored"));
      pushToast("info", tr("cmp.folder.rebindAfterImport")); // 收口③:备份同样不带本机路径,恢复后需重新绑定
      await useAgentStore.getState().load();
      onRestored(r.companyId);
    } catch (e: any) {
      pushToast("error", tr("cmp.backup.restoreFailed") + (e.message || ""));
    } finally { setRestoringFile(null); }
  };

  const handleDelete = async () => {
    if (company.id === "default") { pushToast("error", tr("org.defaultCompanyUndeletable")); return; }
    if (!await confirmDialog({ title: tr("cmp.backup.deleteConfirmTitle"), body: tr("cmp.backup.deleteConfirmBody"), danger: true, confirmLabel: tr("common.delete") })) return;
    setDeleting(true);
    try {
      await api.del(`/companies/${company.id}`);
      pushToast("success", tr("cmp.backup.deleted"));
      await useAgentStore.getState().load();
      onDeleted();
    } catch (e: any) {
      pushToast("error", tr("org.deleteCompanyFailed") + (e.message || ""));
    } finally { setDeleting(false); }
  };

  return (
    <div className="flex flex-col gap-5 max-w-[640px]">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-2">{tr("cmp.backup.exportTitle")}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setExportConfirmOpen(true)} disabled={exporting} className="btn-secondary inline-flex items-center gap-1.5">
            <Download size={14} />{exporting ? "…" : tr("org.exportCompany")}
          </button>
          <ExportConfirmDialog
            open={exportConfirmOpen}
            companyName={company.name || company.id}
            initialMemoryEnabled={company.memoryExportEnabled ?? true}
            exporting={exporting}
            onConfirm={exportTemplate}
            onCancel={() => setExportConfirmOpen(false)}
          />
          <button onClick={shareToCommunity} className="btn-secondary inline-flex items-center gap-1.5">
            <Share2 size={14} />{tr("cmp.backup.shareToCommunity")}
          </button>
        </div>
      </div>
      <div className="section-divider" />
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-2">{tr("cmp.backup.importTitle")}</div>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleImportFile(file);
          }}
          className={`flex flex-col items-center justify-center gap-2 p-5 rounded-lg border border-dashed text-center transition-colors ${
            dragOver ? "border-accent bg-accent/5" : "border-hairline"
          }`}
        >
          <Upload size={18} className="text-ink-subtle" />
          <p className="text-[12px] text-ink-subtle m-0">{tr("cmp.backup.importDropHint")}</p>
          <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing} className="btn-secondary inline-flex items-center gap-1.5">
            <Upload size={14} />{importing ? "…" : tr("cmp.backup.importPick")}
          </button>
        </div>
      </div>
      <div className="section-divider" />
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{tr("cmp.backup.listTitle")}</div>
          <button onClick={loadBackups} disabled={loading}
            className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50 transition-colors bg-transparent border-none cursor-pointer">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />{tr("org.panel.refreshReport")}
          </button>
        </div>
        {backups.length === 0 ? (
          <div className="text-[12px] text-ink-muted py-2">{tr("cmp.backup.empty")}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {backups.map(b => (
              <div key={b.filename} className="flex items-center gap-3 p-2.5 rounded-lg border border-hairline bg-surface-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate">{b.companyTitle}</div>
                  <div className="text-[11px] text-ink-subtle truncate">{tr("cmp.backup.meta", { n: b.agentCount, time: new Date(b.backedUpAt).toLocaleString() })}</div>
                </div>
                <button onClick={() => restore(b.filename)} disabled={restoringFile === b.filename} className="btn-secondary shrink-0">
                  {restoringFile === b.filename ? "…" : tr("cmp.backup.restore")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="section-divider" />
      <div>
        <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-2">
          {tr("cmp.backup.dangerTitle")}
          <HelpTip text={tr("cmp.backup.dangerHint")} />
        </div>
        <button onClick={handleDelete} disabled={deleting} className="btn-danger inline-flex items-center gap-1.5">
          <Trash2 size={14} />{deleting ? "…" : tr("org.deleteCompany")}
        </button>
      </div>
    </div>
  );
}

/* ────────── 主组件(嵌进 OrgPage 架构模式渲染,不带页面级外壳) ────────── */

export default function CompanyStructureForms({
  company, agents, onCompanyUpdated, onSwitchToVisual, onCompanySwitch,
}: {
  company: Company;
  agents: AgentNodeConfig[];
  onCompanyUpdated: (c: Company) => void;
  /** "团队结构" tab 里的「在组织图中打开」按钮——同一页面内切到「可视化」子模式,不做跨页跳转。 */
  onSwitchToVisual: () => void;
  /** 备份恢复出新公司 / 删除当前公司后,把 OrgPage 当前正在看的公司切过去(替代旧页面的跨页跳转)。 */
  onCompanySwitch: (companyId: string) => void;
}) {
  const tr = useT();
  const [tab, setTab] = useState<Tab>("basic");
  useEffect(() => { setTab("basic"); }, [company.id]);

  const cards = useMemo<WorkshopCard[]>(
    () => cardsToWorkshopCards(companyToDraft(company, agents).cards),
    [company, agents],
  );

  const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
    { key: "basic", label: tr("tw.tabBasic"), Icon: Building2 },
    { key: "team", label: tr("tw.tabTeam"), Icon: Users },
    { key: "verify", label: tr("tw.tabVerify"), Icon: ShieldCheck },
    { key: "skills", label: tr("tw.tabSkills"), Icon: Wrench },
    { key: "mcp", label: tr("tw.tabMcp"), Icon: Radio },
    { key: "a2a", label: tr("tw.tabA2a"), Icon: Share2 },
    { key: "capability", label: tr("org.panel.capabilityReport"), Icon: ClipboardCheck },
    { key: "memory", label: tr("cmp.tab.memory"), Icon: Brain },
    { key: "backup", label: tr("cmp.tab.backup"), Icon: Archive },
  ];

  return (
    // 布局修复:外层不再整体滚动(那会把左侧 tab 导航一起卷走,内容长了还会撑出屏幕、右侧内容显示不全)。
    // 改成 h-full flex 列:顶部一段固定 spacer 给 OrgPage 悬浮的模式切换 pill 集群(company switcher 行 +
    // 日常/架构·可视化/表单 两行)让位,下面 flex-1 min-h-0 的行里 aside/内容各自 overflow-y-auto ——
    // aside 内容矮于可用高度时天然"貌似 sticky"(不随内容区滚动),内容区自己滚,两者互不影响。
    <div className="h-full flex flex-col p-5 pt-28">
      <div className="flex-1 min-h-0 flex gap-5 max-w-5xl mx-auto w-full">
        <aside className="w-48 shrink-0 h-full overflow-y-auto flex flex-col gap-1 rounded-xl border border-hairline bg-surface-1 p-2">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium cursor-pointer transition-colors shrink-0 ${
                tab === t.key ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink"
              }`}>
              <t.Icon size={14} />{t.label}
            </button>
          ))}
        </aside>
        <div className="flex-1 min-w-0 h-full overflow-y-auto rounded-xl border border-hairline bg-surface-1 p-5">
          {tab === "basic" && <BasicInfoTab company={company} onUpdated={onCompanyUpdated} />}
          {tab === "team" && <TeamTab company={company} agents={agents} onSwitchToVisual={onSwitchToVisual} />}
          {tab === "verify" && <VerifyTab company={company} cards={cards} onUpdated={onCompanyUpdated} />}
          {tab === "skills" && <SkillsTab company={company} agents={agents} />}
          {tab === "mcp" && <McpTab company={company} onUpdated={onCompanyUpdated} />}
          {tab === "a2a" && <A2ATab company={company} cards={cards} onUpdated={onCompanyUpdated} />}
          {tab === "capability" && <CapabilityTab companyId={company.id} />}
          {tab === "memory" && <MemoryTab companyId={company.id} />}
          {tab === "backup" && <BackupTab company={company} onDeleted={() => onCompanySwitch("default")} onRestored={onCompanySwitch} onUpdated={onCompanyUpdated} />}
        </div>
      </div>
    </div>
  );
}
