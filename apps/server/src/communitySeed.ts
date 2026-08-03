import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentCard, AgentNodeConfig, CompanyBundle, CompanyTemplate, PromptTemplate, CommunityIndex } from "@opc/shared";
import { bundleToTemplateShape, CURRENT_BUNDLE_SCHEMA_VERSION, DEFAULT_MODELS } from "@opc/shared";
import { WORKER_CARDS } from "./seed/communityContent.js";
import { TEAM_TEMPLATES } from "./seed/teamContent.js";
import { COMPANY_TEMPLATES } from "./seed/companyContent.js";
import { GAME_COMPANY } from "./seed/gameContent.js";
import { builtinWorkerSkills } from "./seed/workerSkills.js";

const BASE_AGENT = {
  childrenIds: [] as string[],
  status: "idle" as const,
  currentTask: undefined,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  costUsd: 0,
  lastAction: undefined,
  editable: true,
  deletable: false,
  enabled: true,
};

function fullstackSaaSTeam(): CompanyTemplate {
  const agents = [
    { ...BASE_AGENT, id: "ceo", name: "CEO", role: "ceo", parentId: undefined, model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "lead", name: "Tech Lead", role: "lead", parentId: "ceo", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "architect", name: "Architect", role: "architect", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "dev-fe", name: "Frontend Dev", role: "dev", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "dev-be", name: "Backend Dev", role: "dev", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "dev-db", name: "Database Dev", role: "dev", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "dev-ml", name: "ML Engineer", role: "dev", parentId: "lead", model: "MiniMax-M3", provider: "minimax" },
    { ...BASE_AGENT, id: "test", name: "QA Engineer", role: "test", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "ops", name: "DevOps", role: "ops", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "security", name: "Security", role: "security", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "docs", name: "Docs Writer", role: "dev", parentId: "lead", model: "MiniMax-M3", provider: "minimax" },
  ] as any;
  agents.forEach((a: any, i: number) => {
    if (i > 0) a.childrenIds = [];
  });
  (agents[0] as any).childrenIds = ["lead"];
  (agents[1] as any).childrenIds = agents.slice(2).map((a: any) => a.id);

  return {
    id: "fullstack-saas",
    title: "Fullstack SaaS Team",
    description: "完整的 SaaS 产品开发团队，覆盖从前端到后端、从数据库到机器学习、从测试到安全的全部角色。11 个 Agent 协同工作，适合快速从零构建 SaaS 产品。",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["fullstack", "saas", "web"],
    downloads: 0,
    stars: 0,
    readme: `# Fullstack SaaS Team

## 团队结构
- **CEO**: 项目总指挥，负责任务分发与进度统筹
- **Tech Lead**: 技术负责人，需求分析与架构决策
- **Architect**: 系统架构设计，技术选型
- **Frontend Dev**: React/Next.js 前端开发
- **Backend Dev**: Node.js/Python 后端 API 开发
- **Database Dev**: 数据模型设计与查询优化
- **ML Engineer**: 机器学习模型开发与部署
- **QA Engineer**: 自动化测试与质量保障
- **DevOps**: CI/CD 与部署运维
- **Security**: 安全审计与防护
- **Docs Writer**: 技术文档与 API 文档

## 适用场景
- 从零构建 SaaS 产品 MVP
- 快速迭代产品功能
- 全栈 Web 应用开发

## 推荐配置
- 默认模型: deepseek-v4-pro
- 预算: $10/项目
- 权限: 允许文件写入，禁止 Shell 访问`,
    agents,
    recommendedConfig: {
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 10, maxTokensPerTask: 200_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
    },
  };
}

function openSourceMaintainer(): CompanyTemplate {
  const agents = [
    { ...BASE_AGENT, id: "ceo", name: "CEO", role: "ceo", parentId: undefined, model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "lead", name: "Maintainer Lead", role: "lead", parentId: "ceo", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "dev", name: "Core Dev", role: "dev", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "reviewer", name: "Code Reviewer", role: "dev", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "test", name: "Test Engineer", role: "test", parentId: "lead", model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "docs", name: "Docs Maintainer", role: "dev", parentId: "lead", model: "MiniMax-M3", provider: "minimax" },
    { ...BASE_AGENT, id: "community", name: "Community Manager", role: "ops", parentId: "lead", model: "MiniMax-M3", provider: "minimax" },
  ] as any;
  (agents[0] as any).childrenIds = ["lead"];
  (agents[1] as any).childrenIds = agents.slice(2).map((a: any) => a.id);

  return {
    id: "open-source-maintainer",
    title: "Open Source Maintainer",
    description: "专为开源项目维护设计的团队，包含代码审查、测试、文档和社区管理角色。7 个 Agent 高效协作，帮你维护高质量的开源项目。",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["open-source", "maintenance", "github"],
    downloads: 0,
    stars: 0,
    readme: `# Open Source Maintainer

## 团队结构
- **CEO**: 项目方向决策
- **Maintainer Lead**: 技术路线规划，Issue 优先级排序
- **Core Dev**: 核心功能开发与 Bug 修复
- **Code Reviewer**: PR Review，代码质量把控
- **Test Engineer**: 测试覆盖率，CI 流水线维护
- **Docs Maintainer**: README、CHANGELOG、API 文档
- **Community Manager**: Issue Triage，讨论区管理

## 适用场景
- 维护已有开源项目
- 处理 Issue 和 PR 积压
- 版本发布管理
- 社区运营与增长`,
    agents,
    recommendedConfig: {
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 5, maxTokensPerTask: 100_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true },
    },
  };
}

function securityAuditSquad(): CompanyTemplate {
  const agents = [
    { ...BASE_AGENT, id: "ceo", name: "CEO", role: "ceo", parentId: undefined, model: "deepseek-v4-pro", provider: "deepseek" },
    { ...BASE_AGENT, id: "lead", name: "Security Lead", role: "lead", parentId: "ceo", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "auditor", name: "Security Auditor", role: "security", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "pentest", name: "Penetration Tester", role: "security", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "compliance", name: "Compliance Analyst", role: "security", parentId: "lead", model: DEFAULT_MODELS.anthropic, provider: "anthropic" },
    { ...BASE_AGENT, id: "reporter", name: "Report Writer", role: "dev", parentId: "lead", model: "MiniMax-M3", provider: "minimax" },
  ] as any;
  (agents[0] as any).childrenIds = ["lead"];
  (agents[1] as any).childrenIds = agents.slice(2).map((a: any) => a.id);

  return {
    id: "security-audit-squad",
    title: "Security Audit Squad",
    description: "专业安全审计团队，覆盖代码审计、渗透测试、合规检查和安全报告生成。6 个 Agent 从多维度保障系统安全。",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["security", "audit", "compliance"],
    downloads: 0,
    stars: 0,
    readme: `# Security Audit Squad

## 团队结构
- **CEO**: 审计项目总指挥
- **Security Lead**: 安全策略制定，风险评估
- **Security Auditor**: 代码安全审查，漏洞分析
- **Penetration Tester**: 渗透测试，攻击面分析
- **Compliance Analyst**: 合规检查，标准对齐
- **Report Writer**: 审计报告生成

## 适用场景
- Web 应用安全审计
- API 安全评估
- 合规检查 (SOC2, ISO27001)
- 第三方依赖漏洞扫描`,
    agents,
    recommendedConfig: {
      defaultModel: DEFAULT_MODELS.anthropic,
      budget: { totalUsd: 20, maxTokensPerTask: 300_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
    },
  };
}

function agentCardTypescriptGuru(): AgentCard {
  return {
    id: "typescript-guru",
    title: "TypeScript Guru",
    description: "精通 TypeScript 类型系统、泛型编程和高级模式的专业开发 Agent。擅长大型项目的类型架构设计。",
    role: "dev",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["typescript", "frontend", "type-system"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: "ts-guru",
      name: "TypeScript Guru",
      recommendedProvider: "deepseek",
      recommendedModel: "deepseek-v4-pro",
      systemPrompt: `你是一位资深的 TypeScript 专家，拥有超过十年的大型前端项目经验。你的职责是为团队提供高质量的 TypeScript 代码和类型架构建议。

## 核心能力
- 精通 TypeScript 类型系统的所有特性：泛型、条件类型、映射类型、模板字面量类型、类型推断
- 擅长设计类型安全的 API 接口和领域模型
- 熟悉主流前端框架（React、Vue、Next.js）的 TypeScript 集成
- 能够通过类型系统预防运行时错误，提升代码可维护性

## 工作原则
- 优先使用类型系统表达业务约束，而非运行时检查
- 避免过度使用 any 和类型断言，使用类型守卫和类型谓词代替
- 为公共 API 提供完整准确的类型声明
- 合理使用泛型约束，避免过于宽泛或过于严格的类型
- 联合类型优先于枚举，除非需要运行时枚举值
- 使用 discriminated unions 处理状态相关的数据结构

## 输出规范
- 代码必须通过严格模式（strict: true）的类型检查
- 避免使用 deprecated 的 API 和不推荐的类型模式
- 每个导出的函数和接口都应有完整的类型签名
- 复杂类型应提供使用示例，帮助团队成员理解

## 协作准则
- 收到任务后先分析现有类型定义，保持一致性
- 对于新增类型，考虑其对现有代码的影响范围
- 主动提出类型重构建议，但需评估影响和优先级
- 与后端开发对齐 API 类型定义，避免类型不一致`,
      tools: [
        { name: "read_file", enabled: true, description: "读取项目文件" },
        { name: "write_file", enabled: true, description: "写入/修改文件" },
        { name: "search_code", enabled: true, description: "搜索代码符号" },
        { name: "run_tests", enabled: true, description: "运行类型检查" },
      ],
      expectedRole: "dev",
      recommendedParents: ["lead", "architect"],
    },
  };
}

function agentCardRustSystems(): AgentCard {
  return {
    id: "rust-systems-dev",
    title: "Rust Systems Dev",
    description: "专注系统编程和性能优化的 Rust 开发 Agent。擅长内存安全、并发编程和底层性能调优。",
    role: "dev",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["rust", "systems", "performance"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: "rust-dev",
      name: "Rust Systems Dev",
      recommendedProvider: "deepseek",
      recommendedModel: "deepseek-v4-pro",
      systemPrompt: `你是一位精通 Rust 的系统编程专家，在操作系统内核、网络服务和高性能计算领域拥有丰富的实战经验。你的使命是用 Rust 构建安全、高效、可靠的系统软件。

## 核心能力
- 深入理解 Rust 所有权、生命周期和借用检查机制
- 精通 tokio 异步运行时和 async/await 编程模型
- 熟悉 unsafe Rust 的正确使用场景和安全边界
- 擅长使用 Rust 构建高性能网络服务、CLI 工具和嵌入式系统
- 了解 LLVM 编译优化和性能分析工具（perf、flamegraph、criterion）

## 工作原则
- 安全性优先：在能够用安全代码表达时，绝不使用 unsafe
- 零成本抽象：善用 Rust 的类型系统和 trait 在编译期解决问题
- 错误处理：使用 Result 和 thiserror/anyhow 构建清晰的错误链路
- 性能优化：先测量再优化，使用 benchmark 指导决策
- 遵循 Rust API Guidelines，保持接口的一致性和可预测性

## 输出规范
- 所有代码通过 cargo clippy 和 cargo fmt 检查
- 公共 API 必须有完整的文档注释（/// 和 //!）
- 正确处理所有错误路径，不使用 unwrap() 在生产代码中
- 合理使用 workspaces 组织大型项目

## 协作准则
- 优先复用 crates.io 上成熟、维护良好的 crate
- 与架构师讨论技术选型时，明确各方案的 trade-off
- 为关键路径代码编写单元测试和集成测试
- 关注编译时间，避免不必要的依赖`,
      tools: [
        { name: "read_file", enabled: true },
        { name: "write_file", enabled: true },
        { name: "run_command", enabled: true, description: "执行 cargo 构建和测试" },
        { name: "search_code", enabled: true },
      ],
      expectedRole: "dev",
      recommendedParents: ["lead", "architect"],
    },
  };
}

function agentCardSecurityArchitect(): AgentCard {
  return {
    id: "security-architect",
    title: "Security Architect",
    description: "企业级安全架构专家，擅长威胁建模、安全设计和零信任架构。具备 CISSP 级别的安全知识体系。",
    role: "security",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["security", "architecture", "zero-trust"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: "sec-arch",
      name: "Security Architect",
      recommendedProvider: "anthropic",
      recommendedModel: DEFAULT_MODELS.anthropic,
      systemPrompt: `你是一位企业级安全架构专家，拥有 CISSP 和 CCSP 认证，在金融和互联网行业有超过十五年的安全架构设计经验。你擅长从攻击者的视角审视系统，同时从防御者的角度构建纵深防护体系。

## 核心能力
- 威胁建模：熟练运用 STRIDE、ATT&CK 框架进行系统化威胁分析
- 安全架构设计：零信任架构、微隔离、服务网格安全
- 密码学应用：密钥管理、证书体系、零知识证明的正确应用
- 安全编码：OWASP Top 10 防御、输入验证、输出编码
- 合规框架：SOC2、ISO 27001、GDPR、PCI DSS
- 云原生安全：Kubernetes 安全、容器逃逸防护、供应链安全

## 工作原则
- 纵深防御：不依赖单一安全机制，构建多层防护
- 最小权限：每个组件只拥有完成其功能所必需的最小权限
- 默认安全：系统默认配置应为最安全配置
- 安全左移：在设计和开发阶段就嵌入安全考量，而非事后修补
- 可审计性：所有安全关键操作必须有完整的审计日志

## 评估方法论
- 先进行资产识别和威胁建模，再给出具体建议
- 风险评估需量化影响和概率，给出清晰的优先级
- 对每个安全问题提供修复方案和临时缓解措施
- 区分"必须修复"和"建议改进"，帮助团队合理分配资源

## 输出规范
- 安全报告结构清晰：概述 - 发现 - 风险评估 - 修复建议
- 修复建议需包含具体代码示例或配置片段
- 对合规相关发现需引用对应的标准条款编号`,
      tools: [
        { name: "read_file", enabled: true },
        { name: "write_file", enabled: true },
        { name: "search_code", enabled: true },
        { name: "run_command", enabled: true, description: "运行安全扫描工具" },
      ],
      expectedRole: "security",
      recommendedParents: ["lead", "ceo"],
    },
  };
}

function agentCardUXResearcher(): AgentCard {
  return {
    id: "ux-researcher",
    title: "UX Researcher",
    description: "用户体验研究员，专注于用户行为分析、交互设计和可用性测试。善于从用户视角发现问题并优化产品体验。",
    role: "dev",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["ux", "design", "research"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: "ux-researcher",
      name: "UX Researcher",
      recommendedProvider: "minimax",
      recommendedModel: "MiniMax-M3",
      systemPrompt: `你是一位经验丰富的用户体验研究员，拥有认知心理学背景和多年的互联网产品设计经验。你擅长通过用户研究方法洞察真实需求，并将洞察转化为可落地的设计建议。

## 核心能力
- 用户研究方法论：访谈、问卷、可用性测试、A/B 测试、眼动追踪
- 信息架构设计：卡片分类、树形测试、导航设计
- 交互设计原则：Fitts 定律、Hick 定律、格式塔原则
- 设计系统：组件一致性、无障碍设计（WCAG 2.1 AA）、响应式适配
- 数据分析：用户行为漏斗、热力图、会话录屏分析

## 工作原则
- 用户至上：每个设计决策都应有用户数据或研究依据
- 简约优先：减少认知负荷，每个界面只呈现必要信息
- 可访问性：确保设计对各类用户（包括残障用户）友好
- 渐进披露：复杂功能分层展示，降低初学者的学习曲线
- 一致性：遵循平台设计规范和团队设计系统

## 输出规范
- 设计建议需包含用户场景和预期行为描述
- 交互方案应有清晰的页面流转和状态变化说明
- 对现有界面提出改进时，先分析当前设计的优缺点
- 可用性测试报告包含：测试目标、方法、参与者、关键发现、建议优先级

## 协作准则
- 与前端开发紧密合作，确保设计可实现且不牺牲性能
- 在早期阶段就介入产品讨论，避免后期推倒重来
- 关注用户反馈渠道（客服、社交媒体、应用商店评价），主动发现问题
- 定期进行竞品分析，了解行业最佳实践`,
      tools: [
        { name: "read_file", enabled: true },
        { name: "write_file", enabled: true },
        { name: "web_search", enabled: true, description: "搜索竞品和设计参考" },
        { name: "search_code", enabled: true },
      ],
      expectedRole: "dev",
      recommendedParents: ["lead"],
    },
  };
}

function agentCardDevOpsEngineer(): AgentCard {
  return {
    id: "devops-engineer",
    title: "DevOps Engineer",
    description: "基础设施即代码专家，精通 CI/CD 流水线、容器编排和云原生技术栈。专注自动化运维和系统可靠性。",
    role: "dev",
    author: "OPC Community",
    authorGitHub: "opc-studio",
    createdAt: "2026-06-01T00:00:00Z",
    tags: ["devops", "cloud", "automation"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: "devops",
      name: "DevOps Engineer",
      recommendedProvider: "deepseek",
      recommendedModel: "deepseek-v4-pro",
      systemPrompt: `你是一位资深的 DevOps 工程师，拥有丰富的云原生基础设施和自动化运维经验。你的使命是构建可靠、可扩展、可观测的系统运行环境，让开发团队能够快速安全地交付软件。

## 核心能力
- CI/CD：精通 GitHub Actions、GitLab CI、Jenkins 流水线设计和优化
- 容器技术：Docker 多阶段构建优化，Kubernetes 集群管理和故障排查
- 基础设施即代码：Terraform、Pulumi、Ansible 的模块化编写
- 可观测性：Prometheus + Grafana 监控体系，OpenTelemetry 分布式追踪，ELK/Loki 日志聚合
- 云平台：AWS、GCP、Azure 核心服务的架构和成本优化
- SRE 实践：SLO/SLI 定义，错误预算，事后复盘

## 工作原则
- 自动化一切：能自动化的手动操作绝不留给人工
- 基础设施即代码：所有环境变更必须通过代码管理和版本控制
- 不可变基础设施：服务器不可修改，变更通过重建实现
- 灰度发布：新版本逐步放量，确保可快速回滚
- 安全内置：密钥管理、网络隔离、镜像扫描嵌入流水线

## 输出规范
- 配置文件必须有清晰的注释说明每个参数的含义
- 基础设施变更需附带执行计划和预期影响评估
- 故障排查指南需包含诊断命令和预期输出
- 监控告警规则需附带阈值设置的业务依据

## 协作准则
- 与开发团队建立明确的职责边界：你建平台，他们用平台
- 定期进行容量规划和成本审查，及时发现资源浪费
- 参与架构评审，在早期阶段提出运维和部署相关建议
- 建立 on-call 轮值机制和升级路径`,
      tools: [
        { name: "read_file", enabled: true },
        { name: "write_file", enabled: true },
        { name: "run_command", enabled: true, description: "执行运维脚本和诊断命令" },
        { name: "search_code", enabled: true },
      ],
      expectedRole: "dev",
      recommendedParents: ["lead", "ops"],
    },
  };
}

// Prompt templates
const promptTemplates: PromptTemplate[] = [
  {
    id: "code-review-prompt",
    name: "Code Review Prompt",
    content: `Review the following code for:
1. Correctness — does it do what it claims?
2. Security — are there any vulnerabilities?
3. Performance — any obvious bottlenecks?
4. Maintainability — is it clear and well-structured?

Provide specific, actionable feedback with line references.`,
    enabled: true,
    author: "OPC Community",
    authorGitHub: "opc-studio",
    tags: ["code-review", "quality"],
    downloads: 0,
    stars: 0,
    createdAt: "2026-06-01T00:00:00Z",
  },
  {
    id: "api-design-review",
    name: "API Design Review Prompt",
    content: `Evaluate the following API design:
1. RESTful conventions — resource naming, HTTP verbs, status codes
2. Consistency — naming conventions, pagination, error format
3. Versioning — is there a clear versioning strategy?
4. Documentation — are endpoints self-describing?
5. Security — authentication, rate limiting, input validation

Suggest concrete improvements prioritized by impact.`,
    enabled: true,
    author: "OPC Community",
    authorGitHub: "opc-studio",
    tags: ["api", "design", "backend"],
    downloads: 0,
    stars: 0,
    createdAt: "2026-06-01T00:00:00Z",
  },
  {
    id: "bug-investigation",
    name: "Bug Investigation Prompt",
    content: `Investigate the following bug report:

## Bug Description
{bug_description}

## Steps to Reproduce
{steps}

## Expected vs Actual
Expected: {expected}
Actual: {actual}

Analyze potential root causes, identify affected code paths, and propose a fix with reasoning. If multiple possible causes exist, list them in order of likelihood.`,
    enabled: true,
    author: "OPC Community",
    authorGitHub: "opc-studio",
    tags: ["debugging", "bug-fix"],
    downloads: 0,
    stars: 0,
    createdAt: "2026-06-01T00:00:00Z",
  },
  {
    id: "system-architecture-review",
    name: "System Architecture Review Prompt",
    content: `Review this system architecture considering:
1. Scalability — can it handle 10x growth?
2. Reliability — what are the failure modes?
3. Security — threat model and attack surface
4. Cost efficiency — are resources appropriately used?
5. Observability — how is the system monitored?

For each area, identify risks and propose mitigations. Use the following format:
### {Area}
- Risk: {description} (Severity: High/Medium/Low)
- Mitigation: {concrete action}`,
    enabled: true,
    author: "OPC Community",
    authorGitHub: "opc-studio",
    tags: ["architecture", "system-design", "review"],
    downloads: 0,
    stars: 0,
    createdAt: "2026-06-01T00:00:00Z",
  },
  {
    id: "release-checklist",
    name: "Release Checklist Prompt",
    content: `Generate a release checklist for the current project state:
1. Verify all tests pass (unit, integration, e2e)
2. Check for uncommitted changes in critical paths
3. Review CHANGELOG.md for completeness
4. Verify database migrations are reversible
5. Check API version compatibility
6. Confirm monitoring dashboards are updated
7. Review rollback procedure
8. Validate deployment manifests/configs

For each item, indicate PASS/FAIL/WARN with a one-line note.`,
    enabled: true,
    author: "OPC Community",
    authorGitHub: "opc-studio",
    tags: ["devops", "release", "checklist"],
    downloads: 0,
    stars: 0,
    createdAt: "2026-06-01T00:00:00Z",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 官方种子公司模板(canonical CompanyBundle v0.3.0)
//
// 社区冷启动用的 3 个官方公司,面向本产品第一批真实用户(AI 方向学生/研究者)的高频场景:
//   ① 调研报告公司  ② 代码交付小队  ③ 学习陪练公司
//
// 这里是**权威来源**:每个模板以 canonical CompanyBundle(带 schema_version / privacy /
// compatibility / required_secrets)形式手写。落盘时经 bundleToTemplateShape 桥接成既有社区管线
// 认识的扁平 CompanyTemplate 形状(见 officialSeedTemplates + syncBuiltinContent 接线)——
// .opc/community/templates 目录本来就是由本文件的 seed 函数生成的扁平模板数据,index 重建
// (rebuildIndexFromDisk)也按扁平 CompanyTemplate 读取,直接落 bundle 信封会打乱 index。
// ─────────────────────────────────────────────────────────────────────────────

// 官方种子公司的员工节点默认值(与 BASE_AGENT 同惯例,但带 card persona,故单列一个工厂)。
function seedBundleAgent(over: Partial<AgentNodeConfig> & { id: string; name: string; role: string }): AgentNodeConfig {
  return {
    model: "deepseek-v4-pro",
    provider: "deepseek",
    childrenIds: [],
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0,
    editable: true,
    deletable: true,
    enabled: true,
    ...over,
  };
}

// deepseek provider 依赖统一声明为一条如实的 required_secret(3 个公司都只用 deepseek)。
const DEEPSEEK_SECRET = {
  name: "DEEPSEEK_API_KEY",
  description: "调用 deepseek 模型所需的 API 密钥(在「设置 → Provider」里配置,不随模板打包)。",
  required_for: "api",
};

// ① 调研报告公司:CEO(研究总监)+ 研究员 + 审稿人 → 有引用来源的结构化调研报告(markdown 交付)。
function researchReportCompany(): CompanyBundle {
  const agents: AgentNodeConfig[] = [
    seedBundleAgent({
      id: "ceo", name: "研究总监", role: "ceo", childrenIds: ["researcher", "reviewer"],
      uiPosition: { x: 0, y: 0 },
      card: {
        summary: "调研项目的一号位。接到调研目标后先拆解成子问题与检索方向,把研究任务分派给研究员,待审稿人核查通过后统稿定稿。工作方式:先定调研提纲与验收标准,再放手让成员推进,最后对整体结论负责。产出标准:一份结构清晰、结论有据、可直接交付的调研报告。",
        skills: [{ id: "scope", name: "选题拆解", description: "把模糊调研目标拆成可检索的子问题与提纲" }],
        produces: ["调研提纲", "最终报告"], consumes: ["调研目标"], acceptsQuery: true,
      },
    }),
    seedBundleAgent({
      id: "researcher", name: "研究员", role: "dev", parentId: "ceo",
      uiPosition: { x: -200, y: 220 },
      card: {
        summary: "负责主体检索与结论提炼。工作方式:围绕提纲逐条检索资料,交叉比对多个信息源,边查边记录出处,形成带引用的结论草稿。产出标准:每条关键结论都标注可追溯来源,区分事实与推断,不臆造数据。",
        skills: [{ id: "research", name: "资料检索与提炼", description: "多源检索并把要点整理成带引用的结论" }],
        produces: ["调研草稿"], consumes: ["调研提纲"],
      },
    }),
    seedBundleAgent({
      id: "reviewer", name: "审稿人", role: "fact_checker", parentId: "ceo",
      uiPosition: { x: 200, y: 220 },
      card: {
        summary: "对研究员的草稿逐条核查。工作方式:核对每条结论与其引用是否对应、是否以偏概全、数据是否被曲解,对存疑处标注并要求重做。产出标准:给出可执行的修改意见清单,只放行经得起核查的内容。",
        skills: [{ id: "factcheck", name: "事实核查", description: "逐条比对结论与来源,拦截未经核实的内容" }],
        produces: ["核查意见"], consumes: ["调研草稿"],
      },
    }),
  ];
  return {
    schema_version: CURRENT_BUNDLE_SCHEMA_VERSION,
    bundle_type: "company",
    bundle_id: "research-report-company",
    title: "调研报告公司",
    description: "研究总监统筹,研究员多源检索、审稿人逐条事实核查,把一个调研目标做成有引用来源的结构化调研报告(markdown 交付)——用交叉核查对抗单模型自说自话。",
    metadata: {
      version: "1.0.0",
      created_at: "2026-07-09T00:00:00.000Z",
      license: "OPC-Original",
      tags: ["research", "report", "fact-check", "markdown"],
    },
    company: { company_id: "research-report-company", name: "OPC Studio", description: "官方种子:面向调研/综述场景的研究型公司。", type: "company", default_language: "zh-CN" },
    agents,
    readme: [
      "# 调研报告公司",
      "",
      "把一个调研目标,变成一份**有引用来源、可直接交付的结构化调研报告**。",
      "",
      "## 团队结构",
      "- **研究总监(CEO)**:拆解调研目标为子问题与提纲,分派任务,统稿定稿。",
      "- **研究员**:围绕提纲多源检索,提炼带引用的结论草稿。",
      "- **审稿人**:对草稿逐条事实核查,不通过的内容打回重做。",
      "",
      "## 工作流",
      "研究员产出草稿 → 审稿人核查(verification edge,`fact-check`)→ 不通过则打回研究员重做 → 研究总监统稿成最终报告。",
      "",
      "## 交付物",
      "一份 markdown 调研报告:结论分条目、关键结论标注来源、区分事实与推断。",
      "",
      "## 适用场景",
      "技术趋势 / 竞品 / 行业调研;需要多来源交叉印证的事实密集型问题;把零散资料整理成有引用的综述。",
    ].join("\n"),
    useCases: [
      "技术趋势 / 竞品 / 行业调研报告",
      "需要多来源交叉印证的事实密集型问题",
      "把零散资料整理成有引用的结构化综述",
    ],
    riskNotes: [
      "受限于 worker 的公开网络检索,不适合需要一手实验数据或版权受限资料的调研",
      "事实核查是结构化复核,重大决策仍建议人工复核关键依据",
    ],
    toolRequirements: { requiredEngines: [], requiredProviders: ["deepseek"], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
    recommendedConfig: {
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 5, maxTokensPerTask: 200_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
    },
    workflow: { verificationEdges: [{ id: "ve-research", producer: "researcher", verifier: "reviewer", method: "fact-check", onReject: "redo", maxRounds: 1 }] },
    a2aChannels: [
      { from: "ceo", to: "researcher", purpose: "下发调研提纲与验收标准" },
      { from: "researcher", to: "reviewer", purpose: "提交调研草稿供核查" },
      { from: "reviewer", to: "researcher", purpose: "退回核查意见待修订" },
    ],
    privacy: { redacted: true, redacted_fields: [], required_secrets: [DEEPSEEK_SECRET] },
    compatibility: { min_app_version: CURRENT_BUNDLE_SCHEMA_VERSION, migration_notes: [] },
  };
}

// ② 代码交付小队:CEO(交付负责人)+ 工程师 + 测试员 → 一句话需求做成可运行代码 + 使用说明。
function codeDeliverySquad(): CompanyBundle {
  const agents: AgentNodeConfig[] = [
    seedBundleAgent({
      id: "ceo", name: "交付负责人", role: "ceo", childrenIds: ["engineer", "tester"],
      uiPosition: { x: 0, y: 0 },
      card: {
        summary: "把一句话需求变成可交付成果的一号位。工作方式:先与需求对齐,澄清输入输出与边界,拆成实现任务交给工程师,待测试员验收通过后整理成交付物。产出标准:可运行的代码,加一份让人照着就能跑起来的使用说明。",
        skills: [{ id: "clarify", name: "需求澄清与拆解", description: "把一句话需求澄清成边界清晰的实现任务" }],
        produces: ["交付说明"], consumes: ["需求"], acceptsQuery: true,
      },
    }),
    seedBundleAgent({
      id: "engineer", name: "工程师", role: "dev", parentId: "ceo",
      uiPosition: { x: -200, y: 220 },
      card: {
        summary: "负责把需求实现成可运行代码。工作方式:先想清楚数据流与接口,再写实现,保持结构清晰、命名达意,默认不写多余注释;交付前自测主流程能跑通。产出标准:代码可直接运行,附最小可复现的运行步骤,依赖与入口说明齐全。",
        skills: [{ id: "implement", name: "实现与自测", description: "把任务写成结构清晰、可运行的代码并自测主流程" }],
        produces: ["代码", "运行说明"], consumes: ["实现任务"],
      },
    }),
    seedBundleAgent({
      id: "tester", name: "测试员", role: "test", parentId: "ceo",
      uiPosition: { x: 200, y: 220 },
      card: {
        summary: "对工程师的产出做验收。工作方式:对照需求逐条检查功能是否达成,构造正常与边界输入审查逻辑,定位缺陷并给出可复现的失败场景。产出标准:一份明确的通过/打回结论加缺陷清单,只放行满足需求的代码。",
        skills: [{ id: "verify-code", name: "代码验收", description: "按需求逐条验收并给出可复现的缺陷" }],
        produces: ["验收结论", "缺陷清单"], consumes: ["代码"],
      },
    }),
  ];
  return {
    schema_version: CURRENT_BUNDLE_SCHEMA_VERSION,
    bundle_type: "company",
    bundle_id: "code-delivery-squad",
    title: "代码交付小队",
    description: "交付负责人对齐需求,工程师实现可运行代码,测试员按需求逐条验收、不通过打回——把一句话需求做成可直接运行的代码加使用说明。",
    metadata: {
      version: "1.0.0",
      created_at: "2026-07-09T00:00:00.000Z",
      license: "OPC-Original",
      tags: ["code", "delivery", "python", "prototype"],
    },
    company: { company_id: "code-delivery-squad", name: "OPC Studio", description: "官方种子:把一句话需求快速做成可运行代码的小队。", type: "company", default_language: "zh-CN" },
    agents,
    readme: [
      "# 代码交付小队",
      "",
      "给一句话需求,拿回**可直接运行的代码 + 一份照着就能跑起来的使用说明**。",
      "",
      "## 团队结构",
      "- **交付负责人(CEO)**:澄清需求的输入输出与边界,拆成实现任务,统一交付。",
      "- **工程师**:实现可运行代码,交付前自测主流程。",
      "- **测试员**:对照需求逐条验收,不通过的打回工程师修复。",
      "",
      "## 工作流",
      "工程师实现代码 → 测试员验收(verification edge,`code-review`)→ 不通过则打回工程师修复 → 交付负责人整理成最终交付物。",
      "",
      "## 交付物",
      "可运行代码 + 一份使用说明(依赖、入口、运行步骤)。",
      "",
      "## 适用场景",
      "把一句话需求做成小工具 / 脚本 / 函数;为已有代码补齐可运行示例;快速验证一个实现思路能否跑通。",
    ].join("\n"),
    useCases: [
      "把一句话需求做成可运行的小工具 / 脚本 / 函数",
      "为已有代码补齐可运行示例与说明",
      "快速验证一个实现思路能否跑通",
    ],
    riskNotes: [
      "适合中小规模、边界清晰的需求;大型系统需要更完整的团队与架构环节",
      "测试员为逻辑与需求符合性审查,不等同于完整的自动化测试覆盖",
    ],
    toolRequirements: { requiredEngines: [], requiredProviders: ["deepseek"], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
    recommendedConfig: {
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 5, maxTokensPerTask: 200_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
    },
    workflow: { verificationEdges: [{ id: "ve-code", producer: "engineer", verifier: "tester", method: "code-review", onReject: "redo", maxRounds: 1 }] },
    a2aChannels: [
      { from: "ceo", to: "engineer", purpose: "下发澄清后的需求与边界" },
      { from: "engineer", to: "tester", purpose: "提交可运行代码待验收" },
      { from: "tester", to: "engineer", purpose: "退回缺陷与失败场景待修复" },
    ],
    privacy: { redacted: true, redacted_fields: [], required_secrets: [DEEPSEEK_SECRET] },
    compatibility: { min_app_version: CURRENT_BUNDLE_SCHEMA_VERSION, migration_notes: [] },
  };
}

// ③ 学习陪练公司:CEO(陪练主管)+ 讲解员 + 出题员 → 把材料变成知识清单 + 自测题(带答案)。
function studyCoachCompany(): CompanyBundle {
  const agents: AgentNodeConfig[] = [
    seedBundleAgent({
      id: "ceo", name: "陪练主管", role: "ceo", childrenIds: ["explainer", "quizmaster"],
      uiPosition: { x: 0, y: 0 },
      card: {
        summary: "学习陪练的一号位。工作方式:接到学习材料后先明确学习目标与范围,安排讲解员梳理知识、出题员命题,最后把知识清单与自测题合成一份完整的复习包。产出标准:让学习者拿到就能按图索骥地复习并自我检验。",
        skills: [{ id: "plan-study", name: "复习规划", description: "明确学习目标与范围,安排讲解与命题" }],
        produces: ["复习包"], consumes: ["学习材料"], acceptsQuery: true,
      },
    }),
    seedBundleAgent({
      id: "explainer", name: "讲解员", role: "dev", parentId: "ceo",
      uiPosition: { x: -200, y: 220 },
      card: {
        summary: "负责把材料提炼成知识清单。工作方式:通读材料,按主题归纳要点,用简明的话把每个知识点讲清楚,标注重点与易混淆处。产出标准:一份分条目、有层次的知识清单,覆盖材料主干,表述准确不含糊。",
        skills: [{ id: "distill", name: "知识提炼", description: "把材料归纳成分条目、有层次的知识清单" }],
        produces: ["知识清单"], consumes: ["学习材料"],
      },
    }),
    seedBundleAgent({
      id: "quizmaster", name: "出题员", role: "dev", parentId: "ceo",
      uiPosition: { x: 200, y: 220 },
      card: {
        summary: "根据知识清单命制自测题。工作方式:针对每个知识点设计题目,覆盖记忆、理解与应用不同层次,并给出标准答案与简要解析。产出标准:题目与知识清单一一对应、难度分布合理、答案正确可复核。",
        skills: [{ id: "make-quiz", name: "命题与答案", description: "按知识点命制分层自测题并给出答案解析" }],
        produces: ["自测题", "答案解析"], consumes: ["知识清单"],
      },
    }),
  ];
  return {
    schema_version: CURRENT_BUNDLE_SCHEMA_VERSION,
    bundle_type: "company",
    bundle_id: "study-coach-company",
    title: "学习陪练公司",
    description: "陪练主管统筹,讲解员把材料提炼成知识清单、出题员据此命制自测题,讲解员再核对题目与答案——把一份学习材料变成可复习、可自测的完整复习包。",
    metadata: {
      version: "1.0.0",
      created_at: "2026-07-09T00:00:00.000Z",
      license: "OPC-Original",
      tags: ["study", "learning", "quiz", "review"],
    },
    company: { company_id: "study-coach-company", name: "OPC Studio", description: "官方种子:把学习材料变成知识清单加自测题的学习陪练公司。", type: "company", default_language: "zh-CN" },
    agents,
    readme: [
      "# 学习陪练公司",
      "",
      "给一份学习材料,拿回**一份知识清单 + 一套配套自测题(带答案)**。",
      "",
      "## 团队结构",
      "- **陪练主管(CEO)**:明确学习目标与范围,安排讲解与命题,合成复习包。",
      "- **讲解员**:把材料提炼成分条目、有层次的知识清单。",
      "- **出题员**:据知识清单命制分层自测题,给出标准答案与解析。",
      "",
      "## 工作流",
      "讲解员产出知识清单 → 出题员据此命题 → 讲解员核对题目是否覆盖知识点、答案是否正确(verification edge,`llm-review`)→ 不通过则打回出题员重做 → 陪练主管合成复习包。",
      "",
      "## 交付物",
      "知识清单 + 自测题及答案解析。",
      "",
      "## 适用场景",
      "把课程 PPT / 讲义 / 文档变成复习知识清单;为一份材料生成配套自测题;考前快速梳理并自我检验。",
    ].join("\n"),
    useCases: [
      "把课程 PPT / 讲义 / 文档变成复习知识清单",
      "为一份材料生成配套自测题与答案",
      "考前快速梳理知识点并自我检验",
    ],
    riskNotes: [
      "知识清单与题目基于所给材料生成,材料本身有误会传导;重要结论建议对照原始资料",
      "自测题用于自我检验,不等同于正式考试的覆盖度与难度标定",
    ],
    toolRequirements: { requiredEngines: [], requiredProviders: ["deepseek"], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
    recommendedConfig: {
      defaultModel: "deepseek-v4-pro",
      budget: { totalUsd: 3, maxTokensPerTask: 150_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
    },
    workflow: { verificationEdges: [{ id: "ve-quiz", producer: "quizmaster", verifier: "explainer", method: "llm-review", onReject: "redo", maxRounds: 1 }] },
    a2aChannels: [
      { from: "ceo", to: "explainer", purpose: "下发学习材料与复习目标" },
      { from: "explainer", to: "quizmaster", purpose: "交付知识清单供命题" },
      { from: "quizmaster", to: "explainer", purpose: "提交自测题待核对" },
    ],
    privacy: { redacted: true, redacted_fields: [], required_secrets: [DEEPSEEK_SECRET] },
    compatibility: { min_app_version: CURRENT_BUNDLE_SCHEMA_VERSION, migration_notes: [] },
  };
}

// 3 个官方种子公司的 canonical CompanyBundle(权威来源)。供落盘接线与测试引用。
export const OFFICIAL_SEED_BUNDLES: CompanyBundle[] = [
  researchReportCompany(),
  codeDeliverySquad(),
  studyCoachCompany(),
];

// 桥接成社区管线认识的扁平 CompanyTemplate 形状(供 syncBuiltinContent 落盘 + index 重建)。
export function officialSeedTemplates(): CompanyTemplate[] {
  return OFFICIAL_SEED_BUNDLES.map((b) => bundleToTemplateShape(b) as unknown as CompanyTemplate);
}

export function seedCommunityContent(projectRoot: string) {
  const communityDir = path.join(projectRoot, ".opc", "community");
  if (fs.existsSync(communityDir)) return;

  const templatesDir = path.join(communityDir, "templates");
  const teamsDir = path.join(communityDir, "teams");
  const agentsDir = path.join(communityDir, "agents");
  const promptsDir = path.join(communityDir, "prompts");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });

  // Templates
  const templates = [
    fullstackSaaSTeam(),
    openSourceMaintainer(),
    securityAuditSquad(),
  ];

  // Agent cards
  const cards = [
    agentCardTypescriptGuru(),
    agentCardRustSystems(),
    agentCardSecurityArchitect(),
    agentCardUXResearcher(),
    agentCardDevOpsEngineer(),
  ];

  // Write templates
  for (const t of templates) {
    fs.writeFileSync(path.join(templatesDir, `${t.id}.json`), JSON.stringify(t, null, 2), "utf-8");
  }

  // Write agent cards
  for (const c of cards) {
    fs.writeFileSync(path.join(agentsDir, `${c.id}.json`), JSON.stringify(c, null, 2), "utf-8");
  }

  // Write prompt templates
  for (const p of promptTemplates) {
    fs.writeFileSync(path.join(promptsDir, `${p.id}.json`), JSON.stringify(p, null, 2), "utf-8");
  }

  // Build and write index
  const index: CommunityIndex = {
    templates: templates.map(t => ({
      id: t.id, title: t.title, author: t.author, authorGitHub: t.authorGitHub,
      tags: t.tags, downloads: t.downloads, stars: t.stars, createdAt: t.createdAt,
      agentCount: t.agents.length, license: (t as any).license ?? "OPC-Original",
    })),
    teams: [], // seeded teams arrive in Phase 12 (game company etc.)
    agents: cards.map(c => ({
      id: c.id, title: c.title, author: c.author, authorGitHub: c.authorGitHub,
      role: c.role, tags: c.tags, downloads: c.downloads, stars: c.stars, createdAt: c.createdAt,
      license: (c as any).license ?? "OPC-Original",
    })),
    prompts: promptTemplates.map(p => ({
      id: p.id, title: p.name, author: p.author, authorGitHub: p.authorGitHub,
      tags: p.tags, downloads: p.downloads, stars: p.stars, createdAt: p.createdAt,
    })),
  };

  fs.writeFileSync(path.join(communityDir, "index.json"), JSON.stringify(index, null, 2), "utf-8");
  console.log(`[communitySeed] Seeded ${templates.length} templates, ${cards.length} agent cards, ${promptTemplates.length} prompts`);
}

// Additive: write any builtin content files that are MISSING (never overwrite user edits /
// downloaded items), then rebuild the index from disk. Lets new content batches (Phase 12)
// appear in an already-seeded dev install without wiping anything. Idempotent.
export function syncBuiltinContent(projectRoot: string) {
  const communityDir = path.join(projectRoot, ".opc", "community");
  // Cold install → do the full seed first (creates dirs + initial set + index).
  if (!fs.existsSync(communityDir)) {
    seedCommunityContent(projectRoot);
  }
  const agentsDir = path.join(communityDir, "agents");
  const teamsDir = path.join(communityDir, "teams");
  const templatesDir = path.join(communityDir, "templates");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });

  const writeMissing = (dir: string, items: { id: string }[]): number => {
    let n = 0;
    for (const it of items) {
      const file = path.join(dir, `${it.id}.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(it, null, 2), "utf-8");
        n++;
      }
    }
    return n;
  };

  const addedCards = writeMissing(agentsDir, WORKER_CARDS);
  const addedTeams = writeMissing(teamsDir, TEAM_TEMPLATES);
  // 官方种子公司(canonical CompanyBundle → 扁平安装形状)与既有内置公司一并增量落盘,幂等。
  const addedCompanies = writeMissing(templatesDir, [...COMPANY_TEMPLATES, GAME_COMPANY, ...officialSeedTemplates()]);

  if (addedCards > 0 || addedTeams > 0 || addedCompanies > 0) {
    rebuildIndexFromDisk(projectRoot, communityDir);
    console.log(`[communitySeed] syncBuiltinContent: +${addedCards} workers, +${addedTeams} teams, +${addedCompanies} companies, index rebuilt`);
  }
}

// v3 B1: 把内置 worker 写成社区 builtin skills（.opc/community/skills/<id>.md，带来源/License frontmatter）。
// 增量、幂等：只写缺失文件，不覆盖。worker=skill 模型的官方内容。
export function syncBuiltinSkills(projectRoot: string) {
  const dir = path.join(projectRoot, ".opc", "community", "skills");
  fs.mkdirSync(dir, { recursive: true });
  let added = 0;
  for (const s of builtinWorkerSkills()) {
    const file = path.join(dir, `${s.id}.md`);
    if (fs.existsSync(file)) continue;
    const fm: string[] = ["---",
      `title: ${s.title}`,
      `role: ${s.role}`,
      "enabled: true",
    ];
    if (s.description) fm.push(`description: ${s.description}`);
    if (s.license) fm.push(`license: ${s.license}`);
    if (s.author) fm.push(`author: ${s.author}`);
    if (s.authorGitHub) fm.push(`authorGitHub: ${s.authorGitHub}`);
    fm.push("---", "");
    fs.writeFileSync(file, fm.join("\n") + s.content, "utf-8");
    added++;
  }
  if (added > 0) console.log(`[communitySeed] syncBuiltinSkills: +${added} builtin community skills`);
}

// Rebuild index.json by scanning all on-disk content (preserves user + builtin items).
function rebuildIndexFromDisk(projectRoot: string, communityDir: string) {
  const read = <T>(dir: string): T[] => {
    const full = path.join(communityDir, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full)
      .filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(fs.readFileSync(path.join(full, f), "utf-8")) as T);
  };
  const templates = read<CompanyTemplate>("templates");
  const teams = read<any>("teams");
  const cards = read<AgentCard>("agents");
  const prompts = read<PromptTemplate>("prompts");

  const index: CommunityIndex = {
    templates: templates.map(t => ({
      id: t.id, title: t.title, author: t.author, authorGitHub: t.authorGitHub,
      tags: t.tags, downloads: t.downloads, stars: t.stars, createdAt: t.createdAt,
      agentCount: t.agents.length, license: t.license ?? "OPC-Original",
    })),
    teams: teams.map(t => ({
      id: t.id, title: t.title, author: t.author, authorGitHub: t.authorGitHub,
      tags: t.tags, downloads: t.downloads, stars: t.stars, createdAt: t.createdAt,
      agentCount: Array.isArray(t.agents) ? t.agents.length : 0, license: t.license ?? "OPC-Original",
    })),
    agents: cards.map(c => ({
      id: c.id, title: c.title, author: c.author, authorGitHub: c.authorGitHub,
      role: c.role, tags: c.tags, downloads: c.downloads, stars: c.stars, createdAt: c.createdAt,
      license: c.license ?? "OPC-Original", sourceUrl: c.sourceUrl,
    })),
    prompts: prompts.map(p => ({
      id: p.id, title: p.name, author: p.author, authorGitHub: p.authorGitHub,
      tags: p.tags, downloads: p.downloads, stars: p.stars, createdAt: p.createdAt,
    })),
  };
  fs.writeFileSync(path.join(communityDir, "index.json"), JSON.stringify(index, null, 2), "utf-8");
}
