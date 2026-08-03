# OPC Studio 终极完整方案

> 版本 1.0 · 2026-06-18
> 从命令行框架到开发者的 AI 工程团队桌面应用

---

## 一、产品一句话定位

**OPC Studio 是开发者的"AI 工程团队操作系统"——你不是指挥一个 AI 程序员，而是经营一支可视化、可配置、可分享的 AI 团队，让它们协作完成真实软件项目。**

对标但超越：
- vs **OpenCode**：它是单个 AI 程序员，我们是一支有组织、有分工、有质量门的团队
- vs **Hermes**：它是后台单 agent，我们给它穿上可视化组织 + 团队协作的外衣
- vs **cc-switch**：它管 API 切换，我们管整个 agent 团队的配置、运行、协作

---

## 二、四个定方向的决策（已确认）

| 决策点 | 选择 | 含义 |
|--------|------|------|
| **CEO 大脑** | 用户自己选 + 强推荐 + 质量警告 | 不强制，但用弱模型当 CEO 会弹风险提示 |
| **产品形态** | Electron 桌面应用 | 跨平台窗口，原生 shell，像 cc-switch |
| **Hermes** | Agent 执行引擎（替换 modelGateway） | 每个 agent 背后是一个有工具+记忆+自进化的 Hermes 实例 |
| **目标用户** | 开发者（像 OpenCode） | 代码工具链优先：读写文件、跑测试、git、终端 |

---

## 三、核心矛盾与解法：「便宜模型当大脑」

### 问题本质

整个产品最致命的设计陷阱：**调度大脑（CEO/Lead）的拆解和验收能力，决定整个团队的上限。** 用户为省钱用 DeepSeek 当 CEO → 拆解粗糙、验收失效 → 团队垮掉。这是所有 multi-agent 产品的通病。

### 三层解法（你选了"用户自选"，但要配套保障）

**第 1 层：智能推荐（降低选错概率）**
- CEO/Lead 节点默认推荐高质量模型（GLM-5 / Claude / GPT），并标注"调度大脑建议用强模型"
- Worker 节点默认推荐性价比模型（DeepSeek / MiniMax / Doubao）
- 配置页显示"角色 × 模型"的推荐矩阵

**第 2 层：质量警告（用户选弱模型时提示）**
- 用户把 CEO 设成弱模型时，节点显示黄色 ⚠ + tooltip："弱模型做调度可能导致任务拆解不准"
- 不阻止，但让用户知道风险

**第 3 层：Hermes 兜底（这是关键差异化）**
- Hermes 的自进化 + 记忆系统，能让弱模型"越用越强"
- 弱模型当 CEO，但 Hermes 把过去成功的拆解模式存为 skill，下次自动注入
- **这就是为什么 Hermes 做执行引擎能化解 80% 的"便宜大脑"问题**——它给弱模型外挂了经验

### 确定性兜底（防止纯靠模型）

即使大脑很弱，编排层用确定性规则保底：
- 关键词路由（代码任务→Engineering Lead）
- 任务模板（常见任务类型有预设拆解）
- 质量门（Test/Review agent 必须通过才标记 done，不靠 CEO 自觉）

---

## 四、终极架构

```
┌─────────────────────────────────────────────────┐
│ Electron 桌面窗口                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ React UI（org图 / 终端 / 报告 / 社区 / 配置）│   │
│  └──────────────────────────────────────────┘   │
│         │ IPC + SSE                               │
│  ┌──────────────────────────────────────────┐   │
│  │ Node.js 主进程（编排 + 路由 + 存储 + API）  │   │
│  │  - orchestrator: CEO→Lead→Worker 调度       │   │
│  │  - 确定性路由 + 质量门                       │   │
│  │  - 成本追踪 + 健康监控                       │   │
│  └──────────────────────────────────────────┘   │
│         │ 子进程 / API                            │
│  ┌──────────────────────────────────────────┐   │
│  │ Agent 执行引擎层                            │   │
│  │  ┌─ Hermes 实例池（每 agent 一个）─────┐   │   │
│  │  │  工具系统 / 四层记忆 / skill 自进化   │   │   │
│  │  └────────────────────────────────────┘   │   │
│  │  ┌─ 轻量 modelGateway（备用/简单任务）─┐  │   │
│  │  │  纯 API 调用（DeepSeek/MiniMax/...）  │  │   │
│  │  └────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
         │
         ▼ 各家模型 API
  DeepSeek · MiniMax · Doubao · Claude · GPT · GLM · ...
```

### Hermes 执行引擎集成

每个 OPC Studio agent ↔ 一个 Hermes skill + 一个 Hermes session：

```
OPC Studio "Backend Engineer" 节点
  → Hermes session（持久）
  → 加载 skill: backend-engineer.md（system prompt + 工具配置）
  → 任务执行：读文件 → 写代码 → 跑测试 → 返回
  → 记忆：本次经验存入 ~/.hermes/memories/
  → 自进化：成功的代码模式自动存为新 skill
```

**关键收益**：
- agent 有真实工具（不只是文本）
- agent 跨任务记忆（项目知识累积）
- agent 自进化（用得越多越懂这个项目）
- 弱模型 + Hermes 经验 ≈ 强模型裸跑

---

## 五、面向开发者的功能优先级

既然目标是开发者（像 OpenCode），功能按这个排：

### P0 — 代码工具链（开发者的命脉）
- ✅ readFile / writeFile / listFiles / searchFiles / getProjectTree（已实现）
- ✅ runShell（已实现，带 shellGuard）
- ⏳ git 工具（status / diff / commit / branch）
- ⏳ 测试运行器（自动识别 pytest/jest/cargo test，跑测试 + 解析结果）
- ⏳ 代码诊断（LSP / tsc / eslint 集成）

### P1 — 真实项目流程
- ⏳ 把 OPC Studio 指向任意本地项目目录（不只是自己的目录）
- ⏳ 任务 = git 分支（每个 run 在独立分支，可回滚）
- ⏳ Diff 审查界面（agent 改了什么，人工 approve）
- ⏳ 真实的 CEO plan 解析（不只是关键词路由）

### P2 — 团队可视化（产品的脸面）
- ✅ React Flow 组织图 + 状态灯（已实现，含 restricted 黑灯）
- ✅ 每节点 token/成本/当前任务（已实现）
- ⏳ 实时终端流（看到每个 agent 在做什么）
- ⏳ agent 之间的消息流可视化

### P3 — 社区市场（差异化护城河）
- ✅ 公司架构模板 + Agent 卡 + Prompt 模板（已实现数据层 + UI）
- ⏳ GitHub 后端（身份 / star / 下载量，无需自建服务器）
- ⏳ 一键分享当前团队到社区

---

## 六、分阶段路线图

### v0.1 — 本地多 agent 工作台（当前，Web MVP）
- ✅ 组织图 + 配置 + 终端 + 报告 + 社区
- ✅ 4 家供应商连通（DeepSeek/MiniMax/Doubao/Claude）
- ✅ cc-switch 式 Provider 配置页
- ✅ restricted 状态（API 受限黑灯）

### v0.2 — Hermes 执行引擎集成
- HermesBridge：每 agent 一个 Hermes 实例
- 弱模型 + Hermes 记忆/自进化 = 化解便宜大脑问题
- agent prompt ↔ Hermes skill 双向同步

### v0.3 — 开发者工具链
- git 工具 + 测试运行器 + LSP 诊断
- 指向任意本地项目
- Diff 审查 + 人工 approve

### v0.4 — Electron 桌面化
- 打包成跨平台桌面应用
- 原生 shell + 文件系统
- 系统托盘 + 全局快捷键

### v0.5 — 社区市场上线
- GitHub 后端（star / 下载 / 贡献者主页）
- 一键分享/导入团队

### v0.6 — 质量保障体系
- CEO 大脑质量警告 + 推荐矩阵
- 确定性质量门（Test 不过不能 done）
- 成本预算硬约束

### v0.7+ — 高级能力
- 多项目 dashboard
- 浏览器自动化 agent
- Docker/E2B sandbox 执行
- 账号登录调用（ChatGPT/Claude，如合规可行）

---

## 七、与竞品的差异化（护城河）

| 维度 | OPC Studio | OpenCode | Hermes | cc-switch |
|------|-----------|----------|--------|-----------|
| 团队 vs 单体 | ✅ 可视化团队 | 单 agent | 单 agent | N/A |
| 角色分工 | ✅ 7 角色 + 自定义 | ❌ | ⚠️ 子 agent | ❌ |
| 执行引擎 | Hermes（工具+记忆+进化） | 自有 | ✅ 自身 | ❌ |
| 弱模型可用性 | ✅ Hermes 经验外挂 | ❌ 依赖强模型 | ✅ 自进化 | N/A |
| 社区市场 | ✅ 团队+agent+prompt | ❌ | ⚠️ skill | ❌ |
| API 管理 | ✅ cc-switch 式 | ⚠️ 基础 | ⚠️ | ✅ 专精 |
| 成本可视化 | ✅ 按节点/项目 | ⚠️ | ❌ | ✅ |
| 桌面应用 | ✅ Electron | ⚠️ CLI | CLI | ✅ |

**独特组合（无人同时具备）**：可视化 AI 团队 + Hermes 执行引擎 + 社区市场 + 成本可视化 + 开发者工具链。

---

## 八、当前真实状态（已完成的资产）

```
OPCstudio/（pnpm monorepo，build 通过）
├── packages/shared/      ← 类型 + schema + 价格表
├── apps/server/          ← Express + SSE + 7 路由模块
│   ├── routes/           ← config/agent/run/community/event/pricing/provider
│   ├── runtime/          ← orchestrator + modelGateway + tools + providerHealth
│   ├── storage/          ← project/community/pricing/provider store
│   └── security/         ← pathGuard + shellGuard
├── apps/web/             ← React + Vite + React Flow
│   ├── pages/            ← Org / Settings / Reports / Community / ProviderSettings
│   └── components/       ← 20+ 组件
└── apps/cli/             ← opc init / opc studio
```

**已验证**：
- 4 家供应商 `opc delegate` 全部连通
- 11 agent 组织图渲染
- trace 持久化、报告生成、社区数据层
- Provider 配置页（16 preset + 测试连接 + 计费）
- restricted 黑灯状态

**未做（按路线图推进）**：
- Hermes 执行引擎集成（v0.2，最高优先级）
- 开发者工具链（git/测试/LSP，v0.3）
- Electron 打包（v0.4）

---

## 九、立即下一步（我的建议）

按"化解便宜大脑问题"的优先级，**v0.2 Hermes 执行引擎集成是当前最该做的**——它直接解决你说的"DeepSeek 当大脑不够好"。

实施顺序：
1. `HermesBridge` 模块（子进程调 Hermes）
2. agent prompt → Hermes skill 同步
3. orchestrator 的 `callModel` 替换为 `hermes.execute`
4. 验证：弱模型 + Hermes 记忆，效果是否接近强模型裸跑

需要你确认：是否现在就启动 v0.2 Hermes 集成？
