import { useState, useEffect, useMemo, useRef } from "react";
import { Search, Star, Building2, Users, User, Store, LogIn, Globe, Sparkles, Wrench, Trophy, Upload, History, RotateCcw, EyeOff } from "lucide-react";
import * as api from "../api/client.js";
import { useCommunityStore, type RemoteEntry } from "../store/useCommunityStore.js";
import { useAgentStore } from "../store/useAgentStore.js";
import RemoteCommunity from "../components/RemoteCommunity.js";
import HelpTip from "../components/HelpTip.js";
import { useT } from "../i18n.js";
import { CompanyTemplateSchema, bundleToTemplateShape, type CompanyTemplate, type CompanyBundle, type TeamTemplate, type AgentCard, type CommunityContentType } from "@opc/shared";
import CompanyTemplateCard from "../components/CompanyTemplateCard.js";
import TeamCard from "../components/TeamCard.js";
import AgentCardView from "../components/AgentCardView.js";
import TemplateDetailModal from "../components/TemplateDetailModal.js";
import AgentDetailModal from "../components/AgentDetailModal.js";
import ImportConfirmDialog, {
  type TemplateImportCheck, type InstallMode, type MergeStrategiesInput, DEFAULT_MERGE_STRATEGIES,
  type MergeConflictCounts, type InstallPreviewSummaryView, type TeamDuplicationResolution, type OrgParentResolution,
  type BindingPlanView,
} from "../components/ImportConfirmDialog.js";
import ImportToOrgDialog from "../components/ImportToOrgDialog.js";
import TemplateWorkshop from "../components/community/TemplateWorkshop.js";
import Leaderboard from "../components/community/Leaderboard.js";
import InstallResultModal, { type McpMissingItem } from "../components/community/InstallResultModal.js";
import LocalImportErrorModal from "../components/community/LocalImportErrorModal.js";

// 本地文件导入单个错误列表上限——手写/损坏的大 manifest(agents 多、字段多)可能一次炸出几百条
// zod issue,超量只会淹没真正有用的头几条,截断 + 汇总剩余数量。
const LOCAL_IMPORT_MAX_ISSUES = 30;

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error("file read failed"));
    reader.readAsText(file);
  });
}

interface ShareForm {
  type: "template" | "agent" | "prompt";
  title: string;
  description: string;
  tags: string;
  author: string;
}

type ImportTarget =
  | { type: "template"; item: CompanyTemplate }
  | { type: "team"; item: TeamTemplate }
  | { type: "agent"; item: AgentCard };

const TYPES: { key: CommunityContentType; labelKey: string; icon: typeof Building2 }[] = [
  { key: "company", labelKey: "c.company", icon: Building2 },
  { key: "team", labelKey: "c.team", icon: Users },
  { key: "worker", labelKey: "c.worker", icon: User },
];

// common shape for filtering/sorting across the three content types
interface Listable { id: string; title: string; description: string; author: string; createdAt: string; stars: number; }

export default function CommunityPage() {
  const store = useCommunityStore();
  const tr = useT();
  const [selectedTemplate, setSelectedTemplate] = useState<CompanyTemplate | null>(null);
  const [selectedCard, setSelectedCard] = useState<AgentCard | null>(null);
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [shareForm, setShareForm] = useState<ShareForm>({ type: "template", title: "", description: "", tags: "", author: "" });
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ prUrl?: string; needAuth?: boolean; authUrl?: string; error?: string } | null>(null);
  const [gh, setGh] = useState<{ connected: boolean; login?: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // 非空 = 编辑模式,复用 share 弹窗但保持同一 id
  const [editingData, setEditingData] = useState<Record<string, unknown> | null>(null); // 编辑时保留原内容,只改元信息
  const [sourceId, setSourceId] = useState<string>(""); // 新上传时选中的公司/员工 id
  const [orgCompanies, setOrgCompanies] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [orgAgents, setOrgAgents] = useState<Array<{ id: string; name: string; role: string; companyId?: string }>>([]);
  const [remoteScope, setRemoteScope] = useState<"all" | "mine" | "favorites">("all");
  const [showWorkshop, setShowWorkshop] = useState(false);
  // 「公司架构」表单的「分享到社区」入口跳过来时,预选中那个公司(跳过 start/pick-company 选择步骤,
  // 直接进编辑器)——见下面 open-template-workshop 跨页契约。
  const [workshopCompanyId, setWorkshopCompanyId] = useState<string | undefined>(undefined);
  // 排行榜是独立于 shelf 的一栏(不进 store.shelf,避免动到 store 的 Shelf 类型)。
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  // 公司/团队安装完成后,如实列出模板声明但本机还没配的 MCP(见 InstallResultModal)。
  const [installResult, setInstallResult] = useState<{ title: string; agentCount: number; missingMcp: McpMissingItem[] } | null>(null);
  // 导入本地 .json 公司模板文件:选文件 → 客户端用 CompanyTemplateSchema 校验 → 校验通过则落进本地
  // 模板库(importLocalTemplate)→ 复用现成的 ImportConfirmDialog + handleImport 走安装到组织的既有链路。
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localImporting, setLocalImporting] = useState(false);
  const [localImportError, setLocalImportError] = useState<{ fileName: string; issues: string[] } | null>(null);
  // D1(修 V4):模板确认弹窗打开时拉取 doctor 体检 + dangerFlags(Permission Diff),塞进弹窗展示;
  // error 级禁用确认(服务端安装口同样拦截,这里是前置透明)。远程/本地导入两条路径共用这一个入口。
  // D3(V0 必需):安装三模式(新建公司/合并到当前公司/仅预览)——统一改走 install/company 的 mode:"preview"
  // 分支,一次调用拿到 doctor + dangerFlags + 安装预览摘要,选了合并目标公司时再带上合并冲突报告,
  // 不必再分别打两次接口。
  const [importCheck, setImportCheck] = useState<TemplateImportCheck | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>("new-company");
  const [mergeTargetCompanyId, setMergeTargetCompanyId] = useState<string>("");
  const [mergeStrategies, setMergeStrategies] = useState<MergeStrategiesInput>(DEFAULT_MERGE_STRATEGIES);
  const [teamDuplicationResolution, setTeamDuplicationResolution] = useState<TeamDuplicationResolution | "">(""); // P1#4:语义团队重复处置(未选=禁确认)
  const [orgParentResolution, setOrgParentResolution] = useState<OrgParentResolution | "">(""); // C9-P0:map 遇新父级三选一(map+orgParent 冲突时未选=禁确认)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [previewSummary, setPreviewSummary] = useState<InstallPreviewSummaryView | null>(null);
  const [mergeConflictCounts, setMergeConflictCounts] = useState<MergeConflictCounts | null>(null);
  // D1/令四.1 · retainHighRisk:确认弹窗里「我知情并保留高危授权」的整体勾选态(默认不勾=Safe Install 剥离)。
  // 纯 UI 选择,本身不构成授权——真正的授权凭据是下方 preview 签发的一次性 installConfirmationToken。
  const [retainHighRisk, setRetainHighRisk] = useState(false);
  // 令四.1 · preview 阶段后端签发的一次性安装确认 token(绑本模板危险面,10 分钟过期)。勾选「保留高危
  // 授权」并真装时带回它才启用 unsafe 保留;每次重新预览(模板/模式变)都会拿到新 token,恒用最新的。
  const [installConfirmationToken, setInstallConfirmationToken] = useState<string | undefined>(undefined);
  // P0-1 · 导入绑定计划:预览返回 + 用户逐项改动(map/configure/disable),真装时随请求回传后端。
  const [bindingPlans, setBindingPlans] = useState<BindingPlanView[] | undefined>(undefined);
  // D6 · 安装记录 + 一键撤销:弹窗开关 + 正在撤销的 txId。
  const [showRecords, setShowRecords] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  // 打开一个新的导入目标 → 三模式相关状态清零,不带着上一个模板的选择进新弹窗。
  useEffect(() => {
    if (importTarget?.type !== "template") return;
    setInstallMode("new-company");
    setMergeTargetCompanyId("");
    setMergeStrategies(DEFAULT_MERGE_STRATEGIES);
    setConfirmOverwrite(false);
    setRetainHighRisk(false);
    setInstallConfirmationToken(undefined);
    setTeamDuplicationResolution("");
    setOrgParentResolution("");
    setBindingPlans(undefined);
  }, [importTarget]);
  useEffect(() => {
    if (importTarget?.type !== "template") { setImportCheck(null); setPreviewSummary(null); setMergeConflictCounts(null); setTeamDuplicationResolution(""); setOrgParentResolution(""); setBindingPlans(undefined); return; }
    let cancelled = false;
    setImportCheck({ loading: true });
    setInstallConfirmationToken(undefined); // 重新预览 → 旧 token 作废,等新响应
    const body: Record<string, unknown> = { templateId: importTarget.item.id, mode: "preview" };
    if (installMode === "merge" && mergeTargetCompanyId) body.targetCompanyId = mergeTargetCompanyId;
    else { setMergeConflictCounts(null); setTeamDuplicationResolution(""); setOrgParentResolution(""); }
    api.post<{
      summary: InstallPreviewSummaryView; doctor: TemplateImportCheck["doctor"]; dangerFlags: string[];
      trustLevel: string; hashVerified: boolean; safeInstallPreview: TemplateImportCheck["safeInstallPreview"];
      installConfirmationToken?: string;
      bindingPlans?: BindingPlanView[];
      conflicts?: { agentId: unknown[]; orgEdge: unknown[]; memoryScope: unknown[]; a2aRule: unknown[]; capability: unknown[]; teamDuplication?: unknown[]; orgParent?: unknown[] };
    }>("/community/install/company", body)
      .then(r => {
        if (cancelled) return;
        setImportCheck({ loading: false, doctor: r.doctor, dangerFlags: r.dangerFlags, trustLevel: r.trustLevel, hashVerified: r.hashVerified, safeInstallPreview: r.safeInstallPreview });
        setPreviewSummary(r.summary);
        setInstallConfirmationToken(r.installConfirmationToken); // 令四.1:捕获本次预览签发的一次性 token
        setBindingPlans(r.bindingPlans); // P0-1:捕获本机能力比对后的绑定计划(用户在弹窗逐项确认)
        if (r.conflicts) {
          setMergeConflictCounts({
            agentId: r.conflicts.agentId.length, orgEdge: r.conflicts.orgEdge.length, memoryScope: r.conflicts.memoryScope.length,
            a2aRule: r.conflicts.a2aRule.length, capability: r.conflicts.capability.length,
            teamDuplication: r.conflicts.teamDuplication?.length ?? 0, // P1#4:语义团队重复计数
            orgParent: r.conflicts.orgParent?.length ?? 0, // C9-P0:map 遇新父级冲突计数
          });
          setTeamDuplicationResolution(""); // 每次重算冲突后清空处置选择,强制用户对新预览重新决策
          setOrgParentResolution(""); // 同上:清空新父级处置
        }
      })
      .catch(() => { if (!cancelled) { setImportCheck({ loading: false, error: true }); setPreviewSummary(null); } });
    return () => { cancelled = true; };
  }, [importTarget, installMode, mergeTargetCompanyId]);
  // 合并模式的目标公司下拉复用「我的组织」列表——分享弹窗已有同一份数据,这里放宽拉取条件一起用。
  useEffect(() => {
    if (installMode !== "merge" || importTarget?.type !== "template") return;
    api.get<Array<{ id: string; name: string; description?: string }>>("/companies").then(setOrgCompanies).catch(() => {});
  }, [installMode, importTarget]);

  useEffect(() => { store.loadAll(); }, []);
  // 跨页契约:公司架构表单的「分享到社区」按钮 → sessionStorage 兜底(社区页此时可能还没挂载)+
  // 实时事件(社区页已挂载时直接消费)双保险,与 App.tsx 的 open-task-run 同一惯例。
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("opc-workshop-company");
      if (pending) {
        sessionStorage.removeItem("opc-workshop-company");
        setWorkshopCompanyId(pending);
        setShowWorkshop(true);
      }
    } catch { /* ignore */ }
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent).detail?.companyId;
      if (id) { setWorkshopCompanyId(id); setShowWorkshop(true); }
    };
    window.addEventListener("open-template-workshop", onOpen);
    return () => window.removeEventListener("open-template-workshop", onOpen);
  }, []);
  // GitHub 登录状态:提交署名 = 登录用户的 login(服务端也会用权威 login 覆盖,防冒名)。未登录则引导去登录。
  useEffect(() => { api.get<{ connected: boolean; login?: string }>("/github/status").then(setGh).catch(() => setGh(null)); }, [showShare]);
  // 打开分享弹窗时拉取「我的组织」——上传的是真实的公司/员工内容,得从这里选。
  useEffect(() => {
    if (!showShare) return;
    api.get<Array<{ id: string; name: string; description?: string }>>("/companies").then(setOrgCompanies).catch(() => {});
    api.get<Array<{ id: string; name: string; role: string; companyId?: string }>>("/agents").then(setOrgAgents).catch(() => {});
  }, [showShare]);

  const agentCountByCompany = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of orgAgents) if (a.companyId) m[a.companyId] = (m[a.companyId] || 0) + 1;
    return m;
  }, [orgAgents]);

  const itemsOf = (t: CommunityContentType): Listable[] =>
    (t === "company" ? store.templates : t === "team" ? store.teams : store.agentCards) as unknown as Listable[];

  const counts = useMemo(() => ({
    company: store.shelf === "favorites" ? store.favorites.company.length : store.templates.length,
    team: store.shelf === "favorites" ? store.favorites.team.length : store.teams.length,
    worker: store.shelf === "favorites" ? store.favorites.worker.length : store.agentCards.length,
  }), [store.shelf, store.templates, store.teams, store.agentCards, store.favorites]);

  const list = useMemo(() => {
    let items = itemsOf(store.contentType);
    if (store.shelf === "favorites") {
      const favs = new Set(store.favorites[store.contentType]);
      items = items.filter(i => favs.has(i.id));
    }
    if (store.search) {
      const q = store.search.toLowerCase();
      items = items.filter(i =>
        i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.author.toLowerCase().includes(q));
    }
    items = [...items].sort((a, b) => store.sort === "popular" ? b.stars - a.stars : b.createdAt.localeCompare(a.createdAt));
    return items;
  }, [store.contentType, store.shelf, store.favorites, store.templates, store.teams, store.agentCards, store.search, store.sort]);

  // D3:新建公司(缺省)沿用既有 store.installCompany 链路;合并模式直接打 install/company(mode:"merge"),
  // 装完手动刷新组织(镜像 store.installCompany 内部的 refreshOrg,不改 useCommunityStore.ts)。
  const handleImport = async (opts: { mode: InstallMode; targetCompanyId?: string; mergeStrategies?: MergeStrategiesInput; confirmOverwrite?: boolean; retainHighRisk?: boolean; teamDuplicationResolution?: TeamDuplicationResolution; orgParentResolution?: OrgParentResolution }) => {
    if (!importTarget) return;
    if (importTarget.type !== "template") return;
    const item = importTarget.item;
    setImporting(true);
    try {
      let r: {
        companyId: string; agentCount: number; txId?: string;
        missingMcp?: Array<{ name: string; purpose?: string; optional?: boolean }>;
        safeInstall?: { applied: boolean; stripped: Array<{ id: string; detail: string }> };
      };
      // 令四.1:用户勾选「保留高危授权」→ 带上 preview 阶段后端签发的一次性 token;未勾或无 token(未预览)
      // 一律不带 → 服务端恒走 Safe Install 剥离。token 校验失败(过期/重放/模板被换)服务端回 4xx,走 catch 提示重试。
      const tokenField = opts.retainHighRisk && installConfirmationToken ? { installConfirmationToken } : {};
      // P0-1:用户逐项确认过的绑定计划随真装回传;未预览(无计划)则不带 → 服务端按模板原样落地。
      const planField = bindingPlans ? { bindingPlans } : {};
      if (opts.mode === "merge") {
        r = await api.post("/community/install/company", {
          templateId: item.id, mode: "merge",
          targetCompanyId: opts.targetCompanyId, mergeStrategies: opts.mergeStrategies, confirmOverwrite: opts.confirmOverwrite,
          ...tokenField,
          ...planField,
          ...(opts.teamDuplicationResolution ? { teamDuplicationResolution: opts.teamDuplicationResolution } : {}), // P1#4:语义团队重复显式处置透传
          ...(opts.orgParentResolution ? { orgParentResolution: opts.orgParentResolution } : {}), // C9-P0:map 遇新父级显式处置透传(communityRoutes 需消费)
        });
        try { await useAgentStore.getState().load(); } catch { /* 刷新失败不影响已完成的合并 */ }
      } else {
        // D1:响应新增 safeInstall(Safe Install Mode 默认剥离的高危授权项),如实提示用户。
        r = await store.installCompany(item.id, { ...tokenField, ...planField });
      }
      // D6:保留服务端 txId 到本地安装记录 → 用户可在「安装记录」里一键撤销这次安装。
      if (r.txId) store.recordInstall({ txId: r.txId, name: item.title, agentCount: r.agentCount, mode: opts.mode === "merge" ? "merge" : "new-company" });
      setImportTarget(null);
      const strippedNote = r.safeInstall?.applied ? " · " + tr("c.safeInstallStripped", { n: r.safeInstall.stripped.length }) : "";
      // 有声明但本机缺的 MCP → 弹层如实列出 + 跳配置页;没有就走原来的轻量 toast,不改变常见路径的体感。
      if (r.missingMcp && r.missingMcp.length > 0) {
        setInstallResult({ title: item.title, agentCount: r.agentCount, missingMcp: r.missingMcp });
        if (strippedNote) { setNotice(strippedNote.slice(3)); setTimeout(() => setNotice(null), 6000); }
      } else {
        const noticeKey = opts.mode === "merge" ? "c.noticeCompanyMerged" : "c.noticeCompany";
        setNotice(tr(noticeKey).replace("{name}", item.title).replace("{n}", String(r.agentCount)) + strippedNote);
        setTimeout(() => setNotice(null), 6000);
      }
    } catch (e) {
      console.error("Install failed", e);
      // D1:doctor 拒装(422)带服务端 checks 文案,如实展示,不再一律笼统"导入失败"。
      setNotice((e as Error)?.message || tr("c.importFail"));
      setTimeout(() => setNotice(null), 6000);
    } finally {
      setImporting(false);
    }
  };

  // D6 · 一键撤销一次安装:POST rollback,成功刷新组织 + 标记记录已撤销;失败给服务端人话文案。
  const handleRollback = async (txId: string) => {
    if (typeof window !== "undefined" && !window.confirm(tr("c.rollbackConfirm"))) return;
    setRollingBack(txId);
    try {
      await store.rollbackInstall(txId);
      setNotice(tr("c.rollbackDone"));
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setNotice(tr("c.rollbackFail", { msg: (e as Error)?.message || "" }));
      setTimeout(() => setNotice(null), 6000);
    } finally {
      setRollingBack(null);
    }
  };

  // D8 · 本地库下架:从本地模板/团队/员工列表隐藏该条目(不删磁盘文件),成功后列表自动刷新。
  const handleUnlist = async (type: CommunityContentType, id: string) => {
    if (typeof window !== "undefined" && !window.confirm(tr("c.unlistConfirm"))) return;
    try {
      await store.unlistLocal(type, id);
      setNotice(tr("c.unlistDone"));
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setNotice(tr("c.unlistFail", { msg: (e as Error)?.message || "" }));
      setTimeout(() => setNotice(null), 5000);
    }
  };

  // team/worker install: attach under a chosen CEO/Lead (parentId from the org-attach dialog)
  const handleInstallToOrg = async (parentId: string) => {
    if (!importTarget || importTarget.type === "template") return;
    setImporting(true);
    try {
      if (importTarget.type === "team") {
        const r = await store.installTeam(importTarget.item.id, parentId);
        setNotice(tr("c.noticeTeam").replace("{name}", importTarget.item.title).replace("{n}", String(r.added)));
      } else {
        const r = await store.installWorker(importTarget.item.id, parentId) as { duplicate?: boolean };
        setNotice((r?.duplicate ? tr("c.noticeWorkerDup") : tr("c.noticeWorker")).replace("{name}", importTarget.item.title));
      }
      setImportTarget(null);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      console.error("Install failed", e);
      setNotice(tr("c.importFail"));
      setTimeout(() => setNotice(null), 4000);
    } finally {
      setImporting(false);
    }
  };

  const handleShare = async () => {
    setSharing(true);
    setShareResult(null);
    try {
      const author = gh?.login || shareForm.author; // 署名 = 登录的 GitHub login(服务端会用权威 login 再覆盖一次)
      const tags = shareForm.tags.split(",").map(t => t.trim()).filter(Boolean);
      let data: Record<string, any>;
      if (editingId) {
        // 编辑:保留原有真实内容(agents 等),只更新元信息 + 保持同一 id(review.mjs 视为 modified)
        data = { ...(editingData || {}), id: editingId, title: shareForm.title, description: shareForm.description, tags, author };
      } else {
        // 新上传:从选中的公司/员工序列化**真实内容**(含全部 agents),而不是空壳
        if (shareForm.type === "template") {
          // /companies/:id/export 现产出 canonical Company Bundle(带 schema_version)。社区仓库/审查/
          // 索引仍以扁平 CompanyTemplate 为准(bundle 化是战役C 收尾),故桥接回扁平形状再发布;并去掉
          // memory 桥接出的 seedMemories —— 分享维持既有口径,不把记忆推上公开仓库(与旧 companyToTemplate 一致)。
          const raw = await api.get<Record<string, any>>(`/companies/${sourceId}/export`);
          if (raw && typeof raw.schema_version === "string") {
            const flat = bundleToTemplateShape(raw as unknown as CompanyBundle) as Record<string, any>;
            delete flat.seedMemories;
            data = flat;
          } else {
            data = raw;
          }
        } else {
          data = await api.get<Record<string, any>>(`/agents/${sourceId}/export-card`);
        }
        if (shareForm.title) data.title = shareForm.title;
        if (shareForm.description) data.description = shareForm.description;
        if (tags.length) data.tags = tags;
        data.author = author;
        // id 用 uploader 的 login 命名空间化,避免种子公司 id(如 research-pro)跨用户撞车 → 被误判成"改别人的"。
        data.id = `${author}-${sourceId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
      }
      const result = await store.shareItem(shareForm.type, data, author, `${editingId ? "Update" : "Share"} ${shareForm.type}: ${data.title}`);
      setShareResult(result);
      if (result.prUrl) store.loadRemote();
    } catch (e) {
      // 真实错误(空壳被拒 / 502 / 网络…)——展示服务端文案,不再一律误报"需要登录"。
      setShareResult({ error: (e as Error)?.message || tr("c.shareFail") });
    } finally {
      setSharing(false);
    }
  };

  // 从远程「我的」内容点编辑:拉全量内容预填,保持同一 id 走 modified 提交(内容保留,只改元信息)。
  const handleEditRemote = async (e: RemoteEntry) => {
    let full: Record<string, unknown>;
    // 关键:拉取失败必须中止——否则会用空 stub 覆盖并提交,过审后抹掉你自己发布的真实内容(数据丢失)。
    try { full = await store.getRemoteItem(e.type, e.id); }
    catch { setNotice(tr("c.loadRemoteFailed")); setTimeout(() => setNotice(null), 3500); return; }
    const tags = Array.isArray((full as { tags?: unknown }).tags) ? ((full as { tags: string[] }).tags).join(", ") : "";
    setEditingData(full);
    setShareForm({ type: e.type, title: e.title, description: e.description, tags, author: gh?.login || "" });
    setEditingId(e.id);
    setSourceId("");
    setShareResult(null);
    setShowShare(true);
  };

  // 入口去重:新上传只走 worker(template 的创建+分享已合并进模板工坊,见 TemplateWorkshop 保存成功页)。
  const openShareFresh = () => {
    setEditingId(null); setEditingData(null); setSourceId("");
    setShareForm({ type: "agent", title: "", description: "", tags: "", author: gh?.login || "" });
    setShareResult(null);
    setShowShare(true);
  };

  // 排行榜条目点击 → 简单跳转到 GitHub 全部社区视图并按标题过滤,落在该条目已有的卡片上,
  // 复用它现成的详情/安装/star 操作(不在排行榜里重新实现一套安装逻辑)。
  const openEntryFromLeaderboard = (e: RemoteEntry) => {
    setShowLeaderboard(false);
    store.setShelf("github");
    setRemoteScope("all");
    store.setSearch(e.title);
  };

  // 从社区安装到组织:先拉到本地库(保留 id),再复用现有安装流程。template → 新建公司;agent → 选父节点挂载。
  // D1(修 V4):远程模板**不再直装**——统一进 ImportConfirmDialog(危险权限 Permission Diff + doctor
  // 体检),用户确认后才走 handleImport 真正安装(与本地导入/本地库同一条确认链路)。
  const handleInstallRemote = async (e: RemoteEntry) => {
    const data = await store.importRemote(e.type, e.id); // 存本地 + 返回已取内容
    void store.markDownloaded(e.type, e.id); // 下载粗略计数(🚀),不阻塞安装
    if (e.type === "template") {
      setImportTarget({ type: "template", item: data as unknown as CompanyTemplate });
    } else if (e.type === "agent") {
      setImportTarget({ type: "agent", item: data as unknown as AgentCard }); // 复用返回值,不再二次 GET
    }
  };

  // 导入本地文件:.json → JSON.parse → CompanyTemplateSchema.safeParse。任何一步失败都给出具体原因
  // (哪个字段、什么问题),不是笼统的"格式错误"。校验通过才落库 + 打开确认导入弹窗,复用 handleImport
  // 现成的"安装到组织"链路(installCompany),不是另起一套安装逻辑。
  const handleLocalFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续选同一个文件也能再次触发 onChange
    if (!file) return;
    setLocalImporting(true);
    try {
      const text = await readFileAsText(file);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        setLocalImportError({ fileName: file.name, issues: [tr("c.importLocalJsonSyntaxError", { msg: (err as Error).message })] });
        return;
      }
      const parsed = CompanyTemplateSchema.safeParse(json);
      if (!parsed.success) {
        const all = parsed.error.issues.map(i => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
        const issues = all.length > LOCAL_IMPORT_MAX_ISSUES
          ? [...all.slice(0, LOCAL_IMPORT_MAX_ISSUES), tr("c.importLocalMoreIssues", { n: all.length - LOCAL_IMPORT_MAX_ISSUES })]
          : all;
        setLocalImportError({ fileName: file.name, issues });
        return;
      }
      const template = parsed.data as unknown as CompanyTemplate;
      await store.importLocalTemplate(template);
      setImportTarget({ type: "template", item: template });
    } catch (err) {
      setLocalImportError({ fileName: file.name, issues: [(err as Error)?.message || tr("c.importFail")] });
    } finally {
      setLocalImporting(false);
    }
  };

  // 工坊保存成功:关掉工坊、刷新本地模板库、切到本地库分区让新模板立刻可见。
  const handleWorkshopSaved = async (id: string) => {
    setShowWorkshop(false);
    await store.loadAll();
    store.setShelf("market");
    setNotice(tr("tw.savedNotice", { id }));
    setTimeout(() => setNotice(null), 4000);
  };

  // 选中组织里的公司/员工 → 预填标题/描述(可再改)。
  const pickSource = (type: "template" | "agent", id: string) => {
    setSourceId(id);
    if (type === "template") {
      const c = orgCompanies.find(x => x.id === id);
      if (c) setShareForm(f => ({ ...f, title: f.title || c.name, description: f.description || c.description || "" }));
    } else {
      const a = orgAgents.find(x => x.id === id);
      if (a) setShareForm(f => ({ ...f, title: f.title || a.name, description: f.description || tr("c.defaultWorkerDesc", { role: a.role }) }));
    }
  };

  const FavBtn = ({ id }: { id: string }) => {
    const fav = store.isFavorite(store.contentType, id);
    return (
      <button
        onClick={(e) => { e.stopPropagation(); store.toggleFavorite(store.contentType, id); }}
        title={fav ? tr("c.unfav") : tr("c.fav")}
        className="absolute top-2 end-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-bg-card/80 border border-border cursor-pointer hover:scale-110 transition-transform"
      >
        <Star size={13} className={fav ? "fill-amber text-amber" : "text-text-muted"} />
      </button>
    );
  };

  // 本地库下架入口:只在本地库(market)分区的卡片上出现,叠放在卡片左上角。
  const UnlistBtn = ({ id }: { id: string }) => (
    <button
      onClick={(e) => { e.stopPropagation(); handleUnlist(store.contentType, id); }}
      title={tr("c.unlist")}
      className="absolute top-2 start-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-bg-card/80 border border-border cursor-pointer hover:scale-110 transition-transform"
    >
      <EyeOff size={13} className="text-text-muted" />
    </button>
  );

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Page Header */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-bg-card">
        <div className="flex items-center gap-1.5">
          <h2 className="m-0 text-lg font-semibold text-text-primary">{tr("c.title")}</h2>
          <HelpTip text={tr("c.helpCommunity")} />
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleLocalFileChange} />
          <button
            onClick={() => setShowRecords(true)}
            title={tr("c.installRecords")}
            className="relative inline-flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-full bg-bg-card text-text-primary cursor-pointer text-[13px] font-medium hover:bg-bg-hover transition-colors">
            <History size={14} /> {tr("c.installRecords")}
            {store.installRecords.some(r => !r.rolledBack) && (
              <span className="ms-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-white text-[10px] leading-4 text-center">
                {store.installRecords.filter(r => !r.rolledBack).length}
              </span>
            )}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={localImporting}
            title={tr("c.helpImportLocal")}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 border border-border rounded-full bg-bg-card text-text-primary cursor-pointer text-[13px] font-medium hover:bg-bg-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
            <Upload size={14} /> {localImporting ? "…" : tr("c.importLocalFile")}
          </button>
          <button
            onClick={openShareFresh}
            className="px-4 py-1.5 border-none rounded-full bg-green text-white cursor-pointer text-[13px] font-medium hover:opacity-90 transition-colors">
            {tr("c.share")}
          </button>
        </div>
      </div>

      {/* 创作者入口:生态不只是官方模板——任何人都能把跑顺的公司架构导出、分享给社区(董事长决策③)。
          入口去重:导出为模板 + 分享到社区合并成一条流水线,统一走模板工坊(工坊里保存成功后就地提供分享按钮)。 */}
      <div className="mx-5 mt-3 flex items-center gap-3 px-4 py-3 rounded-xl border border-accent/20 bg-accent/5">
        <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
          <Sparkles size={16} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-text-primary flex items-center gap-1">
            {tr("c.creatorBanner.title")} <HelpTip text={tr("c.creatorBanner.desc")} />
          </div>
        </div>
        <button
          onClick={() => setShowWorkshop(true)}
          className="shrink-0 inline-flex items-center gap-1 btn-primary">
          <Wrench size={13} /> {tr("c.creatorBanner.workshopCta")}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left hierarchical nav: GitHub 社区(all/mine/favorites)+ 本地库(工坊保存的自定义模板)。 */}
        <aside className="w-48 shrink-0 border-r border-border bg-bg-card flex flex-col">
          <div className="p-3 flex flex-col gap-1">
            {([["all", tr("c.all"), Globe], ["mine", tr("c.mine"), User], ["favorites", tr("c.favorites"), Star]] as const).map(([key, label, Icon]) => (
              <button key={key} onClick={() => { setShowLeaderboard(false); store.setShelf("github"); setRemoteScope(key); }}
                className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors ${
                  !showLeaderboard && store.shelf === "github" && remoteScope === key ? "bg-surface-2 text-ink rounded-[10px]" : "bg-bg-hover text-text-secondary hover:text-text-primary rounded-lg"
                }`}>
                <Icon size={14} /> {label}
              </button>
            ))}
            <div className="my-1.5 border-t border-border" />
            {/* 排行榜独立于「全部/我的/收藏/本地库」——单独一栏,不挤在 GitHub 浏览的 tab 里。 */}
            <button onClick={() => setShowLeaderboard(true)}
              className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors ${
                showLeaderboard ? "bg-surface-2 text-ink rounded-[10px]" : "bg-bg-hover text-text-secondary hover:text-text-primary rounded-lg"
              }`}>
              <Trophy size={14} /> {tr("c.leaderboard")}
            </button>
            <div className="my-1.5 border-t border-border" />
            <button onClick={() => { setShowLeaderboard(false); store.setShelf("market"); store.setContentType("company"); }}
              className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium cursor-pointer transition-colors ${
                !showLeaderboard && store.shelf !== "github" ? "bg-surface-2 text-ink rounded-[10px]" : "bg-bg-hover text-text-secondary hover:text-text-primary rounded-lg"
              }`}>
              <Store size={14} /> {tr("c.localShelf")}
            </button>
          </div>
        </aside>

        {/* Main: toolbar + grid */}
        <main className="flex-1 flex flex-col min-w-0">
          {!showLeaderboard && (
            <div className="flex items-center gap-3 px-5 pt-3 pb-2.5 border-b border-border">
              <div className="relative">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  placeholder={tr("c.searchPh")}
                  value={store.search}
                  onChange={e => store.setSearch(e.target.value)}
                  className="border border-border rounded-lg py-1.5 pl-7 pr-2.5 text-[13px] w-[220px] outline-none focus:border-accent bg-bg-card" />
              </div>
              {store.shelf !== "github" && (
                <select value={store.sort} onChange={e => store.setSort(e.target.value as "popular" | "newest")}
                  className="border border-border rounded-md px-2 py-1 text-xs bg-bg-card cursor-pointer outline-none">
                  <option value="popular">{tr("c.sortPopular")}</option>
                  <option value="newest">{tr("c.sortNewest")}</option>
                </select>
              )}
              <div className="flex-1" />
              {store.shelf !== "github" && <span className="text-[12px] text-text-muted">{tr("c.count").replace("{n}", String(list.length))}</span>}
            </div>
          )}

          <div className="flex-1 overflow-auto p-5">
            {showLeaderboard ? (
              <Leaderboard onOpenEntry={openEntryFromLeaderboard} />
            ) : store.shelf === "github" ? (
              <RemoteCommunity myLogin={gh?.connected ? gh.login : undefined} scope={remoteScope} onEdit={handleEditRemote} onInstall={handleInstallRemote} />
            ) : store.loading ? (
              <div className="text-text-muted text-[13px]">{tr("c.loading")}</div>
            ) : list.length === 0 ? (
              <div className="text-text-muted text-[13px]">
                {store.shelf === "favorites" ? tr("c.emptyFav") : tr("c.empty")}
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                {store.contentType === "company" && (list as unknown as CompanyTemplate[]).map(t => (
                  <div key={t.id} className="relative">
                    <FavBtn id={t.id} />
                    {store.shelf === "market" && <UnlistBtn id={t.id} />}
                    <CompanyTemplateCard template={t} onSelect={() => setSelectedTemplate(t)} onImport={() => setImportTarget({ type: "template", item: t })} />
                  </div>
                ))}
                {store.contentType === "team" && (list as unknown as TeamTemplate[]).map(t => (
                  <div key={t.id} className="relative">
                    <FavBtn id={t.id} />
                    {store.shelf === "market" && <UnlistBtn id={t.id} />}
                    <TeamCard team={t} onSelect={() => setImportTarget({ type: "team", item: t })} onImport={() => setImportTarget({ type: "team", item: t })} />
                  </div>
                ))}
                {store.contentType === "worker" && (list as unknown as AgentCard[]).map(c => (
                  <div key={c.id} className="relative">
                    <FavBtn id={c.id} />
                    {store.shelf === "market" && <UnlistBtn id={c.id} />}
                    <AgentCardView card={c} onSelect={() => setSelectedCard(c)} onImport={() => setImportTarget({ type: "agent", item: c })} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {notice && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] px-4 py-2.5 rounded-xl bg-bg-card border border-border shadow-lg text-[13px] text-text-primary">
          {notice}
        </div>
      )}

      {localImportError && (
        <LocalImportErrorModal
          fileName={localImportError.fileName}
          issues={localImportError.issues}
          onClose={() => setLocalImportError(null)}
        />
      )}

      {installResult && (
        <InstallResultModal
          title={installResult.title}
          agentCount={installResult.agentCount}
          missingMcp={installResult.missingMcp}
          onClose={() => setInstallResult(null)}
        />
      )}

      {/* D6 · 安装记录 + 一键撤销:本地保存的 txId 清单,未撤销的可 rollback。 */}
      {showRecords && (
        <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1100]" onClick={() => setShowRecords(false)}>
          <div className="bg-bg-card rounded-xl p-6 w-[480px] max-w-[90vw] max-h-[80vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <History size={18} className="text-accent" />
              <h3 className="m-0 text-base font-semibold text-text-primary flex items-center gap-1">
                {tr("c.recordsTitle")} <HelpTip text={tr("c.recordsHint")} />
              </h3>
            </div>
            {store.installRecords.length === 0 ? (
              <div className="text-[13px] text-text-muted py-8 text-center">{tr("c.recordsEmpty")}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {store.installRecords.map(rec => (
                  <div key={rec.txId} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border bg-bg-hover">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-text-primary truncate">{rec.name}</div>
                      <div className="text-[12px] text-text-muted mt-0.5">
                        {tr(rec.mode === "merge" ? "c.recordModeMerge" : "c.recordModeNew")} · {tr("c.agents", { n: rec.agentCount })} · {new Date(rec.at).toLocaleString()}
                      </div>
                    </div>
                    {rec.rolledBack ? (
                      <span className="shrink-0 text-[12px] px-2 py-1 rounded-full bg-bg-card border border-border text-text-muted">{tr("c.recordRolledBack")}</span>
                    ) : (
                      <button
                        onClick={() => handleRollback(rec.txId)}
                        disabled={rollingBack === rec.txId}
                        className="shrink-0 inline-flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-full border border-red/30 text-red bg-red/5 cursor-pointer hover:bg-red/10 transition-colors disabled:opacity-60 disabled:cursor-default">
                        <RotateCcw size={12} /> {rollingBack === rec.txId ? tr("c.recordRollingBack") : tr("c.recordRollback")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-5">
              <button onClick={() => setShowRecords(false)} className="btn-secondary">{tr("common.close")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showWorkshop && (
        <TemplateWorkshop
          initialCompanyId={workshopCompanyId}
          onClose={() => { setShowWorkshop(false); setWorkshopCompanyId(undefined); }}
          onSaved={(id) => { setWorkshopCompanyId(undefined); handleWorkshopSaved(id); }}
        />
      )}

      {selectedTemplate && (
        <TemplateDetailModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onImport={() => { setImportTarget({ type: "template", item: selectedTemplate }); setSelectedTemplate(null); }}
        />
      )}

      {selectedCard && (
        <AgentDetailModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          onImport={() => { setImportTarget({ type: "agent", item: selectedCard }); setSelectedCard(null); }}
        />
      )}

      {importTarget?.type === "template" && (
        <ImportConfirmDialog
          name={importTarget.item.title}
          agentCount={importTarget.item.agents.length}
          loading={importing}
          check={importCheck ?? undefined}
          retainHighRisk={retainHighRisk}
          onRetainHighRiskChange={setRetainHighRisk}
          hasInstallConfirmationToken={!!installConfirmationToken}
          onConfirm={handleImport}
          onCancel={() => setImportTarget(null)}
          mode={installMode}
          onModeChange={setInstallMode}
          companies={orgCompanies}
          targetCompanyId={mergeTargetCompanyId}
          onTargetCompanyChange={setMergeTargetCompanyId}
          preview={previewSummary}
          mergeConflicts={mergeConflictCounts}
          mergeStrategies={mergeStrategies}
          onMergeStrategiesChange={setMergeStrategies}
          confirmOverwrite={confirmOverwrite}
          onConfirmOverwriteChange={setConfirmOverwrite}
          teamDuplicationResolution={teamDuplicationResolution}
          onTeamDuplicationResolutionChange={setTeamDuplicationResolution}
          orgParentResolution={orgParentResolution}
          onOrgParentResolutionChange={setOrgParentResolution}
          bindingPlans={bindingPlans}
          onBindingPlanChange={(i, patch) => setBindingPlans(prev => prev?.map((p, idx) => idx === i ? { ...p, ...patch } : p))}
        />
      )}

      {importTarget?.type === "team" && (
        <ImportToOrgDialog
          kind="team"
          title={importTarget.item.title}
          previewAgents={importTarget.item.agents.map(a => ({ id: a.id, name: a.name, role: a.role, parentId: a.parentId }))}
          loading={importing}
          onCancel={() => setImportTarget(null)}
          onConfirm={handleInstallToOrg}
        />
      )}

      {importTarget?.type === "agent" && (
        <ImportToOrgDialog
          kind="worker"
          title={importTarget.item.title}
          previewAgents={[{ id: importTarget.item.id, name: importTarget.item.agent.name || importTarget.item.title, role: importTarget.item.agent.expectedRole || importTarget.item.role }]}
          loading={importing}
          onCancel={() => setImportTarget(null)}
          onConfirm={handleInstallToOrg}
        />
      )}

      {/* Share Modal */}
      {showShare && (
        <div className="modal-overlay z-[1000]">
          <div className="bg-bg-card rounded-xl p-6 w-[420px] max-h-[80vh] overflow-auto shadow-lg">
            <h3 className="m-0 mb-4 text-base font-semibold">{tr("c.shareTitle")}</h3>
            {shareResult ? (
              <div>
                {shareResult.needAuth ? (
                  <div>
                    <p className="text-amber">{tr("c.needAuth")}</p>
                    {shareResult.authUrl ? (
                      <a href={shareResult.authUrl} target="_blank" rel="noopener noreferrer" className="text-accent font-medium">{tr("c.goAuth")}</a>
                    ) : (
                      <p className="text-text-muted">{tr("c.configOAuth")}</p>
                    )}
                  </div>
                ) : shareResult.prUrl ? (
                  <div>
                    <p className="text-green">{tr("c.prCreated")}</p>
                    <a href={shareResult.prUrl} target="_blank" rel="noopener noreferrer" className="text-accent font-medium break-all">{shareResult.prUrl}</a>
                  </div>
                ) : (
                  <p className="text-red">{shareResult.error || tr("c.shareFail")}</p>
                )}
                <button onClick={() => setShowShare(false)} className="mt-4 btn-primary">{tr("common.close")}</button>
              </div>
            ) : (
              <div>
                <div className="mb-3">
                  <label className="text-xs text-text-secondary flex items-center gap-1 mb-1">
                    {tr("c.fType")}
                    {editingId && <HelpTip text={tr("c.editModeHint")} />}
                  </label>
                  <select value={shareForm.type} disabled={!!editingId}
                    onChange={e => { setShareForm({ ...shareForm, type: e.target.value as ShareForm["type"] }); setSourceId(""); }}
                    className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] bg-bg-card outline-none disabled:opacity-60">
                    <option value="agent">{tr("c.optWorkerFull")}</option>
                    {/* template 的创建+分享已合并进模板工坊;这里只在编辑一条已发布的旧 template 时才继续显示该选项。 */}
                    {editingId && shareForm.type === "template" && <option value="template">{tr("c.optTemplateFull")}</option>}
                  </select>
                </div>

                {!editingId && (shareForm.type === "template" ? (
                  <div className="mb-3">
                    <label className="text-xs text-text-secondary flex items-center gap-1 mb-1">
                      {tr("c.selectCompanyTeam")} <HelpTip text={tr("c.helpCompanyUpload")} />
                    </label>
                    <select value={sourceId} onChange={e => pickSource("template", e.target.value)}
                      className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] bg-bg-card outline-none">
                      <option value="">{tr("c.selectCompanyPh")}</option>
                      {orgCompanies.map(c => {
                        const n = agentCountByCompany[c.id] || 0;
                        return <option key={c.id} value={c.id} disabled={n === 0}>{c.name}{tr("c.workerCountLabel", { n, suffix: n === 0 ? tr("c.emptyCantUpload") : "" })}</option>;
                      })}
                    </select>
                  </div>
                ) : (
                  <div className="mb-3">
                    <label className="text-xs text-text-secondary block mb-1">{tr("c.selectWorker")}</label>
                    <select value={sourceId} onChange={e => pickSource("agent", e.target.value)}
                      className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] bg-bg-card outline-none">
                      <option value="">{tr("c.selectWorkerPh")}</option>
                      {orgAgents.filter(a => a.role !== "ceo").map(a => (
                        <option key={a.id} value={a.id}>{a.name}（{a.role}）</option>
                      ))}
                    </select>
                  </div>
                ))}

                <div className="mb-3">
                  <label className="text-xs text-text-secondary block mb-1">{tr("c.fAuthor")}</label>
                  {gh?.connected && gh.login ? (
                    <div className="flex items-center gap-1.5 text-[13px] text-text-primary">
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-bg-hover border border-border">@{gh.login}</span>
                      <HelpTip text={tr("c.helpAuthorship")} />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[12px] text-amber bg-amber/10 border border-amber/20 rounded-md px-2.5 py-2">
                      <LogIn size={13} /> {tr("c.loginPromptFull")}
                    </div>
                  )}
                </div>
                <div className="mb-3">
                  <label className="text-xs text-text-secondary block mb-1">{tr("c.fTitle")}</label>
                  <input value={shareForm.title} onChange={e => setShareForm({ ...shareForm, title: e.target.value })}
                    placeholder={tr("c.fTitlePh")}
                    className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] box-border outline-none focus:border-accent" />
                </div>
                <div className="mb-3">
                  <label className="text-xs text-text-secondary block mb-1">{tr("c.fDesc")}</label>
                  <textarea value={shareForm.description} onChange={e => setShareForm({ ...shareForm, description: e.target.value })}
                    placeholder={tr("c.fDescPh")} rows={3}
                    className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] box-border resize-y outline-none focus:border-accent" />
                </div>
                <div className="mb-4">
                  <label className="text-xs text-text-secondary block mb-1">{tr("c.fTags")}</label>
                  <input value={shareForm.tags} onChange={e => setShareForm({ ...shareForm, tags: e.target.value })}
                    placeholder="web, react, typescript"
                    className="w-full border border-border rounded-md px-2 py-1.5 text-[13px] box-border outline-none focus:border-accent" />
                </div>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setShowShare(false)} className="btn-secondary">{tr("common.cancel")}</button>
                  <button onClick={handleShare} disabled={sharing || !gh?.connected || !shareForm.title || (!editingId && !sourceId) || (!!editingId && !editingData)}
                    className={`px-4 py-1.5 border-none rounded-full text-white text-[13px] font-medium ${
                      (sharing || !gh?.connected || !shareForm.title || (!editingId && !sourceId) || (!!editingId && !editingData)) ? "bg-border-light cursor-not-allowed" : "bg-green cursor-pointer hover:opacity-90"
                    }`}>
                    {sharing ? tr("c.sharing") : (editingId ? tr("c.update") : tr("c.share"))}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
