import { ArrowLeft, Download, Users } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { AgentNodeConfig, AgentCard, CompanyTemplate, AgentFramework } from "@opc/shared";
import { EXECUTION_TIER1, CLI_MODEL_ALIASES, patchForTier1, PROVIDER_DEFAULT_MODEL, SUBSCRIPTION_BRAND, isSubscriptionFramework } from "../../lib/framework.js";
import { ROLE_COLORS, ROLE_LABELS } from "../../lib/agentMeta.js";
import { useT } from "../../i18n.js";

const PROVIDER_LIST = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "minimax", name: "MiniMax" },
  { id: "doubao", name: "豆包" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "ollama", name: "Ollama" },
];

// 第一级"执行方式"每个选项对应的 i18n key。EXECUTION_TIER1 自身已是 labelKey/blurbKey(E2 去硬编码),
// 但这张表覆盖全部 AgentFramework(含已下线的 9 个第三方 CLI)——社区卡片可能带任意存量 framework。
// 12+1 框架扩展(2026-07):Record<AgentFramework,...> 是穷举类型——新增框架不在这里补一条会直接编译
// 失败,这是刻意的(逼着每次扩展 AgentFramework 都要同步这张表,不会漏掉)。
// E2 键名去品牌:org.executionModeHermes* → org.executionModeApi*("hermes" 条目为读侧存量兼容)。
const TIER1_I18N: Record<AgentFramework, { labelKey: string; blurbKey: string }> = {
  "api": { labelKey: "org.executionModeApiLabel", blurbKey: "org.executionModeApiBlurb" },
  "hermes": { labelKey: "org.executionModeApiLabel", blurbKey: "org.executionModeApiBlurb" },
  "claude-code": { labelKey: "org.executionModeClaudeCodeLabel", blurbKey: "org.executionModeClaudeCodeBlurb" },
  "codex": { labelKey: "org.executionModeCodexLabel", blurbKey: "org.executionModeCodexBlurb" },
  "gemini-cli": { labelKey: "org.executionModeGeminiCliLabel", blurbKey: "org.executionModeGeminiCliBlurb" },
  "kimi-cli": { labelKey: "org.executionModeKimiCliLabel", blurbKey: "org.executionModeKimiCliBlurb" },
  "grok-build": { labelKey: "org.executionModeGrokBuildLabel", blurbKey: "org.executionModeGrokBuildBlurb" },
  "qwen-code": { labelKey: "org.executionModeQwenCodeLabel", blurbKey: "org.executionModeQwenCodeBlurb" },
  "opencode": { labelKey: "org.executionModeOpencodeLabel", blurbKey: "org.executionModeOpencodeBlurb" },
  "aider": { labelKey: "org.executionModeAiderLabel", blurbKey: "org.executionModeAiderBlurb" },
  "goose": { labelKey: "org.executionModeGooseLabel", blurbKey: "org.executionModeGooseBlurb" },
  "openhands": { labelKey: "org.executionModeOpenhandsLabel", blurbKey: "org.executionModeOpenhandsBlurb" },
  "amp": { labelKey: "org.executionModeAmpLabel", blurbKey: "org.executionModeAmpBlurb" },
  "plandex": { labelKey: "org.executionModePlandexLabel", blurbKey: "org.executionModePlandexBlurb" },
  "open-interpreter": { labelKey: "org.executionModeOpenInterpreterLabel", blurbKey: "org.executionModeOpenInterpreterBlurb" },
  "generic-cli": { labelKey: "org.executionModeGenericCliLabel", blurbKey: "org.executionModeGenericCliBlurb" },
};

export type AddAgentTab = "manual" | "community";

// Add-Agent modal (manual create / import from community / import a whole team template).
// Extracted out of OrgPage.tsx — all state stays owned by OrgPage, this is presentation + callbacks.
export default function AddAgentModal({
  open,
  onCancel,
  addTab, setAddTab,
  addName, setAddName,
  addRole, setAddRole,
  addParentId, setAddParentId,
  addProvider, setAddProvider,
  addModel, setAddModel,
  addFramework, setAddFramework,
  agents,
  onSubmit,
  showTemplatePicker, setShowTemplatePicker,
  communityLoading,
  communityTemplates,
  communityAgents,
  importingTemplateId,
  importTemplate,
  fillFromAgentCard,
}: {
  open: boolean;
  onCancel: () => void;
  addTab: AddAgentTab; setAddTab: (v: AddAgentTab) => void;
  addName: string; setAddName: (v: string) => void;
  addRole: string; setAddRole: (v: string) => void;
  addParentId: string; setAddParentId: (v: string) => void;
  addProvider: string; setAddProvider: (v: string) => void;
  addModel: string; setAddModel: (v: string) => void;
  addFramework: AgentFramework; setAddFramework: (v: AgentFramework) => void;
  agents: AgentNodeConfig[];
  onSubmit: () => void;
  showTemplatePicker: boolean; setShowTemplatePicker: (v: boolean) => void;
  communityLoading: boolean;
  communityTemplates: CompanyTemplate[];
  communityAgents: AgentCard[];
  importingTemplateId: string | null;
  importTemplate: (t: CompanyTemplate) => void;
  fillFromAgentCard: (card: AgentCard) => void;
}) {
  const tr = useT();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="modal-overlay"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2 }}
            className="p-6 min-w-[400px]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-hairline)",
              borderRadius: 12,
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 className="m-0 mb-4 text-base font-semibold tracking-tight text-ink">{tr('org.addAgent')}</h3>

            {/* Tabs */}
            <div className="flex gap-0 mb-4 border-b border-hairline">
              <button
                onClick={() => setAddTab("manual")}
                className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                  addTab === "manual"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {tr('org.tabManual')}
              </button>
              <button
                onClick={() => setAddTab("community")}
                className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                  addTab === "community"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {tr('org.tabCommunity')}
              </button>
            </div>

            {addTab === "manual" ? (
              <>
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldName')}</label>
                    <input value={addName} onChange={e => setAddName(e.target.value)}
                      placeholder={tr('org.fieldNamePlaceholder')}
                      className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-0 text-ink"
                      autoFocus />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldRole')}</label>
                    <select value={addRole} onChange={e => setAddRole(e.target.value)}
                      className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-1 text-ink">
                      {Object.entries(ROLE_LABELS).filter(([k]) => k !== "ceo").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldManager')}</label>
                    <select value={addParentId} onChange={e => setAddParentId(e.target.value)}
                      className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-1 text-ink">
                      <option value="">{tr('org.fieldManagerNone')}</option>
                      {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({ROLE_LABELS[a.role] || a.role})</option>)}
                    </select>
                  </div>
                  {/* 第一级：执行方式(API / Claude Code 订阅 / Codex 订阅)。切换时把 framework/provider/model
                      三个字段一次性算成自洽组合(patchForTier1),不会出现 framework:claude-code 却 provider:deepseek 这种矛盾态。 */}
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldExecutionMode')}</label>
                    <div className="flex flex-col gap-1.5">
                      {EXECUTION_TIER1.map(opt => {
                        const selected = addFramework === opt.id;
                        return (
                          <button key={opt.id} type="button"
                            onClick={() => {
                              if (selected) return;
                              const patch = patchForTier1(opt.id, { provider: addProvider, model: addModel }, PROVIDER_DEFAULT_MODEL);
                              setAddFramework(patch.framework); setAddProvider(patch.provider); setAddModel(patch.model);
                            }}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-left transition-colors border ${
                              selected ? "border-accent bg-accent/10 text-accent" : "border-hairline bg-surface-1 text-ink-muted hover:text-ink"
                            }`}>
                            {isSubscriptionFramework(opt.id) ? (
                              <span className="shrink-0 w-5 h-5 rounded-md text-[10px] font-bold text-white flex items-center justify-center"
                                style={{ backgroundColor: SUBSCRIPTION_BRAND[opt.id].bg }}>{SUBSCRIPTION_BRAND[opt.id].mono}</span>
                            ) : (
                              <span>{opt.emoji}</span>
                            )}
                            <span className="font-medium">{tr(TIER1_I18N[opt.id].labelKey)}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-[10px] text-ink-muted mt-1.5 leading-snug">{tr(TIER1_I18N[addFramework].blurbKey)}</div>
                    {isSubscriptionFramework(addFramework) && addRole !== "ceo" && addRole !== "lead" && (
                      <div className="text-[10px] text-amber mt-1.5 leading-snug">{tr('org.executionModeWorkerCliRisk')}</div>
                    )}
                    {/* 已知限制/风险如实提示(来自 Tier1Option.warningKey,E2 起走 i18n 字典,与 blurb 同类展示位置)。 */}
                    {(() => {
                      const warningKey = EXECUTION_TIER1.find(o => o.id === addFramework)?.warningKey;
                      return warningKey ? (
                        <div className="text-[10px] text-amber mt-1.5 leading-snug">{tr(warningKey)}</div>
                      ) : null;
                    })()}
                  </div>

                  {/* 第二级：CLI 订阅只有模型别名下拉(无"供应商"概念)；API 面才有供应商+模型 */}
                  {isSubscriptionFramework(addFramework) ? (
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldModel')}</label>
                      <select value={addModel} onChange={e => setAddModel(e.target.value)}
                        className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-1 text-ink">
                        {CLI_MODEL_ALIASES[addFramework].map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <div className="text-[10px] text-ink-muted mt-1">{tr('org.frameworkCliHint')}</div>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">Provider</label>
                        <select value={addProvider}
                          onChange={e => {
                            const p = e.target.value;
                            const dm = PROVIDER_DEFAULT_MODEL[p];
                            // Bug 修复(2026-07 · 12+1 框架扩展):以前这里硬编码把 framework 设回 API 面——
                            // 这个分支现在也给 gemini-cli 等 9 个新框架渲染(不只是 API 面),硬编码会在用户
                            // 只是切供应商时把 framework 悄悄拉回 API 面(同 AgentDetailsPanel.tsx 的修复)。
                            setAddProvider(p);
                            if (dm) setAddModel(dm); // 模型跟随供应商默认,保持同步
                          }}
                          className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-1 text-ink">
                          {PROVIDER_LIST.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-1.5">{tr('org.fieldModel')}</label>
                        <input value={addModel} onChange={e => setAddModel(e.target.value)}
                          className="w-full border border-hairline rounded-lg px-3 py-2 text-[13px] outline-none focus:border-accent transition-colors bg-surface-0 text-ink" />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 justify-end mt-5">
                  <button onClick={onCancel} className="btn-secondary">{tr('common.cancel')}</button>
                  <button onClick={onSubmit} className="btn-primary">{tr('org.add')}</button>
                </div>
              </>
            ) : showTemplatePicker ? (
              <>
                <button
                  onClick={() => setShowTemplatePicker(false)}
                  className="flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink mb-3 transition-colors"
                >
                  <ArrowLeft size={12} /> {tr('org.back')}
                </button>
                <p className="text-[12px] text-ink-muted mb-3">{tr('org.templatePickerHint')}</p>
                {communityLoading ? (
                  <div className="text-center py-8 text-ink-muted text-[13px]">{tr('org.loading')}</div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto">
                    {communityTemplates.map(t => (
                      <div key={t.id}
                        className="flex items-center gap-3 p-3 rounded-lg border border-hairline bg-surface-0"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-ink truncate">{t.title}</div>
                          <div className="text-[11px] text-ink-muted mt-0.5">
                            {t.agents.length} agents · {t.author}
                          </div>
                        </div>
                        <button
                          onClick={() => importTemplate(t)}
                          disabled={importingTemplateId === t.id}
                          className="btn-primary flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium disabled:opacity-50 transition-colors flex-shrink-0"
                        >
                          <Download size={12} />
                          {importingTemplateId === t.id ? tr('org.importing') : tr('common.import')}
                        </button>
                      </div>
                    ))}
                    {communityTemplates.length === 0 && (
                      <div className="text-center py-8 text-ink-muted text-[13px]">{tr('org.noTemplates')}</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowTemplatePicker(true)}
                  className="flex items-center gap-2 w-full p-3 mb-3 rounded-lg border border-dashed border-hairline
                    text-[13px] text-ink-muted hover:text-ink hover:border-accent hover:bg-surface-2
                    transition-colors"
                >
                  <Users size={16} />
                  <span>{tr('org.importWholeTeam')}</span>
                </button>
                {communityLoading ? (
                  <div className="text-center py-8 text-ink-muted text-[13px]">{tr('org.loading')}</div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto">
                    {communityAgents.map(card => (
                      <div key={card.id}
                        className="flex items-center gap-3 p-3 rounded-lg border border-hairline bg-surface-0"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-ink truncate">{card.title}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-ink-muted"
                              style={{ color: ROLE_COLORS[card.role] || undefined }}
                            >
                              {ROLE_LABELS[card.role] || card.role}
                            </span>
                            <span className="text-[11px] text-ink-muted">{card.agent.recommendedModel}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => fillFromAgentCard(card)}
                          className="btn-primary flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium transition-colors flex-shrink-0"
                        >
                          <Download size={12} />
                          {tr('common.import')}
                        </button>
                      </div>
                    ))}
                    {communityAgents.length === 0 && (
                      <div className="text-center py-8 text-ink-muted text-[13px]">{tr('org.noCommunityAgents')}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
