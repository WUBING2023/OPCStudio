import { useCallback, useState } from "react";
import * as api from "../api/client.js";
import type { RunType, TeamMode } from "../api/client.js";
import { useCockpitStore } from "../store/useCockpitStore.js";
import { useRunStore } from "../store/useRunStore.js";
import { useT } from "../i18n.js";
import { TASK_RE } from "./taskHeuristic.js";
import { announceRunUiState } from "./runUiState.js";

const TEAM_MODE_KEY: Record<TeamMode, string> = {
  economy: "org.brief.instant.quality.economy",
  balanced: "org.brief.instant.quality.balanced",
  maxQuality: "org.brief.instant.quality.maxQuality",
};

// 派任务/对话发送——org 简报栏(BriefingPanel)与其它命令入口共用同一份逻辑。
// 公司独立(用户指令"每个公司的简报独立"):agentId 传该公司的 CEO id(不是全局 "ceo"),
// 消息历史按此隔离;companyId 随任务下发,run 真正落到当前公司,不再默认公司兜底。
export function useTaskChat(agentId: string = "ceo", opts?: { companyId?: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [runType, setRunType] = useState<RunType>("team");
  const [teamMode, setTeamMode] = useState<TeamMode>("balanced");
  const addLocalMessage = useCockpitStore(s => s.addLocalMessage);
  const loadRuns = useRunStore(s => s.load);
  const tr = useT();
  const companyId = opts?.companyId;

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || pending) return;
    addLocalMessage({ agentId, role: "user", text: t, source: "chat" });
    setText("");
    setPending(true);
    try {
      if (TASK_RE.test(t)) {
        const r = await api.chatTask(t, { runType, teamMode: runType === "team" ? teamMode : undefined, companyId });
        announceRunUiState(r, t, companyId);
        if (r.approvalRequired) {
          // E4 · L3 网关拦下:run 是 pending,不许报"已派任务"——如实提示待审批并通知简报栏拉审批卡。
          addLocalMessage({ agentId, role: "system", text: tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }) });
          window.dispatchEvent(new CustomEvent("governance-approval-requested", { detail: { runId: r.runId } }));
        } else if (r.queued) {
          // P1-5:撞上单 run 互斥闸,已入派发队列 —— 不能假报"已派任务",如实回"已排队#N"。
          addLocalMessage({ agentId, role: "system", text: tr("org.brief.taskQueued", { id: r.runId.slice(0, 8), position: r.queuePosition ?? 0 }) });
        } else {
          const mode = runType === "quick" ? tr("org.brief.mission.runType.quick") : tr("org.brief.mission.runType.team", { teamMode: tr(TEAM_MODE_KEY[teamMode]) });
          addLocalMessage({ agentId, role: "system", text: tr("org.brief.taskDispatched", { id: r.runId.slice(0, 8), mode, message: r.message }) });
        }
        loadRuns();
      } else {
        // 纯对话:公司 CEO 有独立 id 时直聊该 CEO(人格/记忆随公司),全局 "ceo" 才走默认 /chat。
        const r = agentId !== "ceo" ? await api.chatAgent(agentId, t) : await api.chat(t, companyId);
        addLocalMessage({ agentId, role: "assistant", text: r.reply });
      }
    } catch (e: any) {
      addLocalMessage({ agentId, role: "system", text: tr("cockpit.errorPrefix", { msg: e?.message ?? e }) });
    } finally {
      setPending(false);
    }
  }, [text, pending, runType, teamMode, agentId, companyId, addLocalMessage, loadRuns, tr]);

  return { text, setText, pending, runType, setRunType, teamMode, setTeamMode, send };
}
