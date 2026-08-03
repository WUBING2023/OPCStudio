import { create } from "zustand";

// 工作台(微信式 cockpit)状态:当前选中会话(=某 agent)、本地消息、公司筛选、置顶会话。
// 公司筛选 + 置顶 持久化到 localStorage(刷新保留)。
export interface LocalMsg {
  id: string;
  agentId: string;              // 归属会话(agentId;"ceo" 表示与 CEO/公司对话)
  runId?: string;               // 任务上下文;缺省表示普通 1:1 对话
  role: "user" | "assistant" | "system";
  text: string;
  ts: string;                   // ISO 时间
  source?: "chat" | "terminal"; // terminal=从底部终端镜像进来
}

interface CockpitStore {
  activeAgentId: string | null;
  setActiveAgent: (id: string | null) => void;
  activeRunContext: { runId: string; goal: string; status: string } | null;
  setActiveRunContext: (run: { runId: string; goal: string; status: string } | null) => void;
  localMessages: LocalMsg[];
  addLocalMessage: (m: Omit<LocalMsg, "id" | "ts"> & { ts?: string }) => void;
  // 服务端线程注水:打开会话时把持久化的历史 turn 灌进本地消息(每个 agentId 一次,幂等去重),
  // 使刷新页面/换设备仍能看回此前对话——本地 state 只是投影,真相在服务端 chatThreadStore。
  hydratedAgentIds: string[];
  hydrateThread: (agentId: string, turns: { role: "user" | "assistant"; content: string; at: string }[]) => void;
  companyFilter: string;                 // "all" | companyId —— 工作台员工栏按公司筛选
  setCompanyFilter: (c: string) => void;
  pinnedIds: string[];                   // 置顶的会话(agentId),排在员工栏最上
  togglePin: (id: string) => void;
}

function genId(): string {
  try { return crypto.randomUUID(); } catch { return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}
const PIN_KEY = "opc-cockpit-pinned";
const FILTER_KEY = "opc-cockpit-company";
function lsGet(k: string, d: string): string { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function loadPinned(): string[] { try { return JSON.parse(lsGet(PIN_KEY, "[]")); } catch { return []; } }

export const useCockpitStore = create<CockpitStore>((set) => ({
  activeAgentId: null,
  setActiveAgent: (id) => set({ activeAgentId: id, activeRunContext: null }),
  activeRunContext: null,
  setActiveRunContext: (activeRunContext) => set({ activeRunContext }),
  localMessages: [],
  addLocalMessage: (m) =>
    set((s) => ({
      localMessages: [...s.localMessages.slice(-400), { ...m, id: genId(), ts: m.ts ?? new Date().toISOString() }],
    })),
  hydratedAgentIds: [],
  hydrateThread: (agentId, turns) =>
    set((s) => {
      if (s.hydratedAgentIds.includes(agentId)) return s; // 每会话每 agent 只注水一次,不与在途消息打架
      // 去重:已在本地(乐观追加/终端镜像)的同 role+文本不重复灌入。ChatThread 按 ts 排序渲染,
      // 故注水顺序无所谓——这里直接前插。
      const existing = new Set(
        s.localMessages.filter((m) => m.agentId === agentId).map((m) => `${m.role}\u0000${m.text}`),
      );
      const seeded: LocalMsg[] = turns
        .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
        .filter((t) => !existing.has(`${t.role}\u0000${t.content}`))
        .map((t) => ({ id: genId(), agentId, role: t.role, text: t.content, ts: t.at || new Date().toISOString() }));
      return {
        hydratedAgentIds: [...s.hydratedAgentIds, agentId],
        localMessages: seeded.length ? [...seeded, ...s.localMessages].slice(-400) : s.localMessages,
      };
    }),
  companyFilter: lsGet(FILTER_KEY, "all"),
  setCompanyFilter: (c) => { lsSet(FILTER_KEY, c); set({ companyFilter: c }); },
  pinnedIds: loadPinned(),
  togglePin: (id) => set((s) => {
    const next = s.pinnedIds.includes(id) ? s.pinnedIds.filter((x) => x !== id) : [...s.pinnedIds, id];
    lsSet(PIN_KEY, JSON.stringify(next));
    return { pinnedIds: next };
  }),
}));
