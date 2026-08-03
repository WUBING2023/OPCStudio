import { useState, useEffect } from "react";
import { Send, Sparkles, ArrowRight } from "lucide-react";
import * as api from "../api/client.js";
import type { RunType, TeamMode } from "../api/client.js";
import type { Company } from "@opc/shared";
import { useRunStore } from "../store/useRunStore.js";
import { useCockpitStore } from "../store/useCockpitStore.js";
import { useT } from "../i18n.js";
import AutoGrowTextarea from "./common/AutoGrowTextarea.js";
import { announceRunUiState } from "../lib/runUiState.js";

// 小型分段选择器(Run Type / Team Mode 共用)。
function Seg<T extends string>({ value, onChange, opts }: { value: T; onChange: (v: T) => void; opts: Array<{ v: T; label: string; hint: string }> }) {
  return (
    <div className="inline-flex rounded-full bg-surface-2 p-0.5">
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} title={o.hint}
          className={`px-2.5 py-1 rounded-full cursor-pointer border-none transition-colors ${value === o.v ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// 首跑启动台:还没跑过任何 run 时,盖在组织图上的"说出你的目标"主入口。
// 与底部对话栏走同一条启动链路(chatTask + 写入 CEO 会话),一旦有 run 就由 OrgPage 自动隐退、露出团队组织图。

const EXAMPLES = [
  "做一个待办事项网页,能增删改、本地保存",
  "把一份 CSV 销售数据分析成图表小报告",
  "写一个抓取网页标题的 Python 爬虫脚本",
  "做一个个人作品集单页网站",
];

// 选中「AI 研究公司」旗舰模板(id: ai-research-company)时额外露出的研究向示例,
// 呼应其多信息源交叉印证 + 事实核查的团队设计。
const RESEARCH_EXAMPLES = [
  "WebAssembly 相比 asm.js 的主要技术优势是什么,给出 2-3 条可验证依据",
  "某个技术领域的最新进展和主要争议是什么",
];

const FLOW = ["你说目标", "CEO 拆活", "Lead 带队", "员工执行", "自动验收交付"];

export default function LaunchPad({ onPeek, companyId, ceoId }: { onPeek: () => void; companyId?: string; ceoId?: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runType, setRunType] = useState<RunType>("team");
  const [teamMode, setTeamMode] = useState<TeamMode>("balanced");
  const [isResearchCompany, setIsResearchCompany] = useState(false);
  const loadRuns = useRunStore((s) => s.load);
  const addLocalMessage = useCockpitStore((s) => s.addLocalMessage);
  const tr = useT();
  // 本地消息以本公司 CEO 为键(同 BriefingPanel 的 chatCeoId 做法):写死 "ceo" 会让非默认公司
  // (ceoId 形如 "ceo-0-xxxx")的这批消息被简报栏的 CEO 过滤吞掉。
  const chatCeoId = ceoId || "ceo";

  // 当前公司若是从「AI 研究公司」旗舰模板装出来的,额外露出研究向示例(轻量:只查一次公司列表)。
  useEffect(() => {
    if (!companyId) { setIsResearchCompany(false); return; }
    let cancelled = false;
    api.get<Company[]>("/companies")
      .then(list => { if (!cancelled) setIsResearchCompany(list.some(c => c.id === companyId && c.manifestTemplateId === "ai-research-company")); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [companyId]);

  const examples = isResearchCompany ? [...EXAMPLES, ...RESEARCH_EXAMPLES] : EXAMPLES;

  const launch = async () => {
    const t = text.trim();
    if (!t || pending) return;
    setPending(true);
    setErr(null);
    addLocalMessage({ agentId: chatCeoId, role: "user", text: t, source: "chat" });
    try {
      const r = await api.chatTask(t, { runType, teamMode: runType === "team" ? teamMode : undefined, companyId });
      announceRunUiState(r, t, companyId);
      if (r.approvalRequired) {
        // E4 · L3 网关拦下:run 是 pending,不许报"已派任务"——如实提示待审批并通知简报栏拉审批卡。
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }) });
        window.dispatchEvent(new CustomEvent("governance-approval-requested", { detail: { runId: r.runId } }));
      } else if (r.queued) {
        // P1-5:撞上单 run 互斥闸,已入派发队列 —— 如实回"已排队#N",轮到时自动开始。
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.taskQueued", { id: r.runId.slice(0, 8), position: r.queuePosition ?? 0 }) });
      } else {
        addLocalMessage({ agentId: chatCeoId, role: "system", text: `已派任务 · Run #${r.runId.slice(0, 8)} · ${runType === "quick" ? "快速" : "团队/" + teamMode} — ${r.message}` });
      }
      await loadRuns();
      onPeek(); // 立刻隐退,露出正在干活的组织图(run 进行中 task.json 尚未落盘,不能等列表非空)
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setPending(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-6"
      style={{ background: "color-mix(in srgb, var(--color-canvas) 88%, transparent)", backdropFilter: "blur(2px)" }}>
      <div className="w-full max-w-[600px] rounded-2xl border border-hairline bg-surface-1 shadow-xl p-7">
        <div className="flex items-center gap-2 text-accent mb-1">
          <Sparkles size={18} />
          <span className="text-[12px] font-medium tracking-wide">OPC Studio</span>
        </div>
        <h1 className="text-[22px] font-semibold text-ink m-0">你想让团队做什么?</h1>
        <p className="text-[13px] text-ink-muted mt-1.5 mb-3 leading-relaxed">
          说一个目标,CEO 会拆活、组队、执行,最后自动验收交付给你。已经给你配好一支默认团队,直接说就能开工。
        </p>

        {/* 4 步流程,给出心智模型 */}
        <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1 mb-4 text-[12px] text-ink-subtle">
          {FLOW.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={i === 0 ? "text-accent font-medium" : ""}>{s}</span>
              {i < FLOW.length - 1 && <ArrowRight size={11} className="opacity-50" />}
            </span>
          ))}
        </div>

        <div className="flex gap-2 items-end">
          <AutoGrowTextarea
            value={text}
            maxRows={6}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); launch(); } }}
            disabled={pending}
            autoFocus
            placeholder="例如:做一个能记录心情的小日记网页…(Enter 发送,Shift+Enter 换行)"
            className="flex-1 resize-none rounded-xl bg-surface-0 border border-hairline px-3.5 py-3 text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
          />
          <button onClick={launch} disabled={pending || !text.trim()}
            title="派给团队"
            className="btn-primary self-stretch flex items-center justify-center w-12">
            <Send size={16} />
          </button>
        </div>

        {/* 运行方式 / 档位选择器(终结 Quick/Team 入口分裂:显式传 runType/teamMode,不再靠 TASK_RE 猜)*/}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-[12px]">
          <div className="flex items-center gap-1.5">
            <span className="text-ink-subtle">运行方式</span>
            <Seg value={runType} onChange={setRunType} opts={[
              { v: "team", label: "团队", hint: "多 agent,有产物/记忆/验证(推荐)" },
              { v: "quick", label: "快速", hint: "单 agent,1–2 分钟直答" },
            ]} />
          </div>
          {runType === "team" && (
            <div className="flex items-center gap-1.5">
              <span className="text-ink-subtle">档位</span>
              <Seg value={teamMode} onChange={setTeamMode} opts={[
                { v: "economy", label: "经济", hint: "全 deepseek,最省" },
                { v: "balanced", label: "均衡", hint: "Lead/审查用强模型,其余 deepseek(推荐)" },
                { v: "maxQuality", label: "高质", hint: "全强模型,最贵最慢" },
              ]} />
            </div>
          )}
        </div>
        {err && <div className="text-[12px] text-red mt-2">启动失败:{err}</div>}

        {/* 示例目标:点了直接填进输入框 */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {examples.map((ex) => (
            <button key={ex} onClick={() => setText(ex)} disabled={pending}
              className="text-[12px] text-ink-muted border border-hairline rounded-full px-2.5 py-1 bg-surface-0 hover:border-accent hover:text-ink cursor-pointer transition-colors disabled:opacity-50">
              {ex}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mt-5 pt-3 border-t border-hairline">
          <span className="text-[11px] text-ink-subtle">已配好一支团队 · 想自己调整点右下角 ＋ · 也可用下方对话栏</span>
          <button onClick={onPeek}
            className="text-[12px] text-ink-muted hover:text-accent cursor-pointer bg-transparent border-none flex items-center gap-1 shrink-0">
            先看看团队组织 <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
