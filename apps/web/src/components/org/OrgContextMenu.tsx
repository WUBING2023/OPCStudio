import { LayoutDashboard, Plus, Settings, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import type { AgentNodeConfig } from "@opc/shared";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";

export interface CtxMenu { x: number; y: number; agentId: string; }

// Right-click node menu on the org canvas: open chat / add child / edit / delete. Extracted out of
// OrgPage.tsx (temperate split — same behavior, just its own file).
export default function OrgContextMenu({
  menu,
  agents,
  onClose,
  canEditStructure = true,
}: {
  menu: CtxMenu;
  agents: AgentNodeConfig[];
  onClose: () => void;
  /** 日常使用模式下为 false:只保留查看详情/在工作台打开聊天,隐藏加子节点/删除这两项结构性操作。 */
  canEditStructure?: boolean;
}) {
  const tr = useT();
  const ctxAgent = agents.find(a => a.id === menu.agentId);
  const select = useAgentStore(s => s.select);
  if (!ctxAgent) return null;

  const isCeo = ctxAgent.role === "ceo";

  const menuItem = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => (
    <div
      key={label}
      className="px-3 flex items-center gap-2 cursor-pointer hover:bg-surface-2 transition-colors"
      style={{
        height: 32,
        color: danger ? "var(--color-error)" : "var(--color-ink)",
        fontSize: 12,
        borderBottom: "1px solid var(--color-hairline)",
      }}
      onClick={() => { onClose(); onClick(); }}
    >
      <span style={{ opacity: 0.6, flexShrink: 0 }}>{icon}</span> {label}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="fixed z-[9999] overflow-hidden"
      style={{
        left: menu.x,
        top: menu.y,
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-hairline)",
        borderRadius: 8,
        minWidth: 160,
        boxShadow: "var(--shadow-md)",
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* v3 D1: 编辑统一进侧栏（含改名/供应商/模型），右键不再提供冗余的内联重命名，消除"两个编辑入口"。
          isCeo/非isCeo 走同一个"打开设置"入口——两者都只是 select(id) 打开同一个 AgentDetailsPanel，
          区别只在于面板内 CEO 部分字段不可编辑，不需要在右键菜单文案上分叉。 */}
      {menuItem(<Settings size={13} />, tr('org.ctxViewDetails'), () => select(ctxAgent.id))}

      {/* 在工作台查看该员工:切到 Cockpit 页 + 选中其会话(聊天 + 实时产出监视台一起看)。 */}
      {menuItem(<LayoutDashboard size={13} />, tr('org.ctxOpenChat'), () => {
        window.dispatchEvent(new CustomEvent("cockpit-open-agent", { detail: { agentId: ctxAgent.id } }));
      })}

      {canEditStructure && menuItem(<Plus size={13} />, tr('org.ctxAddChild'), () => {
        window.dispatchEvent(new CustomEvent("org-add-agent", {
          detail: { parentId: ctxAgent.id }
        }));
      })}

      {canEditStructure && !isCeo && ctxAgent.deletable && menuItem(<Trash2 size={13} />, tr('common.delete'), () => {
        useAgentStore.getState().select(null);
        window.dispatchEvent(new CustomEvent("org-delete-agent", { detail: { agentId: ctxAgent.id } }));
      }, true)}
    </motion.div>
  );
}
