import type { TeamTemplate } from "@opc/shared";
import { Users } from "lucide-react";

const GithubIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
    <path d="M9 18c-4.51 2-5-2-7-2"/>
  </svg>
);

export default function TeamCard({
  team,
  onSelect,
  onImport,
}: {
  team: TeamTemplate;
  onSelect: () => void;
  onImport: () => void;
}) {
  const authorLink = team.authorGitHub ? `https://github.com/${team.authorGitHub}` : null;
  const workerCount = Math.max(0, team.agents.length - 1); // minus the lead

  return (
    <div className="bg-bg-card border border-border rounded-xl p-3.5 min-w-[200px] max-w-[220px] flex flex-col gap-2 flex-shrink-0 shadow-sm">
      <b className="text-sm cursor-pointer text-accent flex items-center gap-1.5 min-w-0" onClick={onSelect}>
        <Users size={14} className="flex-shrink-0" /> <span className="truncate">{team.title}</span>
      </b>
      <div className="text-[11px] text-text-muted flex items-center gap-1">
        by{" "}
        {authorLink ? (
          <a href={authorLink} target="_blank" rel="noopener noreferrer"
            className="text-accent no-underline inline-flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
            @{team.author}<GithubIcon size={12} />
          </a>
        ) : <span>@{team.author}</span>}
      </div>
      <div className="text-[12px] text-text-secondary line-clamp-2 min-h-[32px]">{team.description}</div>
      <div className="flex flex-wrap gap-1">
        {team.tags.slice(0, 3).map(tag => (
          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">{tag}</span>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-text-muted mt-0.5">
        <span>{workerCount} 名成员 · ★ {team.stars}</span>
        <button onClick={onImport}
          className="px-2.5 py-1 rounded-lg border border-accent/40 bg-accent/10 text-accent text-[12px] cursor-pointer hover:bg-accent/20">
          导入
        </button>
      </div>
    </div>
  );
}
