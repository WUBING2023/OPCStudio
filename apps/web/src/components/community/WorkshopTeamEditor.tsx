import { Plus, Trash2, Check } from "lucide-react";
import { PRESET_PROVIDERS } from "@opc/shared";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import { newCard, type WorkshopCard } from "./workshopTypes.js";
import { EXECUTION_TIER1, patchForTier1, CLI_MODEL_ALIASES, normalizeFramework, isSubscriptionFramework, type SubscriptionFramework } from "../../lib/framework.js";

const ROLE_SUGGESTIONS = ["ceo", "lead", "architect", "dev", "test", "security", "ops", "docs", "researcher"];

// 角色卡的框架/模型只是 AgentDetailsPanel 已有"两级化"选择器的一个简化版(同一份 EXECUTION_TIER1/
// CLI_MODEL_ALIASES/patchForTier1 数据源与换算规则,不再造一套不一致的选项列表)——角色卡场景不需要
// AgentDetailsPanel 那套账号探测/认证方式二级切换,只留三选一按钮 + CLI 订阅下的模型别名下拉。
function isCliFramework(fw: WorkshopCard["framework"]): fw is SubscriptionFramework {
  return isSubscriptionFramework(fw);
}

const SUBSCRIPTION_NAME: Record<SubscriptionFramework, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "kimi-cli": "Kimi Code",
  "grok-build": "Grok Build",
};

export default function WorkshopTeamEditor({
  cards, onChange, errors, showErrors,
}: {
  cards: WorkshopCard[];
  onChange: (cards: WorkshopCard[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const tr = useT();

  const update = (key: string, patch: Partial<WorkshopCard>) => {
    onChange(cards.map(c => (c.key === key ? { ...c, ...patch } : c)));
  };

  const remove = (key: string) => {
    // 删掉一张卡后,原本汇报给它的卡改回顶层,避免立刻产生"汇报对象不存在"的悬空引用。
    onChange(
      cards
        .filter(c => c.key !== key)
        .map(c => (c.reportsTo === key ? { ...c, reportsTo: "" } : c)),
    );
  };

  const add = () => onChange([...cards, newCard()]);

  return (
    <div className="flex flex-col gap-3">
      {errors["global:ceo"] && showErrors && (
        <div className="text-[12px] text-red bg-red/10 border border-red/20 rounded-lg px-3 py-2">{errors["global:ceo"]}</div>
      )}
      {cards.map((c, i) => {
        const err = (field: string) => showErrors ? errors[`card:${c.key}:${field}`] : undefined;
        return (
          <div key={c.key} className="border border-border rounded-xl p-3 bg-bg-hover">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-text-muted">{tr("tw.card")} #{i + 1}</span>
              <button onClick={() => remove(c.key)} title={tr("tw.removeCard")}
                className="border-none bg-transparent cursor-pointer text-text-muted hover:text-red transition-colors p-0.5">
                <Trash2 size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.role")}</label>
                <input value={c.role} onChange={e => update(c.key, { role: e.target.value })}
                  list="tw-role-suggestions" placeholder={tr("tw.rolePh")}
                  className={`w-full border rounded-md px-2 py-1.5 text-[13px] box-border outline-none bg-bg-card ${err("role") ? "border-red" : "border-border focus:border-accent"}`} />
                {err("role") && <div className="text-[11px] text-red mt-0.5">{err("role")}</div>}
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.name")}</label>
                <input value={c.name} onChange={e => update(c.key, { name: e.target.value })}
                  placeholder={tr("tw.namePh")}
                  className={`w-full border rounded-md px-2 py-1.5 text-[13px] box-border outline-none bg-bg-card ${err("name") ? "border-red" : "border-border focus:border-accent"}`} />
                {err("name") && <div className="text-[11px] text-red mt-0.5">{err("name")}</div>}
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.reportsTo")}</label>
                <select value={c.reportsTo} onChange={e => update(c.key, { reportsTo: e.target.value })}
                  className={`w-full border rounded-md px-2 py-1.5 text-[13px] outline-none bg-bg-card ${err("reportsTo") ? "border-red" : "border-border focus:border-accent"}`}>
                  <option value="">{tr("tw.reportsToRoot")}</option>
                  {cards.filter(x => x.key !== c.key).map(x => (
                    <option key={x.key} value={x.key}>{x.name || tr("tw.unnamed")}{x.role ? ` (${x.role})` : ""}</option>
                  ))}
                </select>
                {err("reportsTo") && <div className="text-[11px] text-red mt-0.5">{err("reportsTo")}</div>}
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-text-secondary block mb-1">执行方式</label>
                <div className="flex gap-1.5 flex-wrap">
                  {EXECUTION_TIER1.map(opt => {
                    const selected = normalizeFramework(c.framework) === opt.id;
                    return (
                      <button key={opt.id} type="button" title={tr(opt.blurbKey)}
                        onClick={() => {
                          if (selected) return;
                          update(c.key, patchForTier1(opt.id, { provider: c.provider, model: c.model }));
                        }}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] border transition-colors cursor-pointer ${
                          selected ? "border-accent bg-accent/10 text-accent" : "border-border bg-bg-card text-text-secondary hover:border-text-muted"
                        }`}>
                        <span>{opt.emoji}</span>
                        <span className="font-medium">{tr(opt.labelKey)}</span>
                        {selected && <Check size={12} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              {isCliFramework(c.framework) ? (
                <div className="col-span-2">
                  <label className="text-[11px] text-text-secondary flex items-center gap-1 mb-1">
                    模型(订阅 CLI 别名)
                    <HelpTip text={`订阅模式没有"供应商"概念——归属账号由执行方式决定，安装者用自己的 ${SUBSCRIPTION_NAME[c.framework]} 订阅登录即可运行。`} />
                  </label>
                  <select value={c.model} onChange={e => update(c.key, { model: e.target.value })}
                    className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] outline-none bg-bg-card focus:border-accent">
                    {CLI_MODEL_ALIASES[c.framework].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.provider")}</label>
                    <select value={c.provider} onChange={e => update(c.key, { provider: e.target.value })}
                      className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] outline-none bg-bg-card focus:border-accent">
                      <option value="">{tr("tw.providerBlank")}</option>
                      {PRESET_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[11px] text-text-secondary block mb-1">{tr("tw.model")}</label>
                    <input value={c.model} onChange={e => update(c.key, { model: e.target.value })}
                      list="tw-model-suggestions" placeholder={tr("tw.modelPh")}
                      className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] box-border outline-none bg-bg-card focus:border-accent" />
                  </div>
                </>
              )}
              <div className="col-span-2">
                <label className="text-[11px] text-text-secondary flex items-center gap-1 mb-1">
                  {tr("tw.systemPrompt")} <HelpTip text={tr("tw.systemPromptHint")} />
                </label>
                <textarea value={c.systemPrompt} onChange={e => update(c.key, { systemPrompt: e.target.value })}
                  rows={3} placeholder={tr("tw.systemPromptPh")}
                  className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] box-border resize-y outline-none bg-bg-card focus:border-accent" />
              </div>
            </div>
          </div>
        );
      })}
      <datalist id="tw-role-suggestions">
        {ROLE_SUGGESTIONS.map(r => <option key={r} value={r} />)}
      </datalist>
      <datalist id="tw-model-suggestions">
        <option value="deepseek-v4-pro" /><option value="deepseek-v4-flash" /><option value="MiniMax-M3" />
        <option value="doubao-seed-2-0-pro-260215" /><option value="gpt-5.1" /><option value="gpt-5-mini" />
        <option value="claude-sonnet-5" /><option value="claude-opus-4-8" /><option value="claude-haiku-4-5" />
      </datalist>
      <button onClick={add}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-border text-[13px] text-text-secondary bg-transparent cursor-pointer hover:border-accent hover:text-accent transition-colors">
        <Plus size={14} /> {tr("tw.addCard")}
      </button>
    </div>
  );
}
