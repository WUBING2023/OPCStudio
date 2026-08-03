import type { CompanyTemplate, AgentNodeConfig } from "@opc/shared";

// Stage 7 · 第二个官方 Team:产品/编码队。idea → PRD → scaffold → test report → risk review,
// 异构互审:Claude Code 写代码 → Codex 验证(verification_edge,Stage 6)。
// 注:agents 只含结构(role 决定 prompt,见 getRolePrompt);质量由 Stage F live run 验证。

function node(p: Partial<AgentNodeConfig> & { id: string; role: string; name: string }): AgentNodeConfig {
  return {
    childrenIds: [], model: "sonnet", provider: "anthropic", framework: "claude-code",
    companyId: "", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...p,
  } as AgentNodeConfig;
}

const SONNET = { framework: "claude-code" as const, provider: "anthropic", model: "sonnet" };
// Bug 修复(2026-07-04,活体探测确认):gpt-5-codex 在 ChatGPT 订阅账号下调用会 400 报错(不支持),
// 只有账号自身配置的 gpt-5.5 真的能调通,详见 apps/web/src/lib/framework.ts 的 CLI_MODEL_ALIASES 注释。
const CODEX = { framework: "codex" as const, provider: "openai", model: "gpt-5.5" };

export const productCodingTeamTemplate: CompanyTemplate = {
  id: "product-coding-team-v1",
  title: "产品/编码队",
  description: "一人公司的产品+编码团队:产品需求 → PRD → 脚手架 → 测试报告 → 风险评审,Claude Code 写码、Codex 异构验证。",
  author: "OPC Studio",
  createdAt: "2026-06-30T00:00:00Z",
  tags: ["coding", "product", "cross-verification"],
  downloads: 0,
  stars: 0,
  readme: "## 产品/编码队\n\nidea → PRD(PM)→ 脚手架/代码(Dev, Claude Code)→ 测试报告(Tester)→ 风险评审(Security)。\n\n**异构互审**:Dev 的代码由 Codex 独立 code-review(verification_edge);未通过则打回返工,不进最终交付。\n\n**需要**:Claude Code + Codex 均已安装登录(执行前能力边界报告会检查)。",
  agents: [
    node({ id: "ceo-0", role: "ceo", name: "CEO", childrenIds: ["lead-1"] }),
    node({ id: "lead-1", role: "lead", name: "技术主管", parentId: "ceo-0", childrenIds: ["pm-2", "dev-3", "tester-4", "sec-5", "rev-6"], ...SONNET }),
    node({ id: "pm-2", role: "pm", name: "产品经理", parentId: "lead-1" }),
    node({ id: "dev-3", role: "dev", name: "工程师", parentId: "lead-1", ...SONNET }),
    node({ id: "tester-4", role: "test", name: "测试工程师", parentId: "lead-1" }),
    node({ id: "sec-5", role: "security_reviewer", name: "安全评审", parentId: "lead-1" }),
    node({ id: "rev-6", role: "code_reviewer", name: "Codex 代码核查", parentId: "lead-1", ...CODEX }),
  ],
  useCases: ["小型产品需求的端到端原型", "脚手架 + 测试 + 安全评审一体化", "需要异构模型互审代码的场景"],
  riskNotes: ["不适合大型生产系统的完整交付(原型/MVP 级)", "依赖 Codex 做代码核查;Codex 不可用时整队会被能力闸门拦下"],
  toolRequirements: {
    requiredEngines: ["claude-code", "codex"],
    requiredProviders: ["anthropic", "openai"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  workflow: {
    verificationEdges: [
      { producer: "dev", verifier: "code_reviewer", method: "code-review", onReject: "redo", maxRounds: 1 },
    ],
  },
};
