import { Download, ShieldAlert, ShieldCheck, AlertTriangle, XCircle, CheckCircle2, Loader2, GitMerge } from "lucide-react";
import { useT } from "../i18n.js";

// D1(修 V4):模板安装确认弹窗——除名称/人数外,还展示 Permission Diff(dangerFlags,危险红/警告黄)
// 与 Template Doctor 体检结果;error 级(篡改/组织成环)禁用确认按钮(服务端同样会拒装,这里是前置透明)。
// D3(V0 必需):加安装三模式(新建公司/合并到当前公司/仅预览)——选合并时展示安装预览 + 五类冲突清单,
// 每类可改策略(默认值对齐 installMerge.ts);预览模式不显示确认按钮,弹窗本身就是终点。

export type InstallMode = "new-company" | "merge" | "preview";

export interface MergeStrategiesInput {
  agentId: "copy-as-new" | "keep-current" | "overwrite" | "manual";
  orgEdge: "merge" | "keep-current" | "manual";
  memoryScope: "skip-duplicate" | "coexist" | "overwrite";
  a2aRule: "union" | "keep-current" | "overwrite";
  capability: "strictest" | "manual";
}

export const DEFAULT_MERGE_STRATEGIES: MergeStrategiesInput = {
  agentId: "copy-as-new", orgEdge: "merge", memoryScope: "skip-duplicate", a2aRule: "union", capability: "strictest",
};

const STRATEGY_OPTIONS: { [K in keyof MergeStrategiesInput]: MergeStrategiesInput[K][] } = {
  agentId: ["copy-as-new", "keep-current", "overwrite", "manual"],
  orgEdge: ["merge", "keep-current", "manual"],
  memoryScope: ["skip-duplicate", "coexist", "overwrite"],
  a2aRule: ["union", "keep-current", "overwrite"],
  capability: ["strictest", "manual"],
};

export interface MergeConflictCounts {
  agentId: number;
  orgEdge: number;
  memoryScope: number;
  a2aRule: number;
  capability: number;
  teamDuplication: number; // P1#5/#4:同 role+同 name 的语义团队重复(直接合并会新增第二套团队)
  orgParent: number; // C9-P0:map 到已有员工遇新父级(模板声明上级 ≠ 既有员工现有上级)
}

// P1#4(用户审计)· 语义团队重复的显式处置——**故意无默认值**(后端 resolveMerge 缺省即 409),
// 用户必须在三者中显式选一,否则确认按钮禁用(镜像后端硬拦,不让用户只撞 409)。
export type TeamDuplicationResolution = "map" | "overwrite" | "add-department";
export const TEAM_DUP_RESOLUTIONS: TeamDuplicationResolution[] = ["map", "overwrite", "add-department"];

// C9-P0 · map 到已有员工遇新父级三选一——同样**无默认值**(后端缺省即 409)。只在 teamDup 选了 map
// 且检出 orgParent 冲突时才要求;未选则确认禁用,镜像后端硬拦。
export type OrgParentResolution = "keep-current-org" | "adopt-template-org" | "reject";
export const ORG_PARENT_RESOLUTIONS: OrgParentResolution[] = ["keep-current-org", "adopt-template-org", "reject"];

export interface InstallPreviewSummaryView {
  newAgents: number;
  newOrgEdges: number;
  newA2AChannels: number;
  newCompanyExperiences: number;
  newTeamExperiences: number;
  newAgentExperiences: number;
  newDefaultTasks: number;
  newArtifactContracts: number;
  requiredCapabilities: string[];
}

// P0-1 · 导入绑定计划(预览接口返回,用户逐项确认后随真装回传)。
// action 语义:keep=保持原绑定;map=用候选替代(targetBinding 必填);configure=去配置(本次安装受影响员工禁用);
// disable=禁用受影响员工。userApproved=false 的计划后端按 disable 诚实降级(绝不静默替换)。
export interface BindingPlanView {
  originalBinding: { kind: "provider" | "model" | "engine" | "mcp"; name: string; provider?: string };
  status: "available" | "missing" | "incompatible";
  action: "keep" | "map" | "configure" | "disable";
  targetBinding?: { engine?: string; provider?: string; model?: string };
  candidates?: Array<{ engine?: string; provider?: string; model?: string; recommended?: boolean; recommendationReason?: string }>;
  reason?: string;
  userApproved: boolean;
}

export interface DoctorCheckView {
  id: string;
  status: "pass" | "warning" | "error";
  severity: "info" | "warning" | "error";
  message: string;
}

export interface DoctorReportView {
  status: "pass" | "warning" | "error";
  checks: DoctorCheckView[];
  warnings: number;
  errors: number;
  install_allowed: boolean;
}

export interface TemplateImportCheck {
  loading: boolean;
  error?: boolean; // 体检接口本身失败(不阻塞确认;服务端安装时仍会拦 error 级)
  doctor?: DoctorReportView;
  dangerFlags?: string[];
  trustLevel?: string;
  hashVerified?: boolean;
  safeInstallPreview?: Array<{ id: string; detail: string }>;
}

interface Props {
  name: string;
  agentCount?: number;
  onConfirm: (opts: { mode: InstallMode; targetCompanyId?: string; mergeStrategies?: MergeStrategiesInput; confirmOverwrite?: boolean; retainHighRisk?: boolean; teamDuplicationResolution?: TeamDuplicationResolution; orgParentResolution?: OrgParentResolution }) => void;
  onCancel: () => void;
  loading?: boolean;
  check?: TemplateImportCheck;
  // This is only the user's UI choice. The server authorizes retention exclusively through the preview token.
  retainHighRisk: boolean;
  onRetainHighRiskChange: (v: boolean) => void;
  hasInstallConfirmationToken: boolean;
  // D3:安装三模式——上层(CommunityPage)持有状态,这里是受控组件。
  mode: InstallMode;
  onModeChange: (m: InstallMode) => void;
  companies: Array<{ id: string; name: string }>;
  targetCompanyId: string;
  onTargetCompanyChange: (id: string) => void;
  preview?: InstallPreviewSummaryView | null;
  mergeConflicts?: MergeConflictCounts | null;
  mergeStrategies: MergeStrategiesInput;
  onMergeStrategiesChange: (s: MergeStrategiesInput) => void;
  confirmOverwrite: boolean;
  onConfirmOverwriteChange: (v: boolean) => void;
  // P1#4:语义团队重复处置——"" = 未选(确认禁用,镜像后端 409);选定后随 merge 安装体透传。
  teamDuplicationResolution: TeamDuplicationResolution | "";
  onTeamDuplicationResolutionChange: (v: TeamDuplicationResolution | "") => void;
  // C9-P0:map 遇新父级三选一——"" = 未选(map 且检出 orgParent 冲突时确认禁用,镜像后端 409)。
  orgParentResolution: OrgParentResolution | "";
  onOrgParentResolutionChange: (v: OrgParentResolution | "") => void;
  // P0-1 · 导入绑定计划:预览返回的逐项计划 + 用户逐项改动。CommunityPage 持有状态,本组件受控渲染。
  bindingPlans?: BindingPlanView[];
  onBindingPlanChange?: (index: number, patch: Partial<BindingPlanView>) => void;
}

// shell 是最高危(能执行任意命令)→ 红;其余(文件写/联网/MCP 依赖)→ 黄。
const RED_FLAGS = new Set(["shell-access"]);
// 只有这 5 类走 mergeStrategies 策略表;teamDuplication 是语义团队重复,独立处置(见下方 teamDup 块)。
const CONFLICT_CATEGORIES: (keyof MergeStrategiesInput)[] = ["agentId", "orgEdge", "memoryScope", "a2aRule", "capability"];
// D8 五级信任标签配色:官方绿 / 已验证社区蓝 / 社区中性 / 本地导入黄 / 未受信红。
const TRUST_STYLE: Record<string, string> = {
  official: "bg-green/10 text-green border-green/30",
  verified_community: "bg-accent/10 text-accent border-accent/30",
  community: "bg-bg-hover text-text-secondary border-border",
  local_import: "bg-amber/10 text-amber border-amber/30",
  untrusted: "bg-red/10 text-red border-red/30",
};

export default function ImportConfirmDialog({
  name, agentCount, onConfirm, onCancel, loading, check,
  retainHighRisk, onRetainHighRiskChange, hasInstallConfirmationToken,
  mode, onModeChange, companies, targetCompanyId, onTargetCompanyChange,
  preview, mergeConflicts, mergeStrategies, onMergeStrategiesChange,
  confirmOverwrite, onConfirmOverwriteChange,
  teamDuplicationResolution, onTeamDuplicationResolutionChange,
  orgParentResolution, onOrgParentResolutionChange,
  bindingPlans, onBindingPlanChange,
}: Props) {
  const tr = useT();
  const blocked = !!check?.doctor && !check.doctor.install_allowed;
  const flagLabel = (f: string) => {
    const key = `ic.flag.${f}`;
    const label = tr(key);
    return label === key ? f : label;
  };
  const trustLabel = (level: string) => {
    const key = `ic.trust.${level}`;
    const label = tr(key);
    return label === key ? level : label;
  };
  const checkLabel = (id: string) => {
    const key = `ic.check.${id}`;
    const label = tr(key);
    return label === key ? id : label;
  };
  const stripLabel = (id: string) => {
    const key = `ic.strip.${id}`;
    const label = tr(key);
    return label === key ? id : label;
  };
  const strategyLabel = <K extends keyof MergeStrategiesInput>(category: K, value: MergeStrategiesInput[K]) =>
    tr(`ic.strategy.${category}.${value}`);

  const needsOverwriteConfirm = mode === "merge" && mergeStrategies.agentId === "overwrite" && (mergeConflicts?.agentId ?? 0) > 0;
  // P1#4:检出语义团队重复却未显式选处置 → 与后端一致地拦在确认前(不让用户只撞 409)。
  const needsTeamDupResolution = mode === "merge" && (mergeConflicts?.teamDuplication ?? 0) > 0 && !teamDuplicationResolution;
  // C9-P0:只有选了 map 且检出 orgParent 冲突时才要求三选一(overwrite/add-department 不涉及既有员工改挂)。
  const needsOrgParentResolution = mode === "merge" && teamDuplicationResolution === "map" && (mergeConflicts?.orgParent ?? 0) > 0 && !orgParentResolution;
  const mergeReady = mode !== "merge" || (!!targetCompanyId && (!needsOverwriteConfirm || confirmOverwrite) && !needsTeamDupResolution && !needsOrgParentResolution);
  const needsInstallToken = retainHighRisk && !!check?.safeInstallPreview?.length;
  const hasUnresolvedBinding = !!bindingPlans?.some((p) => {
    if (p.status === "available") return false;
    if (p.originalBinding.kind === "model" && p.originalBinding.provider) {
      const providerPlan = bindingPlans.find((candidate) =>
        candidate.originalBinding.kind === "provider" && candidate.originalBinding.name === p.originalBinding.provider,
      );
      if (providerPlan?.userApproved && (providerPlan.action === "map" || providerPlan.action === "disable")) return false;
    }
    if (!p.userApproved || p.action === "configure") return true;
    if (p.action !== "map") return false;
    if (p.originalBinding.kind === "engine") {
      return !p.targetBinding?.engine || (p.targetBinding.engine === "api" && (!p.targetBinding.provider || !p.targetBinding.model));
    }
    if (p.originalBinding.kind === "provider") return !p.targetBinding?.provider || !p.targetBinding?.model;
    if (p.originalBinding.kind === "model") return !p.targetBinding?.model;
    return true;
  });
  const confirmDisabled = loading || blocked || !mergeReady || hasUnresolvedBinding || (needsInstallToken && !hasInstallConfirmationToken);

  const handleConfirm = () => {
    onConfirm({
      mode,
      targetCompanyId: mode === "merge" ? targetCompanyId : undefined,
      mergeStrategies: mode === "merge" ? mergeStrategies : undefined,
      confirmOverwrite: mode === "merge" ? confirmOverwrite : undefined,
      // This never authorizes the server by itself. The caller must exchange it for the preview-issued token.
      retainHighRisk: retainHighRisk && !!check?.safeInstallPreview?.length ? true : undefined,
      teamDuplicationResolution: mode === "merge" && teamDuplicationResolution ? teamDuplicationResolution : undefined,
      // C9-P0:仅 map 处置下透传 orgParentResolution(其余处置后端不消费)。
      orgParentResolution: mode === "merge" && teamDuplicationResolution === "map" && orgParentResolution ? orgParentResolution : undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1100]" onClick={onCancel}>
      <div className="bg-bg-card rounded-xl p-7 w-[460px] max-w-[90vw] max-h-[85vh] overflow-auto text-center shadow-xl"
        onClick={e => e.stopPropagation()}>
        <Download size={32} className="mx-auto mb-3 text-accent opacity-80" />
        <b className="text-base">{tr("ic.title", { name })}</b>
        <p className="text-[13px] text-text-secondary my-2 mx-0">
          {agentCount !== undefined ? tr("ic.bodyAgents", { n: agentCount }) : tr("ic.bodyAgent")}
        </p>

        {/* D3 · 安装模式选择 */}
        <div className="text-start mb-3">
          <div className="text-[13px] font-semibold text-text-primary mb-1.5">{tr("ic.mode.label")}</div>
          <div className="flex gap-1.5 rounded-full bg-surface-2 p-0.5">
            {(["new-company", "merge", "preview"] as InstallMode[]).map(m => (
              <button key={m} type="button" onClick={() => onModeChange(m)}
                className={`flex-1 text-[12px] px-2 py-1.5 rounded-full border-none transition-colors ${
                  mode === m ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                }`}>
                {tr(`ic.mode.${m === "new-company" ? "newCompany" : m}`)}
              </button>
            ))}
          </div>
        </div>

        {/* D3 · 合并模式:选目标公司 */}
        {mode === "merge" && (
          <div className="text-start mb-3">
            <label className="block text-[13px] font-semibold text-text-primary mb-1.5">{tr("ic.mergeTarget.label")}</label>
            <select value={targetCompanyId} onChange={e => onTargetCompanyChange(e.target.value)}
              className="w-full border border-border rounded-md bg-bg-card text-[13px] py-1.5 px-2 outline-none focus:border-accent text-text-primary">
              <option value="">{tr("ic.mergeTarget.placeholder")}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {check?.loading && (
          <div className="flex items-center justify-center gap-2 text-[13px] text-text-muted my-3">
            <Loader2 size={14} className="animate-spin" /> {tr("ic.checking")}
          </div>
        )}

        {check && !check.loading && check.error && (
          <div className="flex items-start gap-2 text-start text-[12px] text-amber bg-amber/10 border border-amber/20 rounded-md px-2.5 py-2 my-3">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {tr("ic.checkUnavailable")}
          </div>
        )}

        {/* Missing bindings must be resolved before install. Configure navigates to the relevant
            capability page; returning to Community triggers a fresh authoritative preview. */}
        {bindingPlans && bindingPlans.length > 0 && !check?.loading && (
          <div className="text-start mb-3">
            <div className="text-[13px] font-semibold text-text-primary mb-1.5">{tr("ic.binding.title")}</div>
            <div className="flex flex-col gap-2">
              {bindingPlans.map((p, i) => {
                const missing = p.status !== "available";
                return (
                  <div key={`${p.originalBinding.kind}:${p.originalBinding.name}:${i}`}
                    className={`rounded-md border px-2.5 py-2 text-[12px] ${missing ? "border-amber/30 bg-amber/5" : "border-border bg-bg-hover"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-text-primary">
                        {tr(`ic.binding.kind.${p.originalBinding.kind}`)}: {p.originalBinding.name}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-full border ${missing ? "text-amber border-amber/30 bg-amber/10" : "text-green border-green/30 bg-green/10"}`}>
                        {missing ? tr("ic.binding.missing") : tr("ic.binding.available")}
                      </span>
                    </div>
                    {p.reason && <div className="text-text-muted mt-1">{p.reason}</div>}
                    {missing && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {(["configure", "map", "disable"] as const).map(a => (
                          <button key={a} type="button"
                            disabled={a === "map" && (!p.candidates || p.candidates.length === 0)}
                            onClick={() => {
                              onBindingPlanChange?.(i, {
                                action: a,
                                userApproved: a !== "configure",
                                ...(a === "map" && p.candidates?.length && !p.targetBinding ? { targetBinding: { ...p.candidates[0] } } : {}),
                              });
                              if (a === "configure") {
                                const page = p.originalBinding.kind === "engine" ? "subscription" : p.originalBinding.kind === "mcp" ? "mcp" : "api";
                                window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page } }));
                              }
                            }}
                            className={`px-2 py-1 rounded-full border transition-colors ${
                              p.action === a ? "bg-accent/10 text-accent border-accent/40" : "bg-transparent text-ink-muted border-border hover:text-ink"
                            } ${a === "map" && (!p.candidates || p.candidates.length === 0) ? "opacity-40 cursor-not-allowed" : ""}`}>
                            {tr(`ic.binding.action.${a}`)}
                          </button>
                        ))}
                        {p.action === "map" && p.candidates && p.candidates.length > 0 && (
                          <select value={String(Math.max(0, p.candidates.findIndex(c =>
                            c.engine === p.targetBinding?.engine && c.provider === p.targetBinding?.provider && c.model === p.targetBinding?.model,
                          )))}
                            onChange={e => {
                              const c = p.candidates![Number(e.target.value)];
                              if (c) onBindingPlanChange?.(i, { targetBinding: { ...c }, userApproved: true });
                            }}
                            title={p.candidates.find((candidate) => candidate.recommended)?.recommendationReason}
                            className="border border-border rounded-md bg-bg-card text-[12px] py-1 px-1.5 outline-none focus:border-accent text-text-primary">
                            {p.candidates.map((c, candidateIndex) => (
                              <option key={`${c.engine ?? ""}:${c.provider ?? ""}:${c.model ?? ""}:${candidateIndex}`} value={candidateIndex}>
                                {c.recommended ? "推荐 · " : ""}{[c.engine, c.provider, c.model].filter(Boolean).join(" · ")}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {check && !check.loading && !check.error && (
          <div className="text-start my-3 flex flex-col gap-3">
            {/* 来源可信度(五级信任)+ 完整性(hash 校验):拉取的字段此前未渲染,如实展示。 */}
            {(check.trustLevel || check.hashVerified !== undefined) && (
              <div className="flex flex-wrap items-center gap-2">
                {check.trustLevel && (
                  <span className={`text-[12px] px-2 py-0.5 rounded-full border ${TRUST_STYLE[check.trustLevel] ?? "bg-bg-hover text-text-secondary border-border"}`}>
                    {tr("ic.trust.label")}: {trustLabel(check.trustLevel)}
                  </span>
                )}
                <span className={`inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-full border ${
                  check.hashVerified ? "bg-green/10 text-green border-green/30" : "bg-bg-hover text-text-secondary border-border"
                }`}>
                  {check.hashVerified ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                  {check.hashVerified ? tr("ic.hashVerified") : tr("ic.hashUnverified")}
                </span>
              </div>
            )}

            {/* 危险权限(Permission Diff):shell 红,其余黄;没有旗标则显示绿色安心行 */}
            <div>
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-text-primary mb-1.5">
                <ShieldAlert size={13} className={check.dangerFlags?.length ? "text-red" : "text-green"} />
                {tr("ic.dangerTitle")}
              </div>
              {check.dangerFlags && check.dangerFlags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {check.dangerFlags.map(f => (
                    <span key={f} className={`text-[12px] px-2 py-0.5 rounded-full border ${
                      RED_FLAGS.has(f) ? "bg-red/10 text-red border-red/30" : "bg-amber/10 text-amber border-amber/30"
                    }`}>
                      {flagLabel(f)}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-green flex items-center gap-1.5">
                  <ShieldCheck size={13} /> {tr("ic.noDanger")}
                </div>
              )}
            </div>

            {/* Safe Install 默认剥离预览 + 「我知情并保留」勾选(默认不勾=剥离) */}
            {check.safeInstallPreview && check.safeInstallPreview.length > 0 && (
              <div>
                <div className="text-[13px] font-semibold text-text-primary mb-1">{tr("ic.safeStripTitle")}</div>
                <ul className="m-0 ps-4 flex flex-col gap-0.5">
                  {check.safeInstallPreview.map(s => (
                    <li key={s.id} className="text-[12px] text-text-secondary">{stripLabel(s.id)}</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-start gap-2 text-[12px] text-text-primary bg-amber/5 border border-amber/20 rounded-md px-2.5 py-2 cursor-pointer">
                  <input type="checkbox" checked={retainHighRisk}
                    onChange={e => onRetainHighRiskChange(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">{tr("ic.keepDangerCheckbox")}</span>
                    <span className="block text-[11px] text-text-muted mt-0.5">{tr("ic.keepDangerNote")}</span>
                  </span>
                </label>
              </div>
            )}

            {/* Doctor 体检结果:error 红 / warning 黄 / pass 绿 */}
            {check.doctor && (
              <div>
                <div className="text-[13px] font-semibold text-text-primary mb-1">{tr("ic.checksTitle")}</div>
                <div className="flex flex-col gap-1">
                  {check.doctor.checks.map(c => (
                    <div key={c.id} className="flex items-start gap-1.5 text-[12px]">
                      {c.status === "error" ? <XCircle size={13} className="text-red shrink-0 mt-0.5" />
                        : c.status === "warning" ? <AlertTriangle size={13} className="text-amber shrink-0 mt-0.5" />
                        : <CheckCircle2 size={13} className="text-green shrink-0 mt-0.5" />}
                      <span className={c.status === "error" ? "text-red" : c.status === "warning" ? "text-amber" : "text-text-secondary"}>
                        <span className="font-medium">{checkLabel(c.id)}</span>
                        {c.status !== "pass" && <span> — {c.message}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* D3 · 安装预览摘要(指南 11.8:安装预览应显示的内容) */}
            {preview && (
              <div>
                <div className="text-[13px] font-semibold text-text-primary mb-1">{tr("ic.preview.title")}</div>
                <ul className="m-0 ps-4 flex flex-col gap-0.5 text-[12px] text-text-secondary">
                  <li>{tr("ic.preview.agents", { n: preview.newAgents })}</li>
                  <li>{tr("ic.preview.orgEdges", { n: preview.newOrgEdges })}</li>
                  {preview.newA2AChannels > 0 && <li>{tr("ic.preview.a2aChannels", { n: preview.newA2AChannels })}</li>}
                  <li>
                    {preview.requiredCapabilities.length > 0
                      ? tr("ic.preview.capabilities", { list: preview.requiredCapabilities.join(", ") })
                      : tr("ic.preview.capabilitiesNone")}
                  </li>
                </ul>
              </div>
            )}

            {/* D3 · 合并冲突清单:每类冲突数 + 可改策略;agentId=overwrite 且确有冲突时要求二次确认 */}
            {mode === "merge" && targetCompanyId && (
              <div>
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-text-primary mb-1.5">
                  <GitMerge size={13} className={mergeConflicts && CONFLICT_CATEGORIES.some(c => mergeConflicts[c] > 0) ? "text-amber" : "text-green"} />
                  {tr("ic.conflicts.title")}
                </div>
                {!mergeConflicts ? (
                  <div className="flex items-center gap-2 text-[12px] text-text-muted"><Loader2 size={12} className="animate-spin" /> {tr("ic.preview.loading")}</div>
                ) : CONFLICT_CATEGORIES.every(c => mergeConflicts[c] === 0) && mergeConflicts.teamDuplication === 0 ? (
                  <div className="text-[12px] text-green flex items-center gap-1.5"><ShieldCheck size={13} /> {tr("ic.conflicts.none")}</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {CONFLICT_CATEGORIES.filter(c => mergeConflicts[c] > 0).map(category => (
                      <div key={category} className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="text-text-secondary">{tr(`ic.conflict.${category}`)} <span className="text-amber font-medium">×{mergeConflicts[category]}</span></span>
                        <select value={mergeStrategies[category]}
                          onChange={e => onMergeStrategiesChange({ ...mergeStrategies, [category]: e.target.value as never })}
                          className="border border-border rounded-md bg-bg-card text-[12px] py-1 px-1.5 outline-none focus:border-accent text-text-primary">
                          {STRATEGY_OPTIONS[category].map(opt => (
                            <option key={opt} value={opt}>{strategyLabel(category, opt as never)}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {needsOverwriteConfirm && (
                      <label className="flex items-start gap-2 text-[12px] text-red bg-red/10 border border-red/20 rounded-md px-2.5 py-2 cursor-pointer">
                        <input type="checkbox" checked={confirmOverwrite} onChange={e => onConfirmOverwriteChange(e.target.checked)} className="mt-0.5" />
                        {tr("ic.overwriteConfirm")}
                      </label>
                    )}
                    {/* P1#4 · 语义团队重复(同 role+同 name):必须显式选处置,否则会新增第二套团队。未选=确认禁用。 */}
                    {mergeConflicts.teamDuplication > 0 && (
                      <div className={`flex flex-col gap-1.5 text-[12px] rounded-md px-2.5 py-2 border ${needsTeamDupResolution ? "text-red bg-red/10 border-red/20" : "text-text-secondary bg-amber/10 border-amber/20"}`}>
                        <div className="flex items-center gap-1.5 font-medium">
                          <AlertTriangle size={13} className="shrink-0" />
                          {tr("ic.teamDup.title")} <span className="text-amber font-semibold">×{mergeConflicts.teamDuplication}</span>
                        </div>
                        <div className="text-[12px] opacity-90">{tr("ic.teamDup.hint")}</div>
                        <select value={teamDuplicationResolution}
                          onChange={e => onTeamDuplicationResolutionChange(e.target.value as TeamDuplicationResolution | "")}
                          className="border border-border rounded-md bg-bg-card text-[12px] py-1 px-1.5 outline-none focus:border-accent text-text-primary">
                          <option value="">{tr("ic.teamDup.choose")}</option>
                          {TEAM_DUP_RESOLUTIONS.map(opt => (
                            <option key={opt} value={opt}>{tr(`ic.teamDupRes.${opt}`)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {/* C9-P0 · map 到已有员工遇新父级:必须显式选"保持原组织/调整组织/拒绝导入",否则确认禁用。
                        只在选了 map 且检出 orgParent 冲突时出现(overwrite/add-department 不涉及既有员工改挂)。 */}
                    {teamDuplicationResolution === "map" && mergeConflicts.orgParent > 0 && (
                      <div className={`flex flex-col gap-1.5 text-[12px] rounded-md px-2.5 py-2 border ${needsOrgParentResolution ? "text-red bg-red/10 border-red/20" : "text-text-secondary bg-amber/10 border-amber/20"}`}>
                        <div className="flex items-center gap-1.5 font-medium">
                          <GitMerge size={13} className="shrink-0" />
                          {tr("ic.orgParent.title")} <span className="text-amber font-semibold">×{mergeConflicts.orgParent}</span>
                        </div>
                        <div className="text-[12px] opacity-90">{tr("ic.orgParent.hint")}</div>
                        <select value={orgParentResolution}
                          onChange={e => onOrgParentResolutionChange(e.target.value as OrgParentResolution | "")}
                          className="border border-border rounded-md bg-bg-card text-[12px] py-1 px-1.5 outline-none focus:border-accent text-text-primary">
                          <option value="">{tr("ic.orgParent.choose")}</option>
                          {ORG_PARENT_RESOLUTIONS.map(opt => (
                            <option key={opt} value={opt}>{tr(`ic.orgParentRes.${opt}`)}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {blocked && (
              <div className="flex items-start gap-2 text-[12px] text-red bg-red/10 border border-red/20 rounded-md px-2.5 py-2">
                <XCircle size={14} className="shrink-0 mt-0.5" /> {tr("ic.blocked")}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-center mt-5">
          <button onClick={onCancel} className="btn-secondary">{mode === "preview" ? tr("ic.close") : tr("common.cancel")}</button>
          {mode !== "preview" && (
            <button
              onClick={handleConfirm}
              disabled={confirmDisabled}
              className="px-6 py-2 text-[13px] font-medium btn-primary disabled:opacity-50 disabled:cursor-default">
              {loading ? tr("ic.importing") : mode === "merge" ? tr("ic.confirmMerge") : tr("ic.confirm")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
