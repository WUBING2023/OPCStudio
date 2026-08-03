import { X } from "lucide-react";
import type { AgentCard } from "@opc/shared";
import { ROLE_COLORS as SHARED_ROLE_COLORS } from "../lib/agentMeta.js";

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

interface Props {
  card: AgentCard;
  onClose: () => void;
  onImport: () => void;
}

export default function AgentDetailModal({ card, onClose, onImport }: Props) {
  const roleColor = ROLE_COLORS[card.role] || "#999";
  const roleLabel = ROLE_LABELS[card.role] || card.role;
  const a = card.agent;

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl w-[90vw] max-w-[700px] max-h-[85vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <b className="text-lg">{card.title}</b>
            <span className="text-[11px] text-white rounded-full px-2.5 py-0.5 font-medium"
              style={{ backgroundColor: roleColor }}>
              {roleLabel}
            </span>
          </div>
          <button onClick={onClose}
            className="border-none bg-transparent cursor-pointer text-text-muted hover:text-text-primary transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          <div className="flex gap-4 mb-4 flex-wrap">
            {card.tags.map(tag => (
              <span key={tag} className="text-[11px] bg-accent/10 text-accent rounded-full px-2.5 py-0.5">
                {tag}
              </span>
            ))}
          </div>

          <div className="text-[13px] text-text-secondary mb-4">
            {card.description}
          </div>

          {a && (
            <>
              <div className="flex gap-6 mb-4 flex-wrap">
                <div>
                  <div className="text-[11px] text-text-muted">推荐模型</div>
                  <div className="text-[13px] text-text-primary">{a.recommendedProvider} / {a.recommendedModel}</div>
                </div>
                <div>
                  <div className="text-[11px] text-text-muted">推荐 ID</div>
                  <div className="text-[13px] font-mono">{a.suggestedId}</div>
                </div>
                <div>
                  <div className="text-[11px] text-text-muted">预期角色</div>
                  <div className="text-[13px] text-text-primary">{a.expectedRole}</div>
                </div>
              </div>

              {a.recommendedParents.length > 0 && (
                <div className="mb-4">
                  <div className="text-[11px] text-text-muted mb-1">推荐父级</div>
                  <div className="flex gap-1.5">
                    {a.recommendedParents.map(p => (
                      <span key={p} className="text-[11px] bg-bg-hover rounded-full px-2.5 py-0.5 text-text-secondary">
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-2">
                <div className="text-[11px] text-text-muted mb-1">System Prompt</div>
                <pre className="bg-[#1e1e2e] text-[#d4d4d4] rounded-lg p-3.5 text-xs font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-auto m-0 leading-relaxed">
                  {a.systemPrompt}
                </pre>
              </div>

              {a.tools.length > 0 && (
                <div>
                  <div className="text-[11px] text-text-muted mb-1">工具列表</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {a.tools.map(t => (
                      <span key={t.name} className="text-[11px] bg-green/10 text-green rounded-full px-2.5 py-0.5">
                        {t.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-3 justify-end px-5 py-3.5 border-t border-border">
          <button onClick={onClose} className="btn-secondary">取消</button>
          <button onClick={onImport} className="btn-primary">导入</button>
        </div>
      </div>
    </div>
  );
}
