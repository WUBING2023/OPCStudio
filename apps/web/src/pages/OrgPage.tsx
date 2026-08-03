import { useMemo, useState, useEffect, useCallback, useRef, useLayoutEffect, createContext, useContext } from "react";
import ReactFlow, {
  useNodesState,
  useEdgesState,
  Background,
  Controls,
  Handle,
  Position,
  type NodeProps,
  type ReactFlowInstance,
  type Connection,
} from "reactflow";
import "reactflow/dist/style.css";
import { AnimatePresence } from "framer-motion";
import {
  Plus, Trash2, ArrowLeft, Download, Users, Archive, Search,
  Code2, FlaskConical, Shield, Server, Compass, Bot, ChevronRight, Share2, Star,
  Lock, Unlock, ZoomIn, ZoomOut, Maximize2, Wand2, ChevronDown, Building2, Zap, type LucideIcon,
} from "lucide-react";
import { useAgentStore } from "../store/useAgentStore.js";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n.js";
import type { AgentNodeConfig, AgentCard, CompanyTemplate, Company, AgentFramework, TraceEvent } from "@opc/shared";
import * as api from "../api/client.js";
import AgentDetailsPanel from "../components/AgentDetailsPanel.js";
import LaunchPad from "../components/LaunchPad.js";
import OrgContextMenu, { type CtxMenu } from "../components/org/OrgContextMenu.js";
import NewCompanyModal from "../components/org/NewCompanyModal.js";
import AddAgentModal from "../components/org/AddAgentModal.js";
import DeleteAgentDialog from "../components/org/DeleteAgentDialog.js";
import BriefingPanel from "../components/org/BriefingPanel.js";
import CompanyStructureForms, { ConnectivityTestPanel } from "../components/org/CompanyStructureForms.js";
import ArchitectChatPanel from "../components/org/ArchitectChatPanel.js";
import ConnectEdgeModal from "../components/org/ConnectEdgeModal.js";
import { useRunStore } from "../store/useRunStore.js";
import { STATUS_COLORS, ROLE_COLORS, ROLE_LABELS, isActiveStatus, isBusyStatus, statusLabel } from "../lib/agentMeta.js";
import { cleanText } from "../lib/text.js";
import { deriveActivityLabel } from "../lib/agentActivity.js";
import { deriveArtifactFlights, deriveMemoryPulses, isWithinWindow, channelActiveFresh, type ArtifactFlightLine, type MemoryPulseLine } from "../lib/collabLines.js";
import { pushToast } from "../components/common/Toast.js";
import { confirmDialog } from "../components/common/ConfirmDialog.js";
import { downloadJson } from "../lib/download.js";
import { navigateApp } from "../lib/navigation.js";

/* ────────── Constants ────────── */

// Communication adjacency + team colors are derived from the layout on every render and read by
// node components living deeper in the same render tree (rendered inside <ReactFlow>). They used to
// live in module-scope mutable singletons that computeLayout() rewrote as a side effect during
// render (impure, StrictMode-unsafe). Now they flow as plain pure values through a same-render
// React Context — no module state, nothing mutated outside effects.
interface OrgDerived { commAdj: Map<string, Set<string>>; teamColors: Map<string, TeamColor> }
const OrgDerivedContext = createContext<OrgDerived>({ commAdj: new Map(), teamColors: new Map() });

// Focus/dim: when a node is selected, the selected node + its direct parent/children
// + its communication partners stay bright; everything else dims.
function useFocusState(nodeId: string, parentId: string | undefined, childrenIds: string[]) {
  const { commAdj } = useContext(OrgDerivedContext);
  const selectedId = useAgentStore(s => s.selectedId);
  // Narrow selector: only the selected agent's object (stable reference unless THAT agent changes),
  // instead of subscribing to the whole `agents` array (which would re-render every node on any
  // unrelated agent's update).
  const sel = useAgentStore(s => (selectedId ? s.agents.find(a => a.id === selectedId) : undefined));
  if (!selectedId) return { selected: false, dimmed: false };
  if (selectedId === nodeId) return { selected: true, dimmed: false };
  // commAdj is symmetric (built by buildCommAdj), so checking this node's own adjacency set covers
  // both directions.
  const commRelated = commAdj.get(nodeId)?.has(selectedId);
  const related = commRelated || (!!sel && (
    sel.parentId === nodeId ||
    sel.childrenIds.includes(nodeId) ||
    parentId === selectedId ||
    childrenIds.includes(selectedId)
  ));
  return { selected: false, dimmed: !related };
}

// ── Team colors: restrained per-team hues for a quiet lead accent + the team backdrop panel ──
// Muted (~S30-36%) so team identity reads as a quiet detail (lead dot + label + a faint panel wash)
// instead of a saturated card border — the accent + 3 status colors stay the only "loud" colors on
// the canvas. v8: the panel replaced the old empty ring halo, so `soft` is painted again — raised from
// near-zero to a still-whisper-quiet wash that actually shows on both a near-black and a near-white
// canvas (both blend a low-alpha tinted color into their background just fine).
interface TeamColor { key: string; base: string; soft: string; ring: string; }
const TEAM_PALETTE: TeamColor[] = [
  { key: "violet", base: "#766dba", soft: "rgba(118,109,186,0.07)", ring: "rgba(118,109,186,0.30)" },
  { key: "blue",   base: "#6f8ab8", soft: "rgba(111,138,184,0.07)", ring: "rgba(111,138,184,0.30)" },
  { key: "cyan",   base: "#50969b", soft: "rgba(80,150,155,0.07)",  ring: "rgba(80,150,155,0.28)" },
  { key: "amber",  base: "#b4925f", soft: "rgba(180,146,95,0.07)",  ring: "rgba(180,146,95,0.28)" },
  { key: "rose",   base: "#b87a96", soft: "rgba(184,122,150,0.07)", ring: "rgba(184,122,150,0.28)" },
  { key: "green",  base: "#4f9272", soft: "rgba(79,146,114,0.07)",  ring: "rgba(79,146,114,0.28)" },
];

// Stable team color: prefer a semantic match (engineering→violet, product→blue, review→cyan),
// else assign by lead order. Module-scoped map lets node components read their team color.
function teamColorForLead(lead: AgentNodeConfig, leadIndex: number): TeamColor {
  const n = `${lead.id} ${lead.name}`.toLowerCase();
  if (/eng|engineer|\bdev\b|tech|build|前端|后端|工程/.test(n)) return TEAM_PALETTE[0];
  if (/product|prd|spec|design|ux|research|产品|设计|研究/.test(n)) return TEAM_PALETTE[1];
  if (/review|\bqa\b|test|security|audit|quality|评审|测试|安全|质量/.test(n)) return TEAM_PALETTE[2];
  return TEAM_PALETTE[leadIndex % TEAM_PALETTE.length];
}

// The lead this agent reports up to (walk to the nearest role==='lead' ancestor); null for CEO/leads.
// Takes a lookup fn (not a prebuilt Map) so callers can query a live store slice directly instead of
// rebuilding a full id→agent Map on every render just to walk a handful of ancestors.
function leadIdOf(agent: AgentNodeConfig, lookup: (id: string) => AgentNodeConfig | undefined): string | null {
  let cur: AgentNodeConfig | undefined = agent.parentId ? lookup(agent.parentId) : undefined;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur.role === "lead") return cur.id;
    cur = cur.parentId ? lookup(cur.parentId) : undefined;
  }
  return null;
}

// ── Collaboration edges (peer + cross-level) — derived, restrained, no spider-web ──
interface CollabEdge { id: string; source: string; target: string; kind: "peer" | "cross"; status?: string; }

// v5 P4: real communication channels → collab edges. peer-worker/peer-lead → "peer", learn → "cross".
// lead-worker channels are NOT overlaid (the hierarchy edge already shows that link); their "active"
// state is reflected by highlighting the matching hierarchy edge (see activePairKeys).
function channelsToCollabEdges(
  channels: { id: string; a: string; b: string; kind: string; status: string }[],
  requests: { id: string; from: string; to: string; status: string }[],
): CollabEdge[] {
  const out: CollabEdge[] = [];
  for (const c of channels) {
    if (c.kind === "lead-worker") continue;
    const kind: "peer" | "cross" = c.kind === "learn" ? "cross" : "peer";
    out.push({ id: `ch-${c.id}`, source: c.a, target: c.b, kind, status: c.status });
  }
  for (const r of requests) {
    if (r.status !== "pending") continue;
    out.push({ id: `req-${r.id}`, source: r.from, target: r.to, kind: "peer", status: "requested" });
  }
  return out;
}

// pair key (order-independent) for matching active channels onto any edge (incl. hierarchy).
export function pairKey(a: string, b: string): string { return [a, b].sort().join("|"); }

function deriveCollabEdges(agents: AgentNodeConfig[]): CollabEdge[] {
  const out: CollabEdge[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: "peer" | "cross") => {
    if (a === b) return;
    const key = kind + ":" + [a, b].sort().join("::");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: `${kind}-${a}-${b}`, source: a, target: b, kind });
  };

  const leads = agents.filter(a => a.role === "lead");
  // Peer — leads collaborate with the next lead over. Adjacent only (no wraparound): the tree layout
  // lays teams out left→right, so a first↔last wraparound edge would cut a long diagonal clean across
  // the whole canvas instead of reading as a quiet "leads talk to each other" hint.
  for (let i = 0; i + 1 < leads.length; i++) {
    add(leads[i].id, leads[i + 1].id, "peer");
  }
  // Peer — intra-team worker collaboration: chain siblings (avoids an all-pairs spider web).
  for (const lead of leads) {
    const workers = agents.filter(a => a.parentId === lead.id && a.role !== "lead");
    for (let i = 0; i + 1 < workers.length; i++) add(workers[i].id, workers[i + 1].id, "peer");
  }
  // Cross — reviewers/security from OTHER teams ↔ the engineering team's devs (cross-team QA).
  let engLead: AgentNodeConfig | null = null, maxEng = -1;
  for (const l of leads) {
    const n = agents.filter(a => a.parentId === l.id && (a.role === "dev" || a.role === "test")).length;
    if (n > maxEng) { maxEng = n; engLead = l; }
  }
  const engDevs = engLead ? agents.filter(a => a.parentId === engLead!.id && a.role === "dev") : [];
  const reviewers = agents.filter(a => (a.role === "test" || a.role === "security") && a.parentId !== engLead?.id);
  for (const r of reviewers) for (const d of engDevs.slice(0, 2)) add(r.id, d.id, "cross");
  return out;
}

// Nearest reporting target up the chain (lead → its lead/CEO, worker → its lead). Resolves the
// recipient of a "lead-only" report so a worker→lead / lead→CEO message lights the right line.
function nearestReportTarget(id: string, byId: Map<string, AgentNodeConfig>): string | null {
  let cur = byId.get(id);
  cur = cur?.parentId ? byId.get(cur.parentId) : undefined;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur.role === "lead" || cur.role === "ceo") return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

// Live communication pulses straight from the SSE event stream: recent `agent_message` events →
// the sender↔recipient pairs currently exchanging. Recipients come from the message audience
// (`agents:id,…` = explicit, `lead-only` = the report chain) or its channelId. Feeding these pairs
// into activePairs makes the matching edge — including the lead↔worker hierarchy line — flow cyan in
// real time and fade once traffic stops, without spawning extra permanent edges (no spider web).
function liveMessagePairs(
  events: TraceEvent[],
  agents: AgentNodeConfig[],
  channels: { id: string; a: string; b: string }[],
  windowMs: number,
  now: number,
): Set<string> {
  const byId = new Map(agents.map(a => [a.id, a]));
  const present = new Set(agents.map(a => a.id));
  const chById = new Map(channels.map(c => [c.id, c]));
  const out = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "agent_message" || !e.agentId) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t) && now - t > windowMs) break; // events are time-ordered → older ones can't qualify
    const from = e.agentId;
    if (!present.has(from)) continue;
    const p = e.payload as { audience?: string; channelId?: string } | undefined;
    const targets = new Set<string>();
    const ch = p?.channelId ? chById.get(p.channelId) : undefined;
    if (ch) targets.add(ch.a === from ? ch.b : ch.a);
    const aud = p?.audience ?? "";
    if (aud.startsWith("agents:")) for (const id of aud.slice(7).split(",")) { if (id) targets.add(id); }
    else if (aud === "lead-only") { const lead = nearestReportTarget(from, byId); if (lead) targets.add(lead); }
    for (const to of targets) if (to !== from && present.has(to)) out.add(pairKey(from, to));
  }
  return out;
}

function buildCommAdj(edges: { source: string; target: string }[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!m.has(e.source)) m.set(e.source, new Set());
    if (!m.has(e.target)) m.set(e.target, new Set());
    m.get(e.source)!.add(e.target);
    m.get(e.target)!.add(e.source);
  }
  return m;
}

const ROLE_ICONS: Record<string, LucideIcon> = {
  ceo: Star, lead: Users, dev: Code2, test: FlaskConical,
  security: Shield, ops: Server, architect: Compass,
};

const PROVIDER_ICONS: Record<string, string> = {
  deepseek: "DS", minimax: "MM", doubao: "DB",
  openai: "OA", anthropic: "AN", openrouter: "OR", ollama: "OL",
};

// Concise engine labels for the node hover cards — 异构 agent 一眼可辨用哪个执行框架。
// hermes 键保留 = 读侧兼容存量数据(旧 agents/旧模板仍可能带 "hermes" 原始值)。
const FRAMEWORK_LABELS: Record<string, string> = {
  api: "API", hermes: "API", "claude-code": "Claude Code", codex: "Codex",
  "gemini-cli": "Gemini CLI", "kimi-cli": "Kimi CLI", "grok-build": "Grok Build",
};

/* ────────── Helpers ────────── */

function computeTeamStats(agentId: string, agents: AgentNodeConfig[]) {
  const visited = new Set<string>();
  const queue = [agentId];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const a = agents.find(x => x.id === id);
    if (a) for (const cid of a.childrenIds) queue.push(cid);
  }
  visited.delete(agentId);
  let totalTokens = 0;
  for (const a of agents) {
    if (visited.has(a.id)) {
      totalTokens += a.tokenUsage.total;
    }
  }
  return { totalTokens, agentCount: visited.size };
}

function getDescendantIds(agentId: string, agents: AgentNodeConfig[]): Set<string> {
  const descendants = new Set<string>([agentId]);
  const queue = [agentId];
  while (queue.length) {
    const id = queue.shift()!;
    const a = agents.find(x => x.id === id);
    if (a) {
      for (const cid of a.childrenIds) {
        if (!descendants.has(cid)) {
          descendants.add(cid);
          queue.push(cid);
        }
      }
    }
  }
  return descendants;
}

/* ────────── CEO Node ────────── */

// Heuristic: a "weak" model the CEO probably shouldn't run on (CEO does planning/decomposition).
function isWeakModel(model: string): boolean {
  return /flash|mini|haiku|lite|small|nano|tiny|[0-9]b\b/i.test(model || "");
}

function CeoNode({ data }: NodeProps<AgentNodeConfig>) {
  const tr = useT();
  const select = useAgentStore(s => s.select);
  const [hovering, setHovering] = useState(false);
  const color = STATUS_COLORS[data.status] ?? "var(--color-ink-muted)";
  const isWorking = isBusyStatus(data.status); // 11 态:thinking/using_tool/reviewing 同属"正在干活"
  // C6 · 失败红闪:直接读既有 status 字段(不是事件流派生——见 collabLines.ts 顶部注释,这一根
  // "线/节点动画"用现有数据即可,不需要额外的 committed-event 派生管线)。
  const failedFlash = data.status === "failed";
  // Narrow selector: recomputes on every store change (cheap — a filter/BFS over `agents`), but
  // React only re-renders this node when the *returned numbers* actually change (shallow compare),
  // instead of on every unrelated agent update like the old `useAgentStore(s => s.agents)` did.
  const { totalTokens: teamTokens, agentCount, teamCount } = useAgentStore(useShallow(s => {
    const stats = computeTeamStats(data.id, s.agents);
    const teamCount = s.agents.filter(a => a.parentId === data.id && a.role === "lead").length;
    return { ...stats, teamCount };
  }));
  const stats = { totalTokens: teamTokens, agentCount };
  const { selected, dimmed } = useFocusState(data.id, data.parentId, data.childrenIds);
  const tokens = data.tokenUsage?.total ?? 0;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("org-context-menu", {
      detail: { agentId: data.id, x: e.clientX, y: e.clientY }
    }));
  };

  return (
    <div
      className="relative cursor-pointer select-none"
      style={{ width: 176, height: 168, opacity: dimmed ? 0.3 : 1, transition: "opacity 200ms" }}
      onClick={() => select(data.id)}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      title={`${data.name} · CEO · ${data.provider}/${data.model}`}
    >
      <Handle id="s-top" type="source" position={Position.Top} className="org-handle" />
      <Handle id="t-top" type="target" position={Position.Top} className="org-handle" />
      <Handle id="s-bottom" type="source" position={Position.Bottom} className="org-handle" />
      <Handle id="t-bottom" type="target" position={Position.Bottom} className="org-handle" />
      <Handle id="s-left" type="source" position={Position.Left} className="org-handle" />
      <Handle id="t-left" type="target" position={Position.Left} className="org-handle" />
      <Handle id="s-right" type="source" position={Position.Right} className="org-handle" />
      <Handle id="t-right" type="target" position={Position.Right} className="org-handle" />

      {/* Hover info card */}
      {hovering && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none rounded-lg border border-hairline bg-surface-1 px-3 py-2.5 text-left"
          style={{ bottom: 96, width: 230, boxShadow: "var(--shadow-md)" }}
        >
          <div className="text-[12px] font-semibold text-ink truncate">{data.name}</div>
          <div className="text-[10px] text-ink-subtle mb-1.5 truncate">CEO · {data.provider}/{data.model}</div>
          {data.framework && (
            <div className="mb-2">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                style={{ background: "var(--color-surface-2)", color: "var(--color-ink-muted)" }}>
                <Bot size={9} />{FRAMEWORK_LABELS[data.framework] ?? data.framework}
              </span>
            </div>
          )}
          {cleanText(data.currentTask) && (
            <div className="text-[11px] text-ink-muted mb-2 leading-snug line-clamp-2">{cleanText(data.currentTask)}</div>
          )}
          <div className="flex items-center gap-2.5 text-[10px] text-ink-muted">
            <span className="inline-flex items-center gap-1" style={{ color }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
              {statusLabel(tr, data.status)}
            </span>
            <span>{tr('org.memberCount', { n: stats.agentCount })}</span>
            <span>{tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok</span>
          </div>
          {data.lastAction && (
            <div className="text-[10px] text-ink-subtle truncate mt-1.5">↳ {cleanText(data.lastAction)}</div>
          )}
        </div>
      )}

      {/* Core glow — restrained: a dignified hint of presence, not a spotlight */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: 320, height: 188, left: -46, top: -48,
          background: "radial-gradient(ellipse, rgba(2,133,255,0.14) 0%, rgba(2,133,255,0.05) 45%, transparent 70%)",
          filter: "blur(28px)",
        }}
      />

      {/* Card body — 竖版王座工牌:渐变描边伪边框,星徽大头像居中,名号+统计居中在下 */}
      <div
        className="absolute inset-0 transition-all duration-200"
        style={{
          borderRadius: 18,
          padding: 1,
          background: selected
            ? "linear-gradient(160deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 70%, black))"
            : "linear-gradient(160deg, rgba(2,133,255,0.6), rgba(2,133,255,0.24) 50%, rgba(255,255,255,0.09))",
          boxShadow: selected ? "0 0 0 4px rgba(2,133,255,0.16), var(--node-shadow)" : "var(--node-shadow)",
          transform: hovering ? "translateY(-2px)" : "none",
          animation: failedFlash ? "org-node-failed-flash 1.3s ease-in-out infinite" : "none",
        }}
      >
        <div className="w-full h-full flex flex-col items-center justify-center px-3" style={{ borderRadius: 17, background: "var(--node-surface-lead)", boxShadow: "var(--node-sheen)" }}>
          {/* 星徽大头像 — CEO 唯一的高光特权 */}
          <div className="relative shrink-0 flex items-center justify-center"
            style={{ width: 58, height: 58, borderRadius: 17, background: "linear-gradient(145deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 80%, black) 72%)", boxShadow: "0 6px 16px rgba(2,133,255,0.45), inset 0 1.5px 0 rgba(255,255,255,0.28)" }}>
            <Star size={27} className="text-white" strokeWidth={2} fill="rgba(255,255,255,0.92)" />
            <span className="absolute rounded-full" style={{ top: -3, right: -3, width: 12, height: 12, background: color, boxShadow: `0 0 0 2.5px var(--node-surface-lead), 0 0 8px ${color}`, animation: isWorking ? "agent-pulse 1.8s ease-in-out infinite" : "none" }} />
          </div>
          <div className="w-full flex flex-col items-center text-center" style={{ marginTop: 9 }}>
            <div className="text-[15px] font-semibold text-ink truncate leading-tight w-full" style={{ letterSpacing: "-0.01em" }}>{data.name}</div>
            <div className="flex items-center justify-center gap-1.5 mt-[4px]">
              <span className="px-1.5 py-[1.5px] rounded-md text-[10px] font-bold tracking-[0.14em] bg-accent/20 text-accent">CEO</span>
              <span className="text-[10px] text-ink-subtle tabular-nums inline-flex items-center gap-1"><Users size={10} />{stats.agentCount}</span>
              <span className="text-[10px] text-ink-subtle tabular-nums">{stats.totalTokens >= 1000 ? `${(stats.totalTokens / 1000).toFixed(1)}k` : stats.totalTokens} tok</span>
              {isWeakModel(data.model) && <span title={tr('org.weakModelWarning')} className="text-[10px]" style={{ color: "var(--color-warning)" }}>⚠</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────── Agent Node ────────── */

// Node footprints by role — CEO largest, Lead medium, Worker smallest (visual weight = hierarchy).
// These MUST equal the size each card component actually renders at (CeoNode/AgentNode) — the tree
// layout below packs rows/grids using these exact numbers, so any drift causes cards to overlap or
// leave uneven gaps.
// 竖版"人物工牌"(组织架构图的经典语言:大头像在上、名字居中在下,一眼一个"人"),
// 替代横条列表卡——横条怎么排都像浮在画布上的列表项,这是"丑"的根源之一。
function nodeSize(role: string): { w: number; h: number } {
  if (role === "ceo") return { w: 176, h: 168 };
  if (role === "lead") return { w: 148, h: 156 };
  return { w: 132, h: 144 };
}

// 模型名太长(doubao-seed-2-0-pro-260215)撑爆徽标——去日期尾巴/版本噪声,保留可识别主干。
function shortModel(m: string): string {
  const s = (m || "").replace(/-\d{6,}$/, "").replace(/^anthropic\/|^openai\/|^deepseek\/|^google\//, "");
  return s.length > 16 ? s.slice(0, 15) + "…" : s;
}

// Worker "what's it doing right now" bubble — rule-based (no LLM), throttled to ≥1s so a fast token
// stream doesn't repaint the DOM on every chunk. `signal` is a cheap narrow-selector snapshot (this
// agent's latest relevant event id + its output-chunk buffer length) via useShallow, so the effect
// only re-fires when something actually changed for THIS agent — never on unrelated agents' updates.
function useAgentActivityLabel(agentId: string, active: boolean): string | null {
  const tr = useT();
  // tr's identity changes on every render (useT returns a fresh closure) — keep the latest one in a
  // ref instead of the effect's dep array, so a re-render that doesn't actually change `signal`
  // doesn't re-arm the throttle timer (that would turn "≥1s" into "every render, at least 1s apart").
  const trRef = useRef(tr);
  trRef.current = tr;
  const signal = useAgentStore(useShallow(s => {
    const chunkLen = s.outputChunks[agentId]?.length ?? 0;
    let lastEvId: string | null = null;
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i];
      if (e.agentId !== agentId) continue;
      if (e.type === "tool_call" || e.type === "model_call_started" || e.type === "agent_status_changed") { lastEvId = e.id; break; }
    }
    return { chunkLen, lastEvId };
  }));
  const [label, setLabel] = useState<string | null>(null);
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      setLabel(null);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    const compute = () => {
      const s = useAgentStore.getState();
      setLabel(deriveActivityLabel(agentId, s.events, s.outputChunks[agentId], name => trRef.current("org.node.usingTool", { name })));
      lastRunRef.current = Date.now();
      timerRef.current = null;
    };
    if (timerRef.current) return; // an update is already scheduled — it'll pick up the freshest state when it fires
    const elapsed = Date.now() - lastRunRef.current;
    if (elapsed >= 1000) compute();
    else timerRef.current = setTimeout(compute, 1000 - elapsed);
  }, [signal, active, agentId]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return label;
}

// "刚完成" flash — a brief success glow the instant this agent's status flips to idle/done straight
// out of a run. Baselines silently on mount (so historical events already in the store don't flash
// stale completions) and only fires on a genuinely NEW completion event arriving afterward.
function useJustCompletedFlash(agentId: string): boolean {
  const lastDone = useAgentStore(useShallow(s => {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i];
      if (e.agentId !== agentId || e.type !== "agent_status_changed") continue;
      const st = (e.payload as { status?: string } | undefined)?.status;
      return st === "idle" || st === "done" ? { id: e.id } : null;
    }
    return null;
  }));
  const [flash, setFlash] = useState(false);
  const seenRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = lastDone?.id ?? null;
    if (seenRef.current === undefined) { seenRef.current = id; return; }
    if (id && id !== seenRef.current) {
      seenRef.current = id;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 900);
      return () => clearTimeout(t);
    }
    seenRef.current = id;
  }, [lastDone]);
  return flash;
}

function AgentNode({ data }: NodeProps<AgentNodeConfig>) {
  const tr = useT();
  const select = useAgentStore(s => s.select);
  const update = useAgentStore(s => s.update);
  const [hovering, setHovering] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editNameVal, setEditNameVal] = useState(data.name);
  const { selected, dimmed } = useFocusState(data.id, data.parentId, data.childrenIds);

  const isLead = data.role === "lead";
  const color = STATUS_COLORS[data.status] ?? "var(--color-ink-muted)";
  const roleLabel = ROLE_LABELS[data.role] || data.role;
  const isWorking = isBusyStatus(data.status); // 11 态:thinking/using_tool/reviewing 同属"正在干活"
  // C6 · 失败红闪:直接读既有 status 字段(见 CeoNode 同名变量注释)。失败态优先于"刚完成"闪光——
  // 两者极少同时发生,失败更需要持续可见,不该被 900ms 的一次性成功动画抢先结束。
  const failedFlash = data.status === "failed";
  const RoleIcon = ROLE_ICONS[data.role] || Bot;
  const tokens = data.tokenUsage?.total ?? 0;
  const { w, h } = nodeSize(data.role);
  // 命令波纹:工作中头顶浮一句"在做什么"(节流 ≥1s,规则化提炼,不调 LLM);完成瞬间闪一下 + 简报栏同步推送。
  const activityLabel = useAgentActivityLabel(data.id, isWorking);
  const justCompleted = useJustCompletedFlash(data.id);

  // Team lead id + team member count: narrow selectors returning primitives (string|null, number),
  // so a re-render only happens when THIS node's own derived value actually changes — not on every
  // unrelated agent update in the store (the old code subscribed to the whole `agents` array and
  // rebuilt a full id→agent Map every render just to answer these two small questions).
  const teamLeadId = useAgentStore(useCallback(
    s => (isLead ? data.id : leadIdOf(data, id => s.agents.find(a => a.id === id))),
    [isLead, data],
  ));
  const teamCount = useAgentStore(useCallback(
    s => (isLead ? s.agents.filter(a => a.parentId === data.id).length : 0),
    [isLead, data.id],
  ));
  // Team color: a lead uses its own; a worker inherits its lead's. Comes from the same-render
  // context computeLayout derives (see OrgDerivedContext) — not a module-level singleton.
  const { teamColors } = useContext(OrgDerivedContext);
  const team = (teamLeadId && teamColors.get(teamLeadId)) || null;

  // Role color lives ONLY at the avatar (icon + ring) — a muted, restrained identity cue. Team color
  // is a separate, even quieter detail (small dot + halo), never the card's main border.
  const roleColor = ROLE_COLORS[data.role] ?? "var(--color-ink-subtle)";
  const teamAccent = team?.base ?? "var(--color-accent)";
  const ringColor = selected ? "var(--color-accent)"
    : isActiveStatus(data.status) ? color
    : isLead ? (team?.ring ?? "var(--color-hairline-light)")
    : "var(--color-hairline-light)";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("org-context-menu", {
      detail: { agentId: data.id, x: e.clientX, y: e.clientY }
    }));
  };

  const handleRenameSave = () => {
    if (editNameVal.trim() && editNameVal !== data.name) {
      update(data.id, { name: editNameVal.trim() });
    }
    setEditingName(false);
  };

  useEffect(() => {
    const startRename = () => { setEditingName(true); setEditNameVal(data.name); };
    window.addEventListener(`org-rename-${data.id}`, startRename);
    return () => window.removeEventListener(`org-rename-${data.id}`, startRename);
  }, [data.id, data.name]);

  const avatar = isLead ? 54 : 48;

  return (
    <div className="relative" style={{ width: w, height: h, opacity: dimmed ? 0.2 : 1, transition: "opacity 200ms" }}>
      <Handle id="s-top" type="source" position={Position.Top} className="org-handle" />
      <Handle id="t-top" type="target" position={Position.Top} className="org-handle" />
      <Handle id="s-bottom" type="source" position={Position.Bottom} className="org-handle" />
      <Handle id="t-bottom" type="target" position={Position.Bottom} className="org-handle" />
      <Handle id="s-left" type="source" position={Position.Left} className="org-handle" />
      <Handle id="t-left" type="target" position={Position.Left} className="org-handle" />
      <Handle id="s-right" type="source" position={Position.Right} className="org-handle" />
      <Handle id="t-right" type="target" position={Position.Right} className="org-handle" />

      {/* Hover detail card — keeps the default card minimal; full detail lives here + side panel */}
      {hovering && !editingName && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none rounded-lg border border-hairline bg-surface-1 px-3 py-2.5 text-left"
          style={{ bottom: h + 8, width: 220, boxShadow: "var(--shadow-md)" }}
        >
          <div className="text-[12px] font-semibold text-ink truncate">{data.name}</div>
          <div className="text-[10px] text-ink-subtle mb-1.5 truncate">{roleLabel} · {data.provider}/{data.model}</div>
          {data.framework && (
            <div className="mb-2">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                style={{ background: "var(--color-surface-2)", color: "var(--color-ink-muted)" }}>
                <Bot size={9} />{FRAMEWORK_LABELS[data.framework] ?? data.framework}
              </span>
            </div>
          )}
          {cleanText(data.currentTask) && (
            <div className="text-[11px] text-ink-muted mb-2 leading-snug line-clamp-2">{cleanText(data.currentTask)}</div>
          )}
          <div className="flex items-center gap-2.5 text-[10px] text-ink-muted">
            <span className="inline-flex items-center gap-1" style={{ color }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
              {statusLabel(tr, data.status)}
            </span>
            <span>{tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok</span>
          </div>
          {data.lastAction && (
            <div className="text-[10px] text-ink-subtle truncate mt-1.5">↳ {cleanText(data.lastAction)}</div>
          )}
        </div>
      )}

      {/* 工作中头顶气泡:当前在做什么(hover 详情卡已经更全,悬停时让位给它,避免同处叠两张卡)。
          v8: 颜色跟随"工作中=橙"语义(以前硬编码绿——绿现在是空闲,和气泡出现的时机语义相反)。 */}
      {isWorking && !hovering && !editingName && (
        <div
          className="org-activity-bubble absolute left-1/2 -translate-x-1/2 z-40 pointer-events-none px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap overflow-hidden text-ellipsis"
          style={{ bottom: h + 6, maxWidth: 200, background: "color-mix(in srgb, var(--color-warning) 16%, transparent)", color: "var(--color-warning)", border: "1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)" }}
        >
          {activityLabel || tr("org.node.thinking")}
        </div>
      )}

      {/* Card body — 高两档卡面 + 顶缘高光 + 深投影(悬浮感);工作中橙色微光,选中 accent 环。
          lead 卡左缘一条团队色 accent 条(比整圈染色克制,又一眼认队)。 */}
      <div
        className="absolute inset-0 flex items-center cursor-pointer select-none transition-all duration-200"
        style={{
          flexDirection: "column",
          justifyContent: "center",
          gap: 0,
          paddingTop: isLead ? 14 : 12, paddingBottom: 10, paddingLeft: 10, paddingRight: 10,
          borderRadius: 16,
          background: isLead ? "var(--node-surface-lead)" : "var(--node-surface)",
          border: `1px solid ${failedFlash ? "color-mix(in srgb, var(--color-error) 60%, transparent)" : selected ? "var(--color-accent)" : isWorking ? "color-mix(in srgb, var(--color-warning) 50%, transparent)" : hovering ? "var(--node-border-strong)" : "var(--node-border)"}`,
          boxShadow: selected
            ? "0 0 0 3px rgba(2,133,255,0.16), var(--node-shadow), var(--node-sheen)"
            : isWorking
              ? "0 0 20px color-mix(in srgb, var(--color-warning) 16%, transparent), var(--node-shadow), var(--node-sheen)"
              : "var(--node-shadow), var(--node-sheen)",
          transform: hovering ? "translateY(-2px)" : "none",
          animation: failedFlash ? "org-node-failed-flash 1.3s ease-in-out infinite" : justCompleted ? "agent-flash 900ms ease-out" : "none",
        }}
        onClick={() => select(data.id)}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        title={`${data.name} · ${roleLabel} · ${data.provider}`}
      >
        {/* lead 顶缘团队色条(竖版工牌的"队色领带") */}
        {isLead && team && (
          <span className="absolute rounded-full" style={{ top: 0, left: 18, right: 18, height: 3, background: teamAccent, opacity: 0.9 }} />
        )}
        {/* 大头像居中在上 — 角色色渐变"证件照",状态点戴右上角 */}
        <div className="relative shrink-0 flex items-center justify-center"
          style={{
            width: avatar, height: avatar, borderRadius: 15,
            background: `linear-gradient(150deg, color-mix(in srgb, ${roleColor} 52%, var(--node-surface)), color-mix(in srgb, ${roleColor} 30%, var(--node-surface)))`,
            border: `1px solid color-mix(in srgb, ${roleColor} 62%, transparent)`,
            boxShadow: "inset 0 1.5px 0 rgba(255,255,255,0.16), 0 4px 10px rgba(0,0,0,0.25)",
          }}>
          <RoleIcon size={isLead ? 24 : 22} strokeWidth={1.9} style={{ color: "rgba(255,255,255,0.94)" }} />
          <span className="absolute rounded-full"
            style={{ top: -3, right: -3, width: 12, height: 12, background: color, boxShadow: `0 0 0 2.5px var(--node-surface), 0 0 8px ${color}`, animation: isWorking ? "agent-pulse 1.8s ease-in-out infinite" : "none" }} />
        </div>

        {/* 名字/角色/模型 居中排版 */}
        <div className="w-full min-w-0 flex flex-col items-center text-center" style={{ marginTop: 9 }}>
          {editingName ? (
            <input
              value={editNameVal}
              onChange={e => setEditNameVal(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleRenameSave(); if (e.key === "Escape") setEditingName(false); }}
              onBlur={handleRenameSave}
              autoFocus
              className="w-full bg-transparent border-0 border-b border-accent text-[13px] font-semibold outline-none text-ink px-0 py-0 text-center"
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <>
              <div className="w-full text-[14px] font-semibold leading-tight truncate" style={{ color: "var(--color-ink)", letterSpacing: "-0.01em" }} title={data.name}>{data.name}</div>
              <div className="flex items-center justify-center gap-1 mt-[3px] min-w-0 w-full">
                {isLead && (
                  <span className="px-1 py-[1px] rounded-full text-[10px] font-bold shrink-0"
                    style={{ background: `color-mix(in srgb, ${teamAccent} 20%, transparent)`, color: `color-mix(in srgb, ${teamAccent} 65%, var(--color-ink))` }}>Lead</span>
                )}
                <span className="text-[10px] font-medium tracking-wide truncate" style={{ color: `color-mix(in srgb, ${roleColor} 70%, var(--color-ink-muted))` }}>
                  {roleLabel}{isLead ? ` · ${teamCount}` : ""}
                </span>
              </div>
              <span className="mt-[5px] px-1.5 py-[1.5px] rounded-md text-[10px] font-medium truncate"
                style={{ maxWidth: "92%", background: "color-mix(in srgb, var(--color-ink-muted) 13%, transparent)", color: "var(--color-ink-muted)", border: "1px solid var(--node-border)" }}>{shortModel(data.model)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────── Team Region (soft backdrop panel + label, behind everything) ────────── */

interface TeamRegionData { color: TeamColor; label: string; w: number; h: number; count: number; }

function TeamRegionNode({ data }: NodeProps<TeamRegionData>) {
  return (
    <div className="pointer-events-none relative" style={{ width: data.w, height: data.h }}>
      {/* 团队"部门区":可感知的染色面板(团队色 6% 填充 + 18% 描边)+ 左上悬挂标签药丸——
          之前 2% 填充在画布上等于不存在,部门感全靠脑补。 */}
      <div className="absolute" style={{
        inset: 0, borderRadius: 18,
        background: `color-mix(in srgb, ${data.color.base} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${data.color.base} 18%, transparent)`,
      }} />
      <div className="absolute inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[10px] font-semibold whitespace-nowrap"
        style={{
          left: 14, top: -11,
          background: `color-mix(in srgb, ${data.color.base} 22%, var(--color-canvas))`,
          border: `1px solid color-mix(in srgb, ${data.color.base} 40%, transparent)`,
          color: `color-mix(in srgb, ${data.color.base} 60%, var(--color-ink))`,
        }}>
        {data.label}
        <span className="opacity-70">· {data.count}</span>
      </div>
    </div>
  );
}

/* ────────── Hierarchical tree layout ────────── */

function cleanTeamLabel(name: string): string {
  const base = name.replace(/\b(lead|manager|team)\b/gi, "").replace(/(主管|负责人|经理|团队|组)/g, "").trim();
  return (base || name) + " Team";
}

// Lateral (peer/cross) edges vary in direction, so their handle is still picked from source→target
// geometry. Hierarchy edges never need this (see hierEdge below) — in a strict top-down tree a child
// is always directly below its parent, so they always run bottom→top.
function handlesFor(s: { x: number; y: number }, t: { x: number; y: number }) {
  const dx = t.x - s.x, dy = t.y - s.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { sourceHandle: "s-right", targetHandle: "t-left" } : { sourceHandle: "s-left", targetHandle: "t-right" };
  }
  return dy >= 0 ? { sourceHandle: "s-bottom", targetHandle: "t-top" } : { sourceHandle: "s-top", targetHandle: "t-bottom" };
}

// Layout constants (classic org-chart proportions): generous layer gap so the CEO→lead→worker rows
// read as distinct tiers, a tight sibling gap so a team reads as one group, and a wider gap between
// different top-level teams so the whole canvas doesn't read as one undifferentiated grid.
const LAYER_GAP = 92;
const SIBLING_GAP = 30;
const TEAM_GAP = 72;
const ROW_GAP = 26;
const MAX_PER_ROW = 6;
const REGION_PAD = 20;
const REGION_LABEL_H = 26;

// prevTeamColors: the team-color assignment from the last GLOBAL-view computeLayout call. Team-focus
// view doesn't reassign colors, it just looks up what global view already picked (so a team keeps its
// color when you zoom into it) — this is genuine cross-call memory, not render-phase mutation of a
// shared singleton: the caller owns it (a ref) and only the caller writes it back, in an effect.
function computeLayout(agents: AgentNodeConfig[], focusAgentId?: string | null, collabOverride?: CollabEdge[], prevTeamColors?: Map<string, TeamColor>) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const centers = new Map<string, { x: number; y: number }>();
  const nodes: any[] = [];
  const edges: any[] = [];
  const teamColors = new Map<string, TeamColor>();
  const childrenOf = (id: string) => agents.filter(a => a.parentId === id);
  // 大团队换行后,第 2 排起不画 lead→worker 连线(肘线垂直段会穿过第 1 排/戳穿本排卡片,
  // 用户截图实锤"相互覆盖")。归属感由部门底板表达——经典组织图软件的同款取舍。
  const noEdgeKids = new Set<string>();
  let leadPalette = 0;

  const nodeOf = (a: AgentNodeConfig, c: { x: number; y: number }) => {
    const { w, h } = nodeSize(a.role);
    // Manual drag position wins over the computed tree slot (free-drag persistence).
    const center = a.uiPosition ? { x: a.uiPosition.x + w / 2, y: a.uiPosition.y + h / 2 } : c;
    centers.set(a.id, center);
    return {
      id: a.id,
      type: a.role === "ceo" ? ("ceoNode" as const) : ("agentNode" as const),
      position: a.uiPosition ?? { x: center.x - w / 2, y: center.y - h / 2 },
      data: a,
      zIndex: 2,
    };
  };
  const regionNode = (id: string, x: number, y: number, w: number, h: number, color: TeamColor, label: string, count: number) => ({
    id: `region-${id}`, type: "teamRegion" as const,
    position: { x, y },
    data: { color, label, w, h, count }, zIndex: 0, selectable: false, draggable: false,
    className: "org-region-node",
  });
  // A child is always LAYER_GAP below its parent in this layout, so the connector always runs from
  // the parent's bottom edge to the child's top edge — a clean vertical-first elbow, no zig-zag.
  const hierEdge = (source: string, target: string) => ({
    id: `${source}->${target}`, source, target,
    sourceHandle: "s-bottom", targetHandle: "t-top",
    type: "smoothstep" as const, pathOptions: { borderRadius: 10 }, data: { kind: "hier" as const },
  });
  const collabEdge = (e: CollabEdge) => ({
    ...e,
    ...handlesFor(centers.get(e.source) ?? { x: 0, y: 0 }, centers.get(e.target) ?? { x: 0, y: 0 }),
    type: "smoothstep" as const, pathOptions: { borderRadius: 10 }, data: { kind: e.kind, status: e.status },
  });

  // ── measure(): post-order pass. Every node gets a subtree "slot width" — its own width, or (if it
  // has children) the width needed to lay its children out, whichever is larger. A lead with many
  // plain workers (no children of their own) wraps into a compact multi-row grid instead of one very
  // wide line, so a big team still reads as "one screen", not a horizontal scrollbar. ──
  interface Measured {
    node: AgentNodeConfig; width: number; height: number;
    layout: null
      | { type: "row"; kids: Measured[] }
      | { type: "grid"; kids: AgentNodeConfig[]; cols: number; rows: number; cw: number; ch: number };
  }
  // 组内结构:按职能排序聚类(架构→前后端开发→ML→测试→安全→运维→文档→其他),
  // 同职能的工牌相邻,一排读下来就是"部门的岗位结构",不是乱序花名册。
  const ROLE_ORDER: Record<string, number> = {
    architect: 0, dev: 1, frontend: 1, backend: 1, fullstack: 1, ml: 2, ml_engineer: 2,
    test: 3, qa: 3, tester: 3, security: 4, security_reviewer: 4, code_reviewer: 4,
    ops: 5, devops: 5, docs: 6, writer: 6, pm: 7,
  };
  const roleRank = (r: string) => ROLE_ORDER[r] ?? 8;
  const measure = (a: AgentNodeConfig): Measured => {
    const { w: ownW, h: ownH } = nodeSize(a.role);
    const kids = [...childrenOf(a.id)].sort((x, y) => roleRank(x.role) - roleRank(y.role) || x.name.localeCompare(y.name));
    if (!kids.length) return { node: a, width: ownW, height: ownH, layout: null };
    const allPlainWorkers = kids.every(k => childrenOf(k.id).length === 0 && k.role !== "lead");
    if (allPlainWorkers && kids.length > MAX_PER_ROW) {
      const cols = MAX_PER_ROW;
      const rows = Math.ceil(kids.length / cols);
      const { w: cw, h: ch } = nodeSize(kids[0].role);
      const gridW = cols * cw + (cols - 1) * SIBLING_GAP;
      const gridH = rows * ch + (rows - 1) * ROW_GAP;
      return { node: a, width: Math.max(ownW, gridW), height: ownH + LAYER_GAP + gridH, layout: { type: "grid", kids, cols, rows, cw, ch } };
    }
    const kidMeasures = kids.map(measure);
    const rowW = kidMeasures.reduce((s, m) => s + m.width, 0) + SIBLING_GAP * Math.max(kids.length - 1, 0);
    const rowH = Math.max(...kidMeasures.map(m => m.height));
    return { node: a, width: Math.max(ownW, rowW), height: ownH + LAYER_GAP + rowH, layout: { type: "row", kids: kidMeasures } };
  };

  // ── place(): pre-order pass. Centers `node` at (centerX, topY..topY+ownH), then lays its children
  // in a row (or grid) directly beneath it. `drawRegion` is only true for a lead that IS a top-level
  // team (global view's CEO-children, or the focused lead in team view) — nested leads-under-leads
  // don't get their own nested panel, keeping the canvas from turning into a fractal of boxes. ──
  const place = (m: Measured, centerX: number, topY: number, teamColor: TeamColor | null, drawRegion: boolean) => {
    const a = m.node;
    const { h: ownH } = nodeSize(a.role);
    nodes.push(nodeOf(a, { x: centerX, y: topY + ownH / 2 }));

    let childTeam = teamColor;
    if (a.role === "lead") {
      const tc = teamColor ?? teamColorForLead(a, leadPalette++);
      teamColors.set(a.id, tc);
      childTeam = tc;
    }
    if (!m.layout) return;
    const childTopY = topY + ownH + LAYER_GAP;

    if (m.layout.type === "grid") {
      const { kids, cols, cw, ch } = m.layout;
      kids.forEach((k, i) => {
        const row = Math.floor(i / cols);
        const itemsInRow = Math.min(cols, kids.length - row * cols);
        const rowW = itemsInRow * cw + (itemsInRow - 1) * SIBLING_GAP;
        const col = i % cols;
        const kx = centerX - rowW / 2 + cw / 2 + col * (cw + SIBLING_GAP);
        const ky = childTopY + row * (ch + ROW_GAP) + ch / 2;
        if (row > 0) noEdgeKids.add(k.id);
        nodes.push(nodeOf(k, { x: kx, y: ky }));
      });
    } else {
      const { kids } = m.layout;
      const rowW = kids.reduce((s, k) => s + k.width, 0) + SIBLING_GAP * Math.max(kids.length - 1, 0);
      let cur = centerX - rowW / 2;
      for (const k of kids) {
        place(k, cur + k.width / 2, childTopY, childTeam, false);
        cur += k.width + SIBLING_GAP;
      }
    }

    // Region backdrop: measured from the ACTUAL placed positions of every descendant, read back out
    // of `centers` (the same map nodeOf() writes to — including a manual/seed uiPosition override),
    // instead of re-deriving a box from the measure()/place() abstract width/height bookkeeping above.
    // That used to be two parallel coordinate systems that only agreed by coincidence: nodeOf() already
    // prefers `a.uiPosition` over the computed tree slot when present (free-drag persistence, and every
    // agent in a hand-assembled multi-department seed template carries one), but the panel math never
    // consulted uiPosition at all — so a company like the 28-agent/4-layer one-person-company rendered
    // its cards at their seed-authored positions while the color panel floated wherever the generic
    // tree layout *would* have put a from-scratch company, nowhere near the real cards (confirmed
    // numerically: the product-department panel landed at y:462..920 while its cards sit at y:80..544).
    // Building the box from real placed bounds instead is correct-by-construction — it can never be
    // smaller than, or offset from, the nodes it's supposed to backdrop, regardless of how many levels
    // of nested-lead grid-wrapping or manual dragging happened underneath.
    if (a.role === "lead" && drawRegion) {
      const descIds = getDescendantIds(a.id, agents);
      descIds.delete(a.id);
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const did of descIds) {
        const c = centers.get(did);
        if (!c) continue;
        const { w: dw, h: dh } = nodeSize(byId.get(did)?.role ?? "worker");
        left = Math.min(left, c.x - dw / 2);
        right = Math.max(right, c.x + dw / 2);
        top = Math.min(top, c.y - dh / 2);
        bottom = Math.max(bottom, c.y + dh / 2);
      }
      if (left <= right) {
        const panelW = (right - left) + REGION_PAD * 2, panelH = (bottom - top) + REGION_PAD * 2 + REGION_LABEL_H;
        nodes.unshift(regionNode(a.id, left - REGION_PAD, top - REGION_PAD - REGION_LABEL_H, panelW, panelH, childTeam!, cleanTeamLabel(a.name), descIds.size));
      }
    }
  };

  // ── Team-focus view: the focused lead becomes the tree root (its own recursive team laid out below
  // it), with the CEO redrawn above + a hierarchy edge down, exactly the same shape as the global view
  // just re-rooted — no separate radial code path to maintain. ──
  if (focusAgentId && byId.has(focusAgentId)) {
    const focus = byId.get(focusAgentId)!;
    const tc = prevTeamColors?.get(focusAgentId) ?? teamColorForLead(focus, 0);
    const ceo = agents.find(a => a.role === "ceo");
    const showCeo = !!ceo && focus.parentId === ceo.id;

    let rootTopY = 0;
    if (showCeo) {
      const ceoH = nodeSize("ceo").h;
      nodes.push(nodeOf(ceo!, { x: 0, y: ceoH / 2 })); // nodeOf's 2nd arg is a CENTER — this keeps the CEO's top edge at y=0
      rootTopY = ceoH + LAYER_GAP;
    }
    place(measure(focus), 0, rootTopY, tc, true);

    for (const a of agents) {
      if (!centers.has(a.id)) continue;
      for (const cid of a.childrenIds) if (centers.has(cid) && !noEdgeKids.has(cid)) edges.push(hierEdge(a.id, cid));
    }
    if (showCeo) edges.push(hierEdge(ceo!.id, focusAgentId));

    const vis = new Set(nodes.filter(n => n.type !== "teamRegion").map(n => n.id));
    const collab = (collabOverride ?? deriveCollabEdges(agents)).filter(e => vis.has(e.source) && vis.has(e.target));
    const commAdj = buildCommAdj(collab);
    for (const e of collab) edges.push(collabEdge(e));
    return { nodes, edges, commAdj, teamColors };
  }

  // ── Global view: CEO on top, its teams (leads + their workers) laid out left→right below it, extra
  // whitespace between teams; any direct report with no lead just hangs off the CEO as a bare card. ──
  const ceo = agents.find(a => a.role === "ceo");
  if (!ceo) {
    const cols = Math.min(MAX_PER_ROW, agents.length || 1);
    agents.forEach((a, i) => {
      const { w, h } = nodeSize(a.role);
      const row = Math.floor(i / cols);
      const itemsInRow = Math.min(cols, agents.length - row * cols);
      const rowW = itemsInRow * (w + SIBLING_GAP) - SIBLING_GAP;
      const col = i % cols;
      nodes.push(nodeOf(a, { x: -rowW / 2 + w / 2 + col * (w + SIBLING_GAP), y: row * (h + ROW_GAP) + h / 2 }));
    });
    return { nodes, edges, commAdj: new Map<string, Set<string>>(), teamColors };
  }

  const ceoH = nodeSize("ceo").h;
  nodes.push(nodeOf(ceo, { x: 0, y: ceoH / 2 })); // nodeOf's 2nd arg is a CENTER — this keeps the CEO's top edge at y=0
  const top = childrenOf(ceo.id);
  for (const a of agents) if (a.id !== ceo.id && !top.includes(a) && (!a.parentId || !byId.has(a.parentId))) top.push(a);

  let maxBottom = ceoH;
  if (top.length) {
    const rowTopY = ceoH + LAYER_GAP;
    const gap = SIBLING_GAP + TEAM_GAP;
    const topMeasures = top.map(measure);
    const rowW = topMeasures.reduce((s, m) => s + m.width, 0) + gap * Math.max(top.length - 1, 0);
    let cur = -rowW / 2;
    for (const m of topMeasures) {
      place(m, cur + m.width / 2, rowTopY, null, true);
      cur += m.width + gap;
      maxBottom = Math.max(maxBottom, rowTopY + m.height);
    }
  }

  // Any agent the tree traversal above couldn't reach (dangling/cyclic parentId) → a safety-net row
  // below everything else, so data is never silently dropped off the canvas.
  const unplaced = agents.filter(a => !centers.has(a.id));
  if (unplaced.length) {
    const fallbackTop = maxBottom + LAYER_GAP;
    const cols = Math.min(MAX_PER_ROW, unplaced.length);
    unplaced.forEach((a, i) => {
      const { w, h } = nodeSize(a.role);
      const row = Math.floor(i / cols);
      const itemsInRow = Math.min(cols, unplaced.length - row * cols);
      const rowW = itemsInRow * (w + SIBLING_GAP) - SIBLING_GAP;
      const col = i % cols;
      nodes.push(nodeOf(a, { x: -rowW / 2 + w / 2 + col * (w + SIBLING_GAP), y: fallbackTop + row * (h + ROW_GAP) + h / 2 }));
    });
  }

  for (const a of agents) {
    if (!centers.has(a.id)) continue;
    for (const cid of a.childrenIds) if (centers.has(cid) && !noEdgeKids.has(cid)) edges.push(hierEdge(a.id, cid));
  }

  const collab = (collabOverride ?? deriveCollabEdges(agents)).filter(e => centers.has(e.source) && centers.has(e.target));
  const commAdj = buildCommAdj(collab);
  for (const e of collab) edges.push(collabEdge(e));

  return { nodes, edges, commAdj, teamColors };
}

/* ────────── React Flow type maps (module scope — stable identity) ────────── */

const NODE_TYPES = { ceoNode: CeoNode, agentNode: AgentNode, teamRegion: TeamRegionNode };

// Three line systems, one restrained neutral family by default — kind is told apart by weight/dash,
// not by hue. Color only enters on interaction, and only ever the accent + the 3 status hues (never
// a 4th decorative color): touch/select → accent, pending request → warning amber, live traffic →
// accent, a hierarchy line feeding a working agent → success green. Static by default; motion is
// reserved for genuine activity.
// v8: stroke uses the app's own "quiet but readable" text token (--color-ink-subtle) instead of a
// hardcoded dark-theme gray — that token is already tuned to read against BOTH canvases (light theme
// swaps it to a darker gray for the near-white canvas), which is what was making edges nearly
// invisible in light mode before. Base opacities bumped too — the old values plus a semi-transparent
// stroke color compounded into "barely there" hierarchy lines.
const EDGE_BASE = {
  hier:  { stroke: "var(--color-ink-subtle)", width: 2.2, dash: undefined as string | undefined, anim: false, op: 0.8, cls: "org-edge-hier" },
  peer:  { stroke: "var(--color-ink-subtle)", width: 1.3, dash: "6 5", anim: false, op: 0.36, cls: "org-edge-peer" },
  cross: { stroke: "var(--color-ink-subtle)", width: 1.2, dash: "2 7", anim: false, op: 0.24, cls: "org-edge-cross" },
};

function styleEdgeFor(e: any, activeId: string | null, showComm: boolean, activePairs?: Set<string>, statusById?: Map<string, string>) {
  const kind: "hier" | "peer" | "cross" = e.data?.kind ?? "hier";
  const base = EDGE_BASE[kind];
  const collab = kind !== "hier";
  const touches = !!activeId && (e.source === activeId || e.target === activeId);
  // v5 P4: 真实通道状态——requested=申请待批(虚线)，active 或本对正在交流=流动高亮。
  const status: string | undefined = e.data?.status;
  const liveActive = status === "active" || (!!activePairs && activePairs.has([e.source, e.target].sort().join("|")));
  const requested = status === "requested";
  // 命令波纹:lead→worker 连线在该 worker 实际执行期间流光,worker 一回到 idle/failed 自动恢复静态
  // (agent_status_changed SSE 由 useAgentStore.addEvent 实时合并进 agents,无需额外"run 是否进行中"标志)。
  const workerActive = kind === "hier" && isBusyStatus(statusById?.get(e.target)); // 11 态:细分忙碌态同样流光
  // C6 · 失败红闪(边):hier 边的下级进入 failed 态——同 CeoNode/AgentNode 的 failedFlash,直接读
  // 既有 status 字段(不是事件流派生,见 collabLines.ts 顶部注释)。
  const targetFailed = kind === "hier" && statusById?.get(e.target) === "failed";
  let opacity = base.op;
  let width = base.width;
  let animated = base.anim;
  let stroke = base.stroke;
  let dash = base.dash;
  if (collab && !showComm) opacity = 0;
  else if (activeId) {
    if (touches) { opacity = kind === "hier" ? 0.95 : 0.9; width = base.width + 0.9; animated = true; stroke = "var(--color-accent)"; }
    else opacity = collab ? 0.03 : 0.1;
  }
  if (requested) { dash = "2 4"; opacity = Math.max(opacity, 0.4); stroke = "var(--color-warning)"; }         // 申请待批 → 复用警示色
  if (liveActive) { animated = true; width = base.width + 1.1; opacity = Math.max(opacity, 0.95); stroke = "var(--color-accent)"; } // 正在交流 → 复用 accent
  if (workerActive) { animated = true; opacity = Math.max(opacity, 0.55); stroke = "var(--color-success)"; }  // 流向工作中的下属 → 复用成功色
  if (targetFailed) { width = base.width + 0.6; opacity = Math.max(opacity, 0.9); stroke = STATUS_COLORS.failed; } // 下级失败 → 复用失败色,闪烁交给 org-edge-failed
  return {
    ...e,
    animated,
    className: base.cls + (touches ? " org-edge-active" : "") + (liveActive ? " org-edge-live" : "") + (targetFailed ? " org-edge-failed" : ""),
    style: { stroke, strokeWidth: width, strokeDasharray: dash, opacity, transition: "opacity 200ms, stroke-width 200ms" },
  };
}

// C6 · artifact 飞线 / 经验紫线:展示窗口(事件发生后这么久内还画着这条线,之后自然消失——
// "飞线/脉冲"是一次性活动的短暂动画,不是常驻状态,同 liveMessagePairs 的 10s 窗口是同一思路)。
const ARTIFACT_FLIGHT_WINDOW_MS = 9000;
const MEMORY_PULSE_WINDOW_MS = 9000;

// artifact 飞线渲染:带文件图标的边(仍是 ReactFlow 内置 smoothstep 类型 + label,不是自定义边组件——
// 见上方 collabEdge/hierEdge 同款约束注释"custom edge components break node measurement")。
function artifactFlightEdge(f: ArtifactFlightLine, centers: Map<string, { x: number; y: number }>) {
  const s = centers.get(f.source) ?? { x: 0, y: 0 };
  const t = centers.get(f.target) ?? { x: 0, y: 0 };
  return {
    id: `flight-${f.id}`, source: f.source, target: f.target,
    ...handlesFor(s, t),
    type: "smoothstep" as const, pathOptions: { borderRadius: 10 },
    animated: true, label: "📄", labelBgStyle: { fill: "transparent" }, labelStyle: { fontSize: 13 }, labelShowBg: false,
    className: "org-edge-artifact",
    style: { stroke: "#c9975a", strokeWidth: 2, opacity: 0.9, transition: "opacity 200ms" },
    zIndex: 5,
  };
}

// 经验紫线渲染:target 为 null(该员工没有 lead/ceo 上级)时调用方不应传入——这里按非空处理。
function memoryPulseEdge(p: MemoryPulseLine & { target: string }, centers: Map<string, { x: number; y: number }>) {
  const s = centers.get(p.source) ?? { x: 0, y: 0 };
  const t = centers.get(p.target) ?? { x: 0, y: 0 };
  return {
    id: `mempulse-${p.id}`, source: p.source, target: p.target,
    ...handlesFor(s, t),
    type: "smoothstep" as const, pathOptions: { borderRadius: 10 },
    animated: true,
    className: "org-edge-memory",
    style: { stroke: "#957bc1", strokeWidth: 2, opacity: 0.9, transition: "opacity 200ms" },
    zIndex: 5,
  };
}

/* ────────── Main Page ────────── */

// 公司架构模式下常驻的右侧「和 CEO 对话调整架构」面板宽度——浮动加人按钮的偏移量计算需要知道它。
const ARCHITECT_CHAT_WIDTH = 340;

export default function OrgPage({ routeCompanyId }: { routeCompanyId?: string }) {
  const tr = useT();
  const agents = useAgentStore(s => s.agents);
  const selectedId = useAgentStore(s => s.selectedId);
  const select = useAgentStore(s => s.select);
  const update = useAgentStore(s => s.update);
  const selected = agents.find(a => a.id === selectedId);

  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);

  // v9:日常使用/公司架构 双模式。普通 state,不持久化——每次进页面都回到更安全的默认值(日常,
  // 结构编辑能力关闭)。
  // v10(用户明确要求):架构模式原本还分「可视化」(画布拖拽/连线编辑)/「表单」两个子视图,
  // 但画布连线编辑(ConnectEdgeModal 那套)现在还太粗糙、用户明确不会用——去掉这个子切换,架构
  // 模式下只保留表单编辑一条路。画布相关的底层代码(ConnectEdgeModal.tsx、连线 handle 的 CSS、
  // 节点拖拽逻辑)都还在,只是不再从架构模式暴露成编辑入口。注意:showCanvas 只在日常模式为真,
  // 与 canEditStructure 两态互斥——把两者 && 起来的渲染条件恒为 false(浮动加人按钮曾因此成死接线,
  // 见下方按钮处说明),结构编辑类 UI 的门槛应写单一模式判断。
  const [orgMode, setOrgMode] = useState<"daily" | "architecture">("daily");
  const canEditStructure = orgMode === "architecture";
  const showCanvas = orgMode === "daily";
  const [showCapabilityReport, setShowCapabilityReport] = useState(false);

  // 首跑启动台:还没跑过任何 run(runsLoaded 防初始 [] 闪现)且未"先看组织"时,盖在组织图上引导说出第一个目标。
  const runs = useRunStore(s => s.runs);
  const loadRuns = useRunStore(s => s.load);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [peeked, setPeeked] = useState(false);
  const [forcedLaunchPad, setForcedLaunchPad] = useState(false); // 设置→关于「预览首跑启动台」手动触发
  useEffect(() => { loadRuns().catch(() => { /* ignore */ }).finally(() => setRunsLoaded(true)); }, []);
  useEffect(() => {
    const lp = () => { setForcedLaunchPad(true); setPeeked(false); };
    window.addEventListener("open-launchpad", lp);
    return () => window.removeEventListener("open-launchpad", lp);
  }, []);

  // v2: multi-company. The org view shows one company at a time (switcher top-left).
  const [companies, setCompanies] = useState<Company[]>([]);
  // 空壳体验修复:记住上次看的公司(localStorage);首次使用落到"第一个有成员的公司"而不是空的默认公司
  // (headless 截图实锤:新会话停在零成员的默认公司,画布空白,用户以为组织图没做)。
  const [currentCompanyId, setCurrentCompanyId] = useState<string>(() => {
    // The URL is the durable navigation contract. Reading localStorage first creates a
    // mount-time race where the persistence effect rewrites a deep link to the previous
    // company before the route synchronization effect can apply routeCompanyId.
    if (routeCompanyId) return routeCompanyId;
    try { return localStorage.getItem("opc-org-company") || "default"; } catch { return "default"; }
  });
  const autoPickedRef = useRef(!!routeCompanyId);
  useEffect(() => {
    if (!routeCompanyId || routeCompanyId === currentCompanyId) return;
    autoPickedRef.current = true;
    setCurrentCompanyId(routeCompanyId);
    setFocusAgentId(null);
  }, [routeCompanyId, currentCompanyId]);
  useEffect(() => {
    try { localStorage.setItem("opc-org-company", currentCompanyId); } catch { /* */ }
    window.dispatchEvent(new CustomEvent("opc-company-selected", { detail: { companyId: currentCompanyId } }));
    navigateApp({ page: "org", companyId: currentCompanyId }, { replace: true });
  }, [currentCompanyId]);
  useEffect(() => {
    const openArchitecture = (event: Event) => {
      const companyId = String((event as CustomEvent).detail?.companyId || routeCompanyId || currentCompanyId);
      if (companyId) setCurrentCompanyId(companyId);
      setOrgMode("architecture");
      setFocusAgentId(null);
    };
    window.addEventListener("opc-open-company-architecture", openArchitecture);
    return () => window.removeEventListener("opc-open-company-architecture", openArchitecture);
  }, [routeCompanyId, currentCompanyId]);
  useEffect(() => {
    const onOpenCompany = (event: Event) => {
      const id = String((event as CustomEvent).detail?.companyId || "");
      if (!id) return;
      autoPickedRef.current = true;
      setCurrentCompanyId(id);
      setFocusAgentId(null);
    };
    window.addEventListener("opc-open-company", onOpenCompany);
    return () => window.removeEventListener("opc-open-company", onOpenCompany);
  }, []);
  useEffect(() => {
    if (autoPickedRef.current || !companies.length || !agents.length) return;
    autoPickedRef.current = true;
    const hasMembers = (cid: string) => agents.some(a => (a.companyId || "default") === cid);
    if (!hasMembers(currentCompanyId)) {
      const firstWithMembers = companies.find(c => hasMembers(c.id));
      if (firstWithMembers) setCurrentCompanyId(firstWithMembers.id);
    }
  }, [companies, agents, currentCompanyId]);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const companyMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!companyMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!companyMenuRef.current?.contains(event.target as Node)) setCompanyMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [companyMenuOpen]);
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyDesc, setNewCompanyDesc] = useState("");
  const reloadCompanies = useCallback(async () => {
    try {
      const cs = await api.get<Company[]>("/companies");
      setCompanies(cs);
      setCurrentCompanyId(prev => cs.some(c => c.id === prev) ? prev : (cs[0]?.id ?? "default"));
    } catch { /* ignore */ }
  }, []);
  // v3 C2: agents 变化（含社区导入新公司）时同步刷新公司列表，新公司即时进切换器。
  useEffect(() => { reloadCompanies(); }, [reloadCompanies, agents.length]);
  const companyAgents = useMemo(
    () => agents.filter(a => (a.companyId || "default") === currentCompanyId),
    [agents, currentCompanyId],
  );
  // 换公司 ⇒ 清跨公司选中,单一收口:selected 查的是全局 agents(见下方 find),换公司的路径有多条
  // (切换器/备份恢复落地/删除公司回落/自动挑选),散落各处手动 select(null) 漏一条就会出现
  // "画布整体调暗 + 侧板挂着别家公司员工"——统一在这里按 currentCompanyId 变化清理。
  useEffect(() => {
    const st = useAgentStore.getState();
    const cur = st.agents.find(a => a.id === st.selectedId);
    if (cur && (cur.companyId || "default") !== currentCompanyId) st.select(null);
  }, [currentCompanyId]);
  const handleCreateCompany = async () => {
    if (!newCompanyName.trim()) return;
    try {
      const c = await api.post<Company>("/companies", { name: newCompanyName.trim(), description: newCompanyDesc.trim() });
      setShowCompanyModal(false); setNewCompanyName(""); setNewCompanyDesc("");
      await reloadCompanies();
      setCurrentCompanyId(c.id);
      await useAgentStore.getState().load();
    } catch (e: any) { pushToast("error", tr('org.createCompanyFailed') + (e.message || "")); }
  };
  const handleArchiveCompany = async (company: Company) => {
    if (company.id === "default") return;
    try {
      const runs = await api.get<Array<{ companyId?: string }>>("/runs").catch(() => []);
      const runCount = runs.filter((run) => run.companyId === company.id).length;
      const confirmed = await confirmDialog({
        title: tr("archive.confirm.company.title", { name: company.name }),
        body: tr("archive.confirm.company.body", { runs: runCount }),
        danger: true,
        confirmLabel: tr("archive.action"),
      });
      if (!confirmed) return;
      await api.archiveCompany(company.id);
      await reloadCompanies();
      if (currentCompanyId === company.id) setCurrentCompanyId("default");
      await useAgentStore.getState().load();
      pushToast("success", tr("archive.toast.archived"));
    } catch (e: any) {
      pushToast("error", e.message || String(e));
    }
  };
  const currentCompany = companies.find(c => c.id === currentCompanyId);
  const filteredCompanies = useMemo(() => {
    const query = companySearch.trim().toLocaleLowerCase();
    if (!query) return companies;
    return companies.filter((company) =>
      [company.name, company.description, company.id, company.manifestTemplateId]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query)),
    );
  }, [companies, companySearch]);

  // 公司架构模式「表单」子视图(CompanyStructureForms)+ 右侧 CEO 架构对话面板(ArchitectChatPanel)
  // 共用的三个回调:①局部更新本地 companies 列表(不整页刷新)②切到「可视化」子模式(替代旧独立页面
  // 「在组织图中打开」的跨页跳转)③切换当前正在看的公司(备份恢复出新公司 / 删除当前公司后落地)。
  const handleStructureCompanyUpdated = useCallback((updated: Company) => {
    setCompanies(prev => prev.map(c => (c.id === updated.id ? updated : c)));
  }, []);
  // 架构模式的「可视化」子模式已砍掉(见上方 showCanvas 说明),这个回调现在改成"切回日常模式看
  // 画布"(daily 模式的画布本来就是只读查看,不是重新开一个编辑子模式)——按钮本身和 prop 名字不变,
  // 只是含义从"切子模式"变成"切回日常查看"。
  const handleSwitchToVisual = useCallback(() => setOrgMode("daily"), []);
  const handleStructureCompanySwitch = useCallback(async (companyId: string) => {
    await reloadCompanies();
    setCurrentCompanyId(companyId);
  }, [reloadCompanies]);

  useEffect(() => {
    const open = (e: Event) => {
      const { agentId, x, y } = (e as CustomEvent).detail;
      setContextMenu({ agentId, x, y });
    };
    const close = () => setContextMenu(null);
    window.addEventListener("org-context-menu", open);
    window.addEventListener("org-context-menu-close", close);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("org-context-menu", open);
      window.removeEventListener("org-context-menu-close", close);
      window.removeEventListener("click", close);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && focusAgentId) {
        setFocusAgentId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusAgentId]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [addParentId, setAddParentId] = useState("");
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState("dev");
  const [addModel, setAddModel] = useState("deepseek-chat");
  const [addProvider, setAddProvider] = useState("deepseek");
  const [addFramework, setAddFramework] = useState<AgentFramework>("api");
  const [addTab, setAddTab] = useState<"manual" | "community">("manual");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const [communityAgents, setCommunityAgents] = useState<AgentCard[]>([]);
  const [communityTemplates, setCommunityTemplates] = useState<CompanyTemplate[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [importingTemplateId, setImportingTemplateId] = useState<string | null>(null);

  const loadCommunityData = useCallback(async () => {
    setCommunityLoading(true);
    try {
      const [aIdx, tIdx] = await Promise.all([
        api.get<any[]>("/community/agents"),
        api.get<any[]>("/community/templates"),
      ]);
      const [agentsData, templates] = await Promise.all([
        Promise.all(aIdx.map(e =>
          api.get<AgentCard>(`/community/agents/${e.id}`).catch(() => null)
        )),
        Promise.all(tIdx.map(e =>
          api.get<CompanyTemplate>(`/community/templates/${e.id}`).catch(() => null)
        )),
      ]);
      setCommunityAgents(agentsData.filter(Boolean) as AgentCard[]);
      setCommunityTemplates(templates.filter(Boolean) as CompanyTemplate[]);
    } catch {
      // silently fail
    }
    setCommunityLoading(false);
  }, []);

  const fillFromAgentCard = (card: AgentCard) => {
    setAddName(card.agent.name || card.title);
    setAddRole(card.agent.expectedRole || card.role);
    setAddProvider(card.agent.recommendedProvider);
    setAddModel(card.agent.recommendedModel);
    setAddTab("manual");
  };

  const importTemplate = async (template: CompanyTemplate) => {
    setImportingTemplateId(template.id);
    try {
      // 模板成员的 id 全量重映射:parentId/childrenIds 都换成新 id(保留模板内部层级),模板外的引用
      // 丢弃(不留悬空 id);只有模板内没有上级的"根"成员挂到 addParentId 下。落进当前公司,而不是
      // 让服务端 upsert 默认落 "default"。
      const idMap = new Map<string, string>(template.agents.map((a, i) =>
        [a.id, `agent-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`]));
      const rootNewIds: string[] = [];
      for (const agent of template.agents) {
        const newId = idMap.get(agent.id)!;
        const mappedParent = agent.parentId ? idMap.get(agent.parentId) : undefined;
        if (!mappedParent) rootNewIds.push(newId);
        await update(newId, {
          ...agent,
          id: newId,
          companyId: currentCompanyId,
          parentId: mappedParent ?? (addParentId || undefined),
          childrenIds: (agent.childrenIds ?? []).map(c => idMap.get(c)).filter((c): c is string => !!c),
          status: "idle",
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          costUsd: 0,
          editable: true,
          deletable: true,
          enabled: true,
        });
        await new Promise(r => setTimeout(r, 10));
      }
      if (addParentId && rootNewIds.length) {
        const parent = agents.find(a => a.id === addParentId);
        if (parent) await update(addParentId, { childrenIds: [...parent.childrenIds, ...rootNewIds] });
      }
      setShowTemplatePicker(false);
      setShowAddModal(false);
    } catch (e: any) {
      pushToast("error", tr('org.importFailed') + (e.message || ""));
    }
    setImportingTemplateId(null);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.agentId) {
        setDeleteConfirmId(detail.agentId);
        setShowDeleteDialog(true);
      }
    };
    window.addEventListener("org-delete-agent", handler);
    return () => window.removeEventListener("org-delete-agent", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        setAddParentId(detail.parentId || "");
        setAddName("");
        setAddTab("manual");
        setShowAddModal(true);
      }
    };
    window.addEventListener("org-add-agent", handler);
    return () => window.removeEventListener("org-add-agent", handler);
  }, []);

  useEffect(() => {
    if (showAddModal && addTab === "community" && communityAgents.length === 0) {
      loadCommunityData();
    }
  }, [showAddModal, addTab, communityAgents.length, loadCommunityData]);

  const handleAddAgent = async () => {
    if (!addName.trim()) return;
    const newId = `agent-${Date.now()}`;
    const newAgent: AgentNodeConfig = {
      id: newId, name: addName.trim(), role: addRole,
      model: addModel, provider: addProvider, framework: addFramework,
      status: "idle", childrenIds: [],
      parentId: addParentId || undefined,
      // 不带 companyId 时服务端 upsert 默认落 "default" 公司——在非 default 公司视图下新员工会静默消失。
      companyId: currentCompanyId,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      costUsd: 0, editable: true, deletable: true, enabled: true,
    };
    try {
      await update(newId, newAgent);
      if (addParentId) {
        const parent = agents.find(a => a.id === addParentId);
        if (parent) {
          await update(addParentId, { childrenIds: [...parent.childrenIds, newId] });
        }
      }
      setShowAddModal(false);
      setAddName("");
    } catch (e: any) {
      pushToast("error", tr('org.addAgentFailed') + (e.message || ""));
    }
  };

  const handleDeleteAgent = () => {
    if (deleteConfirmId) {
      agents.forEach(a => {
        if (a.childrenIds.includes(deleteConfirmId)) {
          update(a.id, { childrenIds: a.childrenIds.filter(cid => cid !== deleteConfirmId) });
        }
      });
      // 只从父节点的 childrenIds 摘掉还不够——agent 自己还留在列表里,飘成孤立节点(实际没删掉)。
      // 后端没有单个 agent 的硬删除接口,这里用 enabled:false 软删:updateAgent 会持久化它,
      // useAgentStore 的 load/update 已把 enabled:false 的 agent 从可见列表剔除。
      update(deleteConfirmId, { enabled: false });
    }
    setShowDeleteDialog(false);
    setDeleteConfirmId(null);
  };

  const [showComm, setShowComm] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // v5 P4: 真实通信通道（轮询 /api/channels），用于画"谁和谁有通道/正在交流/申请待批"。The server has no
  // SSE push for channel open/close/status transitions, so this genuinely has to be polled — but it
  // shares ONE timer with the "now" tick below (was 2 separate setIntervals at 3s/2s), runs at 10s
  // instead of 3s, and pauses entirely while the tab is hidden.
  const [channels, setChannels] = useState<{ id: string; a: string; b: string; kind: string; status: string; lastActiveAt?: string }[]>([]);
  const [chRequests, setChRequests] = useState<{ id: string; from: string; to: string; status: string }[]>([]);
  // Live comm = channels the server flagged "active" ∪ pairs derived from the real-time
  // agent_message SSE stream (worker→lead reports, peer/A2A messages). The latter fades on its own
  // via the same periodic tick so a pulse only lasts while traffic is fresh.
  const events = useAgentStore(s => s.events);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      setNow(Date.now());
      api.get<{ channels: any[]; requests: any[] }>("/channels")
        .then(j => { setChannels(j.channels ?? []); setChRequests(j.requests ?? []); })
        .catch(() => { /* ignore */ });
    };
    const start = () => { if (!timer) { tick(); timer = setInterval(tick, 10000); } };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  // status==="active" 不直接进渲染:先按 lastActiveAt 新鲜度衰减(见 channelActiveFresh)——服务端的
  // active 是"曾经交流过"的粘滞标记,不衰减会让一条消息点亮的线常驻流光到下个 run。
  const collabOverride = useMemo(
    () => {
      if (!(channels.length || chRequests.some(r => r.status === "pending"))) return undefined;
      const decayed = channels.map(c => c.status === "active" && !channelActiveFresh(c, now) ? { ...c, status: "open" } : c);
      return channelsToCollabEdges(decayed, chRequests);
    },
    [channels, chRequests, now],
  );
  const activePairs = useMemo(() => {
    const s = new Set(channels.filter(c => channelActiveFresh(c, now)).map(c => pairKey(c.a, c.b)));
    for (const k of liveMessagePairs(events, companyAgents, channels, 10000, now)) s.add(k);
    return s;
  }, [channels, events, companyAgents, now]);
  // v3 D3: 锁定状态持久化（localStorage），刷新后保留用户选择（默认锁定）。
  const [locked, setLockedState] = useState<boolean>(() => {
    try { return localStorage.getItem("opc-org-locked") !== "false"; } catch { return true; }
  });
  const setLocked = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setLockedState(prev => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      try { localStorage.setItem("opc-org-locked", String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // 简报栏折叠态持久化(与 locked 同一套 localStorage 模式)。
  const [briefCollapsed, setBriefCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem("opc-briefing-collapsed") === "true"; } catch { return false; }
  });
  const setBriefCollapsed = useCallback((v: boolean) => {
    setBriefCollapsedState(v);
    try { localStorage.setItem("opc-briefing-collapsed", String(v)); } catch { /* ignore */ }
  }, []);
  // New task navigation selects the company, restores daily mode, opens the command panel, and
  // then focuses its execution composer. sessionStorage covers the page-unmounted transition.
  useEffect(() => {
    const openTask = (event?: Event) => {
      let companyId = String((event as CustomEvent | undefined)?.detail?.companyId || "");
      if (!companyId) {
        try { companyId = sessionStorage.getItem("opc-new-task-company") || ""; } catch { /* ignore */ }
      }
      if (companyId) {
        autoPickedRef.current = true;
        setCurrentCompanyId(companyId);
      }
      setOrgMode("daily");
      setBriefCollapsed(false);
      try { sessionStorage.removeItem("opc-new-task-company"); } catch { /* ignore */ }
      setTimeout(() => window.dispatchEvent(new CustomEvent("opc-focus-task-composer")), 0);
    };
    window.addEventListener("opc-new-task", openTask);
    let pending = false;
    try { pending = !!sessionStorage.getItem("opc-new-task-company"); } catch { /* ignore */ }
    if (pending) openTask();
    return () => window.removeEventListener("opc-new-task", openTask);
  }, [setBriefCollapsed]);
  // 简报栏停靠位置(右侧栏 ⇄ 底部横栏)+ 拖拽尺寸(侧栏记宽度、底部记高度,两套值互不覆盖,
  // 切换 dock 后各自保留上次拖到的尺寸)——同一套 localStorage 模式,读值做 range clamp 防脏数据。
  const [briefDock, setBriefDockState] = useState<"side" | "bottom">(() => {
    try { return localStorage.getItem("opc-briefing-dock") === "bottom" ? "bottom" : "side"; } catch { return "side"; }
  });
  const setBriefDock = useCallback((v: "side" | "bottom") => {
    setBriefDockState(v);
    try { localStorage.setItem("opc-briefing-dock", v); } catch { /* ignore */ }
  }, []);
  const [briefWidth, setBriefWidthState] = useState<number>(() => {
    try { const n = Number(localStorage.getItem("opc-briefing-width")); return n >= 280 && n <= 560 ? n : 340; } catch { return 340; }
  });
  const setBriefWidth = useCallback((v: number) => {
    const clamped = Math.min(560, Math.max(280, Math.round(v)));
    setBriefWidthState(clamped);
    try { localStorage.setItem("opc-briefing-width", String(clamped)); } catch { /* ignore */ }
  }, []);
  const [briefHeight, setBriefHeightState] = useState<number>(() => {
    try { const n = Number(localStorage.getItem("opc-briefing-height")); return n >= 240 && n <= 400 ? n : 280; } catch { return 280; }
  });
  const setBriefHeight = useCallback((v: number) => {
    const clamped = Math.min(400, Math.max(240, Math.round(v)));
    setBriefHeightState(clamped);
    try { localStorage.setItem("opc-briefing-height", String(clamped)); } catch { /* ignore */ }
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  // 可视化画布节点连线交互(公司架构模式专属,见 nodesConnectable={canEditStructure} 下方):拖拽
  // 完成后不直接落一条边,先弹 ConnectEdgeModal 让用户选这条边到底代表什么(汇报关系/验证边/A2A 通道)。
  const [connectDraft, setConnectDraft] = useState<{ source: string; target: string } | null>(null);
  const handleConnect = useCallback((params: Connection) => {
    if (!canEditStructure || !params.source || !params.target || params.source === params.target) return;
    setConnectDraft({ source: params.source, target: params.target });
  }, [canEditStructure]);

  // Auto-arrange: clear all manual positions → fall back to the default radial layout + fit.
  const handleAutoArrange = useCallback(() => {
    agents.forEach(a => { if (a.uiPosition) update(a.id, { uiPosition: null }); });
    setTimeout(() => rfRef.current?.fitView({ padding: 0.22, duration: 600 }), 80);
  }, [agents, update]);
  // Cross-call memory for team colors (team-focus view reuses the color global view already picked
  // for that team). A plain ref owned by OrgPage itself — read during the layout useMemo, written
  // back in a layout effect (after commit, never during render) so nothing here is a render-phase
  // mutation of shared state.
  const teamColorsRef = useRef<Map<string, TeamColor>>(new Map());
  const layoutResult = useMemo(
    () => computeLayout(companyAgents, focusAgentId, collabOverride, teamColorsRef.current),
    [companyAgents, focusAgentId, collabOverride],
  );
  useLayoutEffect(() => { teamColorsRef.current = layoutResult.teamColors; }, [layoutResult]);
  // What node components (rendered inside <ReactFlow> below, same render pass) read via context —
  // replaces the old COMM_ADJ/TEAM_COLOR module singletons that computeLayout used to mutate directly.
  const orgDerived = useMemo<OrgDerived>(
    () => ({ commAdj: layoutResult.commAdj, teamColors: layoutResult.teamColors }),
    [layoutResult],
  );

  // 命令波纹:lead→worker 连线在 worker 实际执行期间流光——只需 id→status 这一张薄映射(agents 本就在渲染
  // 这一帧可用,不需要额外订阅)。
  const statusById = useMemo(() => new Map(companyAgents.map(a => [a.id, a.status])), [companyAgents]);

  // C6 · artifact 飞线 / 经验紫线的节点中心坐标——从已布局的节点位置读回(不是 computeLayout 内部的
  // centers,那张表是私有实现细节;这里直接用 position + 节点尺寸重算,与 hierEdge/collabEdge 的
  // handlesFor 用的是同一套坐标语义)。团队聚焦视图下,画布外的 agent 不在 layoutResult.nodes 里,
  // 自然查不到坐标——下面据此过滤掉指向画布外的飞线/脉冲,不画一条戳向 (0,0) 的假线。
  const nodeCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of layoutResult.nodes) {
      if (n.type === "teamRegion") continue;
      const { w, h } = nodeSize((n.data as AgentNodeConfig).role);
      m.set(n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2 });
    }
    return m;
  }, [layoutResult.nodes]);

  // C6 · 硬规则:两条派生只吃 events(committed SSE/历史回放,见 collabLines.ts 顶部注释),按窗口
  // 收窄到"最近发生、还在画着"的那几条——拿不到真实事件就是空数组,不会画出任何线。
  const artifactFlights = useMemo(
    () => deriveArtifactFlights(events, companyAgents, channels).filter(f => isWithinWindow(f.ts, now, ARTIFACT_FLIGHT_WINDOW_MS)),
    [events, companyAgents, channels, now],
  );
  const memoryPulses = useMemo(
    () => deriveMemoryPulses(events, companyAgents).filter(p => isWithinWindow(p.ts, now, MEMORY_PULSE_WINDOW_MS)),
    [events, companyAgents, now],
  );
  // 基础 now 时钟 10s 一跳(见上方与 /channels 轮询共享的 timer),而飞线/紫线是 ≤9s 的短暂动画——
  // 粗粒度时钟下过期要等下个 tick 才被清掉。存在未过期线时把 now 提到 1s tick(窗口 9s > tick 1s,
  // 不会出现"还没画就过期"),线全部过期后 interval 随之卸载,回到 10s 省电节奏;标签页隐藏时跳过
  // setNow(与主 tick 的暂停策略一致,回到前台由主 tick 立即校准)。
  const hasTransientLines = artifactFlights.length > 0 || memoryPulses.length > 0;
  useEffect(() => {
    if (!hasTransientLines) return;
    const t = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
    return () => clearInterval(t);
  }, [hasTransientLines]);

  // Edges (hierarchy + peer + cross) come pre-derived with radial handles + data.kind from the
  // layout. Styling reacts to the active node (hover takes precedence over selection): its lines
  // brighten, the rest fade. Built-in edge types only (custom edge components break node measurement).
  const styledEdges = useMemo(() => {
    const activeId = hoveredId ?? selectedId;
    const base = layoutResult.edges.map(e => styleEdgeFor(e, activeId, showComm, activePairs, statusById));
    const flights = artifactFlights
      .filter(f => nodeCenters.has(f.source) && nodeCenters.has(f.target))
      .map(f => artifactFlightEdge(f, nodeCenters));
    const pulses = memoryPulses
      .filter((p): p is MemoryPulseLine & { target: string } => !!p.target && nodeCenters.has(p.source) && nodeCenters.has(p.target))
      .map(p => memoryPulseEdge(p, nodeCenters));
    return [...base, ...flights, ...pulses];
  }, [layoutResult.edges, selectedId, hoveredId, showComm, activePairs, statusById, artifactFlights, memoryPulses, nodeCenters]);

  const [rnodes, setNodes, onNodesChange] = useNodesState(layoutResult.nodes);
  const [redges, setEdges, onEdgesChange] = useEdgesState(styledEdges);

  useEffect(() => {
    setNodes(layoutResult.nodes);
  }, [layoutResult.nodes, setNodes]);

  useEffect(() => {
    setEdges(styledEdges);
  }, [styledEdges, setEdges]);

  // Smooth zoom when entering/leaving a team focus view.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.3, duration: 600 }), 80);
    return () => clearTimeout(t);
  }, [focusAgentId]);

  const focusedAgent = focusAgentId ? agents.find(a => a.id === focusAgentId) : null;
  const dotColor = document.documentElement.classList.contains('light') ? 'var(--color-surface-2)' : 'var(--color-surface-0)';

  return (
    <div className={`flex h-full relative ${briefDock === "bottom" ? "flex-col" : ""}`} style={{
      // v7: dropped the hero radial-gradient wash — flat canvas color only, no accent glow behind the graph.
      backgroundColor: "var(--color-canvas)", // v6 C3: 跟随主题（浅/深）
    }}>
      {/* 画布 + agent 设置侧板永远横排(row);简报栏停靠位置决定它们整体是排在简报栏左边(side)
          还是叠在简报栏上面(bottom)——外层 flex 方向由 briefDock 决定,这一层内部方向恒定。 */}
      <div className="flex flex-1 min-h-0 min-w-0">
      <div
        className="flex-1 relative"
        onMouseDownCapture={(e) => {
          if (locked && (e.target as HTMLElement).closest(".react-flow__node:not(.react-flow__node-teamRegion)")) {
            showToast(tr('org.toastLocked'));
          }
        }}
      >
        {/* Locked / action toast */}
        {toast && (
          <div className="absolute left-1/2 -translate-x-1/2 top-4 z-30 px-3 py-1.5 rounded-lg bg-surface-1/95 backdrop-blur-sm border border-hairline text-[12px] text-ink shadow"
            style={{ boxShadow: "var(--shadow-md)" }}>
            {toast}
          </div>
        )}
        {/* Company switcher (global view) */}
        {!focusedAgent && (
          <div className="absolute top-4 start-4 z-20 flex items-start gap-2">
            <div ref={companyMenuRef}>
              <button onClick={() => { setCompanyMenuOpen(v => !v); setCompanySearch(""); }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1/90 backdrop-blur-sm border border-hairline text-[13px] text-ink cursor-pointer hover:border-text-muted transition-colors">
                <Building2 size={14} className="text-accent" />
                <span className="font-medium max-w-[180px] truncate">{currentCompany?.name ?? tr('org.defaultCompany')}</span>
                <ChevronDown size={13} className="text-ink-subtle" />
              </button>
              {companyMenuOpen && (
                <div className="mt-1 w-72 rounded-lg bg-surface-1 border border-hairline overflow-hidden" style={{ boxShadow: "var(--shadow-md)" }}>
                  <div className="p-2 border-b border-hairline">
                    <div className="flex items-center gap-2 px-2 h-8 rounded-md bg-surface-2">
                      <Search size={13} className="text-ink-subtle shrink-0" />
                      <input
                        autoFocus
                        value={companySearch}
                        onChange={(event) => setCompanySearch(event.target.value)}
                        placeholder={tr("common.search")}
                        className="min-w-0 flex-1 bg-transparent border-none outline-none text-[12px] text-ink"
                      />
                    </div>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {filteredCompanies.map(c => (
                      <div key={c.id} className="group w-full flex items-center hover:bg-bg-hover transition-colors">
                        <button onClick={() => { setCurrentCompanyId(c.id); setCompanyMenuOpen(false); }}
                          className={"flex-1 min-w-0 text-left px-3 py-2 cursor-pointer bg-transparent border-none " + (c.id === currentCompanyId ? "text-accent" : "text-ink")}>
                          <div className="text-[13px] font-medium truncate">{c.name}</div>
                          <div className="text-[10px] text-ink-subtle truncate">
                            {c.manifestTemplateId ? c.manifestTemplateId : c.id}
                          </div>
                        </button>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const tpl = await api.get<Record<string, unknown>>("/companies/" + c.id + "/export");
                            downloadJson(tpl, (c.name || c.id) + ".opc.bundle.json");
                          } catch (err: any) {
                            pushToast("error", tr("org.exportCompanyFailed") + (err.message || ""));
                          }
                        }} title={tr("org.exportCompany")}
                          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-subtle opacity-0 group-hover:opacity-100 hover:text-accent cursor-pointer">
                          <Download size={13} />
                        </button>
                        {canEditStructure && c.id !== "default" && (
                          <button onClick={(e) => { e.stopPropagation(); void handleArchiveCompany(c); }} title={tr("archive.action")}
                            className="shrink-0 w-7 h-7 mr-1.5 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-subtle opacity-0 group-hover:opacity-100 hover:text-accent cursor-pointer">
                            <Archive size={13} />
                          </button>
                        )}
                      </div>
                    ))}
                    {filteredCompanies.length === 0 && (
                      <div className="px-3 py-5 text-center text-[12px] text-ink-subtle">{tr("common.noResults")}</div>
                    )}
                  </div>
                  {/* 新建公司同样是结构性操作(相当于从零架起一个新组织)——只在「公司架构」模式下可见,
                      与右键菜单「加子节点」/浮动加人按钮同一收口标准,不留侧路。 */}
                  {canEditStructure && (
                    <button onClick={() => { setCompanyMenuOpen(false); setShowCompanyModal(true); }}
                      className="w-full text-left px-3 py-2 text-[13px] text-accent cursor-pointer hover:bg-bg-hover border-t border-hairline flex items-center gap-1.5">
                      <Plus size={13} />{tr('org.newCompany')}
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* 全量测试连接(用户明确要求:换掉这里原来的"能力边界报告"图标,点开直接测所有Agent
                连通性,不用先看报告再找测试按钮)。两种模式下都保留;能力报告本身没有丢,还在
                「公司架构」模式的表单里(CompanyStructureForms 自己的 CapabilityTab tab)。 */}
            {currentCompany && (
              <div className="relative">
                <button
                  onClick={() => setShowCapabilityReport(v => !v)}
                  title={tr('org.panel.connTest')}
                  className={`flex items-center justify-center w-[34px] h-[34px] rounded-lg bg-surface-1/90 backdrop-blur-sm border border-hairline cursor-pointer transition-colors ${
                    showCapabilityReport ? "text-accent border-accent/40" : "text-ink-muted hover:border-text-muted hover:text-ink"
                  }`}>
                  <Zap size={14} />
                </button>
                {showCapabilityReport && (
                  <div className="absolute top-full mt-1 start-0 w-96 max-h-[70vh] overflow-y-auto rounded-lg bg-surface-1 border border-hairline p-4" style={{ boxShadow: "var(--shadow-md)" }}>
                    <ConnectivityTestPanel companyId={currentCompany.id} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {focusedAgent && (
          <div
            className="absolute top-4 start-4 z-20 flex items-center gap-1 px-2.5 py-1.5 rounded-lg
              bg-surface-1/90 backdrop-blur-sm border border-hairline text-[12px]"
            title={tr('org.backToGlobalView')}
          >
            <button
              onClick={() => setFocusAgentId(null)}
              className="flex items-center gap-1 bg-transparent border-none cursor-pointer text-ink-muted hover:text-ink transition-colors px-1"
            >
              <ArrowLeft size={13} />
              <span>{tr('nav.org')}</span>
            </button>
            <ChevronRight size={12} className="text-ink-subtle" />
            <span className="text-ink font-medium px-1">{focusedAgent.name}</span>
          </div>
        )}
        {/* 模式切换:日常使用(默认,结构编辑关闭)⇄ 公司架构(表单编辑 + CEO 对话)。与画布右上角
            工具条同一套克制视觉语言(surface-1/90 背景 + hairline 描边),不引入新样式。
            v2:原先水平居中(start-1/2)在架构模式下会被右上角画布工具条(top-4 end-4)撞上,改成
            贴左、另起一行(company switcher 正下方)。
            v3:两段式 pill 曾横向并排,不够紧凑——改上下堆叠(现只剩这一行,子模式 pill 已在 v10
            连同"可视化"编辑一起砍掉,见 showCanvas 说明)。 */}
        <div className="absolute top-16 start-4 z-20 flex flex-col items-start gap-1">
          <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-surface-2">
            {(["daily", "architecture"] as const).map(m => (
              <button key={m} onClick={() => setOrgMode(m)}
                className={`px-2.5 h-7 rounded-full text-[12px] font-medium cursor-pointer transition-colors border-none ${
                  orgMode === m ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                }`}>
                {tr(m === "daily" ? "org.mode.daily" : "org.mode.architecture")}
              </button>
            ))}
          </div>
        </div>
        {/* Canvas toolbar: collaboration toggle · zoom · fit · lock · auto-arrange (仅画布可见时显示) */}
        {showCanvas && (
        <div className="absolute top-4 end-4 z-20 flex items-center gap-1 px-1.5 py-1 rounded-xl bg-surface-1/90 backdrop-blur-sm border border-hairline">
          <button onClick={() => setShowComm(v => !v)} title={tr('org.collabLinks')}
            className={`flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] cursor-pointer transition-colors ${showComm ? "text-accent bg-accent/12" : "text-ink-muted hover:text-ink"}`}>
            <Share2 size={13} /><span>{tr('org.collabLinks')}</span>
          </button>
          <span className="w-px h-5 bg-hairline mx-0.5" />
          <button onClick={() => rfRef.current?.zoomOut({ duration: 200 })} title={tr('org.zoomOut')} className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-bg-hover cursor-pointer"><ZoomOut size={15} /></button>
          <button onClick={() => rfRef.current?.zoomIn({ duration: 200 })} title={tr('org.zoomIn')} className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-bg-hover cursor-pointer"><ZoomIn size={15} /></button>
          <button onClick={() => rfRef.current?.fitView({ padding: 0.22, duration: 400 })} title={tr('org.fitView')} className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-bg-hover cursor-pointer"><Maximize2 size={14} /></button>
          <button onClick={handleAutoArrange} title={tr('org.autoArrange')} className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-bg-hover cursor-pointer"><Wand2 size={15} /></button>
          <span className="w-px h-5 bg-hairline mx-0.5" />
          <button onClick={() => { setLocked(v => !v); showToast(locked ? tr('org.toastUnlocked') : tr('org.toastLockedShort')); }} title={locked ? tr('org.unlockTip') : tr('org.lockTip')}
            className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer ${locked ? "text-amber bg-amber/12" : "text-accent bg-accent/12"}`}>
            {locked ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
        </div>
        )}
        {showCanvas && (
        <OrgDerivedContext.Provider value={orgDerived}>
          <ReactFlow
            nodes={rnodes}
            edges={redges}
            nodeTypes={NODE_TYPES}
            className={canEditStructure ? "org-canvas-connectable" : undefined}
            nodesConnectable={canEditStructure}
            nodesDraggable={!locked}
            zoomOnDoubleClick={false}
            onInit={(inst) => { rfRef.current = inst; }}
            onConnect={handleConnect}
            onNodeDragStop={(_e, node) => {
              if (node.type !== "teamRegion") update(node.id, { uiPosition: { x: node.position.x, y: node.position.y } });
            }}
            onNodeDoubleClick={(_e, node) => {
              if (node.type === "teamRegion") return;
              const cids = (node.data as AgentNodeConfig)?.childrenIds;
              // v3 D3: 有下级→进团队聚焦视图；无下级（worker）→给反馈+打开详情，不再"双击无反应"。
              if (cids && cids.length > 0) setFocusAgentId(node.id);
              else { select(node.id); showToast(tr('org.toastNoChildren')); }
            }}
            onNodeMouseEnter={(_e, node) => { if (node.type !== "teamRegion") setHoveredId(node.id); }}
            onNodeMouseLeave={() => setHoveredId(null)}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            onPaneClick={() => select(null)}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background color={dotColor} gap={24} size={1.5} />
            <Controls className="!bottom-4 !start-4" showZoom={false} showFitView={false} showInteractive={false} />
          </ReactFlow>
        </OrgDerivedContext.Provider>
        )}
        {/* v3 D3: 空状态引导（当前公司无 agent 时） */}
        {showCanvas && !focusedAgent && companyAgents.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <Building2 size={40} className="text-ink-subtle mb-3" />
            <div className="text-[14px] text-ink-muted mb-1">{tr('org.empty')}</div>
            <div className="text-[12px] text-ink-subtle">{tr('org.emptyHint')}</div>
          </div>
        )}
        {/* 首跑启动台:盖在组织图上,引导新用户说出第一个目标(默认团队已就绪,说了即跑)。跑过一次后自动隐退;
            也可经 设置→关于「预览首跑启动台」强制显示(forcedLaunchPad),供已有数据的用户回看。
            触发条件 = 全局还没跑过任何 run(runs 是全局列表),不再限定 default 公司(报告 #5:之前硬编码 default 导致非 default 公司永远看不到)。 */}
        {showCanvas && (forcedLaunchPad || (runsLoaded && runs.length === 0 && !peeked)) && (
          <LaunchPad onPeek={() => { setPeeked(true); setForcedLaunchPad(false); }} companyId={currentCompanyId} ceoId={currentCompany?.ceoId} />
        )}
        {/* 公司架构模式 · 表单子视图——原独立页面 CompanyManagementPage 的 9 个 Tab 迁移进来,
            填满这块画布区域(canvas 隐藏时)。 */}
        {!showCanvas && currentCompany && (
          <CompanyStructureForms
            company={currentCompany}
            agents={agents}
            onCompanyUpdated={handleStructureCompanyUpdated}
            onSwitchToVisual={handleSwitchToVisual}
            onCompanySwitch={handleStructureCompanySwitch}
          />
        )}
      </div>

      {/* Agent 设置/状态侧板——单击节点或右键「打开设置」都落到这里(select(id) 已接线)。
          真实 bug 修复:canEditStructure 之前完全没传下去,日常模式下这个面板照样能改名/供应商/
          模型/CLI 认证方式,完全绕过了日常/架构双模式——现在面板内部按这个 prop 做只读/可编辑双态。 */}
      {selected && <AgentDetailsPanel
        agent={selected}
        onClose={() => select(null)}
        canEditStructure={canEditStructure}
        companyNativeExecution={currentCompany?.nativeExecution}
      />}

      {/* 公司架构模式常驻:和 CEO 对话调整架构(architect-chat 只提议不落盘,用户点"应用"才
          architect-apply 真正落地——见 ArchitectChatPanel 内部实现)。 */}
      {canEditStructure && currentCompany && (
        <ArchitectChatPanel companyId={currentCompany.id} onApplied={handleStructureCompanyUpdated} />
      )}
      </div>

      {/* Floating Add Agent button —— 只在「公司架构」模式显示(加人是结构性操作,与右键「加子节点」/
          「新建公司」同一收口标准;日常模式没有结构编辑能力)。v10 砍掉架构模式的「可视化」子视图后,
          旧条件把本按钮同时钉在两个互斥模式上恒不渲染,整条 AddAgentModal 链路一度成死接线——
          现按单一模式判断恢复。 */}
      {canEditStructure && (
      <button
        onClick={() => {
          setAddParentId("");
          setAddName("");
          setAddTab("manual");
          setShowAddModal(true);
        }}
        title={tr('org.addAgent')}
        /* v3 D2: 改 absolute（锚定到画布容器底部，画布在终端之上）→ 不再悬浮压住底部终端。
           insetInlineEnd/bottom 要给右侧 AgentDetailsPanel(选中时 350px)+ ArchitectChatPanel(架构
           模式常驻 340px)让位——这两个是真实 flex 尺寸(不是浮层)，按钮的包含块是整个外层容器，
           offset 需要把它们都算进去。BriefingPanel 不再算进这个偏移:这个按钮只在 canEditStructure
           为真时渲染(架构模式），而 BriefingPanel 现在恰好只在 !canEditStructure 时渲染(见下方
           "架构模式下隐藏日常简报栏"）——两者互斥，加按钮出现时 BriefingPanel 必然不在场，不需要
           为它让位。 */
        className="absolute w-12 h-12 btn-primary cursor-pointer
                   flex items-center justify-center z-30 transition-all duration-200
                   shadow-lg"
        style={{
          insetInlineEnd: (selected ? 370 : 32) + ARCHITECT_CHAT_WIDTH,
          bottom: 24,
        }}
      >
        <Plus size={22} />
      </button>
      )}

      {/* Context Menu */}
      <AnimatePresence>
        {contextMenu && (
          <OrgContextMenu
            menu={contextMenu}
            agents={agents}
            onClose={() => setContextMenu(null)}
            canEditStructure={canEditStructure}
          />
        )}
      </AnimatePresence>

      {/* 简报栏(日常使用模式常驻,可折叠,可拖拽尺寸,可停靠右侧栏/底部横栏)——SSE 事件人话化 +
          底部同处派任务入口。用户纠正:切到「公司架构」模式时不该还能同时看到这个日常工作面板——
          与 ArchitectChatPanel(架构模式常驻,见上方 canEditStructure && ... 那段)互斥显示,
          而不是像之前那样两个面板同时挂在页面上。折叠/停靠/拖拽尺寸这些状态本身存在 OrgPage 这一层
          (briefCollapsed/briefDock/briefWidth/briefHeight,落 localStorage),不因为这里条件渲染
          导致组件卸载而丢失——切回日常模式重新挂载时,这些 prop 原样传回去,行为和之前完全一致;
          唯一会重置的是 BriefingPanel 内部未持久化的瞬时 UI 状态(草稿输入框文字、本次会话拉到的
          Plan 简报卡、"高级"折叠区展开与否等)——这些本来就不是"简报栏能力"的一部分,而是没提交的
          临时草稿,用户来回切模式时清空是可接受的代价。 */}
      {!canEditStructure && (
        <BriefingPanel
          collapsed={briefCollapsed}
          onToggleCollapse={() => setBriefCollapsed(!briefCollapsed)}
          activeCompanyId={currentCompanyId}
          ceoId={currentCompany?.ceoId}
          dock={briefDock}
          onDockChange={setBriefDock}
          size={briefDock === "side" ? briefWidth : briefHeight}
          onResize={briefDock === "side" ? setBriefWidth : setBriefHeight}
        />
      )}

      <NewCompanyModal
        open={showCompanyModal}
        name={newCompanyName}
        onNameChange={setNewCompanyName}
        description={newCompanyDesc}
        onDescriptionChange={setNewCompanyDesc}
        onCancel={() => setShowCompanyModal(false)}
        onCreate={handleCreateCompany}
      />

      <AddAgentModal
        open={showAddModal}
        onCancel={() => setShowAddModal(false)}
        addTab={addTab} setAddTab={setAddTab}
        addName={addName} setAddName={setAddName}
        addRole={addRole} setAddRole={setAddRole}
        addParentId={addParentId} setAddParentId={setAddParentId}
        addProvider={addProvider} setAddProvider={setAddProvider}
        addModel={addModel} setAddModel={setAddModel}
        addFramework={addFramework} setAddFramework={setAddFramework}
        agents={agents}
        onSubmit={handleAddAgent}
        showTemplatePicker={showTemplatePicker} setShowTemplatePicker={setShowTemplatePicker}
        communityLoading={communityLoading}
        communityTemplates={communityTemplates}
        communityAgents={communityAgents}
        importingTemplateId={importingTemplateId}
        importTemplate={importTemplate}
        fillFromAgentCard={fillFromAgentCard}
      />

      <DeleteAgentDialog
        open={showDeleteDialog && !!deleteConfirmId}
        agentName={agents.find(a => a.id === deleteConfirmId)?.name || deleteConfirmId || ""}
        onConfirm={handleDeleteAgent}
        onCancel={() => { setShowDeleteDialog(false); setDeleteConfirmId(null); }}
      />

      {/* 可视化画布连线交互:拖拽连接完成后弹出的语义选择弹窗(见 handleConnect 上方注释)。 */}
      {connectDraft && currentCompany && (() => {
        const sourceAgent = agents.find(a => a.id === connectDraft.source);
        const targetAgent = agents.find(a => a.id === connectDraft.target);
        if (!sourceAgent || !targetAgent) return null;
        return (
          <ConnectEdgeModal
            company={currentCompany}
            sourceAgent={sourceAgent}
            targetAgent={targetAgent}
            onClose={() => setConnectDraft(null)}
            onCompanyUpdated={(c) => { handleStructureCompanyUpdated(c); setConnectDraft(null); }}
          />
        );
      })()}

    </div>
  );
}
