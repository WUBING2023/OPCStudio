# OPC Studio — 现状差距 & 分阶段路线图

> 主线：把"调模型"升级为"调执行引擎"——每个 agent 节点是独立、能真正调工具干活的 agent，可按节点选 (供应商 / 模型 / 框架)。框架 = Hermes(默认) / Claude Code CLI / Codex CLI / API。
> 由全仓审计（对照 MASTER_PLAN/MASTER_TODO/初步计划 等愿景文档，目标能力 61 项）得出，2 个 blocker、5 个阶段。

## 0. 关键诊断（为什么"感觉功能是假的、进度慢"）

两个 blocker 是根因，不是错觉：

1. **没有 ExecutionEngine 抽象层。** 现在只有 `modelGateway` 一条 API 路径 + 硬编码在 gateway 里的 Hermes 分支（按 role 判断）。Claude Code / Codex CLI **根本不存在**；节点配置只有 `provider/model`，**没有 `framework` 字段**。整条"可插拔执行框架"主线缺承重墙。
2. **静默回退 mock = 假成功（最危险）。** 未配 key / UI 新增的自定义 provider 时，`callModel` 静默落到 `mockProvider`，产出 `[MOCK...]` 假文本和伪造的 `writeFile(hello.txt)`，**run 仍标记成功、cost=0、不报错**。所以编排链"看起来跑通了"其实全假——这就是你感到"功能失效"的真正来源。`providers.json` 里的自定义 provider 永远不会成为真正的 handler。

> 换句话说：进度慢的感受，本质是"很多功能是 UI/假数据层面的就绪，执行层是空的或假的"。Phase 1 就是把这堵墙砌实。

## 1. 完整差距清单（按严重度）

| # | 区域 | 差距 | 级别 |
|---|------|------|------|
| 1 | 执行引擎·框架抽象 | 无 ExecutionEngine 层；无 framework 字段；CLI 框架不存在 | 🔴 blocker |
| 2 | 执行引擎·mock 降级 | 无 key/自定义 provider → 静默 mock 假成功 | 🔴 blocker |
| 3 | 执行引擎·多账号并行 | orchestrator 纯串行 for-await；无账号池/调度器/进程池/队列 | 🟠 high |
| 4 | 执行引擎·CLI 生命周期 | 无 CLI 安装/登录/隔离 config 目录管理 | 🟠 high |
| 5 | 编排·质量门禁 | quality gate 是关键词扫描（假），非真实 runTests/类型检查结果 | 🟠 high |
| 6 | 执行引擎·Hermes 工具循环 | Hermes 只返回纯文本、不解析 tool_calls；默认 enabled=false | 🟠 high |
| 7 | 记忆 & Skill 自进化 | 四层记忆/Skill 自动注入是 core 目标；runtime 从不消费 skill、enabled 开关无效 | 🟠 high |
| 8 | 编排·CEO 计划解析 | 脆弱 Markdown 正则；未要求 JSON 输出、无 schema 校验 | 🟡 medium |
| 9 | 执行引擎·工具 root | `setToolsProjectRoot` 从未被调用，靠 fallback 侥幸正确，脆弱耦合 | 🟡 medium |
| 10 | 可观测·trace 粒度 | tool_call/tool_result 未系统化 emit；终端流缺结构化工具日志 | 🟡 medium |
| 11 | Provider·动态注册 | handler 启动时硬编码注册一次；改 key/加自定义 provider 需重启 | 🟡 medium |
| 12 | 真实流程·分支隔离 | `createRunBranch` 用 `checkout -b` 在当前分支切换，多 run 并发互踩；无 worktree | 🟡 medium |
| 13 | 后端·MCP 接入执行 | MCP 可 CRUD/测连接，但 runtime 不读 mcpStore，工具从不进调用链 | ⚪ low |
| 14 | 后端·社区/多项目 | githubSources 内存数组(重启即丢)、死代码；projectRoot 启动固定不可运行期切换 | ⚪ low |

## 2. 分阶段路线图（步子放大，每阶段可演示）

### Phase 1 — 执行引擎地基重构（承重墙）
**目标**：把"调模型"升级为"调执行引擎"；引入统一 `ExecutionEngine` 接口，节点带 (provider/model/framework) 三元组，API 路径作为第一个引擎实现接入；**彻底干掉静默 mock 假成功**。
**大改动**：
- 新建 `ExecutionEngine` 接口 `run(node, task, ctx) → {content, toolCalls, tokens, cost, fileChanges, latency}`；把现有 modelGateway + orchestrator 的工具循环抽成 `ApiEngine`；`AgentNodeConfig` 加 `framework` 字段。
- `EngineRouter`：按节点 framework 选引擎、按 provider/model 选 handler；`providers.json` 改为运行时动态注册（替代 index.ts 一次性硬编码），支持自定义 baseUrl。
- 去掉静默 mock：无 key/无 handler → 抛 `ProviderUnavailable`，节点置 restricted 黑灯 + trace/终端明确报错；mock 仅在显式 `provider=mock` 时启用。
- 修复 `setToolsProjectRoot` 脆弱耦合；tool 执行拆出 `tool_call`/`tool_result` 细粒度 trace。
- **真实质量门 v1**：改为调用 `runTests` + `checkTypeErrors` 的真实退出码判定，删除关键词扫描。
**Deliverable**：组织图里一个节点配有效 DeepSeek key、另一节点配无 key 自定义 provider，跑"创建并测试一个函数"——有 key 节点真写文件+测试通过才 commit；无 key 节点 restricted 黑灯+明确报错（不再生成假 hello.txt），run 状态如实。
**验证**：`pnpm -r build` + tsc 通过；curl `POST /api/chat/task` 后检查 `.opc/runs/<id>/trace` 含 tool_call/tool_result、`task.json` status 与真实测试结果一致；无 key 时 cost=0 且 status=failed/restricted 而非 done。

### Phase 2 — 接入 CLI/Hermes 真实执行 + 每节点"CC Switch"
**目标**：在引擎抽象上落地 Claude Code / Codex / Hermes 三个可插拔框架的真实执行；订阅用户走 CLI（自己额度），其余走 API/Hermes。
**大改动**：
- `ClaudeCodeEngine` / `CodexEngine`：封装本地 CLI 进程（复用 hermesBridge 的 daemon/管道模式），跑出真实 diff/结构化结果。
- Hermes 接成真正执行引擎（不再是 gateway 里的 role 旁路）：解析结果为 tool_calls/fileChanges，enabled 改为按节点 framework 决定。
- CLI 生命周期：检测/引导安装、登录（隔离 config 目录）；`/api/frameworks` 暴露可用性与登录状态；前端节点详情面板加 **framework 选择器（每节点 CC Switch：provider×model×framework）**。
- 统一 fileChanges/diff 结构，喂给现有 `DiffReviewPanel`。
**Deliverable**：三个 worker 分别配 API(DeepSeek)/Claude Code/Hermes，跑同一改代码任务；组织图节点灯实时变化，BottomTerminal 流式显示各自 tool call，DiffReviewPanel 展示三者真实 diff 可 approve/reject。
**验证**：每引擎集成测试（stub CLI 验管道协议）；Windows 上对真实测试仓库各跑一次，截图状态灯+终端流+diff；过门自动 commit、失败丢弃。

### Phase 3 — 多账号并行池 + 调度器 + 无上限 agent
**目标**：解除串行瓶颈；同厂商多账号并行（隔离 config 目录、账号池、选最空闲账号），agent 数量不设上限；并发安全的分支隔离。
**大改动**：
- `AccountPool`：每 provider 多账号，每账号隔离 config 目录 + 忙闲状态；`Scheduler` 自动选最空闲账号，接 providerHealth 自动降级。
- 并行 orchestrator：同 Lead 下 workers 并行（并发上限 + backpressure 队列），跨 Lead 也并行，结果逐级汇总。
- 并发安全任务=分支：用 `git worktree` 给每个并行 run 独立工作树（替代 checkout -b 互踩）；过门 commit、失败丢弃、可回滚。
- 运行期可切换 projectRoot + 多项目并行隔离。
**Deliverable**：组织挂 10+ worker、某 provider 配 2 账号，一键跑跨团队大任务；多节点同时 working，调度器日志显示账号分配，各 worker 在独立 worktree 改文件互不干扰，逐级汇总成跨团队报告。
**验证**：20 worker 并发压测，确认无文件互踩、无账号串号（trace 标注所用账号）；worktree 数与并发数匹配且结束清理；对比串行墙钟时间下降。

### Phase 4 — Hermes 记忆 & Skill 自进化（差异化大脑）
**目标**：兑现"弱模型 + Hermes 经验 ≈ 强模型裸跑"；落地四层记忆、Skill 自进化与运行时注入、prompt↔Skill 双向同步，并用基准测试量化。
**大改动**：
- Skill 运行时消费：runAgent 执行前按 agent 注入 enabled 的 skill 到系统提示（打通现状失效的开关）。
- 四层记忆：跨任务项目知识累积（会话/任务/项目/全局），执行前检索注入、执行后沉淀。
- Skill 自进化：run 结束从成功模式自动抽 skill 落盘、下次自动注入；`parseCeoPlan` 升级为 JSON 结构化输出 + schema 校验（替代脆弱正则）。
- `runBenchmark`：固定基准任务集对比"弱模型+记忆/skill" vs "强模型裸跑"的通过率/成本。
**Deliverable**：同一弱模型节点，第一次跑某类任务失败/低质 → 自动沉淀 skill/记忆 → 第二次同类任务注入经验后明显改善；runBenchmark 输出对比表证明接近强模型。
**验证**：基准脚本可重复输出报告；断言第二次注入的 skill/memory >0 且体现在 system prompt（trace 可见）；parseCeoPlan 单测覆盖 JSON+回退。

### Phase 5 — 可观测打磨 + 周边收口
**目标**：把前四阶段的真实能力包装成可交付产品；修审计暴露的死代码/假实现；补 MCP 接入与桌面壳。
**大改动**：
- 可视化收口：节点实时 token/cost/最近 action、xterm 结构化 tool call 流、Talk to any agent；CEO 弱模型⚠ + 角色×模型推荐矩阵接真实数据。
- 报告中心：结构化报告（Goal/Summary/Files Changed/Tests/Cost/Risks/Next Steps）由 Lead 真实产出；修 `updateReportMetaName` 忽略入参 bug。
- 修死代码：社区 githubSources 持久化 + 接入列表 + download 计数路由；config POST 加 Zod 校验。
- MCP 接入执行（注册的 MCP 工具喂进 Phase 1 工具链）+ Electron 桌面壳打包出 Windows 安装包。
**Deliverable**：启动 UI → 导入社区团队 → 指向真实本地项目 → 跑任务全程可视化 → 生成结构化报告 → 打包成 Windows 安装包双击运行。
**验证**：E2E 走查全链路并录屏；社区列表展示远程 GitHub 源且重启不丢。

## 3. 需要董事长拍板的岔路
- **订阅 CLI 跑哪些角色**：建议仅 CEO/Lead 等少数高价值节点用订阅 CLI（限流/ToS 风险低），worker 集群走 API/Hermes 按量付费。
- **"最空闲"判定口径**：先用"活跃会话数最少"起步，是否还要读限流状态？
- **质量门严格度**：测试失败一律丢弃，还是允许"软失败 + 人工 review"？
