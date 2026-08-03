import { CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { useT } from "../../i18n.js";

export interface McpMissingItem { name: string; purpose?: string; optional?: boolean }

// 安装完成弹层:公司/团队已装好之后,如实列出模板声明但本机还没配的 MCP(不阻断安装——MCP 是本机服务,
// 装不装是用户的选择),给一个直达 MCP 配置页的按钮。missingMcp 为空时就是一个纯粹的成功确认。
export default function InstallResultModal({
  title, agentCount, missingMcp, onClose,
}: {
  title: string;
  agentCount: number;
  missingMcp: McpMissingItem[];
  onClose: () => void;
}) {
  const tr = useT();
  const goToMcp = () => {
    window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "capability", tab: "mcp" } }));
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1200]" onClick={onClose}>
      <div className="bg-bg-card rounded-xl p-6 w-[420px] max-w-[90vw] shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 size={20} className="text-green shrink-0" />
          <b className="text-[14px] text-text-primary">{tr("c.installResultTitle", { name: title })}</b>
        </div>
        <p className="text-[13px] text-text-secondary m-0 mb-3">{tr("c.installResultAgents", { n: agentCount })}</p>
        {/* 收口③:模板绝不携带作者机器的绝对路径,装好的公司必然未绑定主工作目录——如实提示去重新绑定 */}
        <p className="text-[12px] text-text-secondary m-0 mb-3">{tr("cmp.folder.rebindAfterImport")}</p>

        {missingMcp.length > 0 && (
          <div className="rounded-lg border border-amber/25 bg-amber/8 p-3 mb-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle size={13} className="text-amber shrink-0" />
              <b className="text-[13px] text-text-primary">{tr("c.missingMcpTitle", { n: missingMcp.length })}</b>
            </div>
            <ul className="m-0 pl-4 flex flex-col gap-1">
              {missingMcp.map((m, i) => (
                <li key={i} className="text-[12px] text-text-secondary">
                  <b className="text-text-primary">{m.name}</b>
                  {m.purpose ? ` — ${m.purpose}` : ""}
                  {m.optional ? ` (${tr("tw.mcpOptional")})` : ""}
                </li>
              ))}
            </ul>
            <button onClick={goToMcp}
              className="mt-2.5 inline-flex items-center gap-1 px-3 py-1.5 rounded-md border-none bg-amber text-white text-[12px] font-medium cursor-pointer hover:opacity-90">
              {tr("c.goConfigureMcp")} <ArrowRight size={12} />
            </button>
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="btn-primary">{tr("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
