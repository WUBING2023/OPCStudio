import type { ArchitectAction } from "../api/client.js";

// CEO 架构对话:把一条 ArchitectAction 判别式联合翻成一行大白话人话(变更预览卡片逐条列出用)。
// 纯函数,不依赖组件——ArchitectChatPanel 里 tr 是渲染态闭包,这里只接受它当参数,不重复实现 i18n。
type Tr = (key: string, params?: Record<string, string | number>) => string;

const VERIFY_METHOD_KEY: Record<string, string> = {
  "llm-review": "org.panel.method.llmReview",
  "code-review": "org.panel.method.codeReview",
  "fact-check": "org.panel.method.factCheck",
};

export function describeArchitectAction(action: ArchitectAction, tr: Tr): string {
  switch (action.type) {
    case "add_agent": {
      let s = tr("arch.action.addAgent", { name: action.name, role: action.role });
      if (action.reportsToName) s += tr("arch.action.reportsTo", { name: action.reportsToName });
      return s;
    }
    case "remove_agent":
      return tr("arch.action.removeAgent", { name: action.name });
    case "update_agent": {
      let s = tr("arch.action.updateAgent", { name: action.name });
      if (action.newName) s += tr("arch.action.renameTo", { name: action.newName });
      if (action.role) s += ` · role → ${action.role}`;
      if (action.provider) s += tr("arch.action.changeProvider", { provider: action.provider });
      if (action.model) s += tr("arch.action.changeModel", { model: action.model });
      if (action.framework) s += ` · framework → ${action.framework}`;
      if (action.reportsToName) s += tr("arch.action.reportsTo", { name: action.reportsToName });
      if (action.workingDirectory !== undefined) s += ` · workdir → ${action.workingDirectory ?? "default"}`;
      if (action.systemPrompt !== undefined) s += ` · prompt ${action.systemPrompt === null ? "reset" : "updated"}`;
      if (action.visibilityPolicy !== undefined) s += ` · visibility → ${action.visibilityPolicy ?? "default"}`;
      if (action.reasoningEffort !== undefined) s += ` · reasoning → ${action.reasoningEffort ?? "default"}`;
      if (action.enabled !== undefined) s += ` · ${action.enabled ? "enabled" : "disabled"}`;
      return s;
    }
    case "add_verification_edge":
      return tr("arch.action.addVerify", {
        producer: action.producerName,
        verifier: action.verifierName,
        method: tr(VERIFY_METHOD_KEY[action.method] ?? "org.panel.method.custom"),
      });
    case "remove_verification_edge":
      return tr("arch.action.removeVerify", { producer: action.producerName, verifier: action.verifierName });
    case "add_a2a_channel": {
      let s = tr("arch.action.addChannel", { from: action.fromName, to: action.toName });
      if (action.purpose) s += tr("arch.action.channelPurpose", { purpose: action.purpose });
      return s;
    }
    case "remove_a2a_channel":
      return tr("arch.action.removeChannel", { from: action.fromName, to: action.toName });
    case "upsert_bundled_skill":
      return `+ Skill「${action.skillName}」→ ${action.roles.join(", ")}`;
    case "remove_bundled_skill":
      return `− Skill「${action.skillName}」`;
    case "update_company_governance": {
      const fields = [
        action.visibilityPolicy !== undefined ? "visibility" : "",
        action.recommendedConfig !== undefined ? "recommended config" : "",
        action.requiredPermissions !== undefined ? "permissions" : "",
        action.toolRequirements !== undefined ? "tool requirements" : "",
        action.mcpRequirements !== undefined ? "MCP requirements" : "",
      ].filter(Boolean);
      return `✎ Company governance · ${fields.join(", ") || "no fields"}`;
    }
    default:
      return tr("arch.action.unknown");
  }
}
