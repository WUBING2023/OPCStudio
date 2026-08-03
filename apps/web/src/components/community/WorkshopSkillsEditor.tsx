import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import type { SkillMeta, Skill } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import { genKey, type WorkshopCard, type WorkshopSkillRef } from "./workshopTypes.js";

// 技能打包区:从本地 skill store 勾选要随模板打包的 skill(内容内联自包含),
// 每条可选择绑定到哪些角色(缺省 = install 时绑定本模板出现过的全部角色,不是全局 "*",防串染)。
export default function WorkshopSkillsEditor({
  skills, cards, onChange, errors, showErrors,
}: {
  skills: WorkshopSkillRef[];
  cards: WorkshopCard[];
  onChange: (skills: WorkshopSkillRef[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const tr = useT();
  const [localSkills, setLocalSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    // origin=user:只列用户自己的真实技能资产——不传的话 listSkills 缺省返回全量,会把 persona/memory/
    // bundled 这些系统内部产物也混进"打包进模板"的候选列表(今晚技能分层做完 origin 字段后遗留的
    // 调用点缺口,这里一并补上,与 SkillsPage.tsx 的默认视图口径保持一致)。
    api.get<SkillMeta[]>("/skills?origin=user").then(setLocalSkills).catch(() => setLocalSkills([])).finally(() => setLoading(false));
  }, []);

  const roleOptions = [...new Set(cards.map(c => c.role.trim()).filter(Boolean))];
  const bundledSourceIds = new Set(skills.map(s => s.skillId).filter(Boolean));

  const addFromLocal = async (meta: SkillMeta) => {
    setAddingId(meta.id);
    try {
      const full = await api.get<Skill>(`/skills/${meta.id}`);
      onChange([...skills, {
        key: genKey(), skillId: meta.id, name: full.title, description: full.description || "", content: full.content, roles: [],
      }]);
    } catch { /* 拉取失败就不加,静默 */ }
    finally { setAddingId(null); }
  };

  const update = (key: string, patch: Partial<WorkshopSkillRef>) =>
    onChange(skills.map(s => (s.key === key ? { ...s, ...patch } : s)));
  const remove = (key: string) => onChange(skills.filter(s => s.key !== key));
  const toggleRole = (key: string, role: string) => {
    const s = skills.find(x => x.key === key);
    if (!s) return;
    const has = s.roles.includes(role);
    update(key, { roles: has ? s.roles.filter(r => r !== role) : [...s.roles, role] });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 className="m-0 mb-2 text-[13px] font-semibold text-text-primary flex items-center gap-1">
          {tr("tw.skillsLocalTitle")} <HelpTip text={tr("tw.skillsHint")} />
        </h4>
        {loading ? (
          <div className="text-[13px] text-text-muted">{tr("c.loading")}</div>
        ) : localSkills.length === 0 ? (
          <div className="text-[13px] text-text-muted">{tr("tw.skillsNoneLocal")}</div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[180px] overflow-auto border border-border rounded-lg p-2 bg-bg-hover">
            {localSkills.map(m => {
              const already = bundledSourceIds.has(m.id);
              return (
                <div key={m.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-bg-card border border-border">
                  <span className="min-w-0">
                    <b className="text-[13px] text-text-primary block truncate">{m.title}</b>
                    <span className="text-[11px] text-text-muted">{m.role}</span>
                  </span>
                  <button onClick={() => addFromLocal(m)} disabled={already || addingId === m.id}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium btn-primary">
                    {addingId === m.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    {already ? tr("tw.skillsAdded") : tr("tw.skillsAdd")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h4 className="m-0 mb-2 text-[13px] font-semibold text-text-primary">{tr("tw.skillsBundledTitle")} ({skills.length})</h4>
        {skills.length === 0 ? (
          <div className="text-[13px] text-text-muted">{tr("tw.skillsBundledEmpty")}</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {skills.map(s => {
              const err = (field: string) => showErrors ? errors[`skill:${s.key}:${field}`] : undefined;
              return (
                <div key={s.key} className="border border-border rounded-xl p-3 bg-bg-hover">
                  <div className="flex items-center justify-between mb-2">
                    <input value={s.name} onChange={e => update(s.key, { name: e.target.value })}
                      placeholder={tr("tw.skillsNamePh")}
                      className={`flex-1 border rounded-md px-2 py-1 text-[13px] box-border outline-none bg-bg-card me-2 ${err("name") ? "border-red" : "border-border focus:border-accent"}`} />
                    <button onClick={() => remove(s.key)} title={tr("tw.removeCard")}
                      className="border-none bg-transparent cursor-pointer text-text-muted hover:text-red transition-colors p-0.5 shrink-0">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {err("name") && <div className="text-[11px] text-red mb-1">{err("name")}</div>}
                  <textarea value={s.description} onChange={e => update(s.key, { description: e.target.value })}
                    rows={1} placeholder={tr("tw.skillsDescPh")}
                    className="w-full border border-border rounded-md px-2 py-1 text-[12px] box-border resize-y outline-none bg-bg-card focus:border-accent mb-2" />
                  <details className="mb-2">
                    <summary className="text-[11px] text-text-muted cursor-pointer select-none">{tr("tw.skillsPreview")}</summary>
                    <pre className="mt-1.5 text-[11px] text-text-secondary whitespace-pre-wrap max-h-[140px] overflow-auto border border-border rounded-md p-2 bg-bg-card">{s.content.slice(0, 2000)}</pre>
                  </details>
                  {err("content") && <div className="text-[11px] text-red mb-1">{err("content")}</div>}
                  <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.skillsRoles")}</label>
                  {roleOptions.length === 0 ? (
                    <span className="text-[11px] text-text-muted">{tr("tw.skillsNoRoles")}</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {roleOptions.map(r => {
                        const on = s.roles.includes(r);
                        return (
                          <button key={r} type="button" onClick={() => toggleRole(s.key, r)}
                            className={`px-2 py-0.5 rounded-full text-[11px] border cursor-pointer transition-colors ${
                              on ? "bg-accent/10 text-accent border-accent" : "bg-bg-card text-text-secondary border-border hover:border-accent"
                            }`}>
                            {r}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="text-[11px] text-text-muted mt-1">{s.roles.length ? "" : tr("tw.skillsRolesDefault")}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
