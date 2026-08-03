import { useState, useCallback, useEffect, useMemo } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Send } from "lucide-react";
import type { TraceEvent } from "@opc/shared";
import { useAgentStore } from "../store/useAgentStore.js";
import { useCockpitStore } from "../store/useCockpitStore.js";
import { useT } from "../i18n.js";
import * as api from "../api/client.js";
import HelpTip from "../components/HelpTip.js";
import AgentRail from "../components/cockpit/AgentRail.js";
import ChatThread from "../components/cockpit/ChatThread.js";
import MonitorPanel from "../components/cockpit/MonitorPanel.js";
import AutoGrowTextarea from "../components/common/AutoGrowTextarea.js";
import CeoCockpit, { useCeoStatus } from "../components/common/CeoCockpit.js";
import PostmortemModal, { type PostmortemData } from "../components/common/PostmortemModal.js";
import { TASK_RE } from "../lib/taskHeuristic.js";
import { isBusyStatus } from "../lib/agentMeta.js";
import { DEFAULT_COMPANY, type GroupSelection } from "../lib/cockpitGroups.js";
import { announceRunUiState } from "../lib/runUiState.js";
import WorkbenchOverview from "../features/runs/components/WorkbenchOverview.js";

// react-resizable-panels v4:Group(orientation) + Panel(defaultSize/minSize) + Separator(可拖拽分隔条)。
function VSep() {
  return <Separator className="w-1 shrink-0 bg-hairline hover:bg-ink-subtle transition-colors" />;
}

export default function CockpitPage({ routeCompanyId, routeRunId, routeAgentId }: {
  routeCompanyId?: string;
  routeRunId?: string;
  routeAgentId?: string;
}) {
  const tr = useT();
  // C3 项目群:群选中态是本页临时视图状态(不进 useCockpitStore 持久化)——选群与选人互斥,
  // 互斥逻辑在 AgentRail(selectGroup 清空选人 / selectAgent 清空选群)。
  const [activeGroup, setActiveGroup] = useState<GroupSelection | null>(null);

  // E3 · CEO 驾驶舱贯穿工作台:与组织页简报栏同源(共享 common/CeoCockpit)。companyId 取当前选中
  // 员工所属公司,未选/无归属则默认公司(与 BriefingPanel 同口径);数据由 useCeoStatus 钩子自足管理。
  const agents = useAgentStore((s) => s.agents);
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const setActiveAgent = useCockpitStore((s) => s.setActiveAgent);
  const companyFilter = useCockpitStore((s) => s.companyFilter);
  const setCompanyFilter = useCockpitStore((s) => s.setCompanyFilter);
  const routeScope = routeCompanyId || (companyFilter !== "all" ? companyFilter : DEFAULT_COMPANY);
  const globalView = routeScope === "all";
  const companyId = useMemo(() => {
    const a = agents.find((x) => x.id === activeAgentId);
    return a?.companyId || (globalView ? DEFAULT_COMPANY : routeScope);
  }, [agents, activeAgentId, globalView, routeScope]);
  useEffect(() => {
    const nextCompany = routeCompanyId || DEFAULT_COMPANY;
    setCompanyFilter(nextCompany);
    const selected = agents.find((agent) => agent.id === activeAgentId);
    if (selected && (nextCompany === "all" || (selected.companyId || DEFAULT_COMPANY) !== nextCompany)) setActiveAgent(null);
  }, [routeCompanyId, agents, activeAgentId, setActiveAgent, setCompanyFilter]);
  useEffect(() => {
    if (!routeAgentId) return;
    const selected = agents.find((agent) => agent.id === routeAgentId);
    if (selected && (selected.companyId || DEFAULT_COMPANY) === companyId) setActiveAgent(routeAgentId);
  }, [routeAgentId, agents, companyId, setActiveAgent]);
  const ceo = useCeoStatus(companyId);
  const workingAgents = useMemo(
    () => agents.filter((a) => (a.companyId || DEFAULT_COMPANY) === companyId && isBusyStatus(a.status)),
    [agents, companyId],
  );
  // 默认折叠,localStorage 记忆开合(工作台以聊天区为主,驾驶舱是可选的一眼概览,不挤压聊天)。
  const [ceoOpen, setCeoOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("opc-cockpit-ceo-open") === "1"; } catch { return false; }
  });
  const toggleCeo = useCallback(() => {
    setCeoOpen((o) => {
      const next = !o;
      try { localStorage.setItem("opc-cockpit-ceo-open", next ? "1" : "0"); } catch { /* 隐私模式写失败忽略 */ }
      return next;
    });
  }, []);
  // 最近失败卡「查看复盘」:与 BriefingPanel 同法——可用则拉端点弹本页 PostmortemModal,否则跳任务档案。
  const [pmModal, setPmModal] = useState<PostmortemData | null>(null);
  const viewFailure = useCallback((f: { runId: string; postmortemAvailable: boolean }) => {
    const openRun = () => window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId: f.runId } }));
    if (!f.postmortemAvailable) { openRun(); return; }
    api.get<PostmortemData>(`/runs/${f.runId}/postmortem`)
      .then((pm) => { if (pm?.available) setPmModal(pm); else openRun(); })
      .catch(openRun);
  }, []);
  // 打开工作台时拉回"最新 run"的历史事件,让监视台/聊天能看到刷新前/此前发生的活动(否则只看得到实时片段)。
  useEffect(() => {
    api.get<{ runId: string | null; events: TraceEvent[] }>("/runs/latest/events")
      .then((r) => { if (r.runId) useAgentStore.getState().mergeRunHistory(r.runId, r.events); })
      .catch(() => { /* ignore */ });
  }, []);
  // 从群聊成员头像菜单「进入对话」/ org 页右键「在工作台查看」跳来时,清空群选中回到该员工 1:1
  // (activeAgentId 由 App.tsx 的 cockpit-open-agent 监听设置;群与单聊互斥,群选中态只在本页)。
  useEffect(() => {
    const clearGroup = () => setActiveGroup(null);
    window.addEventListener("cockpit-open-agent", clearGroup);
    return () => window.removeEventListener("cockpit-open-agent", clearGroup);
  }, []);
  return (
    <Group orientation="horizontal" className="h-full w-full">
      <Panel defaultSize="20%" minSize="12%" maxSize="36%"><AgentRail activeGroup={activeGroup} onSelectGroup={setActiveGroup} initialCompanyId={globalView ? "all" : companyId} /></Panel>
      <VSep />
      <Panel defaultSize="80%" minSize="40%">
        <div className="h-full w-full flex flex-col">
          <div className="flex-1 min-h-0">
            {!activeAgentId && !activeGroup ? (
              <WorkbenchOverview companyId={globalView ? "all" : companyId} routeRunId={routeRunId} />
            ) : (
              <Group orientation="horizontal" className="h-full w-full">
                <Panel defaultSize="52%" minSize="25%"><ChatThread group={activeGroup} /></Panel>
                <VSep />
                <Panel defaultSize="48%" minSize="25%"><MonitorPanel /></Panel>
              </Group>
            )}
          </div>
          {!globalView && <InputBar companyId={companyId} />}
        </div>
      </Panel>
    </Group>
  );
}

function InputBar({ companyId }: { companyId: string }) {
  const tr = useT();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const activeRunContext = useCockpitStore((s) => s.activeRunContext);
  const addLocalMessage = useCockpitStore((s) => s.addLocalMessage);
  const agents = useAgentStore((s) => s.agents);
  const active = agents.find((a) => a.id === activeAgentId);
  const isCeo = !active || active.role === "ceo";
  const targetId = activeAgentId || "ceo";
  const taskInstructionMode = !isCeo && activeRunContext !== null;
  const taskInstructionOpen = taskInstructionMode && activeRunContext.status === "running";
  const inputBlocked = pending || (taskInstructionMode && !taskInstructionOpen);

  // 复制/拖入文件 → 把"文件路径"插进输入作为上下文(Electron 的 File.path;浏览器无 path 时退回文件名)。
  const insertFiles = (files: FileList | null | undefined) => {
    if (!files?.length) return false;
    const items = Array.from(files).map((f) => (f as any).path || tr("cockpit.filePlaceholder", { name: f.name }));
    if (!items.length) return false;
    setText((t) => (t ? t + " " : "") + items.join(" "));
    return true;
  };
  const onPaste = (e: React.ClipboardEvent) => { if (e.clipboardData?.files?.length && insertFiles(e.clipboardData.files)) e.preventDefault(); };
  const onDrop = (e: React.DragEvent) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); insertFiles(e.dataTransfer.files); } };

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || inputBlocked) return;
    const runId = taskInstructionOpen ? activeRunContext?.runId : undefined;
    addLocalMessage({ agentId: targetId, runId, role: "user", text: t, source: "chat" });
    setText("");
    setPending(true);
    try {
      if (!isCeo && taskInstructionOpen && activeRunContext) {
        const result = await api.post<{ ok: boolean; message: string; messageId?: string }>(
          "/runs/" + encodeURIComponent(activeRunContext.runId) + "/agents/" + encodeURIComponent(targetId) + "/instruction",
          { text: t },
        );
        addLocalMessage({
          agentId: targetId,
          runId: activeRunContext.runId,
          role: "system",
          text: tr("cockpit.taskInstruction.accepted", { message: result.message }),
        });
      } else if (!isCeo) {
        // 日常对话保留持久线程;选中运行中任务时则走上面的可审计 A2A 收件箱。
        const r = await api.chatAgent(targetId, t);
        addLocalMessage({ agentId: targetId, role: "assistant", text: r.reply });
      } else if (TASK_RE.test(t)) {
        const r = await api.chatTask(t, { companyId });
        announceRunUiState(r, t, companyId);
        if (r.approvalRequired) {
          // E4 · L3 网关拦下:run 是 pending,不许报"已派任务"——如实提示待审批并通知简报栏拉审批卡。
          addLocalMessage({ agentId: targetId, role: "system", text: tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }) });
          window.dispatchEvent(new CustomEvent("governance-approval-requested", { detail: { runId: r.runId } }));
        } else if (r.queued) {
          // P1-5:撞上单 run 互斥闸,已入派发队列 —— 如实回"已排队#N"。
          addLocalMessage({ agentId: targetId, role: "system", text: tr("org.brief.taskQueued", { id: r.runId.slice(0, 8), position: r.queuePosition ?? 0 }) });
        } else {
          addLocalMessage({ agentId: targetId, role: "system", text: tr("cockpit.taskDispatched", { id: r.runId.slice(0, 8), message: r.message }) });
        }
      } else {
        const r = await api.chat(t);
        addLocalMessage({ agentId: targetId, role: "assistant", text: r.reply });
      }
    } catch (e: any) {
      addLocalMessage({ agentId: targetId, runId: taskInstructionOpen ? activeRunContext?.runId : undefined, role: "system", text: tr("cockpit.errorPrefix", { msg: e?.message ?? e }) });
    } finally {
      setPending(false);
    }
  }, [text, inputBlocked, taskInstructionOpen, activeRunContext, targetId, isCeo, companyId, addLocalMessage, tr]);

  return (
    <div className="flex flex-col bg-surface-1 border-t border-hairline shrink-0">
      <div className="px-3 pt-2 flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-ink-muted">
          {isCeo
            ? tr("cockpit.talkToCeo")
            : taskInstructionMode
              ? tr("cockpit.taskInstruction.mode", { name: active?.name ?? "", task: activeRunContext?.goal ?? "" })
              : tr("cockpit.talkToAgent", { name: active?.name ?? "" })}
        </span>
        {!isCeo && <HelpTip text={taskInstructionMode ? tr("cockpit.taskInstruction.hint") : tr("cockpit.chatModeHint")} />}
      </div>
      <div className="flex gap-2 p-3 items-end">
        <AutoGrowTextarea
          value={text}
          maxRows={6}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          disabled={inputBlocked}
          placeholder={pending
            ? tr("cockpit.inputPlaceholderPending")
            : taskInstructionMode
              ? (taskInstructionOpen ? tr("cockpit.taskInstruction.placeholder") : tr("cockpit.taskInstruction.ended"))
              : tr("cockpit.inputPlaceholderIdle")}
          className="flex-1 resize-none rounded-lg bg-surface-0 border border-hairline px-3 py-2 text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
        />
        <button
          onClick={send}
          disabled={inputBlocked || !text.trim()}
          className="self-end flex items-center gap-1.5 px-3.5 py-2 cursor-pointer text-[13px] font-medium btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Send size={14} /> {tr("cockpit.send")}
        </button>
      </div>
    </div>
  );
}
