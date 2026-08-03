import { useMemo } from "react";
import { ROLE_COLORS } from "../../lib/agentMeta.js";
import { useT } from "../../i18n.js";
import type { WorkshopDraft } from "./workshopTypes.js";

export default function WorkshopPreview({ draft }: { draft: WorkshopDraft }) {
  const tr = useT();

  const tree = useMemo(() => {
    const byParent: Record<string, typeof draft.cards> = {};
    for (const c of draft.cards) {
      const p = c.reportsTo || "__root__";
      (byParent[p] ??= []).push(c);
    }
    const renderLevel = (parentKey: string, depth: number): JSX.Element[] =>
      (byParent[parentKey] || []).map(c => (
        <div key={c.key}>
          <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 20 }}>
            <span className="text-[10px] text-white rounded-lg px-2 py-0.5 whitespace-nowrap font-medium"
              style={{ backgroundColor: ROLE_COLORS[c.role.trim().toLowerCase()] || "#999" }}>
              {c.role || "?"}
            </span>
            <span className="text-[13px] text-text-primary">{c.name || tr("tw.unnamed")}</span>
            {(c.provider || c.model) && (
              <span className="text-[10px] text-text-muted">{c.provider || tr("tw.providerBlank")} / {c.model || "—"}</span>
            )}
            {c.systemPrompt.trim() && <span className="text-[10px] text-accent">{tr("tw.hasPersona")}</span>}
          </div>
          {renderLevel(c.key, depth + 1)}
        </div>
      ));
    return renderLevel("__root__", 0);
  }, [draft.cards, tr]);

  const roleCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of draft.cards) {
      const r = c.role.trim() || "?";
      m[r] = (m[r] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [draft.cards]);

  return (
    <div className="grid grid-cols-[1fr_260px] gap-5">
      <div>
        <h4 className="m-0 mb-2 text-[13px] font-semibold text-text-primary">
          {tr("tw.previewTree")} ({draft.cards.length})
        </h4>
        <div className="border border-border rounded-lg p-3 bg-bg-hover min-h-[120px]">
          {draft.cards.length ? tree : <span className="text-[13px] text-text-muted">{tr("tw.previewEmpty")}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div className="border border-border rounded-lg p-3 bg-bg-hover">
          <h4 className="m-0 mb-2 text-[13px] font-semibold text-text-primary">{tr("tw.previewStats")}</h4>
          <div className="text-[12px] text-text-secondary flex flex-col gap-1">
            <div>{tr("tw.statCards")}: {draft.cards.length}</div>
            <div>{tr("tw.statEdges")}: {draft.edges.length}</div>
            <div>{tr("tw.statPersonas")}: {draft.cards.filter(c => c.systemPrompt.trim()).length}</div>
            <div>{tr("tw.statSkills")}: {draft.bundledSkills.length}</div>
            <div>{tr("tw.statMcp")}: {draft.mcpRequirements.length}</div>
            <div>{tr("tw.statA2a")}: {draft.a2aChannels.length}</div>
            <div>{tr("tw.recommendedConfig")}: {draft.recommendedConfigEnabled ? "✓" : "—"}</div>
          </div>
        </div>
        <div className="border border-border rounded-lg p-3 bg-bg-hover">
          <h4 className="m-0 mb-2 text-[13px] font-semibold text-text-primary">{tr("tw.previewRoles")}</h4>
          <div className="flex flex-col gap-1">
            {roleCounts.map(([r, n]) => (
              <div key={r} className="flex justify-between text-[12px] text-text-secondary">
                <span>{r}</span><span>{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
