import type { CompanyEditOperation } from "@opc/shared";

// D7 · 把一条 CompanyEditOperation 翻成一行大白话(diff preview 逐条列出用)——同
// architectActions.ts::describeArchitectAction 同一用途,换成这套 operation 判别式联合。
type Tr = (key: string, params?: Record<string, string | number>) => string;

export function describeCompanyEditOp(op: CompanyEditOperation, tr: Tr): string {
  switch (op.op) {
    case "add_agent":
      return tr("cae.op.addAgent", { name: op.agent.name, role: op.agent.role });
    case "update_agent":
      return tr("cae.op.updateAgent", { agentId: op.agentId });
    case "remove_agent":
      return tr("cae.op.removeAgent", { agentId: op.agentId });
    case "add_edge":
      return tr("cae.op.addEdge", { from: op.from, to: op.to });
    case "remove_edge":
      return tr("cae.op.removeEdge", { from: op.from, to: op.to });
    case "rename_company":
      return tr("cae.op.renameCompany", { name: op.name });
    case "update_description":
      return tr("cae.op.updateDescription");
    case "update_a2a_policy":
      return op.action === "remove"
        ? tr("cae.op.removeA2a", { from: op.from, to: op.to })
        : tr("cae.op.addA2a", { from: op.from, to: op.to });
    case "add_memory_seed":
      return tr("cae.op.addMemorySeed", { level: op.seed.level, owner: op.seed.owner_type });
    case "add_default_mission":
      return tr("cae.op.addDefaultMission", { title: op.mission.title });
    case "update_capability_requirement":
      return op.requirement.action === "remove"
        ? tr("cae.op.removeCapability", { name: op.requirement.name })
        : tr("cae.op.addCapability", { name: op.requirement.name });
    default:
      // 收敛后所有写侧 op 类型都已覆盖(exhaustive);兜底仅防未来遗漏。
      return tr("cae.op.unsupported", { op: (op as { op: string }).op });
  }
}
