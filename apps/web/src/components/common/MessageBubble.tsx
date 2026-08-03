import { useState, type ReactNode, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ROLE_COLORS } from "../../lib/agentMeta.js";
import type { MessageAttribution } from "../../lib/messageAttribution.js";
import { useT } from "../../i18n.js";
import CopyButton from "./CopyButton.js";

// 共用消息气泡——BriefingPanel(org 简报栏)与 Cockpit(工作台对话)共用同一份渲染:头像(角色色首字母
// 圆形)+名字+时间+气泡;内容支持 markdown;超过阈值自动折叠成前几行摘要 + "展开全文"。
export type MessageBubbleVariant = "user" | "agent" | "system";

export interface MessageBubbleProps {
  variant: MessageBubbleVariant;
  name: string;
  content: string;
  timestamp?: string | number | Date;
  /** Agent role (ceo/lead/dev/test/security/ops/architect…) — drives the avatar color via the
   *  same ROLE_COLORS the org graph uses, so an employee's color stays consistent everywhere. */
  role?: string;
  /** Explicit avatar color override (skips role/variant-based resolution). */
  avatarColor?: string;
  /** Auto-collapse threshold in characters. Default 300. */
  collapseChars?: number;
  className?: string;
  /** Backward-compatible extension: when set, replaces the markdown-rendered `content` inside the
   *  bubble body with arbitrary rich content (e.g. BriefingPanel's run-report card). `content` still
   *  drives the empty-bubble guard and stays as a plain-text fallback. Omitting this prop preserves
   *  the exact previous markdown-only rendering for every existing caller. */
  card?: ReactNode;
  /** 群聊成员头像的左键/右键激活回调:设置后头像与发送者名都变为可点(左键与右键都触发,右键的
   *  preventDefault 由调用方处理),用于弹出成员菜单或进入单聊。不传则保持纯展示(现有调用方不受影响)。 */
  onAvatarActivate?: (e: MouseEvent<HTMLElement>) => void;
  /** 当前消息所属任务的短标签;显示在员工头像右上角,用于区分跨任务产出。 */
  contextBadge?: ReactNode;
  /** 溯源:带产出者归属的系统消息(如"由 Leader 拆解的方案派发失败")——设置后头像/名字显示成
   *  产出者身份(名字+角色色),并追加一枚"系统"小标以区分真·聊天消息;真·系统消息(无归属)不传,
   *  保留灰色"系统"身份。仅在 variant==="system" 时生效。 */
  attributedTo?: MessageAttribution;
}

const USER_COLOR = "var(--color-accent)";
const SYSTEM_COLOR = "var(--color-ink-muted)";

function resolveAvatarColor(variant: MessageBubbleVariant, role: string | undefined, override: string | undefined): string {
  if (override) return override;
  if (variant === "user") return USER_COLOR;
  if (variant === "system") return SYSTEM_COLOR;
  return (role && ROLE_COLORS[role]) || USER_COLOR;
}

function formatTime(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// 规则化截断(不调 LLM):取前 2-3 个非空行,再按字符数兜底裁剪——不追求 markdown 语法完整,只求预览可读。
function makePreview(text: string, maxChars: number): string {
  const nonEmpty = text.split(/\n/).filter(l => l.trim().length > 0);
  let preview = nonEmpty.slice(0, 3).join("\n");
  if (preview.length > maxChars) preview = preview.slice(0, maxChars).trimEnd();
  return preview;
}

export default function MessageBubble({
  variant, name, content, timestamp, role, avatarColor, collapseChars = 300, className, card, onAvatarActivate, contextBadge, attributedTo,
}: MessageBubbleProps) {
  const tr = useT();
  const [expanded, setExpanded] = useState(false);
  const safeContent = content ?? "";
  const isLong = !card && safeContent.length > collapseChars;
  const shown = isLong && !expanded ? makePreview(safeContent, collapseChars) : safeContent;
  // 溯源:带归属的系统消息按产出者身份(名字+角色色)显示,并加"系统"小标;其余保持原有解析。
  const attributed = variant === "system" && !!attributedTo?.name;
  const displayName = attributed ? attributedTo!.name : name;
  const color = attributed
    ? resolveAvatarColor("agent", attributedTo!.role, avatarColor)
    : resolveAvatarColor(variant, role, avatarColor);
  const initial = (displayName || "?").trim().charAt(0).toUpperCase() || "?";
  const isUser = variant === "user";
  const timeStr = timestamp !== undefined ? formatTime(timestamp) : "";

  if (!card && !safeContent.trim()) return null;

  return (
    <div className={`flex items-start gap-2 ${isUser ? "flex-row-reverse" : ""} ${className ?? ""}`}>
      <div className="relative shrink-0">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white select-none ${
            onAvatarActivate ? "cursor-pointer transition-shadow hover:ring-2 hover:ring-accent/50" : ""
          }`}
          style={{ background: color }}
          onClick={onAvatarActivate}
          onContextMenu={onAvatarActivate}
          role={onAvatarActivate ? "button" : undefined}
        >
          {initial}
        </div>
        {contextBadge && (
          <div className="absolute -top-1.5 left-5 max-w-[128px] rounded-full border border-hairline bg-surface-0 px-1.5 py-0.5 text-[9px] font-medium leading-none text-ink-muted shadow-sm truncate">
            {contextBadge}
          </div>
        )}
      </div>
      <div className={`min-w-0 flex flex-col gap-1 max-w-[86%] ${isUser ? "items-end" : "items-start"}`}>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-subtle px-0.5">
          <span
            className={`font-medium text-ink-muted truncate max-w-[160px] ${onAvatarActivate ? "cursor-pointer hover:text-accent hover:underline" : ""}`}
            onClick={onAvatarActivate}
            onContextMenu={onAvatarActivate}
            role={onAvatarActivate ? "button" : undefined}
          >
            {displayName}
          </span>
          {attributed && (
            <span className="shrink-0 px-1 py-px rounded bg-surface-1 border border-hairline text-[10px] text-ink-subtle">
              {tr("org.brief.systemName")}
            </span>
          )}
          {timeStr && <span className="tabular-nums">{timeStr}</span>}
        </div>
        <div
          className={`group relative rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed break-words ${
            isUser ? "bg-surface-2 text-ink"
              : variant === "system" ? "bg-surface-1 border border-hairline text-ink-muted"
                : "bg-surface-1 border border-hairline text-ink"
          }`}
        >
          {!card && (
            <CopyButton
              text={safeContent}
              className="absolute bottom-1 right-1 text-ink-subtle hover:text-ink bg-surface-0/70 hover:bg-surface-0"
            />
          )}
          {card ? card : (
            <div className="markdown-body break-words [&]:text-[13px] [&]:leading-relaxed [&_p]:m-0 [&_p+p]:mt-1.5 [&_pre]:bg-black/20 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-auto [&_code]:text-[0.92em] [&_a]:underline">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
            </div>
          )}
          {isLong && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="mt-1 text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 transition-colors duration-150 text-accent hover:opacity-80"
            >
              {expanded ? tr("common.collapse") : tr("common.expandFull")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
