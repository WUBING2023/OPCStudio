import { create } from "zustand";
import type { AgentNodeConfig, TraceEvent } from "@opc/shared";
import * as api from "../api/client.js";

interface AgentStore {
  agents: AgentNodeConfig[];
  selectedId: string | null;
  events: TraceEvent[];
  outputChunks: Record<string, string>; // Phase 3:agentId → 累积原始 CLI 输出(流式 tail,独立于结构化事件)
  loadedHistoryRuns: string[];           // 已合并过历史的 runId(防重复累积)
  loading: boolean;
  load: () => Promise<void>;
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<AgentNodeConfig>) => Promise<void>;
  addEvent: (e: TraceEvent) => void;
  mergeRunHistory: (runId: string, events: TraceEvent[]) => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  agents: [],
  selectedId: null,
  events: [],
  outputChunks: {},
  loadedHistoryRuns: [],
  loading: false,
  load: async () => {
    set({ loading: true });
    const agents = await api.get<AgentNodeConfig[]>("/agents");
    // 后端没有单个 agent 的硬删除接口,"删除"走 enabled:false 软删——加载时把它们从可见列表里剔除,
    // 否则刷新/重开工作台会把已删除的 agent 又拉回来。
    set({ agents: agents.filter(a => a.enabled !== false), loading: false });
  },
  select: (id) => set({ selectedId: id }),
  update: async (id, patch) => {
    const updated = await api.patch<AgentNodeConfig>(`/agents/${id}`, patch);
    set(s => {
      if (updated.enabled === false) return { agents: s.agents.filter(a => a.id !== id) };
      return s.agents.some(a => a.id === id)
        ? { agents: s.agents.map(a => a.id === id ? updated : a) }
        : { agents: [...s.agents, updated] };
    });
  },
  // Phase 3:流式原始输出分片单独累积到 outputChunks(末尾 100KB 上限),不挤占结构化事件缓冲。
  // 同时把该事件的 runId 标记为"已见"——避免历史回放又把它当历史重复合并。
  // addEvent 只由 App.tsx 的 EventSource(实时 SSE)调用;历史回放走 mergeRunHistory,后者绝不回写
  // agents——否则陈年 run 的 working/failed 会覆盖当前真实状态。
  addEvent: (e) => set(s => {
    const loaded = e.runId && !s.loadedHistoryRuns.includes(e.runId)
      ? [...s.loadedHistoryRuns, e.runId] : s.loadedHistoryRuns;
    if (e.type === "agent_output_chunk" && e.agentId) {
      // B7:模型思考流(<think> 剥离后以 thinking:true 单独 emit)不进画布气泡——不泄漏给用户。
      const p = e.payload as { chunk?: string; thinking?: boolean } | undefined;
      if (p?.thinking === true) return { loadedHistoryRuns: loaded } as Partial<AgentStore>;
      const chunk = p?.chunk ?? "";
      const next = ((s.outputChunks[e.agentId] ?? "") + chunk).slice(-100_000);
      return { outputChunks: { ...s.outputChunks, [e.agentId]: next }, loadedHistoryRuns: loaded } as Partial<AgentStore>;
    }
    const next: Partial<AgentStore> = { events: [...s.events.slice(-300), e], loadedHistoryRuns: loaded };
    // run 进行期间组织图/简报栏的实时状态视觉(工作脉冲/活动气泡/绿色流光/失败红闪)全靠这条回写——
    // 服务端 setAgentStatus 每次状态迁移都 emit agent_status_changed,这里按 agentId 合并进 agents,
    // 语义与服务端一致:currentTask 仅在 payload 显式携带时覆盖(undefined 保留旧值)。
    if (e.type === "agent_status_changed" && e.agentId) {
      const p = (e.payload ?? {}) as { status?: AgentNodeConfig["status"]; currentTask?: string };
      if (p.status && s.agents.some(a => a.id === e.agentId)) {
        next.agents = s.agents.map(a => a.id === e.agentId
          ? { ...a, status: p.status!, ...(p.currentTask !== undefined ? { currentTask: p.currentTask } : {}) }
          : a);
      }
    }
    return next;
  }),
  // Phase 3 历史回放:把某 run 的历史事件(从 /api/runs/:id/events 拉)合并进 store,使刷新/迟到打开工作台后
  // 仍能看到此前的活动。每 run 只合并一次(guard);chunk → outputChunks,其余 → events,按时间排序。
  mergeRunHistory: (runId, evts) => set(s => {
    if (!runId || s.loadedHistoryRuns.includes(runId)) return {} as Partial<AgentStore>;
    const seen = new Set(s.events.map(e => e.id));
    const add: TraceEvent[] = [];
    const oc = { ...s.outputChunks };
    let ocChanged = false;
    for (const e of evts) {
      if (e.type === "agent_output_chunk" && e.agentId) {
        const p = e.payload as { chunk?: string; thinking?: boolean } | undefined;
        if (p?.thinking === true) continue;
        oc[e.agentId] = ((oc[e.agentId] ?? "") + (p?.chunk ?? "")).slice(-100_000);
        ocChanged = true;
      } else if (e.id && !seen.has(e.id)) { add.push(e); seen.add(e.id); }
    }
    const merged = [...s.events, ...add].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || "")).slice(-500);
    return { events: merged, loadedHistoryRuns: [...s.loadedHistoryRuns, runId], ...(ocChanged ? { outputChunks: oc } : {}) } as Partial<AgentStore>;
  }),
}));
