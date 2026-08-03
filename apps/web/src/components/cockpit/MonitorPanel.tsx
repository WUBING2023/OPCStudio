import { useMemo, useRef, useEffect, useState } from "react";
import { Activity, FolderOpen } from "lucide-react";
import type { Company, TraceEvent } from "@opc/shared";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useCockpitStore } from "../../store/useCockpitStore.js";
import { useT } from "../../i18n.js";
import * as api from "../../api/client.js";
import FileExplorer from "./FileExplorer.js";
import FileViewer from "./FileViewer.js";

// 右上监视工作台。两个 tab:
//  「监视」= 当前 agent 的全部活动事件(工具调用/模型调用/info/error/消息),log 式密集视图。
//           (Phase 3 将把它升级为实时流式原始 CLI 输出 + 历史回放。)
//  「文件」= 文件管理器:浏览并打开 md/代码/pdf/图片(产物)。
// 注:原第三个 tab「报告」(ReportsBrowser)已下架——报告浏览能力并入「任务」页
// (任务卡→详情→结果,见 TracePage/ResultSection),不再在工作台重复一份入口。
export default function MonitorPanel() {
  const tr = useT();
  const [tab, setTab] = useState<"monitor" | "files">("monitor");
  const [open, setOpen] = useState<{ path: string; ext: string } | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState(".");
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const activeAgent = useAgentStore((s) => s.agents.find((agent) => agent.id === activeAgentId));
  const canBrowseWorkFiles = Boolean(activeAgent);

  useEffect(() => {
    if (!activeAgent) {
      setWorkspaceRoot(".");
      return;
    }
    let alive = true;
    api.get<Company[]>("/companies")
      .then((companies) => {
        if (!alive) return;
        const company = companies.find((item) => item.id === (activeAgent.companyId || "default"));
        setWorkspaceRoot(company?.folder?.trim() || ".");
      })
      .catch(() => { if (alive) setWorkspaceRoot("."); });
    return () => { alive = false; };
  }, [activeAgent?.companyId, activeAgent?.id]);

  useEffect(() => {
    if (!canBrowseWorkFiles && tab === "files") {
      setTab("monitor");
      setOpen(null);
    }
  }, [canBrowseWorkFiles, tab]);

  return (
    <div className="h-full flex flex-col bg-surface-1 min-w-0">
      <div className="h-10 flex items-center gap-1 px-2 border-b border-hairline shrink-0">
        <TabBtn icon={<Activity size={13} />} label={tr("cockpit.tabMonitor")} active={tab === "monitor"} onClick={() => setTab("monitor")} />
        {canBrowseWorkFiles && (
          <TabBtn
            icon={<FolderOpen size={13} />}
            label={tr("cockpit.tabWorkFiles")}
            title={tr("cockpit.workFilesTip")}
            active={tab === "files"}
            onClick={() => setTab("files")}
          />
        )}
      </div>
      {tab === "monitor" ? (
        <MonitorLog />
      ) : (
        <div className="flex-1 flex min-h-0">
          <div className="w-1/2 border-r border-hairline min-w-0"><FileExplorer root={workspaceRoot} onOpen={(path, ext) => setOpen({ path, ext })} /></div>
          <div className="flex-1 min-w-0">
            {open ? <FileViewer path={open.path} ext={open.ext} /> : <div className="h-full flex items-center justify-center px-4 text-center text-ink-subtle text-[12px]">{tr("cockpit.selectWorkFileToView")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
function TabBtn({ icon, label, title, active, onClick }: { icon: React.ReactNode; label: string; title?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={title}
      className={`flex items-center gap-1.5 px-2.5 h-7 rounded-full border-none cursor-pointer text-[12px] transition-colors ${
        active ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink"
      }`}>
      {icon}{label}
    </button>
  );
}

const COLORS: Record<string, string> = {
  tool_call: "#89b4fa", tool_result: "#a6e3a1", model_call_started: "#9aa0c0",
  model_call_finished: "#9aa0c0", agent_message: "#c0caf5", agent_status_changed: "#e0af68",
  info: "#7c8aff", error: "#c9615c", run_started: "#a6e3a1", run_finished: "#a6e3a1",
};

type TFn = (key: string, params?: Record<string, string | number>) => string;
function lineFor(e: TraceEvent, tr: TFn): string {
  const p = e.payload as any;
  switch (e.type) {
    case "tool_call": return `⚙ ${p?.name}(${p?.args ? JSON.stringify(p.args).slice(0, 80) : ""})`;
    case "tool_result": return `↳ ${p?.name ?? "tool"} → ${String(p?.result ?? "").slice(0, 120)}`;
    case "model_call_started": return tr("cockpit.callingModel", { provider: p?.provider ?? "", model: p?.model ?? "" });
    case "agent_message": return `✉ ${String(p?.text ?? "").slice(0, 120)}`;
    case "agent_status_changed": return `● ${p?.status ?? ""}${p?.currentTask ? `: ${String(p.currentTask).slice(0, 60)}` : ""}`;
    case "error": return `⚠ ${String(p?.message ?? "error")}`;
    case "info": return p?.message ? String(p.message) : (p?.injectedSkills || p?.injectedMemory ? tr("cockpit.injectedSkillMemory") : JSON.stringify(p).slice(0, 100));
    default: return `${e.type} ${JSON.stringify(p).slice(0, 80)}`;
  }
}

function MonitorLog() {
  const tr = useT();
  const events = useAgentStore((s) => s.events);
  const outputChunks = useAgentStore((s) => s.outputChunks);
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const endRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => events.filter((e) => e.agentId === activeAgentId), [events, activeAgentId]);
  const errorCount = useMemo(() => lines.filter((e) => e.type === "error").length, [lines]);
  const raw = activeAgentId ? (outputChunks[activeAgentId] ?? "") : "";
  useEffect(() => { endRef.current?.scrollIntoView(); }, [lines.length, raw.length]);

  if (!activeAgentId) return <div className="flex-1 flex items-center justify-center text-ink-subtle text-[12px]">{tr("cockpit.selectStaffOutputHint")}</div>;
  return (
    <div className="cockpit-monitor flex-1 overflow-y-auto p-2 text-xs leading-relaxed" style={{ background: "#16161e", fontFamily: "var(--font-sans)" }}>
      {errorCount > 0 && (
        <div className="sticky top-0 z-10 mb-1.5 flex items-center gap-1.5 rounded px-2 py-1 text-[11px]"
          style={{ background: "rgba(247,118,142,0.16)", color: "#c9615c", border: "1px solid rgba(247,118,142,0.35)" }}>
          {tr("cockpit.errorBannerHint", { n: errorCount })}
        </div>
      )}
      {lines.length === 0 && !raw ? (
        <div className="text-ink-subtle p-2">{tr("cockpit.noActivityHint")}</div>
      ) : (
        <>
          {lines.map((e) => {
            const isErr = e.type === "error";
            return (
            <div key={e.id} className="whitespace-pre-wrap break-words"
              style={{ color: COLORS[e.type] ?? "#9aa0c0",
                ...(isErr ? { background: "rgba(247,118,142,0.12)", borderLeft: "2px solid #c9615c", paddingLeft: 6, marginTop: 1, marginBottom: 1, borderRadius: 2 } : {}) }}>
              <span style={{ opacity: 0.5 }}>{new Date(e.timestamp).toLocaleTimeString("zh-CN", { hour12: false })} </span>
              {lineFor(e, tr)}
            </div>
            );
          })}
          {raw && (
            <>
              <div className="mt-2 mb-1 text-[10px]" style={{ color: "#565f89" }}>{tr("cockpit.rawOutputHeader")}</div>
              <pre className="whitespace-pre-wrap break-words m-0" style={{ color: "#c0caf5", fontFamily: "var(--font-sans)" }}>{raw}</pre>
            </>
          )}
        </>
      )}
      <div ref={endRef} />
    </div>
  );
}
