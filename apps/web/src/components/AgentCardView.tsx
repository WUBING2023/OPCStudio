import type { AgentCard } from "@opc/shared";
import { ROLE_COLORS as SHARED_ROLE_COLORS } from "../lib/agentMeta.js";

const GithubIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
    <path d="M9 18c-4.51 2-5-2-7-2"/>
  </svg>
);

// 色彩纪律:角色色单一来源 agentMeta(muted 色板),不再各自维护高饱和副本;docs 为本地补充角色。
const ROLE_COLORS: Record<string, string> = { ...SHARED_ROLE_COLORS, docs: "#a3839c" };

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  lead: "Lead",
  architect: "架构师",
  dev: "开发",
  test: "测试",
  security: "安全",
  ops: "运维",
  docs: "文档",
};

export default function AgentCardView({
  card,
  onSelect,
  onImport,
}: {
  card: AgentCard;
  onSelect: () => void;
  onImport: () => void;
}) {
  const roleColor = ROLE_COLORS[card.role] || "#999";
  const roleLabel = ROLE_LABELS[card.role] || card.role;
  const promptPreview = (card.agent?.systemPrompt || "")
    .split("\n")
    .filter(l => l.trim())
    .slice(0, 3)
    .join(" ");
  const authorLink = card.authorGitHub
    ? `https://github.com/${card.authorGitHub}`
    : null;

  return (
    <div className="bg-bg-card border border-border rounded-xl p-3.5 min-w-[200px] max-w-[220px] flex flex-col gap-2 flex-shrink-0 shadow-sm">
      <div className="flex items-center gap-2">
        <b className="text-sm cursor-pointer text-accent flex-1 min-w-0 truncate" onClick={onSelect}>
          {card.title}
        </b>
        <span className="text-[10px] text-white rounded-full px-2 py-0.5 whitespace-nowrap font-medium"
          style={{ backgroundColor: roleColor }}>
          {roleLabel}
        </span>
      </div>
      <div className="text-[11px] text-text-muted">
        推荐模型: {card.agent?.recommendedModel || "—"}
      </div>
      <div className="text-[11px] text-text-muted flex items-center gap-1 flex-wrap">
        by{" "}
        {authorLink ? (
          <a
            href={authorLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent no-underline inline-flex items-center gap-0.5"
            onClick={e => e.stopPropagation()}
          >
            @{card.author}
            <GithubIcon size={12} />
          </a>
        ) : (
          `@${card.author}`
        )}
        {card.license && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-hover text-text-secondary" title="来源许可证">{card.license}</span>
        )}
        {card.sourceUrl && (
          <a href={card.sourceUrl} target="_blank" rel="noopener noreferrer"
            className="text-accent no-underline" onClick={e => e.stopPropagation()} title={card.sourceUrl}>来源↗</a>
        )}
      </div>
      {card.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {card.tags.map(tag => (
            <span key={tag} className="text-[10px] bg-accent/10 text-accent rounded-full px-2 py-0.5">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="flex justify-between text-[11px] text-text-muted">
        <span>{card.downloads.toLocaleString()} 下载</span>
        <span>{card.stars.toLocaleString()} 星</span>
      </div>
      {promptPreview && (
        <div className="text-[10px] text-text-muted/70 leading-snug max-h-[42px] overflow-hidden">
          {promptPreview.slice(0, 120)}
        </div>
      )}
      <button
        onClick={e => { e.stopPropagation(); onImport(); }}
        className="mt-auto py-1.5 text-xs font-medium btn-primary">
        导入
      </button>
    </div>
  );
}
