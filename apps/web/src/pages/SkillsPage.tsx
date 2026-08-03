import { useState, useEffect } from "react";
import { useSkillStore } from "../store/useSkillStore.js";
import * as api from "../api/client.js";
import type { Company, SkillMeta } from "@opc/shared";
import { SKILL_PRESETS, type SkillPreset } from "../data/skillPresets.js";
import { useT } from "../i18n.js";
import { pushToast } from "../components/common/Toast.js";
import { Download, Eye, FlaskConical, FolderSearch, RefreshCw } from "lucide-react";
import IncubatorModal from "../components/skills/IncubatorModal.js";

interface LocalSkillCandidate {
  id: string;
  name: string;
  description?: string;
  role: string;
  source: "codex" | "claude-code" | "agent";
  scope: "user" | "project";
  relativePath: string;
  modifiedAt: string;
  installed: boolean;
}

const roleKeys: Record<string, string> = {
  ceo: "skills.role.ceo",
  lead: "skills.role.lead",
  architect: "skills.role.architect",
  dev: "skills.role.dev",
  test: "skills.role.test",
  ops: "skills.role.ops",
  security: "skills.role.security",
};

const roleColors: Record<string, string> = {
  ceo: "#2563eb",
  lead: "#7c3aed",
  architect: "#0d9488",
  dev: "#3fae67",
  test: "#c99a52",
  ops: "#ca8a04",
  security: "#c9615c",
};

export default function SkillsPage() {
  const t = useT();
  const store = useSkillStore();
  // 技能内容不应被随意改写(用户原话)——只保留只读查看,不再有可编辑的 textarea/保存。
  const [viewId, setViewId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importSource, setImportSource] = useState("");
  const [importPreview, setImportPreview] = useState<string | null>(null);
  const [importPreviewLoading, setImportPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [incubateSkill, setIncubateSkill] = useState<SkillMeta | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<LocalSkillCandidate[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localImporting, setLocalImporting] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);

  const importedTitles = new Set(store.skills.map(s => s.title));
  const handleImportPreset = async (preset: SkillPreset) => {
    try {
      await api.post("/skills", { title: preset.title, role: preset.role, content: preset.content, enabled: true });
      await store.load();
      setNotice(t('skills.presetImported', { title: preset.title, source: preset.sourceLabel }));
      setTimeout(() => setNotice(null), 4000);
    } catch {
      setNotice(t('skills.importFailed'));
      setTimeout(() => setNotice(null), 4000);
    }
  };

  useEffect(() => {
    store.load();
    loadPath();
    loadLocalSkills();
    api.get<Company[]>("/companies").then(setCompanies).catch(() => setCompanies([]));
  }, []);

  const loadPath = async () => {
    try {
      const data = await api.get<{ path: string }>("/skills/path");
      setStoragePath(data.path);
    } catch { /* ignore */ }
  };

  const loadLocalSkills = async () => {
    setLocalLoading(true);
    try {
      setLocalSkills(await api.get<LocalSkillCandidate[]>("/skills/local"));
    } catch {
      setLocalSkills([]);
    } finally {
      setLocalLoading(false);
    }
  };

  const handleImportLocal = async (candidate: LocalSkillCandidate) => {
    setLocalImporting(candidate.id);
    try {
      await api.post(`/skills/local/${candidate.id}/import`, {});
      await Promise.all([store.load(), loadLocalSkills()]);
      setNotice(t("skills.localImported", { name: candidate.name }));
      setTimeout(() => setNotice(null), 4000);
    } catch (e: any) {
      pushToast("error", t("skills.importFailedPrefix") + (e.message || t("skills.unknownError")));
    } finally {
      setLocalImporting(null);
    }
  };
  const handleView = async (id: string) => {
    await store.loadOne(id);
    setViewId(id);
  };

  const handleDelete = async (id: string) => {
    await store.remove(id);
    setDeleteConfirm(null);
  };

  const handlePreview = async () => {
    if (!importSource.trim()) return;
    setImportPreviewLoading(true);
    setImportPreview(null);
    try {
      // 令五.6:经 api.post 走 client.ts 统一注入 X-OPC-Session-Token(变更型请求服务端强校验)。
      const data = await api.post<{ preview?: string; content?: string }>("/skills/preview", { source: importSource.trim() });
      setImportPreview(data.preview || data.content || "(no content)");
    } catch (e: any) {
      setImportPreview(`Preview failed: ${e.message}`);
    } finally {
      setImportPreviewLoading(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      await api.post("/skills/import", { source: importSource.trim() });
      setShowImport(false);
      setImportSource("");
      setImportPreview(null);
      await store.load();
    } catch (e: any) {
      pushToast("error", t('skills.importFailedPrefix') + (e.message || t('skills.unknownError')));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="px-6 py-4 bg-bg-card border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="m-0 text-lg font-semibold tracking-tight text-text-primary">{t('skills.title')}</h2>
          <div className="flex gap-2">
            <button onClick={() => { setShowImport(true); setImportSource(""); setImportPreview(null); }}
              className="btn-primary text-[13px]">
              {t('skills.importSkill')}
            </button>
          </div>
        </div>
        <div className="flex items-center">
          {storagePath && (
            <div className="text-[11px] text-text-muted font-mono">
              {t('skills.storagePath')}: {storagePath}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {/* Import Modal */}
        {showImport && (
          <div className="modal-overlay z-[100]">
            <div className="bg-bg-card rounded-2xl p-6 min-w-[420px] max-w-[520px] shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
              <h3 className="m-0 mb-4 text-base font-semibold tracking-tight">{t('skills.importSkill')}</h3>

              <input
                placeholder={t('skills.importPlaceholder')}
                value={importSource}
                onChange={e => setImportSource(e.target.value)}
                className="w-full border-0 border-b-2 border-border bg-transparent text-[13px] py-2.5 outline-none focus:border-accent transition-colors mb-4"
              />

              {/* Preview */}
              <div className="mb-4">
                <button
                  onClick={handlePreview}
                  disabled={!importSource.trim() || importPreviewLoading}
                  className="text-[12px] text-text-secondary border border-border rounded-full px-3 py-1.5 bg-bg-card cursor-pointer hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default transition-colors">
                  {importPreviewLoading ? t('skills.loadingPreview') : t('skills.previewContent')}
                </button>
                {importPreview && (
                  <div className="mt-2 max-h-[200px] overflow-auto rounded-lg border border-border bg-bg-hover p-3">
                    <pre className="m-0 text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                      {importPreview}
                    </pre>
                  </div>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowImport(false); setImportPreview(null); }} className="btn-secondary">{t('common.cancel')}</button>
                <button onClick={handleImport} disabled={importing || !importSource.trim()}
                  className="btn-primary disabled:opacity-60">
                  {importing ? t('skills.importing') : t('common.import')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Recommended skill presets (one-click import, source-attributed) */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-text-primary m-0 mb-2.5">{t('skills.recommendedSkills')}</h3>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {SKILL_PRESETS.map(preset => {
              const done = importedTitles.has(preset.title);
              return (
                <div key={preset.id} className="bg-bg-card rounded-xl border border-border p-3.5 shadow-sm flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[13px] text-text-primary">{preset.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (roleColors[preset.role] || "#6b7280") + "18", color: roleColors[preset.role] || "#6b7280" }}>
                      {roleKeys[preset.role] ? t(roleKeys[preset.role]) : preset.role}
                    </span>
                  </div>
                  <div className="text-[11px] text-text-secondary leading-snug min-h-[30px]">{preset.description}</div>
                  <div className="flex items-center justify-between mt-1">
                    <a href={preset.source} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-accent hover:underline truncate max-w-[140px]" title={preset.source}>
                      {t('skills.sourceLabel')}{preset.sourceLabel}
                    </a>
                    <button onClick={() => handleImportPreset(preset)} disabled={done}
                      className={`px-2.5 py-0.5 rounded-full text-[11px] border transition-colors ${
                        done ? "border-border text-text-muted cursor-default" : "border-accent/40 bg-accent/10 text-accent cursor-pointer hover:bg-accent/20"
                      }`}>
                      {done ? t('skills.imported') : t('common.import')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Card Grid */}
        {store.skills.length > 0 && <h3 className="text-sm font-semibold text-text-primary m-0 mb-2.5 mt-2">{t('skills.installed')}</h3>}
        {store.skills.length === 0 ? (
          <div className="text-center py-10 text-text-muted">
            {t('skills.emptyOwn')}
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {store.skills.map(skill => (
              <div key={skill.id}
                className="bg-bg-card rounded-2xl border-0 p-4 relative cursor-default
                           shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)]
                           hover:-translate-y-0.5 transition-all duration-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium tracking-wide"
                    style={{
                      backgroundColor: (roleColors[skill.role] || "#6b7280") + "18",
                      color: roleColors[skill.role] || "#6b7280",
                    }}>
                    {roleKeys[skill.role] ? t(roleKeys[skill.role]) : t('skills.role.other')}
                  </span>
                  <div className="flex items-center gap-1">
                    {(skill.origin ?? "user") !== "user" && (
                      <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted">
                        {t(`skills.origin.${skill.origin ?? "user"}`)}
                      </span>
                    )}
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${
                      skill.enabled ? "bg-green/10 text-green" : "bg-red/10 text-red"
                    }`}>
                      {skill.enabled ? t('skills.statusEnabled') : t('skills.statusDisabled')}
                    </span>
                  </div>
                </div>
                <h4 className="m-0 mb-1.5 text-[15px] font-semibold tracking-tight text-text-primary">{skill.title}</h4>
                <div className="text-[11px] text-text-muted mb-3">
                  {t('skills.lastModified')}: {new Date(skill.lastModified).toLocaleDateString("zh-CN")}
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => store.toggle(skill.id)}
                    className="px-2.5 py-0.5 border border-border rounded-full bg-bg-card cursor-pointer text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
                    {skill.enabled ? t('skills.disable') : t('skills.enable')}
                  </button>
                  <button onClick={() => handleView(skill.id)}
                    className="px-2.5 py-0.5 border border-border rounded-full bg-bg-card cursor-pointer text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors inline-flex items-center gap-1">
                    <Eye size={11} />{t('skills.view')}
                  </button>
                  <button onClick={() => setIncubateSkill(skill)}
                    title={t('skills.inc.buttonTip')}
                    className="px-2.5 py-0.5 border border-accent/40 rounded-full bg-accent/10 cursor-pointer text-[11px] text-accent hover:bg-accent/20 transition-colors inline-flex items-center gap-1">
                    <FlaskConical size={11} />{t('skills.inc.button')}
                  </button>
                  <button onClick={() => setDeleteConfirm(skill.id)}
                    className="ml-auto px-2.5 py-0.5 border border-red/20 rounded-full bg-bg-card cursor-pointer text-[11px] text-red hover:bg-red/10 hover:text-red transition-colors">
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Skills discovered from supported local agent installations. Import is server-resolved by discovery id. */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2.5">
            <h3 className="text-sm font-semibold text-text-primary m-0 inline-flex items-center gap-1.5">
              <FolderSearch size={15} />{t("skills.localTitle")}
            </h3>
            <button onClick={loadLocalSkills} disabled={localLoading}
              title={t("skills.localRefresh")}
              className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-border bg-bg-card text-text-secondary hover:bg-bg-hover disabled:opacity-50">
              <RefreshCw size={14} className={localLoading ? "animate-spin" : ""} />
            </button>
          </div>
          {localLoading ? (
            <div className="text-[12px] text-text-muted py-4">{t("common.loading")}</div>
          ) : localSkills.length === 0 ? (
            <div className="border border-dashed border-border rounded-lg px-4 py-5 text-[12px] text-text-muted">
              {t("skills.localEmpty")}
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
              {localSkills.map(candidate => (
                <div key={candidate.id} className="bg-bg-card rounded-lg border border-border p-3.5 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[13px] text-text-primary truncate" title={candidate.name}>{candidate.name}</div>
                      <div className="text-[10px] text-text-muted mt-0.5">
                        {t(`skills.localSource.${candidate.source}`)} · {t(`skills.localScope.${candidate.scope}`)}
                      </div>
                    </div>
                    <button onClick={() => handleImportLocal(candidate)}
                      disabled={candidate.installed || localImporting === candidate.id}
                      title={candidate.installed ? t("skills.imported") : t("common.import")}
                      className="shrink-0 h-7 px-2 inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 text-[11px] text-accent hover:bg-accent/20 disabled:border-border disabled:bg-transparent disabled:text-text-muted">
                      <Download size={12} />
                      {candidate.installed ? t("skills.imported") : localImporting === candidate.id ? t("skills.importing") : t("common.import")}
                    </button>
                  </div>
                  {candidate.description && <div className="text-[11px] text-text-secondary leading-snug mt-2 line-clamp-2">{candidate.description}</div>}
                  <div className="text-[10px] font-mono text-text-muted truncate mt-2" title={candidate.relativePath}>{candidate.relativePath}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* View Panel(只读:技能内容不应被随意改写,只看不改)——bug 修复:原来是 mt-4 追加渲染在整个
            卡片网格最后面,技能数量一多(实测45个)面板会开在远超当前滚动位置的页面底部,用户点"查看"
            观感上"毫无反应"。改成 modal-overlay 弹窗(和本文件里 Import/孵化器等弹窗同一套既有模式),
            不管点哪张卡片,查看内容都在当前视口正中弹出。 */}
        {viewId && store.current?.id === viewId && (
          <div className="modal-overlay z-[100]" onClick={() => { setViewId(null); store.clearCurrent(); }}>
            <div className="bg-bg-card rounded-2xl p-4 min-w-[420px] max-w-[640px] w-full shadow-[0_8px_30px_rgba(0,0,0,0.12)]" onClick={e => e.stopPropagation()}>
              <div className="flex gap-3 mb-2 items-center">
                <h4 className="m-0 text-[14px] font-semibold text-text-primary">{store.current.title}</h4>
                <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ backgroundColor: (roleColors[store.current.role] || "#6b7280") + "18", color: roleColors[store.current.role] || "#6b7280" }}>
                  {roleKeys[store.current.role] ? t(roleKeys[store.current.role]) : t('skills.role.other')}
                </span>
              </div>
              <div className="max-h-[400px] overflow-auto rounded-lg border border-border bg-bg-hover p-3">
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[13px] text-text-secondary">{store.current.content}</pre>
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => { setViewId(null); store.clearCurrent(); }} className="btn-secondary">{t('common.close')}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Skill 孵化器:技能 → 员工/专家小组/团队(消耗用户 tokens 由 LLM 设计,全流程向导) */}
      {incubateSkill && <IncubatorModal skill={incubateSkill} onClose={() => setIncubateSkill(null)} />}

      {notice && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] px-4 py-2.5 rounded-xl bg-bg-card border border-border shadow-lg text-[13px] text-text-primary">
          {notice}
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="modal-overlay z-[100]">
          <div className="bg-bg-card rounded-2xl p-6 min-w-[320px] text-center shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
            <p className="m-0 mb-4 text-sm text-text-primary">{t('skills.deleteConfirm')}</p>
            <div className="flex gap-2 justify-center">
              <button onClick={() => handleDelete(deleteConfirm)} className="btn-danger">{t('skills.confirmDelete')}</button>
              <button onClick={() => setDeleteConfirm(null)} className="btn-secondary">{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
