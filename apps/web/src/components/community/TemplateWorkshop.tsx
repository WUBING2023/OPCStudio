import { useEffect, useMemo, useState } from "react";
import {
  X, FileText, Users, ShieldCheck, Eye, Building2, GitFork, Sparkles, ArrowLeft, Loader2,
  Wrench, Radio, CheckCircle2, Share2, LogIn, Wand2,
} from "lucide-react";
import type { Company, CompanyTemplate, CommunityIndexEntry, CompanyBundle } from "@opc/shared";
import { bundleToTemplateShape } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import WorkshopTeamEditor from "./WorkshopTeamEditor.js";
import WorkshopVerificationEditor from "./WorkshopVerificationEditor.js";
import WorkshopSkillsEditor from "./WorkshopSkillsEditor.js";
import WorkshopMcpEditor from "./WorkshopMcpEditor.js";
import WorkshopA2AEditor from "./WorkshopA2AEditor.js";
import WorkshopPreview from "./WorkshopPreview.js";
import AiEditPanel from "./AiEditPanel.js";
import { blankDraft, draftFromTemplate, validateDraft, buildPayload, type WorkshopDraft } from "./workshopTypes.js";

type Tab = "basic" | "team" | "verify" | "skills" | "mcp" | "a2a" | "preview";
type Stage = "start" | "pick-company" | "pick-fork" | "editor" | "saved";

/** start 首屏。busy=initialCompanyId 预选公司导出进行中(整屏 spinner);error=该导出失败的原因
 *  (没有它,失败时用户停在三选一首屏且零解释——错误此前只在 pick-company/pick-fork 分支渲染)。 */
export function WorkshopStartScreen({ busy, error, onBlank, onFromCompany, onFork }: {
  busy: boolean; error: string | null;
  onBlank: () => void; onFromCompany: () => void; onFork: () => void;
}) {
  const tr = useT();
  if (busy) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
      {error && <div className="text-[13px] text-red max-w-[520px] text-center">{error}</div>}
      <p className="text-[13px] text-text-secondary max-w-[520px] text-center mb-1">{tr("tw.startHint")}</p>
      <div className="grid grid-cols-3 gap-4 w-full max-w-[760px]">
        <button onClick={onBlank}
          className="flex flex-col items-center gap-2 p-5 rounded-xl border border-border bg-bg-card cursor-pointer hover:border-accent transition-colors text-center">
          <Sparkles size={22} className="text-accent" />
          <b className="text-[14px] text-text-primary">{tr("tw.startBlank")}</b>
          <span className="text-[12px] text-text-muted">{tr("tw.startBlankDesc")}</span>
        </button>
        <button onClick={onFromCompany}
          className="flex flex-col items-center gap-2 p-5 rounded-xl border border-border bg-bg-card cursor-pointer hover:border-accent transition-colors text-center">
          <Building2 size={22} className="text-accent" />
          <b className="text-[14px] text-text-primary">{tr("tw.startCompany")}</b>
          <span className="text-[12px] text-text-muted">{tr("tw.startCompanyDesc")}</span>
        </button>
        <button onClick={onFork}
          className="flex flex-col items-center gap-2 p-5 rounded-xl border border-border bg-bg-card cursor-pointer hover:border-accent transition-colors text-center">
          <GitFork size={22} className="text-accent" />
          <b className="text-[14px] text-text-primary">{tr("tw.startFork")}</b>
          <span className="text-[12px] text-text-muted">{tr("tw.startForkDesc")}</span>
        </button>
      </div>
    </div>
  );
}

export default function TemplateWorkshop({
  onClose, onSaved, initialCompanyId,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
  /** 从「公司架构」表单的「分享到社区」按钮跳过来时预选的公司——跳过 start/pick-company 这两步
   *  选择界面,挂载时直接把该公司的草稿拉进编辑器(复用既有的 pickCompany,不重新实现一套分享逻辑)。 */
  initialCompanyId?: string;
}) {
  const tr = useT();
  const [stage, setStage] = useState<Stage>("start");
  const [draft, setDraft] = useState<WorkshopDraft | null>(null);
  const [tab, setTab] = useState<Tab>("basic");
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showAiEdit, setShowAiEdit] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [templatesIdx, setTemplatesIdx] = useState<CommunityIndexEntry[]>([]);
  const [pickLoading, setPickLoading] = useState(false);
  // 带 initialCompanyId 挂载时首帧就置 busy——挂载 effect 里的 pickCompany 要下一拍才跑,否则先闪一下三选一首屏。
  const [pickBusyId, setPickBusyId] = useState<string | null>(initialCompanyId || null);
  const [pickError, setPickError] = useState<string | null>(null);

  // 保存成功后的分享一体化(入口去重:导出为模板 → 保存本地 → 这里直接分享,不再另开一条独立入口)。
  const [savedTemplate, setSavedTemplate] = useState<CompanyTemplate | null>(null);
  const [gh, setGh] = useState<{ connected: boolean; login?: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ prUrl?: string; needAuth?: boolean; authUrl?: string; error?: string } | null>(null);

  useEffect(() => {
    if (stage === "saved") api.get<{ connected: boolean; login?: string }>("/github/status").then(setGh).catch(() => setGh(null));
  }, [stage]);

  useEffect(() => {
    if (stage === "pick-company" && companies.length === 0) {
      setPickLoading(true);
      api.get<Company[]>("/companies").then(setCompanies).catch(() => setPickError(tr("tw.loadListFail"))).finally(() => setPickLoading(false));
    }
    if (stage === "pick-fork" && templatesIdx.length === 0) {
      setPickLoading(true);
      api.get<CommunityIndexEntry[]>("/community/templates").then(setTemplatesIdx).catch(() => setPickError(tr("tw.loadListFail"))).finally(() => setPickLoading(false));
    }
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const startBlank = () => { setDraft(blankDraft()); setTab("basic"); setAttemptedSave(false); setStage("editor"); };

  const pickCompany = async (id: string) => {
    setPickBusyId(id); setPickError(null);
    try {
      // P0-3:/companies/:id/export 现产出 canonical Company Bundle(带 schema_version)。工坊需要扁平
      // CompanyTemplate,带 schema_version 时用 bundleToTemplateShape 桥接回(结构字段已在 bundle 内保真)。
      const raw = await api.get<Record<string, unknown>>(`/companies/${id}/export`);
      const tpl = (raw && typeof raw.schema_version === "string"
        ? bundleToTemplateShape(raw as unknown as CompanyBundle)
        : raw) as unknown as CompanyTemplate;
      setDraft(draftFromTemplate(tpl, "company"));
      setTab("basic"); setAttemptedSave(false); setStage("editor");
    } catch (e) {
      setPickError((e as Error).message || tr("tw.loadListFail"));
    } finally { setPickBusyId(null); }
  };

  // 挂载时若带了 initialCompanyId,直接走 pickCompany(不需要用户在 start/pick-company 里再选一次)。
  // 只在挂载时触发一次(不把 initialCompanyId 放进 deps——它是外部一次性传入的,不该在其它 state 变化时重跑)。
  useEffect(() => {
    if (initialCompanyId) pickCompany(initialCompanyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFork = async (id: string) => {
    setPickBusyId(id); setPickError(null);
    try {
      const r = await api.post<{ ok: boolean; template: CompanyTemplate }>(`/community/templates/${id}/fork`, {});
      setDraft(draftFromTemplate(r.template, "fork"));
      setTab("basic"); setAttemptedSave(false); setStage("editor");
    } catch (e) {
      setPickError((e as Error).message || tr("tw.loadListFail"));
    } finally { setPickBusyId(null); }
  };

  const validation = useMemo(() => (draft ? validateDraft(draft) : { errors: {}, valid: false }), [draft]);
  const errorCount = Object.keys(validation.errors).length;

  const handleSave = async () => {
    if (!draft) return;
    setAttemptedSave(true);
    if (!validation.valid) {
      if (validation.errors["basic:title"]) setTab("basic");
      else if (validation.errors["global:ceo"] || Object.keys(validation.errors).some(k => k.startsWith("card:"))) setTab("team");
      else if (Object.keys(validation.errors).some(k => k.startsWith("edge:"))) setTab("verify");
      else if (Object.keys(validation.errors).some(k => k.startsWith("skill:"))) setTab("skills");
      else if (Object.keys(validation.errors).some(k => k.startsWith("mcp:"))) setTab("mcp");
      else if (Object.keys(validation.errors).some(k => k.startsWith("a2a:"))) setTab("a2a");
      return;
    }
    setSaving(true); setSaveError(null);
    try {
      const { template, personas } = buildPayload(draft);
      const r = await api.post<{ ok: boolean; id: string; author: string }>("/community/templates", { template, personas });
      // 保存成功不立即关闭:先落到"已保存"页,让创作者可以就地一键分享(入口去重的核心)。
      setSavedTemplate({ ...template, id: r.id, author: r.author });
      setShareResult(null);
      setStage("saved");
    } catch (e) {
      setSaveError((e as Error).message || tr("tw.saveFail"));
    } finally {
      setSaving(false);
    }
  };

  const handleShareToCommunity = async () => {
    if (!savedTemplate) return;
    setSharing(true); setShareResult(null);
    try {
      const author = gh?.login || savedTemplate.author;
      // 同 CommunityPage 既有分享流程的命名空间化:author-id,避免跨用户 id 撞车。
      const shareId = `${author}-${savedTemplate.id}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
      const data = { ...savedTemplate, author, id: shareId };
      const result = await api.post<{ prUrl?: string; needAuth?: boolean; authUrl?: string }>(
        "/community/share", { type: "template", data, author, message: `Share template: ${data.title}` },
      );
      setShareResult(result);
    } catch (e) {
      setShareResult({ error: (e as Error).message || tr("c.shareFail") });
    } finally {
      setSharing(false);
    }
  };

  const finishAndClose = () => { if (savedTemplate) onSaved(savedTemplate.id); };

  const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
    { key: "basic", label: tr("tw.tabBasic"), icon: FileText },
    { key: "team", label: tr("tw.tabTeam"), icon: Users },
    { key: "verify", label: tr("tw.tabVerify"), icon: ShieldCheck },
    { key: "skills", label: tr("tw.tabSkills"), icon: Wrench },
    { key: "mcp", label: tr("tw.tabMcp"), icon: Radio },
    { key: "a2a", label: tr("tw.tabA2a"), icon: Share2 },
    { key: "preview", label: tr("tw.tabPreview"), icon: Eye },
  ];

  const tabErrorCount = (t: Tab): number => {
    if (!draft) return 0;
    const keys = Object.keys(validation.errors);
    if (t === "basic") return keys.filter(k => k.startsWith("basic:")).length;
    if (t === "team") return keys.filter(k => k.startsWith("card:") || k === "global:ceo" || k === "global:cards").length;
    if (t === "verify") return keys.filter(k => k.startsWith("edge:")).length;
    if (t === "skills") return keys.filter(k => k.startsWith("skill:")).length;
    if (t === "mcp") return keys.filter(k => k.startsWith("mcp:")).length;
    if (t === "a2a") return keys.filter(k => k.startsWith("a2a:")).length;
    return 0;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1400]">
      <div className="bg-bg-primary rounded-2xl w-[94vw] h-[90vh] max-w-[1180px] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-bg-card shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={17} className="text-accent" />
            <b className="text-[15px] text-text-primary">{tr("tw.title")}</b>
            {stage === "editor" && draft?.title && <span className="text-[13px] text-text-muted">— {draft.title || tr("tw.untitled")}</span>}
          </div>
          <div className="flex items-center gap-2">
            {stage === "editor" && draft && (
              <button onClick={() => setShowAiEdit(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-bg-primary text-[13px] font-medium text-text-primary cursor-pointer hover:border-accent transition-colors">
                <Wand2 size={14} className="text-accent" /> {tr("cae.entry")}
              </button>
            )}
            <button onClick={onClose} className="border-none bg-transparent cursor-pointer text-text-muted hover:text-text-primary transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {stage === "start" && (
          <WorkshopStartScreen busy={pickBusyId !== null} error={pickError}
            onBlank={startBlank}
            onFromCompany={() => { setPickError(null); setStage("pick-company"); }}
            onFork={() => { setPickError(null); setStage("pick-fork"); }} />
        )}

        {(stage === "pick-company" || stage === "pick-fork") && (
          <div className="flex-1 flex flex-col p-6 overflow-auto">
            <button onClick={() => { setPickError(null); setStage("start"); }}
              className="self-start mb-3 inline-flex items-center gap-1 text-[13px] text-text-muted bg-transparent border-none cursor-pointer hover:text-accent">
              <ArrowLeft size={13} /> {tr("common.cancel")}
            </button>
            {pickLoading ? (
              <div className="text-[13px] text-text-muted">{tr("c.loading")}</div>
            ) : pickError ? (
              <div className="text-[13px] text-red">{pickError}</div>
            ) : stage === "pick-company" ? (
              companies.length === 0 ? (
                <div className="text-[13px] text-text-muted">{tr("tw.noCompanies")}</div>
              ) : (
                <div className="flex flex-col gap-2 max-w-[560px]">
                  {companies.map(c => (
                    <button key={c.id} onClick={() => pickCompany(c.id)} disabled={pickBusyId === c.id}
                      className="flex items-center justify-between text-left px-3.5 py-2.5 rounded-lg border border-border bg-bg-card cursor-pointer hover:border-accent transition-colors disabled:opacity-60">
                      <span>
                        <b className="text-[13px] text-text-primary block">{c.name}</b>
                        {c.description && <span className="text-[12px] text-text-muted">{c.description}</span>}
                      </span>
                      {pickBusyId === c.id && <Loader2 size={14} className="animate-spin text-accent" />}
                    </button>
                  ))}
                </div>
              )
            ) : templatesIdx.length === 0 ? (
              <div className="text-[13px] text-text-muted">{tr("tw.noTemplates")}</div>
            ) : (
              <div className="flex flex-col gap-2 max-w-[560px]">
                {templatesIdx.map(t => (
                  <button key={t.id} onClick={() => pickFork(t.id)} disabled={pickBusyId === t.id}
                    className="flex items-center justify-between text-left px-3.5 py-2.5 rounded-lg border border-border bg-bg-card cursor-pointer hover:border-accent transition-colors disabled:opacity-60">
                    <span>
                      <b className="text-[13px] text-text-primary block">{t.title}</b>
                      <span className="text-[12px] text-text-muted">@{t.author} · {tr("c.agents", { n: t.agentCount ?? 0 })}</span>
                    </span>
                    {pickBusyId === t.id && <Loader2 size={14} className="animate-spin text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {stage === "editor" && draft && (
          <div className="flex flex-1 min-h-0">
            <aside className="w-44 shrink-0 border-r border-border bg-bg-card p-2.5 flex flex-col gap-1">
              {TABS.map(t => {
                const n = tabErrorCount(t.key);
                return (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors relative ${
                      tab === t.key ? "bg-surface-2 text-ink rounded-[10px]" : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-lg"
                    }`}>
                    <t.icon size={14} /> {t.label}
                    {attemptedSave && n > 0 && (
                      <span className="ms-auto text-[10px] w-4 h-4 rounded-full bg-red text-white flex items-center justify-center">{n}</span>
                    )}
                  </button>
                );
              })}
            </aside>

            <div className="flex-1 overflow-auto p-5">
              {tab === "basic" && (
                <div className="flex flex-col gap-3 max-w-[640px]">
                  <div className="text-[11px] text-text-muted">{tr("tw.templateId")}: <code>{draft.id}</code></div>
                  <div>
                    <label className="text-[12px] text-text-secondary block mb-1">{tr("tw.fTitle")}</label>
                    <input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}
                      placeholder={tr("c.fTitlePh")}
                      className={`w-full border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none bg-bg-card ${attemptedSave && validation.errors["basic:title"] ? "border-red" : "border-border focus:border-accent"}`} />
                    {attemptedSave && validation.errors["basic:title"] && <div className="text-[11px] text-red mt-0.5">{validation.errors["basic:title"]}</div>}
                  </div>
                  <div>
                    <label className="text-[12px] text-text-secondary block mb-1">{tr("c.fDesc")}</label>
                    <textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}
                      rows={3} placeholder={tr("c.fDescPh")}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border resize-y outline-none bg-bg-card focus:border-accent" />
                  </div>
                  <div>
                    <label className="text-[12px] text-text-secondary block mb-1">{tr("c.fTags")}</label>
                    <input value={draft.tags} onChange={e => setDraft({ ...draft, tags: e.target.value })}
                      placeholder="web, research, coding"
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none bg-bg-card focus:border-accent" />
                  </div>
                  <div>
                    <label className="text-[12px] text-text-secondary block mb-1">{tr("tw.useCases")}</label>
                    <textarea value={draft.useCases} onChange={e => setDraft({ ...draft, useCases: e.target.value })}
                      rows={3} placeholder={tr("tw.useCasesPh")}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border resize-y outline-none bg-bg-card focus:border-accent" />
                  </div>
                  <div>
                    <label className="text-[12px] text-text-secondary block mb-1">{tr("tw.riskNotes")}</label>
                    <textarea value={draft.riskNotes} onChange={e => setDraft({ ...draft, riskNotes: e.target.value })}
                      rows={3} placeholder={tr("tw.riskNotesPh")}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border resize-y outline-none bg-bg-card focus:border-accent" />
                  </div>

                  {/* recommendedConfig:此前工坊完全没有编辑入口,fork/导出带这个字段的模板再保存会静默丢掉。 */}
                  <div className="border-t border-border pt-3 mt-1">
                    <label className="flex items-center gap-2 text-[13px] text-text-primary font-medium cursor-pointer mb-2">
                      <input type="checkbox" checked={draft.recommendedConfigEnabled}
                        onChange={e => setDraft({ ...draft, recommendedConfigEnabled: e.target.checked })} />
                      {tr("tw.recommendedConfig")}
                      <HelpTip text={tr("tw.recommendedConfigHint")} />
                    </label>
                    {draft.recommendedConfigEnabled && (
                      <div className="flex flex-col gap-2.5 pl-1">
                        <div>
                          <label className="text-[12px] text-text-secondary block mb-1">{tr("settings.defaultModel")}</label>
                          <input value={draft.recommendedDefaultModel}
                            onChange={e => setDraft({ ...draft, recommendedDefaultModel: e.target.value })}
                            placeholder={tr("tw.modelPh")}
                            className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none bg-bg-card focus:border-accent" />
                        </div>
                        <div>
                          <div>
                            <label className="text-[12px] text-text-secondary block mb-1">{tr("settings.budget.maxTokens")}</label>
                            <input type="number" min={0} step="1000" value={draft.recommendedMaxTokensPerTask}
                              onChange={e => setDraft({ ...draft, recommendedMaxTokensPerTask: e.target.value })}
                              className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none bg-bg-card focus:border-accent" />
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer">
                            <input type="checkbox" checked={draft.recommendedAllowShell}
                              onChange={e => setDraft({ ...draft, recommendedAllowShell: e.target.checked })} />
                            {tr("settings.perm.shell")}
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer">
                            <input type="checkbox" checked={draft.recommendedAllowFileWrite}
                              onChange={e => setDraft({ ...draft, recommendedAllowFileWrite: e.target.checked })} />
                            {tr("settings.perm.fileWrite")}
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer">
                            <input type="checkbox" checked={draft.recommendedAllowWebAccess}
                              onChange={e => setDraft({ ...draft, recommendedAllowWebAccess: e.target.checked })} />
                            {tr("settings.perm.webAccess")}
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === "team" && (
                <WorkshopTeamEditor cards={draft.cards} onChange={cards => setDraft({ ...draft, cards })}
                  errors={validation.errors} showErrors={attemptedSave} />
              )}

              {tab === "verify" && (
                <WorkshopVerificationEditor edges={draft.edges} cards={draft.cards}
                  onChange={edges => setDraft({ ...draft, edges })}
                  errors={validation.errors} showErrors={attemptedSave} />
              )}

              {tab === "skills" && (
                <WorkshopSkillsEditor skills={draft.bundledSkills} cards={draft.cards}
                  onChange={bundledSkills => setDraft({ ...draft, bundledSkills })}
                  errors={validation.errors} showErrors={attemptedSave} />
              )}

              {tab === "mcp" && (
                <WorkshopMcpEditor requirements={draft.mcpRequirements}
                  onChange={mcpRequirements => setDraft({ ...draft, mcpRequirements })}
                  errors={validation.errors} showErrors={attemptedSave} />
              )}

              {tab === "a2a" && (
                <WorkshopA2AEditor channels={draft.a2aChannels} cards={draft.cards}
                  onChange={a2aChannels => setDraft({ ...draft, a2aChannels })}
                  errors={validation.errors} showErrors={attemptedSave} />
              )}

              {tab === "preview" && <WorkshopPreview draft={draft} />}
            </div>
          </div>
        )}

        {/* 保存成功页:导出为模板 → 保存本地 → 就地分享,一条流水线走完(入口去重)。 */}
        {stage === "saved" && savedTemplate && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
            <CheckCircle2 size={40} className="text-green" />
            <div className="text-center">
              <b className="text-[15px] text-text-primary block mb-1">{tr("tw.savedTitle")}</b>
              <span className="text-[13px] text-text-muted">{tr("tw.savedNotice", { id: savedTemplate.id })}</span>
            </div>

            <div className="w-full max-w-[420px] border border-border rounded-xl p-4 bg-bg-card">
              {shareResult ? (
                shareResult.needAuth ? (
                  <div className="text-center">
                    <p className="text-[13px] text-amber m-0 mb-2">{tr("c.needAuth")}</p>
                    {shareResult.authUrl ? (
                      <a href={shareResult.authUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-accent text-[13px] font-medium">
                        <LogIn size={13} /> {tr("c.goAuth")}
                      </a>
                    ) : <p className="text-[12px] text-text-muted m-0">{tr("c.configOAuth")}</p>}
                  </div>
                ) : shareResult.prUrl ? (
                  <div className="text-center">
                    <p className="text-[13px] text-green m-0 mb-2">{tr("c.prCreated")}</p>
                    <a href={shareResult.prUrl} target="_blank" rel="noopener noreferrer"
                      className="text-accent text-[13px] font-medium break-all">{shareResult.prUrl}</a>
                  </div>
                ) : (
                  <p className="text-[13px] text-red text-center m-0">{shareResult.error || tr("c.shareFail")}</p>
                )
              ) : (
                <div className="flex flex-col items-center gap-2.5">
                  <button onClick={handleShareToCommunity} disabled={sharing}
                    className={`inline-flex items-center gap-1.5 px-4 py-1.5 border-none rounded-full text-white text-[13px] font-medium ${sharing ? "bg-border-light cursor-not-allowed" : "bg-green cursor-pointer hover:opacity-90"}`}>
                    <Share2 size={14} /> {sharing ? tr("c.sharing") : tr("tw.shareToCommunity")}
                  </button>
                </div>
              )}
            </div>

            <button onClick={finishAndClose} className="btn-secondary mt-1">{tr("tw.finish")}</button>
          </div>
        )}

        {/* Footer */}
        {stage === "editor" && (
          <div className="flex items-center gap-3 justify-end px-5 py-3.5 border-t border-border bg-bg-card shrink-0">
            {saveError && <span className="text-[13px] text-red me-auto">{saveError}</span>}
            {attemptedSave && errorCount > 0 && !saveError && (
              <span className="text-[13px] text-red me-auto">{tr("tw.fixErrors", { n: errorCount })}</span>
            )}
            <button onClick={onClose} className="btn-secondary">{tr("common.cancel")}</button>
            <button onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? tr("tw.saving") : tr("tw.save")}
            </button>
          </div>
        )}
      </div>

      {showAiEdit && draft && (
        <AiEditPanel
          draft={draft}
          onClose={() => setShowAiEdit(false)}
          onApply={(next) => { setDraft(next); setShowAiEdit(false); }}
        />
      )}
    </div>
  );
}
