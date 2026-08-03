import type { CompanyTemplate } from "@opc/shared";
import { useT } from "../i18n.js";

function stripMd(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/(?<![*\w])[*_`](?![*\s])/g, "")
    .replace(/(?<![\s*])[*_`](?![*\w])/g, "")
    .trim();
}

const GithubIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
    <path d="M9 18c-4.51 2-5-2-7-2"/>
  </svg>
);

export default function CompanyTemplateCard({
  template,
  onSelect,
  onImport,
}: {
  template: CompanyTemplate;
  onSelect: () => void;
  onImport: () => void;
}) {
  const t = useT();
  const lines = (template.readme || "")
    .split("\n")
    .map(l => stripMd(l))
    .filter(l => l.trim())
    .slice(0, 2);
  const authorLink = template.authorGitHub
    ? `https://github.com/${template.authorGitHub}`
    : null;

  return (
    <div className="bg-bg-card border border-border rounded-xl p-3.5 min-w-[200px] max-w-[220px] flex flex-col gap-2 flex-shrink-0 shadow-sm">
      <b className="text-sm cursor-pointer text-accent truncate min-w-0 pe-7" onClick={onSelect}>
        {template.title}
      </b>
      <div className="text-[11px] text-text-muted flex items-center gap-1" dir="ltr">
        {t('common.by')}{" "}
        {authorLink ? (
          <a
            href={authorLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent no-underline inline-flex items-center gap-0.5"
            onClick={e => e.stopPropagation()}
          >
            @{template.author}
            <GithubIcon size={12} />
          </a>
        ) : (
          `@${template.author}`
        )}
      </div>
      {template.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {template.tags.map(tag => (
            <span key={tag} className="text-[10px] bg-accent/10 text-accent rounded-full px-2 py-0.5">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="text-[11px] text-text-secondary">
        {t('c.agents', { n: template.agents.length })}
      </div>
      <div className="flex justify-between text-[11px] text-text-muted">
        <span>{t('c.downloads', { n: template.downloads.toLocaleString() })}</span>
        <span>{t('c.stars', { n: template.stars.toLocaleString() })}</span>
      </div>
      {lines.length > 0 && (
        <div className="text-[10px] text-text-muted/70 leading-snug line-clamp-2">
          {lines.join(" ")}
        </div>
      )}
      <button
        onClick={e => { e.stopPropagation(); onImport(); }}
        className="mt-auto py-1.5 text-xs btn-primary">
        {t('common.import')}
      </button>
    </div>
  );
}
