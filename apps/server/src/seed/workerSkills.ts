// Phase 12 v3 B1 — 把现有 30 个 worker AgentCard 改写成"skill 单元"模型（D1：worker=skill）。
// 这些是 OPC 官方原创内容（license=OPC-Original），systemPrompt 正文已在结尾标注真实参考来源。
// 落地为社区 builtin skills（.opc/community/skills/<id>.md），可被列出、下载、导入即转 scoped skill。
import type { SkillMeta } from "@opc/shared";
import { WORKER_CARDS } from "./communityContent.js";

export interface BuiltinSkillUnit extends Omit<SkillMeta, "enabled" | "lastModified"> {
  content: string;
}

// 人物卡：合规声明（原创演绎·非真人）已在其 systemPrompt 正文内，这里统一标 license=OPC-Original。
export function builtinWorkerSkills(): BuiltinSkillUnit[] {
  return WORKER_CARDS.map((c) => ({
    id: c.id,
    title: c.title,
    role: c.role,
    description: c.description,
    license: "OPC-Original",
    author: c.author,
    authorGitHub: c.authorGitHub,
    // source 保持 undefined：这是 OPC 官方原创，非从 GitHub 下载（来源在正文「## 参考来源」标注）。
    content: c.agent.systemPrompt,
  }));
}
