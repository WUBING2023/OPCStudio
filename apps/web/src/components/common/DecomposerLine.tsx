import type { TaskDecomposer } from "../../api/client.js";

// 方案卡下方"由 Leader「X」拆解 / 该公司暂无 Leader,由 CEO「X」兜底拆解"这行小字——把产出者名字
// (decomposer.name)做成可点击链接:能对应到真实 agent(isRealAgent 判定)就点进其单聊(复用
// cockpit-open-agent 跨页契约),否则退回纯文本(不做假链接)。BriefingPanel 与 ArchitectChatPanel
// 两处方案卡共用这一份,文案 key 由调用方传入(org.brief.exec.* / arch.exec.*)。
export default function DecomposerLine({ decomposer, leadKey, fallbackKey, isRealAgent, tr }: {
  decomposer: TaskDecomposer;
  leadKey: string;
  fallbackKey: string;
  isRealAgent: (id: string) => boolean;
  tr: (key: string, params?: Record<string, string | number>) => string;
}) {
  const key = decomposer.fallbackToCeo ? fallbackKey : leadKey;
  const clickable = !!decomposer.agentId && isRealAgent(decomposer.agentId);

  if (!clickable) {
    return <div className="text-[11px] text-ink-subtle">{tr(key, { name: decomposer.name })}</div>;
  }

  // 不插值 {name},按占位拆成前后两段,中间嵌可点击名字——保持整句语序,只让名字这一处成为链接。
  const template = tr(key);
  const idx = template.indexOf("{name}");
  const before = idx >= 0 ? template.slice(0, idx) : template + " ";
  const after = idx >= 0 ? template.slice(idx + "{name}".length) : "";
  const open = () => window.dispatchEvent(new CustomEvent("cockpit-open-agent", { detail: { agentId: decomposer.agentId } }));

  return (
    <div className="text-[11px] text-ink-subtle">
      {before}
      <button
        onClick={open}
        title={tr("chat.member.openChat")}
        className="text-accent hover:underline font-medium bg-transparent border-none p-0 cursor-pointer"
      >
        {decomposer.name}
      </button>
      {after}
    </div>
  );
}
