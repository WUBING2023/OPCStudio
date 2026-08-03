import { create } from "zustand";
import type { CompanyTemplate, TeamTemplate, AgentCard, CommunityIndexEntry, CommunityFavorites, CommunityContentType } from "@opc/shared";
import * as api from "../api/client.js";
import { useAgentStore } from "./useAgentStore.js";

// v3 C2: 导入后让 Org 立即反映新节点（之前导入成功但 Org 不刷新 → 体感"假"）。
async function refreshOrg() {
  try { await useAgentStore.getState().load(); } catch { /* 忽略刷新失败 */ }
}

type SortMode = "popular" | "newest";
type Shelf = "market" | "favorites" | "github";

// GitHub-backed 社区(免登录浏览的远程条目)。type 对齐仓库目录 templates/agents(prompt 模块已下线)。
type RemoteType = "template" | "agent";
interface RemoteEntry {
  type: RemoteType; id: string; title: string;
  author: string | null; authorLogin: string | null; authorUrl: string | null;
  description: string; path: string; stars: number; downloads: number;
}

// content type ↔ community index shelf
const SHELF_OF: Record<CommunityContentType, "templates" | "teams" | "agents"> = {
  company: "templates", team: "teams", worker: "agents",
};

// unsafeAck+rollback 接线:安装成功后把服务端返回的 txId 连同展示信息存本地(localStorage),
// 用户可在「安装记录」里对未撤销的记录一键 rollback。纯前端本地清单(每台设备各存一份),不落服务端。
export interface InstallRecord {
  txId: string;
  name: string;
  agentCount: number;
  mode: "new-company" | "merge";
  at: string; // ISO
  rolledBack?: boolean;
}

const INSTALL_RECORDS_KEY = "opc-install-records";
const MAX_INSTALL_RECORDS = 20;

function loadInstallRecords(): InstallRecord[] {
  try {
    const raw = localStorage.getItem(INSTALL_RECORDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((r): r is InstallRecord => !!r && typeof r.txId === "string") : [];
  } catch { return []; }
}

function persistInstallRecords(records: InstallRecord[]): void {
  try { localStorage.setItem(INSTALL_RECORDS_KEY, JSON.stringify(records.slice(0, MAX_INSTALL_RECORDS))); } catch { /* SSR/隐私模式:忽略 */ }
}

interface CommunityStore {
  templates: CompanyTemplate[];
  teams: TeamTemplate[];
  agentCards: AgentCard[];
  favorites: CommunityFavorites;
  // navigation: shelf (market/favorites) × content type (company/team/worker), mutually exclusive views
  shelf: Shelf;
  contentType: CommunityContentType;
  search: string;
  sort: SortMode;
  loading: boolean;
  loadAll: () => Promise<void>;
  // 令四.1:unsafe 保留改由后端签发的一次性 token 授权(preview 拿 token → 真装带回),替代旧的
  // 客户端布尔 unsafeAcknowledged。带 installConfirmationToken 才启用 unsafe 保留;不带恒走 Safe Install。
  installCompany: (id: string, opts?: { installConfirmationToken?: string; bindingPlans?: unknown[] }) => Promise<{
    companyId: string; ceoId: string | null; agentCount: number;
    missingMcp?: Array<{ name: string; purpose?: string; optional?: boolean }>;
    bundledSkillsInstalled?: number; presetChannelsInstalled?: number;
    txId?: string;
    safeInstall?: { applied: boolean; stripped: Array<{ id: string; detail: string }> };
  }>;
  installTeam: (teamId: string, parentId: string) => Promise<{ added: number; parentId: string }>;
  installWorker: (workerId: string, parentId: string) => Promise<{ added: number; agentId: string; parentId: string }>;
  importTemplate: (id: string) => Promise<void>;
  importTeam: (id: string) => Promise<void>;
  importAgentCard: (id: string) => Promise<void>;
  // 本地 .json 文件导入(客户端已用 CompanyTemplateSchema 校验过):落进本地模板库,复用现成的
  // /community/templates/import + installCompany 落地链路,不是另起一套导入逻辑。
  importLocalTemplate: (template: CompanyTemplate) => Promise<void>;
  toggleFavorite: (type: CommunityContentType, id: string) => Promise<void>;
  isFavorite: (type: CommunityContentType, id: string) => boolean;
  starItem: (type: "templates" | "teams" | "agents", id: string) => Promise<void>;
  shareItem: (type: "template" | "agent" | "prompt", data: unknown, author: string, message: string) => Promise<{ prUrl?: string; needAuth?: boolean; authUrl?: string }>;
  // GitHub 远程社区
  remoteEntries: RemoteEntry[];
  remoteLoading: boolean;
  loadRemote: () => Promise<void>;
  starRemote: (type: RemoteType, id: string, remove?: boolean) => Promise<number | null>;
  markDownloaded: (type: RemoteType, id: string) => Promise<void>;
  deleteRemote: (type: RemoteType, id: string) => Promise<{ prUrl?: string; error?: string }>;
  getRemoteItem: (type: RemoteType, id: string) => Promise<Record<string, unknown>>;
  importRemote: (type: RemoteType, id: string) => Promise<Record<string, unknown>>;
  // unsafeAck+rollback:本地安装记录 + 一键撤销 + 本地库下架。
  installRecords: InstallRecord[];
  recordInstall: (rec: Omit<InstallRecord, "at" | "rolledBack"> & { at?: string }) => void;
  rollbackInstall: (txId: string) => Promise<{ ok?: boolean }>;
  unlistLocal: (type: CommunityContentType, id: string) => Promise<void>;
  setShelf: (s: Shelf) => void;
  setContentType: (t: CommunityContentType) => void;
  setSearch: (s: string) => void;
  setSort: (s: SortMode) => void;
}

export const useCommunityStore = create<CommunityStore>((set, get) => ({
  templates: [],
  teams: [],
  agentCards: [],
  favorites: { company: [], team: [], worker: [] },
  shelf: "github", // 合并后:社区页默认就是 GitHub 社区(市场已并入)
  contentType: "company",
  search: "",
  sort: "popular",
  loading: false,
  installRecords: loadInstallRecords(),

  loadAll: async () => {
    set({ loading: true });
    try {
      const [tIdx, teamIdx, aIdx, favorites] = await Promise.all([
        api.get<CommunityIndexEntry[]>("/community/templates"),
        api.get<CommunityIndexEntry[]>("/community/teams"),
        api.get<CommunityIndexEntry[]>("/community/agents"),
        api.get<CommunityFavorites>("/community/favorites").catch(() => ({ company: [], team: [], worker: [] })),
      ]);
      const [templates, teams, agentCards] = await Promise.all([
        Promise.all(tIdx.map(e => api.get<CompanyTemplate>(`/community/templates/${e.id}`).catch(() => null))),
        Promise.all(teamIdx.map(e => api.get<TeamTemplate>(`/community/teams/${e.id}`).catch(() => null))),
        Promise.all(aIdx.map(e => api.get<AgentCard>(`/community/agents/${e.id}`).catch(() => null))),
      ]);
      set({
        templates: templates.filter(Boolean) as CompanyTemplate[],
        teams: teams.filter(Boolean) as TeamTemplate[],
        agentCards: agentCards.filter(Boolean) as AgentCard[],
        favorites,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  // Install a company template into the org as a NEW company (org mutation).
  // 令四.1:带 installConfirmationToken(preview 阶段后端签发的一次性凭据)才启用 unsafe 保留;
  // 不带则服务端恒走 Safe Install 剥离高危授权。
  installCompany: async (id: string, opts?: { installConfirmationToken?: string; bindingPlans?: unknown[] }) => {
    const r = await api.post<{
      companyId: string; ceoId: string | null; agentCount: number;
      missingMcp?: Array<{ name: string; purpose?: string; optional?: boolean }>;
      bundledSkillsInstalled?: number; presetChannelsInstalled?: number;
      txId?: string;
      safeInstall?: { applied: boolean; stripped: Array<{ id: string; detail: string }> };
    }>("/community/install/company", {
      templateId: id,
      ...(opts?.installConfirmationToken ? { installConfirmationToken: opts.installConfirmationToken } : {}),
      // P0-1:用户确认过的导入绑定计划(map/configure/disable)透传后端落地;不带则模板原样。
      ...(opts?.bindingPlans ? { bindingPlans: opts.bindingPlans } : {}),
    });
    await refreshOrg();
    return r;
  },

  // Install a team/worker under a chosen CEO/Lead (org mutation).
  installTeam: async (teamId, parentId) => {
    const r = await api.post<{ added: number; parentId: string }>("/community/install/team", { teamId, parentId });
    await refreshOrg();
    return r;
  },
  installWorker: async (workerId, parentId) => {
    const r = await api.post<{ added: number; agentId: string; parentId: string }>("/community/install/worker", { workerId, parentId });
    await refreshOrg();
    return r;
  },

  importTemplate: async (id: string) => {
    const t = await api.get<CompanyTemplate>(`/community/templates/${id}`);
    await api.post("/community/templates/import", t);
  },

  importTeam: async (id: string) => {
    const t = await api.get<TeamTemplate>(`/community/teams/${id}`);
    await api.post("/community/teams/import", t);
  },

  importAgentCard: async (id: string) => {
    const a = await api.get<AgentCard>(`/community/agents/${id}`);
    await api.post("/community/agents/import", a);
  },

  importLocalTemplate: async (template: CompanyTemplate) => {
    // __localImport:true 标记这是"用户本地 .json 文件导入"(区别于 importRemote 的远程社区拉取),
    // 服务端据此走本地导入语义;远程导入(importRemote)不加此标记。
    await api.post("/community/templates/import", { ...template, __localImport: true });
    await get().loadAll();
  },

  toggleFavorite: async (type, id) => {
    const { favorited } = await api.post<{ favorited: boolean }>("/community/favorites/toggle", { type, id });
    set(s => {
      const list = new Set(s.favorites[type]);
      if (favorited) list.add(id); else list.delete(id);
      return { favorites: { ...s.favorites, [type]: [...list] } };
    });
  },

  isFavorite: (type, id) => get().favorites[type].includes(id),

  starItem: async (type, id) => {
    await api.post(`/community/${type}/${id}/star`, {});
    if (type === "templates") set(s => ({ templates: s.templates.map(t => t.id === id ? { ...t, stars: t.stars + 1 } : t) }));
    else if (type === "teams") set(s => ({ teams: s.teams.map(t => t.id === id ? { ...t, stars: t.stars + 1 } : t) }));
    else set(s => ({ agentCards: s.agentCards.map(a => a.id === id ? { ...a, stars: a.stars + 1 } : a) }));
  },

  shareItem: async (type, data, author, message) => {
    return api.post<{ prUrl?: string; needAuth?: boolean; authUrl?: string }>(
      "/community/share", { type, data, author, message }
    );
  },

  remoteEntries: [],
  remoteLoading: false,
  loadRemote: async () => {
    set({ remoteLoading: true });
    try {
      const r = await api.get<{ entries: RemoteEntry[] }>("/community/remote");
      set({ remoteEntries: r.entries || [], remoteLoading: false });
    } catch { set({ remoteEntries: [], remoteLoading: false }); }
  },
  starRemote: async (type, id, remove = false) => {
    // 乐观采用 POST 返回的 count(可靠;避免亚秒传播延迟)。remove=true 取消收藏(删自己的 reaction,计数 -1)。
    const r = await api.post<{ ok?: boolean; stars?: number | null }>("/community/star", { type, id, remove });
    const stars = typeof r.stars === "number" ? r.stars : null;
    if (stars != null) set(s => ({ remoteEntries: s.remoteEntries.map(e => e.type === type && e.id === id ? { ...e, stars } : e) }));
    return stars;
  },
  deleteRemote: async (type, id) => {
    try { return await api.post<{ prUrl?: string }>("/community/remote/delete", { type, id }); }
    catch (e: unknown) { return { error: (e as Error)?.message || "删除失败" }; }
  },
  markDownloaded: async (type, id) => {
    // 安装后打一下下载计数(🚀 reaction),尽力而为,失败不影响安装。
    try {
      const r = await api.post<{ counted?: boolean; downloads?: number | null }>("/community/download", { type, id });
      if (typeof r.downloads === "number") set(s => ({ remoteEntries: s.remoteEntries.map(e => e.type === type && e.id === id ? { ...e, downloads: r.downloads as number } : e) }));
    } catch { /* best effort */ }
  },
  getRemoteItem: async (type, id) => {
    const r = await api.get<{ data: Record<string, unknown> }>(`/community/remote/item?type=${type}&id=${encodeURIComponent(id)}`);
    return r.data;
  },
  importRemote: async (type, id) => {
    const data = await get().getRemoteItem(type, id);
    if (type === "template") await api.post("/community/templates/import", data);
    else if (type === "agent") await api.post("/community/agents/import", data);
    else throw new Error("prompt 暂不支持导入到本地");
    await get().loadAll();
    return data; // 返回已取数据,调用方(agent 安装)复用,省掉重复 GET
  },

  recordInstall: (rec) => {
    const full: InstallRecord = { ...rec, at: rec.at ?? new Date().toISOString() };
    set(s => {
      const next = [full, ...s.installRecords.filter(r => r.txId !== full.txId)].slice(0, MAX_INSTALL_RECORDS);
      persistInstallRecords(next);
      return { installRecords: next };
    });
  },

  rollbackInstall: async (txId) => {
    // 服务端 POST /community/install/:txId/rollback:409=已撤销、404=找不到、其它 4xx 带人话 error 文案。
    const r = await api.post<{ ok?: boolean }>(`/community/install/${encodeURIComponent(txId)}/rollback`, {});
    set(s => {
      const next = s.installRecords.map(rec => rec.txId === txId ? { ...rec, rolledBack: true } : rec);
      persistInstallRecords(next);
      return { installRecords: next };
    });
    await refreshOrg();
    return r;
  },

  unlistLocal: async (type, id) => {
    // 本地库下架:只标 visibility:"unlisted"(不删文件),服务端列表默认过滤掉 → 重新 loadAll 即从视图消失。
    await api.post(`/community/local/${SHELF_OF[type]}/${encodeURIComponent(id)}/unlist`, {});
    await get().loadAll();
  },

  setShelf: (shelf) => set({ shelf }),
  setContentType: (contentType) => set({ contentType, search: "" }),
  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
}));

export { SHELF_OF };
export type { Shelf, RemoteType, RemoteEntry };
