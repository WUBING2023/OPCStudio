// Phase 12 T3 — ~10 原创团队模板（TeamTemplate = 一个 lead + 自包含子树）。
// 导入时 rerootAgents 会整棵换 id 并挂到选定的 CEO/Lead，故内部 id 只需自洽。
import type { TeamTemplate, AgentNodeConfig } from "@opc/shared";
import { DEFAULT_MODELS } from "@opc/shared";

const BASE = {
  childrenIds: [] as string[],
  status: "idle" as const,
  currentTask: undefined,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  costUsd: 0,
  lastAction: undefined,
  editable: true,
  deletable: true,
  enabled: true,
};

interface WorkerSpec { id: string; name: string; role: string; provider: string; model: string; }

function team(o: {
  id: string; title: string; desc: string; tags: string[];
  leadName: string; leadProvider: string; leadModel: string;
  workers: WorkerSpec[]; readme: string;
}): TeamTemplate {
  const leadId = `${o.id}-lead`;
  const lead: AgentNodeConfig = {
    ...BASE, id: leadId, name: o.leadName, role: "lead", parentId: undefined,
    provider: o.leadProvider, model: o.leadModel,
    childrenIds: o.workers.map(w => `${o.id}-${w.id}`),
  } as AgentNodeConfig;
  const workers: AgentNodeConfig[] = o.workers.map(w => ({
    ...BASE, id: `${o.id}-${w.id}`, name: w.name, role: w.role, parentId: leadId,
    provider: w.provider, model: w.model, childrenIds: [],
  })) as AgentNodeConfig[];

  return {
    id: o.id, title: o.title, description: o.desc,
    author: "OPC Community", authorGitHub: "opc-studio",
    createdAt: "2026-06-12T00:00:00Z", tags: o.tags, downloads: 0, stars: 0,
    license: "OPC-Original",
    readme: o.readme, leadId, agents: [lead, ...workers],
  };
}

const DS = "deepseek", DM = "deepseek-v4-pro";
const MX = "minimax", MM = "MiniMax-M3";
const AN = "anthropic", AS = DEFAULT_MODELS.anthropic;

export const TEAM_TEMPLATES: TeamTemplate[] = [
  team({
    id: "team-research", title: "科研团队", tags: ["research", "academic", "writing"],
    desc: "文献综述 + 实验设计 + 论文写作的科研小组，由科研负责人统筹，方法严谨可复现。",
    leadName: "科研负责人", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "lit", name: "文献综述员", role: "dev", provider: AN, model: AS },
      { id: "exp", name: "实验设计员", role: "dev", provider: DS, model: DM },
      { id: "writer", name: "论文写作员", role: "dev", provider: AN, model: AS },
    ],
    readme: `# 科研团队\n\n- **科研负责人**：把研究问题拆成可检验的子问题，把控方法严谨性\n- **文献综述员**：系统检索与批判性阅读，区分一手证据与转述\n- **实验设计员**：可证伪假设、对照与可复现协议\n- **论文写作员**：结构化论证，主张与证据匹配\n\n## 适用\n论文写作、文献调研、实验方案评审。`,
  }),
  team({
    id: "team-writing", title: "内容写作团队", tags: ["writing", "content", "docs"],
    desc: "主编 + 技术写作 + 文案 + 校对的内容小组，从选题到成稿一条龙。",
    leadName: "内容主编", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "tech", name: "技术写作", role: "dev", provider: MX, model: MM },
      { id: "copy", name: "文案", role: "dev", provider: MX, model: MM },
      { id: "editor", name: "校对编辑", role: "test", provider: AN, model: AS },
    ],
    readme: `# 内容写作团队\n\n- **内容主编**：定选题与受众，把控质量与一致性\n- **技术写作**：把复杂技术讲清楚，面向读者任务组织\n- **文案**：精炼有力、打动人心的表达\n- **校对编辑**：事实核查、语言润色与风格统一\n\n## 适用\n技术文档、博客、产品文案、对外材料。`,
  }),
  team({
    id: "team-qa", title: "测试团队", tags: ["testing", "qa", "quality"],
    desc: "测试负责人带领的质量小组：自动化测试 + 代码审查 + 性能测试。",
    leadName: "测试负责人", leadProvider: DS, leadModel: DM,
    workers: [
      { id: "auto", name: "自动化测试", role: "test", provider: DS, model: DM },
      { id: "review", name: "代码审查", role: "test", provider: AN, model: AS },
      { id: "perf", name: "性能测试", role: "test", provider: DS, model: DM },
    ],
    readme: `# 测试团队\n\n- **测试负责人**：制定测试策略与覆盖目标\n- **自动化测试**：按测试金字塔分层，写真正会失败的测试\n- **代码审查**：结构化评审，区分阻塞项与建议\n- **性能测试**：先测量再优化，关注 p95/p99\n\n## 适用\n质量门禁、回归保障、上线前验收。`,
  }),
  team({
    id: "team-product", title: "产品团队", tags: ["product", "ux", "research"],
    desc: "产品经理带领的产品小组：交互设计 + 用户研究 + 数据分析，从问题到方案闭环。",
    leadName: "产品经理", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "ux", name: "交互设计师", role: "dev", provider: MX, model: MM },
      { id: "research", name: "用户研究", role: "dev", provider: MX, model: MM },
      { id: "analyst", name: "数据分析师", role: "dev", provider: MX, model: MM },
    ],
    readme: `# 产品团队\n\n- **产品经理**：从用户问题出发定义需求与优先级\n- **交互设计师**：清晰高效、低认知负荷的交互\n- **用户研究**：用研究方法洞察真实需求\n- **数据分析师**：用数据验证假设与衡量结果\n\n## 适用\n需求定义、产品迭代、体验优化。`,
  }),
  team({
    id: "team-growth", title: "增长团队", tags: ["growth", "marketing", "operations"],
    desc: "增长负责人带领：增长工程 + 市场策略 + 运营，用实验驱动可复现增长。",
    leadName: "增长负责人", leadProvider: MX, leadModel: MM,
    workers: [
      { id: "hacker", name: "增长工程", role: "dev", provider: MX, model: MM },
      { id: "market", name: "市场策略", role: "dev", provider: MX, model: MM },
      { id: "ops", name: "运营", role: "ops", provider: DS, model: DM },
    ],
    readme: `# 增长团队\n\n- **增长负责人**：定增长目标与实验节奏\n- **增长工程**：漏斗分析与 A/B 实验，找可复现杠杆\n- **市场策略**：定位与信息，把价值翻译成用户语言\n- **运营**：流程与节奏，让增长动作落地\n\n## 适用\n用户增长、转化优化、渠道运营。`,
  }),
  team({
    id: "team-data", title: "数据团队", tags: ["data", "analytics", "ml"],
    desc: "数据负责人带领：数据工程 + 数据科学 + 数据分析，从管道到洞察。",
    leadName: "数据负责人", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "engineer", name: "数据工程", role: "dev", provider: DS, model: DM },
      { id: "scientist", name: "数据科学", role: "dev", provider: MX, model: MM },
      { id: "analyst", name: "数据分析", role: "dev", provider: MX, model: MM },
    ],
    readme: `# 数据团队\n\n- **数据负责人**：统筹数据资产、口径与 SLA\n- **数据工程**：可靠可重跑的数据管道\n- **数据科学**：统计与实验，提取可信洞察\n- **数据分析**：把业务问题翻译成指标与分析\n\n## 适用\n数据平台、指标体系、分析支持。`,
  }),
  team({
    id: "team-frontend", title: "前端团队", tags: ["frontend", "react", "ui"],
    desc: "前端 Lead 带领的界面小组：React 开发 ×2 + 交互设计，注重性能与可访问性。",
    leadName: "前端 Lead", leadProvider: DS, leadModel: DM,
    workers: [
      { id: "dev1", name: "前端工程师 A", role: "dev", provider: DS, model: DM },
      { id: "dev2", name: "前端工程师 B", role: "dev", provider: DS, model: DM },
      { id: "ux", name: "交互设计师", role: "dev", provider: MX, model: MM },
    ],
    readme: `# 前端团队\n\n- **前端 Lead**：组件架构与技术选型\n- **前端工程师 A/B**：React 18 + 状态管理 + 性能优化\n- **交互设计师**：交互流程与可访问性\n\n## 适用\nWeb 界面开发、组件库、体验打磨。`,
  }),
  team({
    id: "team-backend", title: "后端团队", tags: ["backend", "api", "database"],
    desc: "后端 Lead 带领：Go + Python + 数据库架构，构建高并发可靠服务。",
    leadName: "后端 Lead", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "go", name: "Go 工程师", role: "dev", provider: DS, model: DM },
      { id: "py", name: "Python 工程师", role: "dev", provider: DS, model: DM },
      { id: "db", name: "数据库架构师", role: "architect", provider: AN, model: AS },
    ],
    readme: `# 后端团队\n\n- **后端 Lead**：服务架构与接口契约\n- **Go 工程师**：高并发低延迟服务\n- **Python 工程师**：Web 服务与数据接口\n- **数据库架构师**：数据建模与查询优化\n\n## 适用\nAPI 服务、数据后端、系统集成。`,
  }),
  team({
    id: "team-security", title: "安全团队", tags: ["security", "audit", "compliance"],
    desc: "安全负责人带领：安全架构 + 渗透测试 + 合规分析，纵深防御。",
    leadName: "安全负责人", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "arch", name: "安全架构师", role: "security", provider: AN, model: AS },
      { id: "pentest", name: "渗透测试", role: "security", provider: AN, model: AS },
      { id: "compliance", name: "合规分析", role: "security", provider: AN, model: AS },
    ],
    readme: `# 安全团队\n\n- **安全负责人**：安全策略与风险评估\n- **安全架构师**：威胁建模与零信任设计\n- **渗透测试**：攻击面分析与漏洞验证\n- **合规分析**：标准对齐（SOC2/ISO27001）\n\n## 适用\n安全审计、威胁建模、合规检查。`,
  }),
  team({
    id: "team-ai", title: "AI 团队", tags: ["ai", "ml", "prompt"],
    desc: "AI 负责人带领：机器学习工程 + 提示工程 + 数据科学，把模型带到生产。",
    leadName: "AI 负责人", leadProvider: AN, leadModel: AS,
    workers: [
      { id: "ml", name: "机器学习工程", role: "dev", provider: MX, model: MM },
      { id: "prompt", name: "提示工程", role: "dev", provider: AN, model: AS },
      { id: "ds", name: "数据科学", role: "dev", provider: MX, model: MM },
    ],
    readme: `# AI 团队\n\n- **AI 负责人**：AI 方案选型与评估标准\n- **机器学习工程**：训练-服务一致与监控\n- **提示工程**：稳定可评估的 LLM 工作流\n- **数据科学**：实验设计与离线评估\n\n## 适用\nAI 功能落地、模型迭代、LLM 应用。`,
  }),
];
