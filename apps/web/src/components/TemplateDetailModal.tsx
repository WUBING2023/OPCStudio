import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { X } from "lucide-react";
import type { CompanyTemplate } from "@opc/shared";
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
  template: CompanyTemplate;
  onClose: () => void;
  onImport: () => void;
}

export default function TemplateDetailModal({ template, onClose, onImport }: Props) {
  const authorLink = template.authorGitHub
    ? `https://github.com/${template.authorGitHub}`
    : null;

  const agentTree = useMemo(() => {
    const byParent: Record<string, typeof template.agents> = {};
    for (const a of template.agents) {
      const p = a.parentId || "__root__";
      (byParent[p] ??= []).push(a);
    }
    const renderLevel = (parentId: string | undefined, depth: number): JSX.Element[] => {
      const children = byParent[parentId || "__root__"] || [];
      return children.map(a => (
        <div key={a.id}>
          <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 20 }}>
            <span className="text-[10px] text-white rounded-lg px-2 py-0.5 whitespace-nowrap font-medium"
              style={{ backgroundColor: ROLE_COLORS[a.role] || "#999" }}>
              {ROLE_LABELS[a.role] || a.role}
            </span>
            <span className="text-[13px] text-text-primary">{a.name}</span>
            <span className="text-[10px] text-text-muted">{a.provider} / {a.model}</span>
          </div>
          {renderLevel(a.id, depth + 1)}
        </div>
      ));
    };
    return renderLevel(undefined, 0);
  }, [template.agents]);

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl w-[90vw] max-w-[900px] max-h-[85vh] flex flex-col overflow-hidden shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center px-5 py-4 border-b border-border">
          <div>
            <b className="text-lg">{template.title}</b>
            <div className="text-xs text-text-muted mt-0.5">
              by{" "}
              {authorLink ? (
                <a href={authorLink} target="_blank" rel="noopener noreferrer" className="text-accent">
                  @{template.author}
                </a>
              ) : (
                `@${template.author}`
              )}
            </div>
          </div>
          <button onClick={onClose}
            className="border-none bg-transparent cursor-pointer text-text-muted hover:text-text-primary transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 p-5 overflow-auto">
            {template.tags.length > 0 && (
              <div className="flex gap-1.5 mb-4 flex-wrap">
                {template.tags.map(tag => (
                  <span key={tag} className="text-[11px] bg-accent/10 text-accent rounded-full px-2.5 py-0.5">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div className="text-sm text-text-secondary leading-relaxed">
              <ReactMarkdown>{template.readme}</ReactMarkdown>
            </div>
          </div>

          <div className="w-[320px] border-l border-border p-5 overflow-auto bg-bg-hover">
            <h4 className="m-0 mb-3 text-sm font-semibold">团队结构 ({template.agents.length} Agent)</h4>
            {agentTree}
            {template.recommendedConfig && (
              <div className="mt-5 p-3 bg-bg-card rounded-lg border border-border">
                <h4 className="m-0 mb-2 text-[13px] font-semibold">推荐配置</h4>
                {template.recommendedConfig.defaultModel && (
                  <div className="text-[11px] text-text-secondary mb-1">
                    默认模型: {template.recommendedConfig.defaultModel}
                  </div>
                )}
                {template.recommendedConfig.budget && (
                  <div className="text-[11px] text-text-secondary mb-1">
                    Token 上限: {template.recommendedConfig.budget.maxTokensPerTask.toLocaleString()} / 任务
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 justify-end px-5 py-3.5 border-t border-border">
          <button onClick={onClose} className="btn-secondary">取消</button>
          <button onClick={onImport} className="btn-primary">
            导入 ({template.agents.length} Agent)
          </button>
        </div>
      </div>
    </div>
  );
}
