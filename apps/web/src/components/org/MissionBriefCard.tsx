import { useCallback, useState } from "react";
import {
  CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronUp, Sparkles, Edit3, Rocket,
  Plus, X, Users, Package, Check, GitBranch,
} from "lucide-react";
import * as api from "../../api/client.js";
import type { ApiError, MissionBrief, MissionTeamModeOverride } from "../../api/client.js";
import { pushToast } from "../common/Toast.js";
import { SUCCESS, ERROR } from "../trace/traceTypes.js";

// Plan 模式的核心产出——POST /api/missions 拿到的 MissionBrief 渲染成一张可交互简报卡,插进
// BriefingPanel 的消息流(见该文件 missionToEntry)。三个底部动作:继续头脑风暴(重开输入框,原
// 想法+补充文字重新调用创建端点)/ 修改简报(展开字段为可编辑输入,PATCH)/ 确认并执行(调用 approve
// 端点,把 dispatched 交回宿主——run 走"已派任务"气泡,goal/loop 走 AutomationPanel 既有轮询展示)。
// 一旦 approvalStatus 不再是 draft(已确认执行/已停止),三个动作收起,只留一行状态摘要——
// 简报卡片本身不该在派发后还能被改或被重复执行。

type Tr = (key: string, params?: Record<string, string | number>) => string;

const TEAM_MODE_KEY: Record<string, string> = {
  economy: "org.brief.instant.quality.economy",
  balanced: "org.brief.instant.quality.balanced",
  maxQuality: "org.brief.instant.quality.maxQuality",
};

const PERMISSION_KEY: Record<string, string> = {
  no_code: "org.brief.mission.permission.no_code",
  propose_only: "org.brief.mission.permission.propose_only",
  write_code: "org.brief.mission.permission.write_code",
  external_actions: "org.brief.mission.permission.external_actions",
};

// 后端 RequiredDepartment 枚举("research"/"product"/"launch")→ 人话标签;未知值原样展示
// (兼容后端将来加新枚举,或用户在"修改简报"里自由打了别的部门名)。
const DEPARTMENT_KEY: Record<string, string> = {
  research: "org.brief.mission.department.research",
  product: "org.brief.mission.department.product",
  launch: "org.brief.mission.department.launch",
};

function splitLines(s: string): string[] {
  return s.split("\n").map(x => x.trim()).filter(Boolean);
}

// 可增删行的数组字段编辑器(successCriteria/nonGoals 专用)——发送前过滤空行,至少留一行输入框。
function EditableRows({ items, onChange, placeholder, addLabel }: {
  items: string[]; onChange: (items: string[]) => void; placeholder: string; addLabel: string;
}) {
  const update = (i: number, v: string) => onChange(items.map((x, idx) => (idx === i ? v : x)));
  const add = () => onChange([...items, ""]);
  const remove = (i: number) => onChange(items.length <= 1 ? [""] : items.filter((_, idx) => idx !== i));
  return (
    <div className="flex flex-col gap-1">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={it}
            onChange={e => update(i, e.target.value)}
            placeholder={placeholder}
            className="flex-1 min-w-0 rounded-md bg-surface-1 border border-hairline px-2 py-1 text-[11px] text-ink outline-none focus:border-accent placeholder:text-ink-subtle"
          />
          <button
            onClick={() => remove(i)}
            className="w-5 h-5 rounded-lg flex items-center justify-center text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer shrink-0"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start flex items-center gap-1 text-[11px] text-ink-subtle hover:text-accent bg-transparent border-none cursor-pointer p-0"
      >
        <Plus size={11} />{addLabel}
      </button>
    </div>
  );
}

function EditField({ label, value, onChange, rows = 2 }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink-subtle">{label}</span>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className="w-full resize-none rounded-md bg-surface-1 border border-hairline px-2 py-1 text-[11px] text-ink outline-none focus:border-accent"
      />
    </div>
  );
}

interface EditDraft {
  interpretedGoal: string;
  problemStatement: string;
  proposedDirection: string;
  targetUser: string;
  successCriteria: string[];
  nonGoals: string[];
  assumptions: string;
  risks: string;
  requiredDepartments: string;
  expectedArtifacts: string;
}

function draftFromMission(m: MissionBrief): EditDraft {
  return {
    interpretedGoal: m.interpretedGoal,
    problemStatement: m.problemStatement ?? "",
    proposedDirection: m.proposedDirection ?? "",
    targetUser: m.targetUser ?? "",
    successCriteria: m.successCriteria.length > 0 ? [...m.successCriteria] : [""],
    nonGoals: m.nonGoals.length > 0 ? [...m.nonGoals] : [""],
    assumptions: m.assumptions.join("\n"),
    risks: m.risks.join("\n"),
    requiredDepartments: m.requiredDepartments.join("\n"),
    expectedArtifacts: m.expectedArtifacts.join("\n"),
  };
}

export default function MissionBriefCard({ mission, onUpdate, onBrainstorm, onApproved, tr }: {
  mission: MissionBrief;
  /** 简报字段被 PATCH 更新后,回写宿主(BriefingPanel)的 missions 状态——卡片自己不留真源。 */
  onUpdate: (m: MissionBrief) => void;
  /** "继续头脑风暴":宿主重开输入框、记住这份简报当基底,等用户补充文字后重新调用创建端点。 */
  onBrainstorm: (m: MissionBrief) => void;
  /** approve 成功后回调:宿主据 dispatched.kind 决定"已派任务"气泡还是 AutomationPanel 自动展示。 */
  onApproved: (m: MissionBrief, dispatched: { kind: "run" | "goal" | "loop"; id: string }) => void;
  tr: Tr;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>(() => draftFromMission(mission));
  const [risksOpen, setRisksOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  // 建议档位只作参考。默认尊重公司节点配置,避免用户点“确认”后员工模型被静默替换。
  const [teamModeOverride, setTeamModeOverride] = useState<MissionTeamModeOverride>("configured");
  // B6 · 任务图派发(第三条派发路径,missionRoutes A2):CEO 结构化提案 → Core 六项校验 → 按拓扑序执行。
  // 复杂 mission(预估 L/XL 或多部门)默认走图;用户可随时勾选/取消。422 校验失败 mission 停留 draft,
  // errors 逐条如实展示(不折叠成一句笼统失败)。
  const complexByEstimate = mission.complexityEstimate?.complexity === "L" || mission.complexityEstimate?.complexity === "XL";
  const [taskGraphMode, setTaskGraphMode] = useState<boolean>(complexByEstimate || mission.requiredDepartments.length > 1);

  const startEdit = useCallback(() => {
    setDraft(draftFromMission(mission));
    setEditing(true);
  }, [mission]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const saveEdit = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await api.updateMission(mission.id, {
        interpretedGoal: draft.interpretedGoal.trim() || mission.interpretedGoal,
        problemStatement: draft.problemStatement.trim() || undefined,
        proposedDirection: draft.proposedDirection.trim() || undefined,
        targetUser: draft.targetUser.trim() || undefined,
        successCriteria: draft.successCriteria.map(s => s.trim()).filter(Boolean),
        nonGoals: draft.nonGoals.map(s => s.trim()).filter(Boolean),
        assumptions: splitLines(draft.assumptions),
        risks: splitLines(draft.risks),
        requiredDepartments: splitLines(draft.requiredDepartments),
        expectedArtifacts: splitLines(draft.expectedArtifacts),
      });
      onUpdate(updated);
      setEditing(false);
    } catch (e: any) {
      pushToast("info", tr("org.brief.mission.saveFailed", { message: e?.message ?? String(e) }));
    } finally {
      setSaving(false);
    }
  }, [mission.id, mission.interpretedGoal, draft, onUpdate, tr]);

  const approve = useCallback(async () => {
    setApproving(true);
    try {
      const r = await api.approveMission(mission.id, {
        teamMode: teamModeOverride,
        ...(taskGraphMode ? { dispatchMode: "task-graph" as const } : {}),
      });
      if (taskGraphMode) {
        // task-graph 路径无 dispatched(响应是 committed 图快照);approved 状态回写宿主,
        // 图本体由 CEO 驾驶舱的拆解树卡(TaskGraphTree,同 missionId)实时展示。
        onUpdate({ ...mission, approvalStatus: "approved" });
        pushToast("info", tr("org.brief.mission.taskGraphDispatched", { n: r.graph?.nodes.length ?? 0 }));
      } else if (r.dispatched) {
        onApproved({ ...mission, approvalStatus: "approved" }, r.dispatched);
      }
    } catch (e: any) {
      // 422(task-graph 校验失败)带 errors 数组:mission 停留 draft,可改后重试——逐条如实展示。
      const errs = (e as ApiError)?.errors;
      const message = errs?.length ? `${e?.message ?? ""}: ${errs.join("; ")}` : (e?.message ?? String(e));
      pushToast("info", tr("org.brief.mission.approveFailed", { message }));
    } finally {
      setApproving(false);
    }
  }, [mission, onApproved, onUpdate, tr, taskGraphMode, teamModeOverride]);

  const isDraft = mission.approvalStatus === "draft";
  const busy = saving || approving;

  const runTypeLine = mission.suggestedRunType === "quick"
    ? tr("org.brief.mission.runType.quick")
    : tr("org.brief.mission.runType.team", { teamMode: mission.suggestedTeamMode ? tr(TEAM_MODE_KEY[mission.suggestedTeamMode] ?? "") : "" });

  const permissionLabel = PERMISSION_KEY[mission.permissionNeeds] ? tr(PERMISSION_KEY[mission.permissionNeeds]) : mission.permissionNeeds;

  return (
    <div className="flex flex-col gap-2.5 min-w-[240px] max-w-[420px]">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-medium text-ink leading-snug">
          {tr("org.brief.mission.understood", { goal: mission.interpretedGoal })}
        </div>
        {!isDraft && (
          <span
            className={`badge shrink-0 ${mission.approvalStatus === "approved" ? "bg-green/20 text-green" : "bg-surface-2 text-ink-subtle"}`}
          >
            {tr(mission.approvalStatus === "approved" ? "org.brief.mission.statusApproved" : "org.brief.mission.statusStopped")}
          </span>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2.5">
          <EditField label={tr("org.brief.mission.field.interpretedGoal")} value={draft.interpretedGoal} onChange={v => setDraft(d => ({ ...d, interpretedGoal: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.problemStatement")} value={draft.problemStatement} onChange={v => setDraft(d => ({ ...d, problemStatement: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.proposedDirection")} value={draft.proposedDirection} onChange={v => setDraft(d => ({ ...d, proposedDirection: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.targetUser")} value={draft.targetUser} onChange={v => setDraft(d => ({ ...d, targetUser: v }))} rows={1} />
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-ink-subtle">{tr("org.brief.mission.field.successCriteria")}</span>
            <EditableRows items={draft.successCriteria} onChange={v => setDraft(d => ({ ...d, successCriteria: v }))}
              placeholder={tr("org.brief.mission.field.successCriteriaPlaceholder")} addLabel={tr("org.brief.harness.criteriaAdd")} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-ink-subtle">{tr("org.brief.mission.field.nonGoals")}</span>
            <EditableRows items={draft.nonGoals} onChange={v => setDraft(d => ({ ...d, nonGoals: v }))}
              placeholder={tr("org.brief.mission.field.nonGoalsPlaceholder")} addLabel={tr("org.brief.harness.criteriaAdd")} />
          </div>
          <EditField label={tr("org.brief.mission.field.assumptions")} value={draft.assumptions} onChange={v => setDraft(d => ({ ...d, assumptions: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.risks")} value={draft.risks} onChange={v => setDraft(d => ({ ...d, risks: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.requiredDepartments")} value={draft.requiredDepartments} onChange={v => setDraft(d => ({ ...d, requiredDepartments: v }))} rows={2} />
          <EditField label={tr("org.brief.mission.field.expectedArtifacts")} value={draft.expectedArtifacts} onChange={v => setDraft(d => ({ ...d, expectedArtifacts: v }))} rows={2} />
          <div className="flex items-center gap-3">
            <button
              disabled={busy}
              onClick={() => void saveEdit()}
              className="flex items-center gap-1 text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 disabled:opacity-40"
              style={{ color: SUCCESS }}
            >
              <Check size={11} />{saving ? tr("org.brief.mission.saving") : tr("common.save")}
            </button>
            <button
              disabled={busy}
              onClick={cancelEdit}
              className="text-[11px] text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer p-0 disabled:opacity-40"
            >
              {tr("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {mission.problemStatement && (
            <div className="text-[12px] text-ink-muted leading-snug">{mission.problemStatement}</div>
          )}
          {mission.proposedDirection && (
            <div className="text-[12px] text-ink-muted leading-snug">{mission.proposedDirection}</div>
          )}

          {mission.successCriteria.length > 0 && (
            <ul className="flex flex-col gap-1 list-none m-0 p-0">
              {mission.successCriteria.map((c, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[12px] text-ink leading-snug">
                  <CheckCircle2 size={12} className="shrink-0 mt-[1.5px]" style={{ color: SUCCESS }} />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}

          {mission.nonGoals.length > 0 && (
            <ul className="flex flex-col gap-1 list-none m-0 p-0">
              {mission.nonGoals.map((c, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[12px] text-ink-muted leading-snug">
                  <XCircle size={12} className="shrink-0 mt-[1.5px] text-ink-subtle" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}

          {mission.risks.length > 0 && (
            <div className="rounded-md border border-hairline bg-surface-0 overflow-hidden">
              <button
                onClick={() => setRisksOpen(o => !o)}
                className="w-full flex items-center gap-1.5 px-2 py-1 bg-transparent border-none cursor-pointer text-left"
              >
                {risksOpen ? <ChevronUp size={11} className="text-ink-subtle shrink-0" /> : <ChevronDown size={11} className="text-ink-subtle shrink-0" />}
                <AlertTriangle size={11} style={{ color: ERROR }} className="shrink-0" />
                <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.mission.risksTitle", { n: mission.risks.length })}</span>
              </button>
              {risksOpen && (
                <ul className="px-2 pb-1.5 flex flex-col gap-0.5 list-none m-0">
                  {mission.risks.map((r, i) => (
                    <li key={i} className="text-[11px] text-ink-muted leading-snug">· {r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {mission.requiredDepartments.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Users size={11} className="text-ink-subtle shrink-0" />
              {mission.requiredDepartments.map((d, i) => (
                <span key={i} className="badge bg-surface-2 text-ink-muted">{DEPARTMENT_KEY[d] ? tr(DEPARTMENT_KEY[d]) : d}</span>
              ))}
            </div>
          )}

          {mission.expectedArtifacts.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-subtle">
                <Package size={11} className="shrink-0" />{tr("org.brief.mission.artifactsTitle")}
              </div>
              <ul className="flex flex-col gap-0.5 list-none m-0 pl-[17px]">
                {mission.expectedArtifacts.map((a, i) => (
                  <li key={i} className="text-[11px] text-ink-muted leading-snug">· {a}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-[11px] text-ink-subtle">{runTypeLine} · {permissionLabel}</div>

          {isDraft && mission.suggestedRunType === "team" && (
            <label className="flex items-center justify-between gap-2 text-[11px] text-ink-subtle">
              <span>{tr("org.brief.instant.qualityLabel")}</span>
              <select
                value={teamModeOverride}
                onChange={e => setTeamModeOverride(e.target.value as MissionTeamModeOverride)}
                disabled={busy}
                title={tr("org.brief.mission.teamModeHint")}
                className="min-w-0 max-w-[220px] rounded-md border border-hairline bg-surface-1 px-2 py-1 text-[11px] text-ink outline-none focus:border-accent disabled:opacity-40"
              >
                <option value="configured">{tr("org.brief.mission.teamModeConfigured")}</option>
                <option value="economy">{tr(TEAM_MODE_KEY.economy)}</option>
                <option value="balanced">{tr(TEAM_MODE_KEY.balanced)}</option>
                <option value="maxQuality">{tr(TEAM_MODE_KEY.maxQuality)}</option>
              </select>
            </label>
          )}

          {isDraft && (
            <label className="flex items-center gap-1.5 text-[11px] text-ink-subtle cursor-pointer select-none">
              <input
                type="checkbox"
                checked={taskGraphMode}
                onChange={e => setTaskGraphMode(e.target.checked)}
                disabled={busy}
                className="accent-[var(--color-accent)] disabled:opacity-40"
              />
              <GitBranch size={11} className="shrink-0" />
              <span>{tr("org.brief.mission.taskGraphOption")}</span>
            </label>
          )}

          {isDraft && (
            <div className="flex items-center gap-3 pt-0.5">
              <button
                disabled={busy}
                onClick={() => onBrainstorm(mission)}
                className="flex items-center gap-1 text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 disabled:opacity-40"
              >
                <Sparkles size={11} />{tr("org.brief.mission.continueBrainstorm")}
              </button>
              <button
                disabled={busy}
                onClick={startEdit}
                className="flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink bg-transparent border-none cursor-pointer p-0 disabled:opacity-40"
              >
                <Edit3 size={11} />{tr("org.brief.mission.editBrief")}
              </button>
              <button
                disabled={busy}
                onClick={() => void approve()}
                className="btn-primary ml-auto flex items-center gap-1 h-6 px-2.5 text-[11px] font-medium disabled:opacity-40"
              >
                <Rocket size={11} />{approving ? tr("org.brief.mission.approving") : tr("org.brief.mission.approve")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
