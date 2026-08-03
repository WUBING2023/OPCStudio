import type { AgentNodeConfig, TraceEvent } from "@opc/shared";
import { roleColor } from "./AgentAvatar.js";
import { NEUTRAL_GRAY } from "../../lib/agentMeta.js";
import { stripMd } from "./traceFormat.js";
import type { BadgeKey } from "./traceTypes.js";

// 分享欲 Stage · "群聊剧本"派生 —— 把 GET /runs/:id/transcript 的结构化条目(+ 直播时并入的
// TraceEvent)翻成"群聊气泡流":连续同人消息聚合、日期分隔线、系统通知 pill、结尾交付报告卡。
// 纯派生 + 纯数据(不含 ReactNode)——同一份 blocks 既喂 ChatReplay.tsx 的 React 渲染，也喂
// buildShareHtml 的静态 HTML 导出，保证"页面上看到的"和"导出分享的"永远是同一份剧本。

export type TranscriptKind = "system_start" | "message" | "verifier" | "rejected" | "degraded" | "system_end";
export interface TranscriptEntry {
  id: string;
  at: string;
  kind: TranscriptKind;
  agentId?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

// 直播事件 → 与服务端 deriveChatTranscript 同形状的条目，供 isLive 时把 useAgentStore 的实时事件
// 并入已拉到的历史快照(与 traceTypes.ts 的 normalizeLive 同一"静态+实时双路"模式，字段来源须与
// runRoutes.ts::deriveChatTranscript 保持一致，两边各自独立解析同一批 TraceEvent payload 形状)。
export function liveEventToTranscriptEntry(e: TraceEvent): TranscriptEntry | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const base = { id: e.id, at: e.timestamp };
  switch (e.type) {
    case "run_started":
      return { ...base, kind: "system_start", text: typeof p.goal === "string" ? p.goal : undefined };
    case "agent_message": {
      const text = typeof p.text === "string" ? p.text : undefined;
      if (!text) return null;
      return { ...base, kind: "message", agentId: e.agentId, text, meta: { audience: p.audience } };
    }
    case "verifier_result":
      return { ...base, kind: "verifier", agentId: e.agentId, meta: { producer: p.producer, method: p.method, accept: p.accept, reason: p.reason } };
    case "artifact_rejected":
      return { ...base, kind: "rejected", agentId: e.agentId, meta: { artifactId: p.artifactId, reason: p.reason } };
    case "deliverable_degraded":
      return { ...base, kind: "degraded", meta: { reason: p.reason } };
    case "run_finished":
      return { ...base, kind: "system_end", meta: { totalTokens: p.totalTokens, totalCost: p.totalCost, allClean: p.allClean, deferredCount: p.deferredCount, failed: p.failed } };
    default:
      return null;
  }
}

export interface ChatActor { id?: string; name: string; role?: string; color: string; initial: string; }
function guessRole(id: string): string { return id.split("-")[0] || id; }
export function resolveActor(agentId: string | undefined, agents: AgentNodeConfig[]): ChatActor {
  if (!agentId) return { name: "OPC", color: NEUTRAL_GRAY, initial: "O" };
  const agent = agents.find(a => a.id === agentId);
  const role = agent?.role ?? guessRole(agentId);
  const color = roleColor(role);
  const name = (agent?.name && agent.name.trim()) || agentId;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return { id: agentId, name, role, color, initial };
}

export interface ChatBlockDivider { kind: "divider"; id: string; label: string; }
export interface ChatBlockUser { kind: "user"; id: string; text: string; at: string; }
export interface ChatBlockPill { kind: "pill"; id: string; text: string; at: string; tone: "info" | "warn" | "error"; }
export interface ChatBlockCluster { kind: "cluster"; id: string; actor: ChatActor; messages: Array<{ id: string; text: string; at: string }>; }
export interface ChatBlockReport {
  kind: "report"; id: string; title: string; summary: string;
  badgeLabel: string; badgeColor: string; pending: boolean; viewLabel: string;
}
export type ChatBlock = ChatBlockDivider | ChatBlockUser | ChatBlockPill | ChatBlockCluster | ChatBlockReport;

type Tr = (key: string, params?: Record<string, string | number>) => string;

export interface ChatBlockOptions {
  agents: AgentNodeConfig[];
  t: Tr;
  lang: string;
  userGoal?: string;
  startedAt?: string | null;
}

// 剧本主体(不含结尾报告卡——那张卡需要 badge/report 摘要等 transcript 之外的数据，由调用方
// 用 buildReportBlock 单独拼在 blocks 末尾)。
export function buildChatBlocks(entries: TranscriptEntry[], opts: ChatBlockOptions): ChatBlock[] {
  const { agents, t, lang } = opts;
  const blocks: ChatBlock[] = [];
  let lastDay: string | null = null;
  let cluster: ChatBlockCluster | null = null;

  const pushDivider = (at: string) => {
    const day = at.slice(0, 10);
    if (!day || day === lastDay) return;
    lastDay = day;
    const d = new Date(at);
    const label = isNaN(d.getTime()) ? day : d.toLocaleDateString(lang, { month: "long", day: "numeric", weekday: "short" });
    blocks.push({ kind: "divider", id: `div-${day}`, label });
    cluster = null; // 跨天不聚合连续消息
  };

  // 开场:用户指令(右侧气泡)优先用调用方已加载的权威口径(taskMeta.userGoal);
  // entries 里的 system_start(run_started 事件)只在它缺失时兜底。
  const startEntry = entries.find(e => e.kind === "system_start");
  const goalText = opts.userGoal || startEntry?.text;
  const goalAt = opts.startedAt || startEntry?.at;
  if (goalText && goalAt) {
    pushDivider(goalAt);
    blocks.push({ kind: "user", id: "user-goal", text: goalText, at: goalAt });
  }

  for (const e of entries) {
    // system_start 已在开场处理；system_end 的"报告卡"由调用方在末尾单独拼，这里都跳过。
    if (e.kind === "system_start" || e.kind === "system_end") continue;
    pushDivider(e.at);

    if (e.kind === "message") {
      if (!e.text) continue;
      const actor = resolveActor(e.agentId, agents);
      const text = stripMd(e.text);
      if (cluster && cluster.actor.id === actor.id) {
        cluster.messages.push({ id: e.id, text, at: e.at });
      } else {
        cluster = { kind: "cluster", id: e.id, actor, messages: [{ id: e.id, text, at: e.at }] };
        blocks.push(cluster);
      }
      continue;
    }

    cluster = null; // 非 message 事件打断聚合(系统通知插进来，视觉上像 WeChat 的群系统消息)
    if (e.kind === "verifier") {
      const producer = resolveActor(typeof e.meta?.producer === "string" ? e.meta.producer : undefined, agents).name;
      const verifier = resolveActor(e.agentId, agents).name;
      const accept = !!e.meta?.accept;
      const text = accept
        ? t("trace.chat.verifierPass", { verifier, producer })
        : t("trace.chat.verifierFail", { verifier, producer });
      blocks.push({ kind: "pill", id: e.id, text, at: e.at, tone: accept ? "info" : "warn" });
    } else if (e.kind === "rejected") {
      const agent = resolveActor(e.agentId, agents).name;
      blocks.push({ kind: "pill", id: e.id, text: t("trace.chat.artifactRejected", { agent }), at: e.at, tone: "warn" });
    } else if (e.kind === "degraded") {
      blocks.push({ kind: "pill", id: e.id, text: t("trace.chat.degraded"), at: e.at, tone: "error" });
    }
  }
  return blocks;
}

export function buildReportBlock(opts: {
  badge: BadgeKey; badgeLabel: string; badgeColor: string; summary: string; pending: boolean; t: Tr;
}): ChatBlockReport {
  return {
    kind: "report", id: "report-card",
    title: opts.t("trace.chat.reportTitle"),
    summary: opts.summary,
    badgeLabel: opts.badgeLabel,
    badgeColor: opts.badgeColor,
    pending: opts.pending,
    viewLabel: opts.t("trace.chat.viewResult"),
  };
}

// ── 导出分享 HTML(自包含、内联样式、无外链)────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function nl2br(s: string): string {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

export interface ShareHtmlMeta { title: string; subtitle: string; footer: string; lang: string; }

function renderBlockHtml(b: ChatBlock): string {
  switch (b.kind) {
    case "divider":
      return `<div class="divider"><span>${escapeHtml(b.label)}</span></div>`;
    case "user":
      return `<div class="row row-user"><div class="bubble bubble-user">${nl2br(b.text)}</div></div>`;
    case "pill":
      return `<div class="pill pill-${b.tone}">${escapeHtml(b.text)}</div>`;
    case "cluster": {
      const msgs = b.messages.map(m => `<div class="bubble bubble-agent">${nl2br(m.text)}</div>`).join("");
      return `<div class="row row-agent">
        <div class="avatar" style="background:${b.actor.color}22;color:${b.actor.color};border-color:${b.actor.color}55">${escapeHtml(b.actor.initial)}</div>
        <div class="col">
          <div class="name" style="color:${b.actor.color}">${escapeHtml(b.actor.name)}</div>
          ${msgs}
        </div>
      </div>`;
    }
    case "report":
      return `<div class="report">
        <div class="report-top"><span class="report-title">${escapeHtml(b.title)}</span><span class="badge" style="background:${b.badgeColor}">${escapeHtml(b.badgeLabel)}</span></div>
        <div class="report-summary">${escapeHtml(b.summary)}</div>
      </div>`;
    default:
      return "";
  }
}

const SHARE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0d0d12;color:#f0f0f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
.wrap{max-width:640px;margin:0 auto;padding:32px 16px 44px;}
.hd{text-align:center;margin-bottom:8px;}
.brand{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#5e6ad2;background:#5e6ad222;border:1px solid #5e6ad255;padding:3px 10px;border-radius:999px;margin-bottom:12px;}
.hd h1{font-size:17px;margin:0 0 4px;font-weight:600;line-height:1.45;}
.hd .sub{font-size:12px;color:#8b8b96;}
.chat{display:flex;flex-direction:column;gap:10px;margin-top:22px;}
.divider{text-align:center;font-size:11px;color:#585862;margin:14px 0 4px;}
.divider span{background:#1a1a1f;padding:3px 10px;border-radius:999px;}
.row{display:flex;gap:8px;align-items:flex-start;}
.row-user{justify-content:flex-end;}
.avatar{width:30px;height:30px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;border:1px solid;}
.col{display:flex;flex-direction:column;gap:4px;max-width:78%;}
.name{font-size:11px;font-weight:600;padding:0 2px;}
.bubble{padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;}
.bubble-agent{background:#1a1a1f;color:#f0f0f5;border:1px solid #222228;border-top-left-radius:4px;}
.bubble-user{background:#5e6ad2;color:#fff;border-top-right-radius:4px;max-width:78%;}
.pill{align-self:center;text-align:center;font-size:11.5px;padding:5px 12px;border-radius:999px;margin:2px auto;}
.pill-info{background:#0ea5e922;color:#0ea5e9;}
.pill-warn{background:#f59e0b22;color:#f59e0b;}
.pill-error{background:#ef444422;color:#ef4444;}
.report{margin-top:14px;padding:14px;border-radius:14px;background:linear-gradient(155deg,#171722,#121218);border:1px solid #26263066;}
.report-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.report-title{font-size:13.5px;font-weight:700;}
.badge{font-size:10.5px;font-weight:600;color:#fff;padding:2px 8px;border-radius:999px;white-space:nowrap;}
.report-summary{margin-top:6px;font-size:12.5px;color:#8b8b96;line-height:1.6;}
.ft{text-align:center;margin-top:30px;font-size:11px;color:#585862;}
`;

export function buildShareHtml(blocks: ChatBlock[], meta: ShareHtmlMeta): string {
  const body = blocks.map(renderBlockHtml).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(meta.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>${SHARE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="hd"><div class="brand">OPC Studio</div><h1>${escapeHtml(meta.title)}</h1><div class="sub">${escapeHtml(meta.subtitle)}</div></header>
<div class="chat">
${body}
</div>
<footer class="ft">${escapeHtml(meta.footer)}</footer>
</div>
</body>
</html>
`;
}
