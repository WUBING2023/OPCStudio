import { useEffect } from "react";
import { motion } from "framer-motion";
import { Settings, MessageSquare } from "lucide-react";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";

export interface MemberMenu { x: number; y: number; agentId: string; companyId: string; }

// 群聊成员头像的左键/右键菜单:进入配置 / 进入对话。菜单点外关闭、右键关闭、Esc 关闭。
// 进入配置:先把 org 页要看的公司写进 localStorage(与 OrgPage 同一 key,跳过去后从这家公司挂载
// 并选中该员工,避免被"换公司清选中"的兜底 effect 清掉)+ select(agentId) + 跳 org 页(opc-navigate)。
// 进入对话:复用既有 cockpit-open-agent 跨页契约(App.tsx 切工作台 + 选中该员工;群/单聊互斥由
// CockpitPage 监听同一事件清空群选中)。
export default function MemberAvatarMenu({ menu, onClose }: { menu: MemberMenu; onClose: () => void }) {
  const tr = useT();

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const enterConfig = () => {
    try { localStorage.setItem("opc-org-company", menu.companyId); } catch { /* localStorage 不可用则跳过公司预置 */ }
    useAgentStore.getState().select(menu.agentId);
    window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "org" } }));
  };
  const enterChat = () => {
    window.dispatchEvent(new CustomEvent("cockpit-open-agent", { detail: { agentId: menu.agentId } }));
  };

  const item = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <div
      key={label}
      className="px-3 flex items-center gap-2 cursor-pointer hover:bg-surface-2 transition-colors"
      style={{ height: 32, color: "var(--color-ink)", fontSize: 12 }}
      onClick={() => { onClose(); onClick(); }}
    >
      <span style={{ opacity: 0.6, flexShrink: 0 }}>{icon}</span> {label}
    </div>
  );

  const left = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : menu.x) - 180);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed z-[9999] overflow-hidden py-0.5"
      style={{
        left: Math.max(4, left),
        top: menu.y,
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-hairline)",
        borderRadius: 8,
        minWidth: 160,
        boxShadow: "var(--shadow-md)",
      }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      {item(<Settings size={13} />, tr("chat.member.openConfig"), enterConfig)}
      {item(<MessageSquare size={13} />, tr("chat.member.openChat"), enterChat)}
    </motion.div>
  );
}
