// Phase 12 T4 — 原创公司模板（CompanyTemplate = 完整 CEO→lead→worker 组织树）。
// 用 company() 构建器自动接 childrenIds，支持多团队（多 lead）以展示嵌套放射布局。
import type { CompanyTemplate, AgentNodeConfig } from "@opc/shared";
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

interface NodeSpec { id: string; name: string; role: string; provider: string; model: string; }
interface TeamSpec { lead: NodeSpec; workers: NodeSpec[]; }

function node(spec: NodeSpec, parentId: string | undefined, children: string[]): AgentNodeConfig {
  return {
    ...BASE, id: spec.id, name: spec.name, role: spec.role, parentId,
    provider: spec.provider, model: spec.model, childrenIds: children,
  } as AgentNodeConfig;
}

function company(o: {
  id: string; title: string; desc: string; tags: string[]; readme: string;
  ceo: NodeSpec; teams: TeamSpec[];
  recommendedConfig?: CompanyTemplate["recommendedConfig"];
}): CompanyTemplate {
  const agents: AgentNodeConfig[] = [];
  const leadIds = o.teams.map(t => t.lead.id);
  agents.push(node(o.ceo, undefined, leadIds));
  for (const t of o.teams) {
    agents.push(node(t.lead, o.ceo.id, t.workers.map(w => w.id)));
    for (const w of t.workers) agents.push(node(w, t.lead.id, []));
  }
  return {
    id: o.id, title: o.title, description: o.desc,
    author: "OPC Community", authorGitHub: "opc-studio",
    createdAt: "2026-06-14T00:00:00Z", tags: o.tags, downloads: 0, stars: 0,
    license: "OPC-Original",
    readme: o.readme, agents,
    recommendedConfig: o.recommendedConfig,
  };
}

const DS = "deepseek", DM = "deepseek-v4-pro";
const MX = "minimax", MM = "MiniMax-M3";
const AN = "anthropic", AS = DEFAULT_MODELS.anthropic;
// P2(引擎/模型异质性 · 审计发现②):事实核查员专用——原模板全员 DM(deepseek-v4-pro),连"审查"角色
// 也和被审查者同一个模型,交叉验证的独立信号形同虚设。理想选择是换厂商(如 anthropic/claude-sonnet-5),
// 但这是官方旗舰模板,toolRequirements.requiredProviders 只声明了 deepseek——用户很可能没配 anthropic
// key,换厂商会让这个"开箱即用"的模板在无 anthropic key 时直接卡死核查环节。退而求其次:同厂商但换
// 不同代际/架构的模型——deepseek-reasoner 是推理特化模型,与生成向的 deepseek-v4-pro 训练路线不同,
// 用它审查能提供有意义的独立视角,且不引入新的 provider key 依赖。
const DM_FACT_CHECKER = "deepseek-reasoner";

// P0-4 · 精简默认公司·三槽位。不硬编码 provider 品牌,导入时按本机能力映射。
const ONE_PERSON_STARTUP: CompanyTemplate = {
  id: "one-person-startup",
  title: "一人初创公司",
  description: "精简三槽位起步:调度者分配任务、生产者编码交付、独立验证者核验。简单任务只启生产者;需要测试时增加验证者;复杂任务再增加 lead 或研究员。Provider 使用能力槽位而非品牌——导入时按本机可用模型自动映射。",
  author: "OPC Studio",
  authorGitHub: "opc-studio",
  createdAt: "2026-07-21T00:00:00Z",
  tags: ["starter", "minimal", "coding"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# 一人初创公司

三槽位起步——不用在一开始就看懂八人团队。

## 角色

- **调度者 (CEO)**: 理解任务,决定扩不扩编。简单任务直派给生产者,需要验证时增加验证者。
- **生产者 (Dev)**: 具备真文件读写 + 编码执行能力。写代码、写测试、写文档皆由此角色负责。
- **独立验证者 (Tester)**: 不与生产者共用自证路径。在独立快照中运行真实测试,只认退出码与 hash 一致。

## 使用方式

1. 简单编码任务→只启生产者,不需要验证者。
2. 需要测试证明→增加验证者,生产者产出后自动触发独立验证。
3. 复杂多步任务→增加 lead(研究员/架构师)或专业角色。

## Provider 映射

所有角色使用能力槽位而非硬编码品牌:
- plannerStrong → 调度者的 reasoning 能力
- toolCapableProducer → 生产者的工具调用+文件写入能力
- independentVerifier → 验证者的独立判定能力

导入时按本机 Doctor 结果自动匹配可用模型,不匹配则禁用对应角色并提示缺失能力。`,
  agents: [
    { ...BASE, id: "ceo-0", name: "调度者", role: "ceo", childrenIds: ["dev-1", "tester-2"], provider: "deepseek", model: "deepseek-v4-pro", companyId: "", uiPosition: { x: 400, y: 0 } },
    { ...BASE, id: "dev-1", name: "生产者", role: "dev", parentId: "ceo-0", childrenIds: [], provider: "deepseek", model: "deepseek-v4-pro", companyId: "", uiPosition: { x: 200, y: 200 } },
    { ...BASE, id: "tester-2", name: "独立验证者", role: "tester", parentId: "ceo-0", childrenIds: [], provider: "deepseek", model: "deepseek-v4-pro", companyId: "", uiPosition: { x: 600, y: 200 } },
  ],
  useCases: [
    "编码任务(JS/TS/HTML/CSS):生产者写代码+测试,验证者独立复核",
    "一人初创团队:调度→生产→验证,精简但闭环",
    "不需要全流程团队的第一天体验",
  ],
  riskNotes: [
    "单生产者的系统容忍单点故障:若生产者不可用,任务无可用 worker → honest failed",
    "验证者的独立快照确保测试不污染工作目录,但测试范围限于 contract-bound 文件",
    "调度者按任务复杂度决定是否增加验证者——空跑验证增加 token 开销但防止自证",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  workflow: {
    verificationEdges: [
      { producer: "dev", verifier: "tester", method: "code-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: "deepseek-chat",
    budget: { totalUsd: 5, maxTokensPerTask: 100_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
  },
};

// 旗舰官方模板·AI 研究公司。标记为高级模板(多 provider、多角色、高成本)。改编自一份高质量的用户本地模板(6→7 角色设计精良),打磨点见下方注释。
// 独立字面量(不用 company() 构建器)是因为需要 workflow.verificationEdges / useCases / riskNotes /
// toolRequirements / recommendedConfig 这些 Manifest v1.5 字段——company() 目前不支持,参照
// apps/server/src/seeds/productCodingTeam.ts 的写法（同为官方模板、同样手写字面量）。
const AI_RESEARCH_COMPANY: CompanyTemplate = {
  id: "ai-research-company",
  title: "AI 研究公司",
  description: "深度研究与分析的 AI 公司:研究主管统筹,核心研究员/背景调研员/数据分析员各自独立并行检索不同信息源与角度,事实核查员对全部产出交叉核验,综合撰写员整合成有引用来源的最终报告——用交叉验证对抗单模型自说自话。",
  author: "OPC Studio",
  authorGitHub: "opc-studio",
  createdAt: "2026-07-01T00:00:00Z",
  tags: ["research", "analysis", "fact-check"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# AI 研究公司

CEO(研究总监)下设一个研究团队,由研究主管统筹 5 名成员。

## 并行检索(同时下场,互不等待)
- **核心研究员**:主线选题的深度检索与结论提炼
- **背景调研员**:补齐背景/历史/上下文,防止结论脱离语境
- **数据分析员**:找数据、做量化交叉印证,让结论有数字支撑

三人各自独立检索不同信息源与角度、并行工作,而不是排队接力——覆盖面和抗单点遗漏能力都优于单个 agent 或串行分工。

## 交叉核验(不是自说自话)
- **事实核查员**:对其他成员的产出逐一核验(verification edge),核查不通过的内容会被打回重做,不会带着未经核实的结论进入最终交付。事实核查员刻意配置了与其他角色不同的模型(deepseek-reasoner,推理特化;其余角色为 deepseek-v4-pro),避免"用同一个模型审查自己产出"这种交叉验证形同虚设的情况。

## 汇总交付
- **综合撰写员**:按统一体例整理成有引用来源的报告草稿,与其他成员产出一并由研究主管做最终整合定稿。

## 适用
深度调研报告、竞品/趋势分析、需要多信息源交叉印证的复杂问题。`,
  agents: [
    { ...BASE, id: "ceo-0", name: "研究总监", role: "ceo", childrenIds: ["lead-1"], model: DM, provider: DS, companyId: "", uiPosition: { x: -600, y: -60 } },
    { ...BASE, id: "lead-1", name: "研究主管", role: "lead", parentId: "ceo-0", childrenIds: ["dev-2", "dev-3", "dev-4", "fact-5", "dev-6"], model: DM, provider: DS, companyId: "", uiPosition: { x: -600, y: 200 } },
    { ...BASE, id: "dev-2", name: "核心研究员", role: "dev", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -1000, y: 460 } },
    { ...BASE, id: "dev-3", name: "背景调研员", role: "dev", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -800, y: 460 } },
    { ...BASE, id: "dev-4", name: "数据分析员", role: "dev", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -600, y: 460 } },
    // 打磨点:role 从原模板的 "test" 改为 "fact_checker"——roleProfile.ts 把 "test" 映射到 code_profile_v1
    // (12min 超时、允许 shell),而专为事实核查设计的 fact_check_profile_v1(6min、禁 shell)只认
    // "fact_checker"/"fact_check"/"fact-check"。用错角色名会让核查员拿着写代码的执行画像去做核查。
    // P2 打磨点:model 从 DM 换成 DM_FACT_CHECKER(deepseek-reasoner)——同厂商换代际,避免与被核查的
    // 生产角色(DM = deepseek-v4-pro)"自己审自己",体现有意为之的模型多样性设计(见上方常量注释)。
    { ...BASE, id: "fact-5", name: "事实核查员", role: "fact_checker", parentId: "lead-1", childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: -400, y: 460 } },
    { ...BASE, id: "dev-6", name: "综合撰写员", role: "dev", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -200, y: 460 } },
  ],
  useCases: [
    "深度调研报告(技术趋势、市场/竞品分析、行业综述)",
    "需要多信息源交叉印证的事实密集型问题",
    "背景/数据/一手资料需要多角度综合的复杂调研任务",
  ],
  riskNotes: [
    "不适合需要真实一手实验、独家数据采集或版权受限资料的调研(受限于 worker 的公开网络检索能力)",
    "事实核查是结构化复核,不能完全替代人工专业审计;重大决策仍建议人工复核关键依据",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  // 打磨点:原模板完全没有 workflow.verificationEdges——"事实核查员"角色存在但没有验证边指向它,
  // 交叉核验只是摆设。补上后:核心研究员/背景调研员/数据分析员/综合撰写员(producer: "dev")的产出
  // 都会被事实核查员(verifier: "fact_checker")用 llm-review 方式核验;method 特意选 "llm-review" 而非
  // "fact-check"——后者在 orchestrator 里是纯程序化契约校验(校验 producer 自身输出的结构,不会真的
  // 调用 verifier agent),只有 "llm-review"/"code-review" 才会真正调用 verifier 做语义审查(见
  // apps/server/src/runtime/orchestrator.ts 的验证边 gate)。
  workflow: {
    verificationEdges: [
      { producer: "dev", verifier: "fact_checker", method: "llm-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: DM,
    budget: { totalUsd: 10, maxTokensPerTask: 200_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
  },
  // C3 · 示例任务(作者设计的真实可下发目标,与 useCases 逐条对应;非运行时伪造)——装完可原样发给
  // CEO 跑第一单,也是安装预览 newDefaultTasks 计数的真数据源。
  defaultTasks: [
    {
      title: "开源大模型推理框架选型调研",
      goal: "调研 vLLM、SGLang、TensorRT-LLM 三个开源推理框架:各自的性能特点、生态成熟度与适用场景,多信息源交叉印证后产出一份带引用来源的对比选型报告,并分别给出小团队与中型团队两档的选型建议。",
    },
    {
      title: "AI Agent 产品趋势分析报告",
      goal: "梳理近一年 AI Agent 方向的代表性产品与公开发布/融资事件,分析技术路线分化(工作流编排 vs 自主智能体)与商业化落地情况,对关键数字做量化交叉印证,产出一份趋势研判报告。",
    },
    {
      title: "热门技术论断的事实核查",
      goal: "针对「GraphRAG 显著优于朴素 RAG」这一流行论断做多信息源事实核查:收集正反两方证据、标注每条证据的出处与适用边界,核查不通过的结论不得进入最终交付,产出一份立场中立的核查报告。",
    },
  ],
};

// "One-Person AI Company"三部门战略·第一块(推广/发布)。用户给出完整规格重做(替换早前的简化版:
// 定位分析师/文案撰写/社媒运营/品牌调性审核 4 人)。用户原话:"这非常适合 OPC,因为它能直接回答:OPC
// 不只是帮我写产品,还能帮我运营这个产品。这才更像一人公司"——6 个产出角色覆盖"调研 → 定位 → 演示 →
// 内容 → 社区 → 指标"全链路营销/运营职能,不再是早前的简化版(3 名内容产出角色)。
//
// 角色→产物(用户给定规格,原样落地,不阉割):
//   市场调研员 → 竞品表 / 用户群体 / 痛点分析      定位策略师 → 产品定位 / 首屏文案 / 差异化
//   演示制作   → demo 脚本 / 录屏分镜               内容撰写   → README / X/知乎/B站/小红书文案
//   社区运营   → 发布渠道 / 用户反馈表 / issue triage  指标分析师 → star/fork/试用/留存/反馈总结
//
// role 字段设计(打磨点):6 个角色全部复用 roleProfile.ts::ROLE_PROFILE_MAP 里映射到 research_profile_v1
// 的既定同义词 "worker"("通用 worker 走最严格的研究 profile"),而不是旧版用过的 "dev"(映射
// code_profile_v1,shellMode: "full")。这 6 个角色全是纯文本产出(竞品表/定位简报/demo 脚本/README/
// 社媒文案/渠道清单/反馈表/指标复盘框架……),没有一个需要跑 shell 或建开发环境,research_profile_v1
// (只写 .md/.json、shellMode: "allowlist"、blockedGlobs 拦 .py/.sh/.exe/.bat)精确匹配"文本产出、不允许
// shell 建环境"这条执行边界。"worker" 是 ROLE_PROFILE_MAP 里现成的同义词,不是新发明的角色名,不会静默
// 落进兜底 profile(哪怕真落进兜底,兜底本身也恰好是 research_profile_v1——但显式声明优于隐式兜底)。
// verifier 沿用既有的 "fact_checker" 角色名(映射 fact_check_profile_v1),但职责从旧版单一的"品牌调性
// 审核"扩展为"文案核查员"——核对夸大宣传 + 不实竞品对比 + 合规风险三项,是旧版"品牌调性审核"与"事实
// 核查"两个概念的合并体,不重复设两个 verifier 角色(用户明确要求合并,理由:市场类内容的核查重点与
// 事实核查本就有交叉)。
// 同为独立字面量(理由同 AI_RESEARCH_COMPANY 顶部注释:需要 workflow.verificationEdges 等 Manifest v1.5
// 字段,company() 构建器不支持)。
const AI_LAUNCH_COMPANY: CompanyTemplate = {
  id: "ai-launch-company",
  title: "AI 发布公司",
  description: "面向新品/新版本发布的营销与运营内容公司:推广总监统筹,发布主管带队——市场调研员摸清竞品与用户痛点,定位策略师定基调与差异化,演示制作出 demo 脚本与录屏分镜,内容撰写产出 README 与多平台文案,社区运营规划发布渠道与反馈收集,指标分析师搭建 star/fork/留存/反馈的复盘框架,文案核查员对全部产出交叉核验有无夸大宣传、不实竞品对比、合规风险。只产出文字类营销与规划物料,不涉及真实软件发布/部署/录屏/社媒发帖。",
  author: "OPC Studio",
  authorGitHub: "opc-studio",
  createdAt: "2026-07-01T00:01:00Z",
  tags: ["launch", "marketing", "growth", "copywriting"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# AI 发布公司

CEO(推广总监)下设一个发布团队,由发布主管统筹 6 名产出成员,外加一名交叉核验的文案核查员。

## 调研与定位(摸清受众,定好基调)
- **市场调研员**:梳理竞品表、目标用户群体、核心痛点分析
- **定位策略师**:基于调研产出产品定位、首屏文案方向、差异化卖点

定位策略师的定位简报是团队其余角色对齐同一套基调的参考依据,避免各写各的、调性各说各话。

## 并行产出(不是排队接力)
- **演示制作**:写 demo 脚本与录屏分镜(仍是文本产出,不涉及真实录屏)
- **内容撰写**:产出 README 文案、X/知乎/B站/小红书等平台的适配文案
- **社区运营**:规划发布渠道清单、设计用户反馈表模板、给出 issue triage 分类规则(仍是文本规划产出,不涉及真的去对应平台发帖或操作 GitHub issue)
- **指标分析师**:搭建 star、fork、试用、留存、反馈的复盘框架与总结

四人基于市场调研与定位简报并行展开,覆盖面优于排队接力的单线程产出。

## 交叉核验(不是自说自话)
- **文案核查员**:对市场调研员、定位策略师、演示制作、内容撰写、社区运营、指标分析师的产出逐一核验(verification edge)——核查有无夸大宣传、不实竞品对比、合规风险措辞,核查不通过的内容会被打回重做,不会带着夸大或失实的文案进入最终交付。文案核查员刻意配置了与生产角色不同的模型(deepseek-reasoner,推理特化;其余角色为 deepseek-v4-pro),避免"用同一个模型审查自己产出"这种交叉验证形同虚设的情况。

## 汇总交付(每次 run 期望产出 7 份文件)
发布主管把六人的产出整合成一套完整的发布物料包:
- \`launch_plan.md\`:发布总纲,整合定位策略师的定位/差异化与社区运营的渠道/反馈机制规划
- \`competitor_matrix.md\`:市场调研员产出的竞品表
- \`user_interview_questions.md\`:市场调研员基于用户群体与痛点分析设计的访谈问题
- \`demo_script.md\`:演示制作产出的 demo 脚本与分镜
- \`README_section.md\`:内容撰写产出的 README 文案
- \`social_posts.md\`:内容撰写产出的多平台社媒文案
- \`feedback_summary.md\`:指标分析师产出的指标与反馈总结框架

不强制按文件名产出(orchestrator 不按文件名校验),但角色设计与派工目标会引导团队自然产出这 7 类内容。

## 适用
新产品/新版本发布的全套准备:竞品与用户调研、定位与差异化、demo 脚本、README 与多平台文案、访谈问题、发布渠道与反馈机制规划、指标复盘框架——一次 run 装齐"研究 + 内容 + 运营"全链路,而不只是"帮你写文案"。

## 不涉及
本团队只产出文字类营销与规划物料,不执行任何真实软件发布、部署、录屏、社媒账号发帖或 GitHub issue 操作。`,
  agents: [
    { ...BASE, id: "ceo-0", name: "推广总监", role: "ceo", childrenIds: ["lead-1"], model: DM, provider: DS, companyId: "", uiPosition: { x: 650, y: -60 } },
    { ...BASE, id: "lead-1", name: "发布主管", role: "lead", parentId: "ceo-0", childrenIds: ["mkt-2", "pos-3", "demo-4", "content-5", "comm-6", "metrics-7", "fact-8"], model: DM, provider: DS, companyId: "", uiPosition: { x: 650, y: 200 } },
    // 打磨点(见文件头部大段注释):6 个产出角色 role 统一用 "worker"(research_profile_v1 同义词),
    // 不用 "dev"/"coder"/"code"(code_profile_v1,shellMode: "full")——6 个角色没有一个需要跑 shell。
    { ...BASE, id: "mkt-2", name: "市场调研员", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 100, y: 460 } },
    { ...BASE, id: "pos-3", name: "定位策略师", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 300, y: 460 } },
    { ...BASE, id: "demo-4", name: "演示制作", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 500, y: 460 } },
    { ...BASE, id: "content-5", name: "内容撰写", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 700, y: 460 } },
    { ...BASE, id: "comm-6", name: "社区运营", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 900, y: 460 } },
    { ...BASE, id: "metrics-7", name: "指标分析师", role: "worker", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1100, y: 460 } },
    // 打磨点(沿用 AI_RESEARCH_COMPANY/旧版 AI_LAUNCH_COMPANY 同一处审计结论):verifier 角色用 "fact_checker"
    // 而非 "test"/"reviewer"(两者都路由到 code_profile_v1,允许 shell、12min 超时)。"fact_checker" 精确映射
    // fact_check_profile_v1(6min、禁 shell),匹配"只读文本产出判定"的 verifier 需求。职责从旧版单一的
    // "品牌调性审核"扩展为"文案核查员"——核对夸大宣传 + 不实竞品对比 + 合规风险三项,是旧版"品牌调性审核"
    // 与"事实核查"两个概念的合并体,不重复设两个 verifier 角色。model 换成 DM_FACT_CHECKER(deepseek-reasoner,
    // 同厂商换代际),避免"同模型审自己"信号形同虚设。代价(同旧版已知 gap):agentMeta.ts 的 ROLE_LABELS/
    // ROLE_COLORS 未收录 "fact_checker"/"worker"(该文件不在本次改动白名单内),组织图上这些节点的角色徽标
    // 会显示英文而非中文——优先保证执行画像正确,而非徽标好看。
    { ...BASE, id: "fact-8", name: "文案核查员", role: "fact_checker", parentId: "lead-1", childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: 1300, y: 460 } },
  ],
  useCases: [
    "新产品/新版本发布全套准备:竞品分析、目标受众与定位、demo 脚本、README 与多平台文案、访谈问题、发布渠道与反馈机制规划、指标复盘框架一次产出",
    "需要适配不同社媒平台调性的营销短文案(X/Twitter 风格短线程、小红书风格种草文、知乎/B站风格长文案),且要交叉核验夸大宣传与合规风险的场景",
    "把\"发布\"当成一个可复盘的完整闭环来准备——不只是写文案,还要提前规划发布渠道、用户反馈收集方式与关键指标,而不是发完了才想起来要不要看数据",
  ],
  riskNotes: [
    "只产出文字类营销与规划物料(发布计划/竞品表/demo 脚本/README/社媒文案/访谈问题/反馈总结框架),不执行任何真实软件发布、部署、录屏或社媒账号发帖操作",
    "文案核查员是结构化的语言层面复核(夸大宣传/不实竞品对比/合规风险措辞),不能替代专业法务对广告法规、行业特定合规要求(如金融、医疗)的审查",
    "市场调研/竞品分析/指标复盘框架基于 worker 的公开网络检索与训练知识,不接入真实 GitHub/应用商店 API,不保证覆盖最新市场动态或实时 star/fork/留存数据,重大发布决策仍建议人工核实一手数据",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  // 打磨点:producer: "worker" 覆盖 6 个内容/规划产出角色的输出,verifier: "fact_checker" 对应上面的文案
  // 核查员。method 选 "llm-review" 而非 "fact-check"——后者是纯程序化契约校验(不调用 verifier agent),只有
  // "llm-review"/"code-review" 才会真正调用 verifier 做语义审查(见 orchestrator.ts 的验证边 gate)。
  workflow: {
    verificationEdges: [
      { producer: "worker", verifier: "fact_checker", method: "llm-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: DM,
    budget: { totalUsd: 14, maxTokensPerTask: 200_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
  },
};

// AI 产品公司。审计(方法论同 AI_RESEARCH_COMPANY/AI_LAUNCH_COMPANY 当晚审计):原实现用 company()
// 构建器生成——组织结构(双 lead 多团队、跨角色异构 provider)本身设计合理,不动;但 company() 不支持
// workflow.verificationEdges / useCases / riskNotes / toolRequirements 等 Manifest v1.5 字段,导致此模板
// 审计前存在与研究模板修复前完全相同的缺陷:**验证边完全缺失**——7 个产出角色(机器学习工程/提示工程/
// 数据科学/后端工程/交互设计/前端工程/数据分析)全员并行产出,却没有任何一条边核验,交叉核验有名无实。
// 改为独立字面量(同 Research/Launch 写法)以补齐这些字段,并新增一个跨两条线的"质量评审"角色(role 用
// "fact_checker"——同 Research/Launch 的既定惯例:该 profile 对应 fact_check_profile_v1,免 shell、短
// 超时、只读产出判定,精确匹配"审阅其他角色文本产出、给通过/拒绝判定"这类工作,而非 code_profile_v1
// 那种要写代码跑 shell 的画像)。质量评审模型特意选 DM_FACT_CHECKER(deepseek-reasoner,推理特化,同厂商
// 换代际)而非与生产角色相同的 deepseek-v4-pro——避免"同模型审自己"信号形同虚设,做法与 Research/Launch
// 的事实核查员/品牌调性审核完全一致。verificationEdges 的 method 选 "llm-review" 而非 "fact-check"(后者
// 是纯程序化契约校验,不会真的调用 verifier agent)或 "code-review"(该 method 会把命中的 producer 标记为
// "isCodingRun → 真写代码"——但本模板 recommendedConfig.permissions.allowShell 就是 false,且 producer
// 里混了交互设计/数据分析这类非编码产出,用 code-review 会把它们错误地当成"必须写可运行代码"来提示)。
const AI_PRODUCT_COMPANY: CompanyTemplate = {
  id: "ai-product-company",
  title: "AI 产品公司",
  description: "研发 + 产品双线的 AI 公司：AI 研发团队负责模型与工作流，产品团队负责需求与体验；质量评审对两条线的全部产出交叉核验。双 lead 多团队结构。",
  author: "OPC Community",
  authorGitHub: "opc-studio",
  createdAt: "2026-06-14T00:00:00Z",
  tags: ["ai", "product", "startup"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# AI 产品公司

双线组织，CEO 下设两个团队：

## AI 研发团队（AI 研发负责人）· 并行推进模型侧能力
- **机器学习工程**：训练-服务一致与监控
- **提示工程**：稳定可评估的 LLM 工作流
- **数据科学**：实验设计与离线评估
- **后端工程**：模型服务与 API

## 产品团队（产品负责人）· 并行推进体验侧能力
- **交互设计**：直觉低负荷的体验
- **前端工程**：界面实现
- **数据分析**：用数据衡量结果

两条线内部四/三人各自独立展开、并行工作而非排队接力；仅在各自负责人汇总时收口。

## 交叉核验(不是自说自话)
- **质量评审**：对两条线全部七个产出角色逐一核验(verification edge),核查不通过的内容会被打回重做,不会带着未经核实的结论进入最终交付。质量评审刻意配置了与生产角色不同的模型(deepseek-reasoner,推理特化),且不隶属于被审查的任一条线,保持跨团队独立视角。

## 汇总交付
两位负责人各自整理本团队产出，一并提交给 CEO 做最终整合。

## 适用
构建 AI 驱动的产品，从模型研发（训练/工作流/服务）到用户体验闭环（设计/前端/数据洞察）。`,
  agents: [
    // Bug 修复(端到端验证抓出):这几个节点原来是 AN(anthropic)——用户只配 deepseek 时,capability
    // gate 在花一分钱之前就整个公司 409 拦死(gate 不感知 teamMode,只看持久化 provider,该问题更系统性的
    // 修法是让 gate 感知 teamMode,但那要贯穿 capabilityReport→chatRoutes 调用链,风险更高,这次不动)。
    // 换成 DS/DM,与 AI_RESEARCH_COMPANY/AI_LAUNCH_COMPANY 已验证过的"开箱即用"设计保持一致。
    { ...BASE, id: "ceo", name: "CEO", role: "ceo", childrenIds: ["rnd-lead", "prod-lead"], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "rnd-lead", name: "AI 研发负责人", role: "lead", parentId: "ceo", childrenIds: ["ml", "prompt", "ds", "be"], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "ml", name: "机器学习工程", role: "dev", parentId: "rnd-lead", childrenIds: [], model: MM, provider: MX, companyId: "" },
    { ...BASE, id: "prompt", name: "提示工程", role: "dev", parentId: "rnd-lead", childrenIds: [], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "ds", name: "数据科学", role: "dev", parentId: "rnd-lead", childrenIds: [], model: MM, provider: MX, companyId: "" },
    { ...BASE, id: "be", name: "后端工程", role: "dev", parentId: "rnd-lead", childrenIds: [], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "prod-lead", name: "产品负责人", role: "lead", parentId: "ceo", childrenIds: ["ux", "fe", "analyst", "qa"], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "ux", name: "交互设计", role: "dev", parentId: "prod-lead", childrenIds: [], model: MM, provider: MX, companyId: "" },
    { ...BASE, id: "fe", name: "前端工程", role: "dev", parentId: "prod-lead", childrenIds: [], model: DM, provider: DS, companyId: "" },
    { ...BASE, id: "analyst", name: "数据分析", role: "dev", parentId: "prod-lead", childrenIds: [], model: MM, provider: MX, companyId: "" },
    // 打磨点(同 AI_RESEARCH_COMPANY/AI_LAUNCH_COMPANY):新增的跨团队质量评审——role 用 "fact_checker"
    // 而非 "test"/"reviewer"(两者都路由到 code_profile_v1,允许 shell、12min 超时,是给写代码角色用的
    // 画像;质量评审只读七个角色的文本产出给判定,不需要 shell/长超时)。挂在 prod-lead 下(childrenIds
    // 追加 "qa"),但验证边按 role 匹配,核验范围覆盖两条线全部 producer:"dev" 角色,不受挂载位置限制。
    { ...BASE, id: "qa", name: "质量评审", role: "fact_checker", parentId: "prod-lead", childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "" },
  ],
  useCases: [
    "从模型研发到用户体验的端到端 AI 产品构建(训练/工作流/服务 + 设计/前端/数据洞察)",
    "需要工程与产品双线并行推进、且对全部产出做交叉核验的场景",
    "小团队 AI 创业公司的一体化研发与产品分工蓝图",
  ],
  riskNotes: [
    "默认关闭 shell 执行权限(recommendedConfig.permissions.allowShell: false)——产出是设计文档/代码方案/训练与工作流说明/数据分析报告等文本工件,不会真的安装环境、跑训练或部署;需要真实执行代码需自行开启并承担相应风险",
    "质量评审是结构化的语义核验,不能替代真实的模型评测、代码测试或人工验收;重大工程决策仍建议人工复核关键依据",
    "机器学习工程/数据科学等角色的结论基于 worker 的专业知识与检索能力,不等价于真实训练实验或真实用户数据的结果",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek", "minimax"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  workflow: {
    verificationEdges: [
      { producer: "dev", verifier: "fact_checker", method: "llm-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: DM,
    budget: { totalUsd: 15, maxTokensPerTask: 250_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
  },
};

// "One-Person AI Company"三部门战略·收官件:把上面三个独立部门模板(各自原本都有自己的 CEO)组装成
// 一个由单一集团 CEO 统筹的完整公司——研究部门产出选题/竞品/事实依据 → 产品部门把它工程化成可交付的
// 产品能力 → 发布部门把产品能力包装成对外文案与发布物料。三个部门原来的 CEO 在此**降级为该部门的
// Lead**,直接向新增的集团 CEO 汇报;每个部门原有的内部结构(worker 层级、甚至 product 部门原本的双
// Lead 嵌套)完全保留不动,只是把原来的根节点(原 CEO)接到集团 CEO 下面——等价于手写一遍
// apps/server/src/runtime/install.ts::rerootAgents 的静态版本(id 全部换成 "<部门前缀>-<原 id>",
// parentId/childrenIds 跟着换算,根节点 parentId 指向集团 CEO id),但这里不能 import 运行时函数
// (种子文件要保持"纯字面量数据"),所以手工展开。
//
// ── id 冲突处理 ──
// 三个部门各自的 agent id 有大量重名(都有 "ceo-0"/"lead-1"/"dev-2"/"fact-5" 这类通用命名),组装时统一
// 加部门前缀:研究部门 "research-"、产品部门 "product-"、发布部门 "launch-"(见下方 R/P/L 常量),三部门
// 内部原有的 parentId/childrenIds 引用也同步换算,保证全公司 28 个 agent id 两两不同(发布部门用户给出
// 完整规格重做后从 6 人扩到 9 人,全公司总数同步从 25 → 28)。
//
// ── role 字段:没有跟着加前缀,而是复用 roleProfile.ts 里已有的同义词桶(审计发现③) ──
// 天真的做法是连 role 字段也加前缀(如 "research-dev"),但审计发现 role 字符串被两张**精确匹配**的表
// 消费:roleProfile.ts::ROLE_PROFILE_MAP(决定 shell/网络/磁盘执行边界)与 prompts.ts::ROLE_PROMPTS
// (决定 system prompt)。这两个文件不在本次改动白名单内,任何未登记的新 role 字符串都会静默退化到最
// 保守 fallback(research_profile_v1 + 通用 prompt),对 product 部门里真正要写代码、需要 shellMode:"full"
// 的角色(机器学习工程/后端工程/前端工程)是实打实的能力回退。
// 于是改用 ROLE_PROFILE_MAP 里**本来就存在、指向同一个 profile 的同义词**做部门区分,零副作用。生产者
// 角色现在分两个 profile 家族(不再是三部门统一挤在 code_profile_v1 家族里):
//   - code_profile_v1 家族:dev(product 保留原样)/ coder(research)—— 两者都精确映射到 code_profile_v1
//     (shellMode: "full"),执行沙箱两部门完全一致,唯一代价是 research 的 worker system prompt 从"你是
//     软件工程师……"退化成通用 fallback prompt(prompts.ts 本来就没给 research 的产出角色量身定制过
//     prompt;product 部门的编码角色留用 "dev" 保住最需要这份 prompt 的地方)。
//   - research_profile_v1 家族:worker(launch,用户给出完整规格重做后新增)—— launch 部门的 6 个产出角色
//     (市场调研员/定位策略师/演示制作/内容撰写/社区运营/指标分析师)全是纯文本产出,不需要 shellMode:
//     "full",换到 research_profile_v1(shellMode: "allowlist"、只写 .md/.json)是**主动选择更贴合的执行
//     画像**,不是像 coder/dev 那样单纯为 id 去重而已;顺带效果是天然不会和 research/product 两部门的
//     code_profile_v1 家族同义词(coder/dev)冲突,不需要再额外找第三个 code 家族同义词。
//   - 核查者:fact_checker(research 保留原样)/ fact_check(launch)/ fact-check(product)—— 三者都精确
//     映射到 fact_check_profile_v1,且 ROLE_PROMPTS 里从来没有任何一个 fact_checker 系变体的专属 prompt
//     (三部门原模板的事实核查角色本来就在吃通用 fallback prompt),所以这一组换同义词**零质量损失**。
// agentMeta.ts(前端角色徽标颜色/中文标签)同理不在白名单内——research/launch 的产出角色徽标会从
// "开发"(绿色)退化成无样式的裸 role 字符串,这是已知、可接受的 cosmetic gap(与三个原模板里事实核查员
// 徽标缺失是同一类问题,不是本次新引入的更严重的缺陷)。
//
// ── 为什么不能用 agentId 做 producer/verifier 引用(即便 schema 允许) ──
// VerificationEdge.producer/verifier 本可以是 agentId 或 role(见 schemas.ts 注释)。但公司模板走
// POST /api/community/install/company 安装时,communityRoutes.ts 用 rerootAgents(tpl.agents, companyId,
// old => `${old}-${shortId}`) 给**每个 agent id 都追加同一个安装期随机 shortId**,而 company.workflow
// 是把 tpl.workflow 原样落盘、**不经过 idMap 换算**(a2aChannels 才有 resolveTemplateAgentRef 这一层换算,
// verificationEdges 没有)。这意味着任何写死在 verificationEdges 里的模板本地 id,装完之后永远匹配不上
// 真实 agent id(id 已经被追加后缀),这条边形同虚设。role 字段则是 rerootAgents 唯一原样保留、不做任何
// 改写的字段——这是三个原模板全部用 role 而不是 id 写 producer/verifier 的真正原因,也是本次组装必须
// 沿用同一约定(role 而不是 id)的原因。
//
// ── 验证边设计 ──
// 部门内 3 条(每部门各自的生产者角色 → 该部门自己的核查者角色),外加 1 条可选的跨部门协作边:
// 发布部门的文案(producer: "worker")除了被发布部门自己的"文案核查员"核验,还会被产品部门的"质量评审"
// (verifier: "fact-check",全公司唯一持有这个 role 字符串的 agent)额外抽查一次"内容是否准确反映产品
// 能力"——体现"一人公司"里研究/产品/发布不是三个互不知情的黑箱,发布物料最终要对产品部门的真实产出
// 负责。两条边命中同一个 producer 时按 orchestrator.ts 的"一票否决"语义顺序执行:内部核查先跑,不通过
// 就直接剔除、不会再跑跨部门核查(短路,省一次 LLM 调用);内部通过了才会跑跨部门抽查,是真正意义上的
// "再多一层眼睛",不是无谓的重复劳动。
const CEO_GROUP = "ceo-group";
const R = "research-", L = "launch-", P = "product-"; // 部门 id 前缀

const AI_ONE_PERSON_COMPANY: CompanyTemplate = {
  id: "one-person-ai-company",
  title: "一人公司·全流程团队",
  description: "把研究、产品研发、发布推广三个部门模板组装成一家完整公司:集团 CEO 统筹三位部门 Lead——研究部门产出有交叉核验的选题/竞品/事实依据,产品部门把结论工程化成研发与体验双线的产品能力,发布部门把产品能力包装成对外文案物料,且发布文案额外接受产品部门一次\"是否准确反映产品能力\"的跨部门核对。研究→产品→推广全链路一次装齐,一个人也能有一整个公司。",
  author: "OPC Studio",
  authorGitHub: "opc-studio",
  createdAt: "2026-07-01T00:02:00Z",
  tags: ["company", "research", "product", "launch", "full-pipeline"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# 一人公司·全流程团队

集团 CEO 下设三个平级部门,各自的 Lead 直接向集团 CEO 汇报:

## 研究部门(研究总监 → 研究主管 → 5 名研究员)
沿用 [AI 研究公司] 的完整设计:核心研究员/背景调研员/数据分析员并行检索,事实核查员交叉核验,综合撰写员整合成有引用来源的报告。

## 产品部门(产品研发负责人 → AI 研发负责人 / 产品负责人 → 7 名工程师)
沿用 [AI 产品公司] 的双线设计:AI 研发线(机器学习工程/提示工程/数据科学/后端工程)与产品体验线(交互设计/前端工程/数据分析)并行推进,质量评审跨两条线交叉核验。

## 发布部门(推广总监 → 发布主管 → 6 名成员)
沿用 [AI 发布公司] 的完整设计:市场调研员摸清竞品与用户痛点,定位策略师定基调,演示制作/内容撰写/社区运营/指标分析师并行产出 demo 脚本、README 与多平台文案、发布渠道与反馈机制规划、指标复盘框架,文案核查员交叉核验。

## 跨部门协作(不是三个各自为战的黑箱)
发布部门产出的文案(市场调研员/定位策略师/演示制作/内容撰写/社区运营/指标分析师),除了被本部门的文案核查员核验,**还会额外被产品部门的质量评审抽查一次**——核对文案宣称的产品能力是否与产品部门的真实产出相符,防止发布物料脱离产品实际、自说自话地夸大宣传。

## 组织设计说明
三个部门原本各自独立、各有一位 CEO;组装成一家公司后,三位原 CEO 都**降级为所在部门的 Lead**,新增一位集团 CEO 统筹全局分诊——不需要惊动三个部门时,集团 CEO 可以只指派用得上的那一个或两个部门,不必每次都全员出动。

## 适用
需要"选题调研 → 产品工程化 → 对外发布"全链路一次跑完的场景;也适合只用其中一两个部门(集团 CEO 会按目标分诊,不会不必要地把三个部门全部拉起来)。

## 不涉及
产品部门默认关闭 shell 执行权限,发布部门只产出文字物料——都不执行真实的软件构建、部署或上线操作。`,
  agents: [
    // Bug 修复(端到端验证抓出的结构性缺陷):集团CEO 原来是 AN(anthropic)——它是全公司唯一入口,
    // 用户只配 deepseek 时,capability gate 直接把整个 28 人公司(发布部门用户给出完整规格重做后从
    // 25 人扩到 28 人)409 拦死,哪怕其中绝大多数 agent 明明是 deepseek/minimax 可跑的("按需分诊、
    // 不必全员出动"这个卖点因为分诊者自己进不去门而完全兑现不了)。换成 DS/DM,与三个子部门已验证过
    // 的"开箱即用"设计对齐。
    { ...BASE, id: CEO_GROUP, name: "集团CEO", role: "ceo", childrenIds: [`${R}ceo-0`, `${P}ceo`, `${L}ceo-0`], model: DM, provider: DS, companyId: "", uiPosition: { x: 150, y: -520 } },

    // ── 研究部门(沿用 AI_RESEARCH_COMPANY 原有结构,根节点降级为 Lead)──
    { ...BASE, id: `${R}ceo-0`, name: "研究总监", role: "lead", parentId: CEO_GROUP, childrenIds: [`${R}lead-1`], model: DM, provider: DS, companyId: "", uiPosition: { x: -1000, y: -220 } },
    { ...BASE, id: `${R}lead-1`, name: "研究主管", role: "lead", parentId: `${R}ceo-0`, childrenIds: [`${R}dev-2`, `${R}dev-3`, `${R}dev-4`, `${R}fact-5`, `${R}dev-6`], model: DM, provider: DS, companyId: "", uiPosition: { x: -1000, y: 80 } },
    // role 用 "coder"(同义词,见文件顶部注释)——精确映射同一个 code_profile_v1,只是把生产者角色和
    // launch/product 两部门的同名角色区分开,避免 workflow.verificationEdges 按 role 匹配时跨部门串扰。
    { ...BASE, id: `${R}dev-2`, name: "核心研究员", role: "coder", parentId: `${R}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -1400, y: 400 } },
    { ...BASE, id: `${R}dev-3`, name: "背景调研员", role: "coder", parentId: `${R}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -1200, y: 400 } },
    { ...BASE, id: `${R}dev-4`, name: "数据分析员", role: "coder", parentId: `${R}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -1000, y: 400 } },
    { ...BASE, id: `${R}fact-5`, name: "事实核查员", role: "fact_checker", parentId: `${R}lead-1`, childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: -800, y: 400 } },
    { ...BASE, id: `${R}dev-6`, name: "综合撰写员", role: "coder", parentId: `${R}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -600, y: 400 } },

    // ── 产品部门(沿用 AI_PRODUCT_COMPANY 原有双 Lead 结构,根节点 "ceo" 降级为 Lead 并改名)──
    { ...BASE, id: `${P}ceo`, name: "产品研发负责人", role: "lead", parentId: CEO_GROUP, childrenIds: [`${P}rnd-lead`, `${P}prod-lead`], model: DM, provider: DS, companyId: "", uiPosition: { x: 230, y: -220 } },
    { ...BASE, id: `${P}rnd-lead`, name: "AI 研发负责人", role: "lead", parentId: `${P}ceo`, childrenIds: [`${P}ml`, `${P}prompt`, `${P}ds`, `${P}be`], model: DM, provider: DS, companyId: "", uiPosition: { x: -130, y: 80 } },
    { ...BASE, id: `${P}ml`, name: "机器学习工程", role: "dev", parentId: `${P}rnd-lead`, childrenIds: [], model: MM, provider: MX, companyId: "", uiPosition: { x: -400, y: 400 } },
    { ...BASE, id: `${P}prompt`, name: "提示工程", role: "dev", parentId: `${P}rnd-lead`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: -220, y: 400 } },
    { ...BASE, id: `${P}ds`, name: "数据科学", role: "dev", parentId: `${P}rnd-lead`, childrenIds: [], model: MM, provider: MX, companyId: "", uiPosition: { x: -40, y: 400 } },
    { ...BASE, id: `${P}be`, name: "后端工程", role: "dev", parentId: `${P}rnd-lead`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 140, y: 400 } },
    { ...BASE, id: `${P}prod-lead`, name: "产品负责人", role: "lead", parentId: `${P}ceo`, childrenIds: [`${P}ux`, `${P}fe`, `${P}analyst`, `${P}qa`], model: DM, provider: DS, companyId: "", uiPosition: { x: 590, y: 80 } },
    { ...BASE, id: `${P}ux`, name: "交互设计", role: "dev", parentId: `${P}prod-lead`, childrenIds: [], model: MM, provider: MX, companyId: "", uiPosition: { x: 320, y: 400 } },
    { ...BASE, id: `${P}fe`, name: "前端工程", role: "dev", parentId: `${P}prod-lead`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 500, y: 400 } },
    { ...BASE, id: `${P}analyst`, name: "数据分析", role: "dev", parentId: `${P}prod-lead`, childrenIds: [], model: MM, provider: MX, companyId: "", uiPosition: { x: 680, y: 400 } },
    // role 用 "fact-check"(同义词)——全公司唯一持有此 role 字符串的 agent,因此也是下方跨部门验证边
    // (发布部门文案 → 产品部门核对)verifier 的精确落点,不会被其他部门的同角色节点抢先命中。
    { ...BASE, id: `${P}qa`, name: "质量评审", role: "fact-check", parentId: `${P}prod-lead`, childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: 860, y: 400 } },

    // ── 发布部门(沿用 AI_LAUNCH_COMPANY 原有结构,根节点降级为 Lead;用户给出完整规格重做后从 4 名
    // 成员扩到 6 名产出成员 + 1 名核查员)──
    { ...BASE, id: `${L}ceo-0`, name: "推广总监", role: "lead", parentId: CEO_GROUP, childrenIds: [`${L}lead-1`], model: DM, provider: DS, companyId: "", uiPosition: { x: 1310, y: -220 } },
    { ...BASE, id: `${L}lead-1`, name: "发布主管", role: "lead", parentId: `${L}ceo-0`, childrenIds: [`${L}mkt-2`, `${L}pos-3`, `${L}demo-4`, `${L}content-5`, `${L}comm-6`, `${L}metrics-7`, `${L}fact-8`], model: DM, provider: DS, companyId: "", uiPosition: { x: 1310, y: 80 } },
    // role 用 "worker"(research_profile_v1 同义词,见文件顶部注释)——launch 部门 6 个产出角色全是纯
    // 文本产出,主动换到不允许 shell 建环境的执行画像,顺带也天然不与 research/product 的 coder/dev 冲突。
    { ...BASE, id: `${L}mkt-2`, name: "市场调研员", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 900, y: 400 } },
    { ...BASE, id: `${L}pos-3`, name: "定位策略师", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1060, y: 400 } },
    { ...BASE, id: `${L}demo-4`, name: "演示制作", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1220, y: 400 } },
    { ...BASE, id: `${L}content-5`, name: "内容撰写", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1380, y: 400 } },
    { ...BASE, id: `${L}comm-6`, name: "社区运营", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1540, y: 400 } },
    { ...BASE, id: `${L}metrics-7`, name: "指标分析师", role: "worker", parentId: `${L}lead-1`, childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1700, y: 400 } },
    { ...BASE, id: `${L}fact-8`, name: "文案核查员", role: "fact_check", parentId: `${L}lead-1`, childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: 1860, y: 400 } },
  ],
  useCases: [
    "从选题调研到产品工程化再到对外发布的全链路一次装齐(深度调研 → 双线产品研发 → 发布文案与跨部门核对)",
    "只想要三个部门里的一两个也可以——集团 CEO 会按目标分诊,不需要每次都把三个部门全部拉起来",
    "需要发布物料对产品真实能力负责、而不是脱离产品自说自话的营销场景",
  ],
  riskNotes: [
    "团队规模大(28 个 agent、四层组织),单次目标若真的调动全部三个部门,token/费用消耗会明显高于单部门模板,recommendedConfig 的预算按较大但非拉满全部门估算,真要全公司出动建议手动调高预算",
    "产品部门默认关闭 shell 执行权限、发布部门只产出文字与规划物料——都不会真的安装环境、跑训练、部署、录屏或发帖,需要真实执行需自行开启并承担相应风险",
    "研究部门的生产者角色因跨部门 role 去重(coder,详见模板内注释)不再命中 dev 角色的专属 system prompt,退化为通用 fallback 提示语;发布部门的生产者角色(worker)则是主动换到不允许 shell 建环境的执行画像(research_profile_v1),同样吃通用 fallback 提示语,但这是画像更贴合角色实际需求的选择,不只是为了去重",
    "三层交叉核验(部门内 + 跨部门)都是结构化的语义核查,不能替代真人专业审计;重大决策仍建议人工复核关键依据",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek", "minimax"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  workflow: {
    verificationEdges: [
      // 研究部门内部:producer "coder"(研究部门专属同义词)命中研究部门 4 名生产者,verifier 精确落到
      // 全公司唯一持有 "fact_checker" 的 research-fact-5。
      { producer: "coder", verifier: "fact_checker", method: "llm-review", onReject: "redo", maxRounds: 1 },
      // 产品部门内部:producer "dev" 命中产品部门 7 名生产者(未改名,唯一保留原生 dev 角色的部门),
      // verifier 精确落到全公司唯一持有 "fact-check" 的 product-qa。
      { producer: "dev", verifier: "fact-check", method: "llm-review", onReject: "redo", maxRounds: 1 },
      // 发布部门内部:producer "worker"(research_profile_v1 家族,发布部门专属)命中发布部门 6 名生产者,
      // verifier 精确落到全公司唯一持有 "fact_check" 的 launch-fact-8。
      { producer: "worker", verifier: "fact_check", method: "llm-review", onReject: "redo", maxRounds: 1 },
      // 跨部门协作边(加分设计,非必需):发布部门的同一批生产者(producer 仍是 "worker")额外再被产品部门
      // 的质量评审(verifier "fact-check")抽查一次"文案是否准确反映产品能力"。与上面第三条边共享同一个
      // producer,orchestrator 里一票否决即 break——发布部门内部核查先跑,没通过就不会跑到这条跨部门边,
      // 省一次 LLM 调用;内部通过了才会跑这条,真正起到"多一层眼睛"的作用,不是无谓的重复核验。
      { producer: "worker", verifier: "fact-check", method: "llm-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: DM,
    // 发布部门用户给出完整规格重做后从 6 人扩到 9 人(全公司 25 → 28),预算同步小幅上调。
    budget: { totalUsd: 34, maxTokensPerTask: 250_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
  },
};

// AI 财务公司。第四个部门模板(调研见 docs/第四部门调研-一人公司候选部门评估.md)。
//
// 【定案】不并入 one-person 合体公司,财务作为独立第四模板长期发布。理由:
// 1) 叙事不同源:one-person 三部门是"选题调研→产品工程化→对外发布"一条连续管线,部门间有真实的产出
//    依赖(产品消费研究结论、发布文案被产品部门跨部门核对)。财务的预算/成本/定价/投融资叙事不消费、也不
//    被前三个部门的产出消费,是一项独立于"做产品"管线之外的按需服务,硬塞进同一棵组织树不代表真实工作流。
// 2) 规模/成本不划算:28→35 agent,recommendedConfig 预算要继续上调;但集团 CEO 分诊本来就是"按需只
//    拉起用得上的部门",单次目标里"研究+产品+发布+财务"四部门全上场的真实场景几乎不存在,合并换来的
//    "开箱即所有"卖点边际价值很低,却要长期承担多一层角色去重/命名冲突的复杂度税。
// 3) 免责声明的量级不同:财务的"重大财务决策需具备资质的专业人士复核"是比研究/产品/发布现有风险提示
//    更强的合规性表述,独立模板能让这条提示在用户"决定要不要用财务能力"时就先看到、看得清楚;摊进 35 人
//    大公司的第 4 分支反而容易被忽略,削弱了这条本该醒目的免责声明。
// 4) 没有新增交叉验证边的价值:one-person 里跨部门边(发布→产品核对)成立是因为发布文案*真实描述*产品
//    产出,是有真实耦合的复核;财务产出和研究/产品/发布没有这种耦合,合并也造不出一条有意义的新验证边
//    (调研文档已提示"不强制加,除非有明确价值"——这里没有)。
// 若后续真出现"同一个目标里需要财务与其他部门联动"的具体用户场景,再考虑重新评估,而不是现在预先合并。
//
// 角色表、验证边设计原样落地调研
// 结论,不自由发挥:CEO"财务总监" → Lead"财务主管" → 4 名生产者(预算规划师/成本估算师/定价策略分析师/
// 投融资叙事撰写)+ 1 名核查(数字与免责声明核查员)。role 字段:4 名生产者用 "research"(调研文档表格里
// 给定的字段值,也是 ROLE_PROFILE_MAP 精确同义词,映射 research_profile_v1——只写 .md/.json、shell=
// allowlist、10min,贴合预算规划/成本估算/定价分析/投融资叙事这类财务分析纯文本产出的能力边界,不接触
// 真实银行/记账/报税系统),核查员用 "fact_checker"(映射 fact_check_profile_v1,shell=none、7min)。
// verificationEdges.method 用 "llm-review" 而非 "fact-check"(后者是纯程序化契约校验,不会真的调用
// verifier agent,见 orchestrator.ts 的验证边 gate 注释,与 RESEARCH/LAUNCH/PRODUCT 三个模板的既定惯例
// 一致)。model 延续"全员 deepseek 开箱即用,verifier 换代际模型(deepseek-reasoner)"的既定哲学。
// riskNotes 明确写财务类内容特有的免责声明(不做真实记账/报税/银行接口/支付,产出不构成投资建议,重大
// 财务决策需具备资质的专业人士复核)——参照社区 legal-advisor/finance-analyst 单体卡片(.opc/community/
// skills/legal-advisor.md、finance-analyst.md)已验证过的免责声明措辞惯例,改写为团队级验证边契约。
const AI_FINANCE_COMPANY: CompanyTemplate = {
  id: "ai-finance-company",
  title: "AI 财务公司",
  description: "面向预算规划、成本估算、定价策略与投融资叙事的财务分析公司:财务总监统筹,财务主管带队——预算规划师做开发/运营预算规划,成本估算师拆解成本构成,定价策略分析师设计定价与付费/赞助梯度,投融资叙事撰写产出面向潜在投资人/赞助方的资金申请材料,数字与免责声明核查员对全部产出交叉核验数字是否有依据、是否有误导性表述、是否需要专业人士复核。只产出财务分析类文本材料,不做真实记账、报税、银行接口或支付,不构成投资建议。",
  author: "OPC Studio",
  authorGitHub: "opc-studio",
  createdAt: "2026-07-04T00:00:00Z",
  tags: ["finance", "budget", "pricing", "fundraising"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# AI 财务公司

CEO(财务总监)下设一个财务团队,由财务主管统筹 4 名产出成员,外加一名交叉核验的数字与免责声明核查员。

## 并行产出(不是排队接力)
- **预算规划师**:产出开发/运营/人力等维度的预算规划(\`budget_plan.md\`)
- **成本估算师**:拆解开发与运营成本构成,给出估算区间与关键假设(\`cost_breakdown.md\`)
- **定价策略分析师**:设计定价方案与可选的付费/赞助梯度(\`pricing_strategy.md\`)
- **投融资叙事撰写**:产出面向潜在投资人/赞助方的资金申请叙事材料(\`investor_pitch.md\`)

四人各自独立展开、并行产出,而不是排队接力。

## 交叉核验(不是自说自话)
- **数字与免责声明核查员**:对四名生产者的产出逐一核验(verification edge)——核查数字/假设是否标注来源、是否有误导性表述、是否已注明需要专业人士复核,核查不通过的内容会被打回重做,不会带着无依据的数字或缺失免责声明的表述进入最终交付。核查员刻意配置了与生产角色不同的模型(deepseek-reasoner,推理特化;其余角色为 deepseek-v4-pro),避免"用同一个模型审查自己产出"这种交叉验证形同虚设的情况。

## 汇总交付
财务主管把四人的产出整合成一套完整的财务材料包,连同核查意见一并提交给财务总监做最终整合。

## 适用
面向潜在赞助方/投资人的资金申请材料准备、新产品/新功能的预算规划与成本估算、需要设计定价或付费/赞助梯度的场景。

## 不涉及(免责声明)
本团队只产出预算规划、成本估算、定价分析、投融资叙事等文本材料,**不做真实记账、报税、银行账户接入、支付处理**,所有数字是估算框架而非审计结果,**不构成投资建议**。重大财务决策(融资协议、税务申报、正式投资决策)必须由具备资质的专业人士(注册会计师/税务师/持牌财务顾问/执业律师)复核确认。`,
  agents: [
    { ...BASE, id: "ceo-0", name: "财务总监", role: "ceo", childrenIds: ["lead-1"], model: DM, provider: DS, companyId: "", uiPosition: { x: 2050, y: -60 } },
    { ...BASE, id: "lead-1", name: "财务主管", role: "lead", parentId: "ceo-0", childrenIds: ["budget-2", "cost-3", "pricing-4", "pitch-5", "fact-6"], model: DM, provider: DS, companyId: "", uiPosition: { x: 2050, y: 200 } },
    // role 用 "research"(调研文档给定字段值 + ROLE_PROFILE_MAP 精确同义词,见文件头部注释)——4 个生产者
    // 角色全是纯文本产出(预算/成本/定价/投融资叙事),不需要 shell 建环境,research_profile_v1 精确匹配。
    { ...BASE, id: "budget-2", name: "预算规划师", role: "research", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1700, y: 460 } },
    { ...BASE, id: "cost-3", name: "成本估算师", role: "research", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 1900, y: 460 } },
    { ...BASE, id: "pricing-4", name: "定价策略分析师", role: "research", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 2100, y: 460 } },
    { ...BASE, id: "pitch-5", name: "投融资叙事撰写", role: "research", parentId: "lead-1", childrenIds: [], model: DM, provider: DS, companyId: "", uiPosition: { x: 2300, y: 460 } },
    // 打磨点(沿用 RESEARCH/LAUNCH/PRODUCT 三个模板的既定惯例):verifier 角色用 "fact_checker" 而非
    // "test"/"reviewer"(两者路由到 code_profile_v1,允许 shell、12min 超时,是给写代码角色用的画像)。
    // model 换成 DM_FACT_CHECKER(deepseek-reasoner,同厂商换代际),避免"同模型审自己"信号形同虚设。
    { ...BASE, id: "fact-6", name: "数字与免责声明核查员", role: "fact_checker", parentId: "lead-1", childrenIds: [], model: DM_FACT_CHECKER, provider: DS, companyId: "", uiPosition: { x: 2500, y: 460 } },
  ],
  useCases: [
    "面向潜在赞助方/投资人的资金申请材料准备(预算规划、开发成本估算、可选的定价/赞助梯度设计)",
    "新产品/新功能上线前的预算规划与成本估算,或为线上小额付费产品设计定价策略",
    "寻求种子轮融资或赞助的项目准备投融资叙事材料,并核查数字是否标注假设来源与免责声明",
  ],
  riskNotes: [
    "不做真实记账、报税、银行账户接入或支付处理——只产出预算规划、成本估算、定价分析、投融资叙事等文本工件,不接入任何银行/记账系统、税务申报系统或支付网关",
    "所有产出是分析建议与估算框架,不是专业财务、税务或法律意见;重大财务决策(融资协议、税务申报、正式投资决策)必须由具备资质的专业人士(注册会计师/税务师/持牌财务顾问/执业律师)复核确认,不构成投资建议",
    "数字与免责声明核查员是结构化的语言层面复核(假设是否标注来源、是否有误导性表述、是否已注明需专业人士复核),不能替代真实审计、尽职调查或专业财务/法律意见;预算与成本估算基于 worker 的公开知识与检索能力,不接入实时市场数据或企业真实财务系统",
  ],
  toolRequirements: {
    requiredEngines: ["api"],
    requiredProviders: ["deepseek"],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  },
  // 打磨点(沿用 RESEARCH/LAUNCH/PRODUCT 三个模板的既定惯例):producer: "research" 覆盖 4 个生产者角色,
  // verifier: "fact_checker" 对应数字与免责声明核查员。method 选 "llm-review" 而非 "fact-check"——后者是
  // 纯程序化契约校验(不调用 verifier agent),只有 "llm-review"/"code-review" 才会真正调用 verifier 做语义
  // 审查(见 orchestrator.ts 的验证边 gate)。
  workflow: {
    verificationEdges: [
      { producer: "research", verifier: "fact_checker", method: "llm-review", onReject: "redo", maxRounds: 1 },
    ],
  },
  recommendedConfig: {
    defaultModel: DM,
    budget: { totalUsd: 10, maxTokensPerTask: 200_000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
  },
};

export const COMPANY_TEMPLATES: CompanyTemplate[] = [
  // P0-4 · 精简默认公司:排在数组第一位(首次体验推荐)。
  ONE_PERSON_STARTUP,
  // 旗舰模板标记为高级(多角色、多 provider)。
  AI_RESEARCH_COMPANY,
  // 三部门战略第一块(推广/发布),紧随研究模板之后。
  AI_LAUNCH_COMPANY,
  // 三部门战略第二块(研发/产品),紧随发布模板之后。
  AI_PRODUCT_COMPANY,
  // 三部门战略收官件:把以上三个部门组装成一家由集团 CEO 统筹的完整公司,紧随三个独立部门模板之后。
  AI_ONE_PERSON_COMPANY,
  // 第四部门(定案独立发布,不并入 one-person 合体——理由见 AI_FINANCE_COMPANY 定义上方注释)。
  AI_FINANCE_COMPANY,
  company({
    id: "data-platform-company", title: "数据平台公司",
    desc: "以数据为核心资产的公司：数据工程团队建管道，分析团队产洞察。",
    tags: ["data", "analytics", "platform"],
    ceo: { id: "ceo", name: "CEO", role: "ceo", provider: AN, model: AS },
    teams: [
      {
        lead: { id: "de-lead", name: "数据工程负责人", role: "lead", provider: AN, model: AS },
        workers: [
          { id: "de1", name: "数据工程 A", role: "dev", provider: DS, model: DM },
          { id: "de2", name: "数据工程 B", role: "dev", provider: DS, model: DM },
          { id: "dba", name: "数据库架构", role: "architect", provider: AN, model: AS },
          { id: "ops", name: "数据运维", role: "ops", provider: DS, model: DM },
        ],
      },
      {
        lead: { id: "an-lead", name: "分析负责人", role: "lead", provider: AN, model: AS },
        workers: [
          { id: "sci", name: "数据科学", role: "dev", provider: MX, model: MM },
          { id: "an1", name: "数据分析", role: "dev", provider: MX, model: MM },
        ],
      },
    ],
    readme: `# 数据平台公司\n\n## 数据工程团队\n- 数据工程 A/B：可靠可重跑的管道\n- 数据库架构：数据建模与查询优化\n- 数据运维：平台稳定性\n\n## 分析团队\n- 数据科学：统计与实验\n- 数据分析：指标与业务洞察\n\n## 适用\n数据中台、BI 平台、指标体系建设。`,
    recommendedConfig: {
      defaultModel: DM,
      budget: { totalUsd: 12, maxTokensPerTask: 200_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false },
    },
  }),
  company({
    id: "content-media-company", title: "内容媒体公司",
    desc: "内容生产 + 增长的媒体公司：编辑团队做内容，增长团队做分发。",
    tags: ["content", "media", "growth"],
    ceo: { id: "ceo", name: "CEO", role: "ceo", provider: AN, model: AS },
    teams: [
      {
        lead: { id: "ed-lead", name: "主编", role: "lead", provider: AN, model: AS },
        workers: [
          { id: "tech", name: "技术写作", role: "dev", provider: MX, model: MM },
          { id: "copy", name: "文案", role: "dev", provider: MX, model: MM },
          { id: "edit", name: "校对编辑", role: "test", provider: AN, model: AS },
        ],
      },
      {
        lead: { id: "gr-lead", name: "增长负责人", role: "lead", provider: MX, model: MM },
        workers: [
          { id: "market", name: "市场策略", role: "dev", provider: MX, model: MM },
          { id: "ops", name: "运营", role: "ops", provider: DS, model: DM },
        ],
      },
    ],
    readme: `# 内容媒体公司\n\n## 编辑团队（主编）\n- 技术写作 / 文案：选题到成稿\n- 校对编辑：事实核查与润色\n\n## 增长团队（增长负责人）\n- 市场策略：定位与信息\n- 运营：分发与节奏\n\n## 适用\n内容平台、自媒体矩阵、知识付费。`,
    recommendedConfig: {
      defaultModel: MM,
      budget: { totalUsd: 8, maxTokensPerTask: 150_000 },
      permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: true },
    },
  }),
  company({
    id: "mobile-app-company", title: "移动应用公司",
    desc: "聚焦移动 App 的精干公司：一个工程团队覆盖移动端、后端与测试。",
    tags: ["mobile", "app", "startup"],
    ceo: { id: "ceo", name: "CEO", role: "ceo", provider: DS, model: DM },
    teams: [
      {
        lead: { id: "eng-lead", name: "工程负责人", role: "lead", provider: AN, model: AS },
        workers: [
          { id: "mobile1", name: "移动端 A", role: "dev", provider: DS, model: DM },
          { id: "mobile2", name: "移动端 B", role: "dev", provider: DS, model: DM },
          { id: "be", name: "后端工程", role: "dev", provider: DS, model: DM },
          { id: "qa", name: "测试", role: "test", provider: DS, model: DM },
          { id: "ux", name: "交互设计", role: "dev", provider: MX, model: MM },
        ],
      },
    ],
    readme: `# 移动应用公司\n\n精干单团队，CEO 直管工程负责人：\n- 移动端 A/B：跨平台 App 开发\n- 后端工程：API 与数据\n- 测试：分层测试与发布质量\n- 交互设计：移动体验\n\n## 适用\n独立 App、小团队快速迭代、MVP 验证。`,
    recommendedConfig: {
      defaultModel: DM,
      budget: { totalUsd: 8, maxTokensPerTask: 150_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false },
    },
  }),
];
