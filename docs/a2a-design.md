# OPC Studio 真·A2A 通信设计(Google A2A + FIPA-ACL/JADE 融合)

> 来源:董事长指示「彻底优化整个 A2A,参考 Google A2A + FIPA-ACL/JADE」。设计经 workflow(测绘现状→3提案→综合)产出,扎根真实代码。


## 实施进度(全部完成 ✅ — 三端 tsc 0、140 vitest 全绿)
- [x] **Phase 0 类型地基**:types.ts/schemas.ts 新增 Performative/A2APart/ArtifactRef/Artifact/AgentSkillDesc/AgentCapabilityCard,扩展 AgentMessage(可选)、AgentNodeConfig(card?)、ChannelKind(+a2a)。三端 tsc 0、126 vitest 全绿、零行为变更。
- [x] **Phase 1 投递部件**:新建 apps/server/src/runtime/a2aBus.ts(A2ABus inbox + ArtifactStore),a2aBus.test.ts 6 新测全绿、未接线。
- [x] **Phase 2** recordMessage 真投递 + recordA2A + deliverToInboxes(canCommunicate 门控)+ a2aBus/artifactStore 单例 ✅
- [x] **Phase 3** runEngineCore drain inbox 注入(限5条/2000字,dedup 派活)✅
- [x] **Phase 4** 工具 discover_agents/send_message/share_artifact/list_my_inbox + request_channel 放宽 kind + apiToolLoop 回退 paramSchema ✅
- [x] **Phase 5** ask_agent 双向问询(同步子调用 + 深度≤2 + A↔B 环检测 + 引擎自带超时)✅
- [x] **Phase 6** Agent Card 派生兜底(deriveSummary)+ worker 产出存 artifactStore ✅

## 一、融合决策

采用「融合派为骨架、A2A 派为细化」的方案，落地为单进程内存语义复刻，零网络协议。

融合决策(四层映射，全部叠加在现有结构之上而非替换):
- A2A Agent Card 自描述发现 → 落在 AgentNodeConfig 上新增可选 card 字段 + 一个 directory 查询函数(从内存 agents 数组派生)，即 FIPA 的 DF 黄页。不新建顶层 AgentCard(该名已被 marketplace 类型 types.ts:271 占用)，新类型命名 AgentCapabilityCard。
- FIPA performative 言语行为 → 扩展现有 AgentMessage，加可选 performative(inform/request/ask/reply/share/propose/accept/reject)。缺省视为 inform，旧消息语义不变。
- FIPA query-ref 双向问询 → 新工具 ask_agent，带 correlationId 的请求-等待-返回闭环，明确不交权(区别 handoff)。三道防死锁闸(深度≤2、超时复用 taskTimeoutMs、环检测)。
- A2A Artifact 一等公民 → claim-check 引用(ArtifactRef)，复用现有 FileChange/git 工件库与 leadSummary，大文档传 id 不内联，控 token。

嫁接到 OPC 现有四层:ChannelRegistry.canCommunicate 作授权门(fail-closed ACL，零改)、visibility.visibleTo 作收件人解析与可见性(零改纯函数)、recordMessage 作唯一投递点(升级为真投递)、eventBus 严格保持仅 UI 观测(不承载定向消息正文，修掉已知 SSE 泄漏隐患)。新增唯一传输部件:per-agent inbox(A2ABus)。

为何这样融合而非纯 A2A 或纯 FIPA:OPC 是单进程、中心协调(CEO/lead)、已有两层 ACL 的系统。纯 A2A 的 HTTP/JSON-RPC/跨进程发现对单机是 over-engineering(draco-eval/reports/a2a-synthesis.md 已指出)；纯 FIPA 缺能力声明与产出物模型。融合取二者语义、弃二者的网络/重协议负担，且全部可选字段+新工具+新单例，现有 channels.test.ts/visibility.test.ts/requestChannelTool.test.ts 三套契约零破坏。

## 二、类型改动(packages/shared)

全部改动在 packages/shared/src/types.ts + schemas.ts，新增字段一律可选(barrel 是 export *，对所有导入零破坏)。

=== types.ts 改动 ===

1) 扩展 ChannelKind(types.ts:102)——加 a2a 成员供未来跨进程 Engine 用，本期不强制走它:
  export type ChannelKind = "lead-worker" | "peer-worker" | "peer-lead" | "learn" | "a2a";
(channels.ts 全部逻辑 kind-agnostic，加成员仅是分类标签，行为不变。)

2) 新增 Performative 闭集(FIPA 言语行为子集):
  export type Performative =
    | "inform"   // 通知/产出回报(现有 recordMessage 默认 = inform)
    | "request"  // 委派(同侪间请求做事)
    | "ask"      // 问询，需 reply(阻塞，带 correlationId)
    | "reply"    // 对 ask 的回应(带相同 correlationId)
    | "share"    // 主动把 artifact 发给某人
    | "propose" | "accept" | "reject"; // 协商类(评审 ACCEPT/REDO 可逐步迁入，本期不强制)

3) 新增 A2APart(结构化多模态，text 字段保留为纯文本投影以兼容 visibility/UI):
  export type A2APart =
    | { kind: "text"; text: string }
    | { kind: "data"; data: Record<string, unknown> }
    | { kind: "artifact"; ref: string }; // artifactId，不内联大文档

4) 新增 ArtifactRef + Artifact(claim-check):
  export interface ArtifactRef { id: string; name: string; type: string; summary?: string; }
  export interface Artifact {
    id: string; runId?: string; producedBy: string;
    kind: "file-change" | "report" | "text";
    name: string; type: string;             // "code-diff"|"design-doc"|"test-report"|"file"
    fileChanges?: FileChange[];              // 复用 engine.ts:9 FileChange
    workdirPath?: string;                    // 指向 worktree/activeWorkRoot 相对路径
    inlineText?: string;                     // 仅 <4KB 才内联
    summary?: string; createdAt: string;
  }
(FileChange 从 ./engine.js import；types.ts 顶部加 import type { FileChange } from "./engine.js"。)

5) 扩展 AgentMessage(types.ts:131)——全部可选，旧消息合法:
  export interface AgentMessage {
    id: string; runId?: string; channelId?: string;
    from: string; text: string; timestamp: string;
    visibility: MessageVisibility;
    // —— A2A/FIPA 叠加层(可选) ——
    to?: string[];                 // 显式收件人(真投递)；缺省回退 visibility.audience
    performative?: Performative;   // 缺省视为 inform
    parts?: A2APart[];             // text 始终是 parts 的纯文本投影
    conversationId?: string;       // 一次协作/问答串关联(A2A contextId / FIPA conversation-id)
    correlationId?: string;        // ask/reply 配对(FIPA reply-with/in-reply-to)
    taskRef?: string;              // 关联 A2ATask id(可选，本期 Task 状态机为后期阶段)
    artifactRefs?: string[];       // claim-check 引用，只放 artifactId
  }

6) 新增 AgentCapabilityCard + AgentSkillDesc(落到 AgentNodeConfig):
  export interface AgentSkillDesc { id: string; name: string; description: string; inputModes?: string[]; outputModes?: string[]; }
  export interface AgentCapabilityCard {
    summary: string;            // 一句话"我能干什么"(喂 directory 检索/选人)
    skills: AgentSkillDesc[];
    produces?: string[];        // 能产出的 artifact 类型标签
    consumes?: string[];        // 能消费/能回答的问询类型
    acceptsQuery?: boolean;     // 是否可被 ask(默认 true)
    tools?: string[];           // 该 agent 实际可用工具子集(默认全局 ALL_TOOLS)
  }

7) 扩展 AgentNodeConfig(types.ts:13)末尾加一行:
  card?: AgentCapabilityCard;

=== schemas.ts 改动(序列化/UI 编辑校验入口，单进程内不强制 parse) ===

- PerformativeSchema = z.enum(["inform","request","ask","reply","share","propose","accept","reject"]);
- A2APartSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({ kind: z.literal("data"), data: z.record(z.unknown()) }),
    z.object({ kind: z.literal("artifact"), ref: z.string() }),
  ]);
- AgentSkillDescSchema / AgentCapabilityCardSchema(照 AgentNodeConfigSchema 写法，全 .optional())。
- 把 card: AgentCapabilityCardSchema.optional() 挂进 AgentNodeConfigSchema(schemas.ts:5 内追加一行)。
- 新增 AgentMessageSchema(填补现有缺口):MessageAudience 的模板字面量(role:/agents:)用 z.union([z.enum([...固定值]), z.string().refine(s=>s.startsWith("role:")||s.startsWith("agents:"))]) 表达；A2A 字段全 .optional()。
- 新增 ArtifactSchema / ArtifactRefSchema 备序列化。
注:ChannelKind 扩成员后，凡有 z.enum(["lead-worker",...]) 的 schema 同步加 "a2a"(grep 确认 schemas.ts 当前无 ChannelKind 的 zod，仅 types.ts；无需改 schemas.ts 的 channel 部分)。

## 三、agent 新工具

所有新工具加进 tools.ts 的 ALL_TOOLS(tools.ts:50)，照搬 request_channel 模式:带 paramSchema 字段(自动进 toOpenAITools)，且必须同步补 apiToolLoop.ts 的 TOOL_PARAM_SCHEMAS 静态表(否则 Hermes 文本引擎 buildToolInstructions 缺参数签名——这是已验证的现存缺口，line 47 只读静态表)。执行身份统一复用 currentAgentId()(runWithAgent 注入，tools.ts:26-29)，无需改 runTool 签名或 ExecContext。与 orchestrator 用回调 hook 解耦(避免循环依赖)，新增 setA2ASendHandler/setAskHandler/setDiscoverHandler/setShareHandler，与现有 setChannelRequestHandler 同区域注入。

1) discover_agents — 能力发现(A2A Agent Card 发现 / FIPA DF 黄页)
  name: "discover_agents"
  paramSchema: { properties: { role: {type:"string",description:"按角色筛选"}, skill: {type:"string",description:"按能力标签/关键词筛选"}, produces: {type:"string",description:"按可产出 artifact 类型筛选"} }, required: [] }
  语义: 调 discoverHandler(currentAgentId(), filter) → orchestrator 对内存 agents 数组按 card.skills/role/produces 过滤(复用 indexById)，excludeSelf。
  返回: JSON 文本，每条 {id,name,role,summary,skills:[name]}。绝不返回 org 全树或消息(token 收敛)。

2) send_message — fire-and-forget 通知(performative=inform)
  name: "send_message"
  paramSchema: { properties: { target:{type:"string"}, text:{type:"string"}, artifactId:{type:"string",description:"可选，附带产出物引用"} }, required: ["target","text"] }
  语义: 校验 currentAgentId() + canCommunicate(from,target)，无通道返回提示"请先 request_channel"。经 sendHandler 调 recordA2A({from, to:[target], text, performative:"inform", artifactRefs: artifactId?[artifactId]:undefined})。不阻塞、不等回复。

3) ask_agent — 同步阻塞问询(performative=ask/reply，query-ref，不交权)
  name: "ask_agent"
  paramSchema: { properties: { target:{type:"string"}, question:{type:"string"} }, required: ["target","question"] }
  语义: 经 askHandler(async): (a) canCommunicate 准入门；(b) 生成 correlationId=`${runId}-q-${seq}`；(c) recordA2A 一条 performative:"ask"、to:[target]、correlationId、conversationId 投进 target inbox；(d) await pendingQueries.get(correlationId) 的 Promise，直到对方 reply 或 timeout(复用 taskTimeoutMs)或深度>2 截断。
  返回: 对方答案文本 / "对方未及时回应" / "问询过深，请基于现有信息作答"。
  description 必须写明:用于向他人要信息，不是把任务交给他人(防模型误用为 handoff)；ask 不创建 Task、不转移所有权。
  ChannelRequestHandler 风格 hook 改为返回 Promise<string>(execute 已是 async，改动小)。

4) share_artifact — claim-check 发产出物(performative=share)
  name: "share_artifact"
  paramSchema: { properties: { target:{type:"string"}, artifactId:{type:"string"}, note:{type:"string"} }, required: ["target","artifactId"] }
  语义: 校验 artifactId 由 currentAgentId 产出或对其可见 → recordA2A({from,to:[target],text:note,performative:"share",artifactRefs:[artifactId]})。正文只放 note+标题，不内联全文。收件人 inbox 收到 ref+summary。

5) request_channel(改造现有，tools.ts:61) — 放宽 kind 参数
  paramSchema 加可选 kind: { type:"string", description:"通道类型 peer-worker(默认)/peer-lead" }。
  execute 仍取 currentAgentId()(无则拒，保留旧拒绝文案"无法确定申请方")，把 kind 透传给 handler。
  ChannelRequestHandler 签名扩为 (from, target, reason, kind?:ChannelKind)=>string，默认 "peer-worker"(保持 requestChannelTool.test.ts 断言 kind==="peer-worker" 的默认路径不破)。

6) list_my_inbox(可选自省工具) — 感知待处理消息
  name: "list_my_inbox"; required: []
  语义: peek(currentAgentId())，返回待处理消息摘要(from/performative/conversationId/text 前 N 字)，不消费。便于模型决定是否 reply。

## 四、registry Agent Card

注意路径陷阱:M:/OPC/agents/registry.yaml 属于 Python OPC 框架(池清单+预算元数据，字段固定 id/role/model/count/budget_monthly_usd/status)，与 A2A 改造无关，不要动它。A2A 目标是 TS 系统(OPC Studio)，其 agent 定义来源是 <projectRoot>/.opc/agents.json(JSON 数组，loadAgents/saveAgents) 与 DEFAULT_AGENTS(defaults.ts)。Agent Card 落在 AgentNodeConfig 的可选 card 字段，因此"registry"在 TS 这套就是 agents.json。下面给 agents.json 节点的 Agent Card 示例(JSON，非 YAML):

[
  {
    "id": "backend-engineer",
    "name": "后端工程师",
    "role": "dev",
    "parentId": "engineering-lead",
    "childrenIds": [],
    "model": "deepseek-v4-pro",
    "provider": "deepseek",
    "framework": "api",
    "status": "idle",
    "tokenUsage": { "prompt": 0, "completion": 0, "total": 0 },
    "editable": true, "deletable": true, "enabled": true,
    "card": {
      "summary": "实现后端 API、数据模型与服务端业务逻辑，可被前端问询接口契约。",
      "skills": [
        { "id": "api-impl", "name": "API 实现", "description": "设计并实现 REST/RPC 端点", "outputModes": ["code-diff"] },
        { "id": "data-model", "name": "数据建模", "description": "schema 与持久层", "outputModes": ["code-diff","design-doc"] }
      ],
      "produces": ["code-diff", "design-doc"],
      "consumes": ["api-contract-query", "data-shape-query"],
      "acceptsQuery": true,
      "tools": ["readFile","writeFile","searchFiles","runShell","runTests","ask_agent","send_message","share_artifact","discover_agents"]
    }
  }
]

派生兜底:card 缺省时 orchestrator 在 initOrchestrator(orchestrator.ts:138 已用 spread {framework,companyId,...a} 合并)自动合成降级卡——summary 取 getRolePrompt(role) 首句、skills 由该 role 的 skillStore 标题派生、tools 默认全局 ALL_TOOLS 名单。保证旧 agents.json 零迁移。

若需给 Python registry.yaml 也加能力声明(非本期必须、不影响 TS A2A)，可在每池条目加可选 capabilities: [string]，但 ROLE_MODEL_MAP 仍是路由权威，capabilities 仅元数据——不建议本期改，避免误改另一套系统。

## 五、orchestrator/channels/eventBus 改动

函数级改动点(集中在 orchestrator.ts，约 150 行；channels.ts/visibility.ts 零改):

1) 新增 run 级模块单例(orchestrator.ts:84-88 区域，与 runMessages/runChannels 平级):
   const inbox = new Map<string, AgentMessage[]>();
   const pendingQueries = new Map<string, { resolve:(s:string)=>void; timeoutAt:number; depth:number }>();
   let artifactStore = new ArtifactStore();   // 新文件 a2aBus.ts 或就近定义
   let querySeq = 0;
   在 startRun(orchestrator.ts:495-511)重置:inbox.clear()、pendingQueries.clear()、artifactStore = new ArtifactStore(runId)、querySeq=0。与现有 runMessages.length=0 / runChannels=new ChannelRegistry(runId) 并列。

2) recordMessage(orchestrator.ts:90)升级为唯一投递点——保留旧位置参数签名不动(8 处调用零改)，新增内部 deliver 逻辑 + 新增 recordA2A(opts) 重载:
   - 旧 recordMessage(from,text,audience,phase?,channelId?) 末尾追加:调 deliverToInboxes(msg)。
   - deliverToInboxes(msg): 解析收件人 = msg.to(若有) 否则仅对定向 audience(agents:/role:/lead-only)用 visibleTo 反解出 run 内 viewer 集合(对 all/team 不做点对点投递，避免 N² 风暴，广播仍走原 visibleMessagesFor 拉取)。对每个收件人先 runChannels.canCommunicate(from,recipient)(fail-closed)，通过才 push 进其 inbox。若 msg.performative==="reply" 且 correlationId 命中 pendingQueries → resolve 那个 Promise(把答案回填给阻塞中的 ask)。
   - recordA2A(opts: { from; text; to?; audience?; performative?; conversationId?; correlationId?; artifactRefs? }):内部组装同一个 AgentMessage(text 为 parts 纯文本投影)，复用同管线(push runMessages + setActive + emit + deliverToInboxes)。to 优先于 audience；若只给 to 则 audience 自动设为 `agents:${to.join(",")}`(复用 visibleTo 的 agents: 解析，不改 visibility 纯函数)。
   - emit("agent_message") 只发 {text,audience,performative,conversationId,channelId}，不发 parts/artifact 全文(eventBus 仅 UI 观测，杜绝 SSE 定向泄漏)。

3) runEngineCore(orchestrator.ts:170)执行前 drain inbox 注入 prompt——这是把"消息→执行输入"接通的关键缺口(现状 worker 只收 wa.task 字符串):
   在组装 finalSystem 处(orchestrator.ts:189 附近，buildSystemPrompt 之后、injectedTask 之前)调 drainInbox(agent.id):取出并清空该 agent inbox，按 performative 渲染(inform→"同伴告知"、ask→"请回答以下问询"、share→artifact 摘要+可 readFile)，按 conversationId 收敛、限条数(≤5)+字数(≤MAX_TOTAL_INJECTION 同量级 2000 字符)拼进 injectedTask.goal 头部。注入内容计入 token(走同一 runEngineCore 记账漏斗)。

4) hook 注入(orchestrator.ts:505 setChannelRequestHandler 同区域)新增:
   - setChannelRequestHandler 改为接收 kind(默认 "peer-worker"，保持现有 emit lead-only 提示 + request 流不变)。
   - setA2ASendHandler((from,target,text,artifactId?) => { canCommunicate 校验；recordA2A(...); return 提示 })。
   - setShareHandler 类似(performative:"share")。
   - setDiscoverHandler((from,filter) => discoverAgents(filter) 的 JSON 文本)。
   - setAskHandler(async (from,target,question) => { canCommunicate；correlationId=`${runId}-q-${++querySeq}`；depth=父 query 深度+1，>2 直接返回截断；recordA2A(performative:"ask",to:[target],correlationId)；返回 new Promise，存 resolver 进 pendingQueries，setTimeout(taskTimeoutMs) reject→resolve("对方未及时回应") })。
   - ask 被投递后,orchestrator 在主循环检测 inbox 有 ask → 给 target 排一次轻量 runEngineCore(systemPrompt:"请仅回答以下问询") → 产出即 recordA2A(performative:"reply",correlationId) → deliverToInboxes 命中 pendingQueries → resolve。

5) 跨队 peer-worker/A2A 兜底(补 orchestrator.ts:734 之后):所有 lead 跑完后，CEO 扫剩余 runChannels.pendingRequests() 对跨队请求决策(现状注释说"待 CEO"但无代码)。简单策略:跨队 peer-worker 默认 grant 并记一条 CEO 协调消息(可加上限/白名单)。

6) discoverAgents(filter)(新函数，orchestrator.ts 内或新 directory.ts):对内存 agents 数组按 card.skills/role/produces 过滤，返回精简 {id,name,role,summary,skills}。

7) 记账/熔断不破:所有 A2A 触发的 run(ask 轻量 run、被 send/request 的处理)必须仍走 runEngineCore(累加 runTokens/runCost，受 maxTokensPerRun 熔断 orchestrator.ts:683)。ask 深度单独计数防吃满 MAX_TOOL_ROUNDS=5。

8) apiToolLoop.ts:把新工具(discover_agents/send_message/ask_agent/share_artifact/list_my_inbox)+ request_channel 的 kind 同步补进 TOOL_PARAM_SCHEMAS(line 6)，使 Hermes 文本路径 buildToolInstructions 有参数签名(现存缺口:line 47 只读静态表，request_channel 当前在 Hermes 下就缺签名)。

## 六、分阶段实施计划

### 阶段0 — 类型与 schema 地基(零行为变更)
- **改动**:在 types.ts 新增 Performative/A2APart/ArtifactRef/Artifact/AgentSkillDesc/AgentCapabilityCard，扩展 AgentMessage(全可选 A2A 字段)、AgentNodeConfig(加 card?)、ChannelKind(加 a2a)。在 schemas.ts 新增对应 zod schema(全 optional)并把 card 挂进 AgentNodeConfigSchema、新增 AgentMessageSchema 填补缺口。不改任何 runtime 逻辑。向后兼容:barrel export * 不变;旧 agents.json/旧消息合法。
- **文件**:packages/shared/src/types.ts, packages/shared/src/schemas.ts
- **验证**:pnpm -C packages/shared tsc --noEmit 通过;pnpm -C packages/shared vitest run(若有 schema 测试)通过;全仓 tsc 无新错误(可选字段不破现有消费方)。

### 阶段1 — A2ABus + ArtifactStore(纯内存部件，独立单测)
- **改动**:新建 apps/server/src/runtime/a2aBus.ts:class A2ABus { deliver(msg,recipients); drain(agentId); peek(agentId); pending() }(per-agent inbox Map) + class ArtifactStore { put(a):id; get(id); list() }(run 级)。不接线进 orchestrator。
- **文件**:apps/server/src/runtime/a2aBus.ts, apps/server/src/runtime/a2aBus.test.ts
- **验证**:新增 a2aBus.test.ts:deliver→drain 取出并清空、peek 不消费、pending 计数、ArtifactStore put/get 往返。pnpm -C apps/server vitest run a2aBus 通过;现有测试不受影响(新文件无接线)。

### 阶段2 — recordMessage 升级为投递点 + recordA2A(接线但工具未暴露)
- **改动**:orchestrator.ts 加 inbox/pendingQueries/artifactStore 单例 + startRun 重置;recordMessage 末尾加 deliverToInboxes(仅定向 audience 投递，canCommunicate 门控);新增 recordA2A(opts)。eventBus emit payload 加 performative/conversationId(仍不发 parts 全文)。暂不接 agent 工具。
- **文件**:apps/server/src/runtime/orchestrator.ts
- **验证**:pnpm -C apps/server vitest run channels visibility orchestratorParsing requestChannelTool 全绿(deliverToInboxes 对现有 audience=all/team/agents 消息行为:定向才投递，不影响 visibleMessagesFor 拉取与 visibility 测试)。新增 orchestrator 级单测:recordA2A to:[x] → inbox(x) 收到 & canCommunicate=false 时不投。tsc --noEmit 通过。

### 阶段3 — drain inbox 注入执行输入
- **改动**:runEngineCore 在 buildSystemPrompt 后注入 drainInbox(agent.id) 渲染结果到 injectedTask.goal 头部(限条数/字数、按 conversationId 收敛)。
- **文件**:apps/server/src/runtime/orchestrator.ts
- **验证**:新增单测:预置 inbox 一条 inform，跑 runEngineCore(可 mock engine)断言 task.goal 含注入文本且不超字数上限。现有 orchestrator.test.ts 全绿(无 inbox 时注入为空，行为不变)。tsc 通过。

### 阶段4 — agent 工具:discover/send/share + request_channel 放宽 kind
- **改动**:tools.ts 加 discover_agents/send_message/share_artifact(带 paramSchema)+ 三个 hook setter;request_channel 加可选 kind 透传，ChannelRequestHandler 签名加 kind?(默认 peer-worker)。apiToolLoop.ts TOOL_PARAM_SCHEMAS 补这些工具。orchestrator setChannelRequestHandler/setA2ASendHandler/setShareHandler/setDiscoverHandler 注入。
- **文件**:apps/server/src/runtime/tools.ts, apps/server/src/runtime/engines/apiToolLoop.ts, apps/server/src/runtime/orchestrator.ts
- **验证**:requestChannelTool.test.ts 全绿(默认 kind=peer-worker 断言不破)。新增 tools 测试:工具在 getActiveTools 清单、有/无 agentId 两路径、send_message 无通道返回提示。pnpm -C apps/server vitest run tools requestChannelTool 通过。tsc 通过。

### 阶段5 — ask_agent 双向问询(async hook + 防死锁)
- **改动**:新增 setAskHandler 返回 Promise<string>;tools.ts ask_agent execute await it。orchestrator setAskHandler + pendingQueries resolve(在 deliverToInboxes 命中 reply 时)+ 深度≤2 + setTimeout(taskTimeoutMs)+ 主循环检测 ask inbox 给 target 排轻量 reply run。
- **文件**:apps/server/src/runtime/tools.ts, apps/server/src/runtime/orchestrator.ts
- **验证**:新增单测:ask→reply resolve 返回答案;超时返回'未及时回应';深度>2 截断;A↔B 互问不死锁(环检测/超时)。pnpm -C apps/server vitest run a2a 通过。tsc 通过。手动跑一次小目标 startRun 确认不卡死。

### 阶段6 — Agent Card 发现 + 派生兜底 + Artifact 衔接(可选增强)
- **改动**:orchestrator initOrchestrator 加 card 派生兜底(缺省合成降级卡);discoverAgents 实现;worker 产出(orchestrator.ts:701-703)顺手 artifactStore.put(fileChanges/leadSummary)得 artifactId 供 share_artifact 引用。contextBuilder 若把 card 进 prompt 计入 MAX_TOTAL_INJECTION。
- **文件**:apps/server/src/runtime/orchestrator.ts, apps/server/src/runtime/contextBuilder.ts
- **验证**:新增单测:discover_agents 按 role/skill 过滤返回正确子集且 excludeSelf;无 card 节点合成降级卡不报错。现有 contextBuilder/orchestrator 测试全绿(card 缺省时零影响)。tsc 通过;全仓 pnpm vitest run 全绿。

## 七、保留项与迁移

保留项(零改/复用):
1) 两层 ACL 完整保留:visibility.ts(visibleTo/filterVisible/defaultAudienceFor/teamOf/isAncestorOf)纯函数零改，A2A 复用其解析收件人与可见性、保留 fail-closed(unknown audience deny)；ChannelRegistry(open/request/grant/deny/canCommunicate/between，channels.ts)零改，canCommunicate 作 A2A 准入门，幂等 open/复用语义不动。
2) request→grant 申请-审批授权链保留:worker request_channel→lead 批同队→跨队待 CEO(本期补 CEO 兜底，不改已有路径)。A2A 的 send/ask 仍须先有 open/active 通道(canCommunicate)才允许，不绕过审批。
3) CEO/Lead 中心编排主干不变(startRun:CEO 出 plan→lead 自拆→并行 worker→lead 评审≤2 轮→lead 综合最终交付物)。A2A 是叠加的横向能力，lead 综合仍是产出唯一汇聚点。
4) 记账熔断:runEngineCore 单一漏斗 + runTokens/runCost + maxTokensPerRun/PerTask 全保留，A2A 流量纳入同一刹车。worktree 隔离 + 质量门 + AsyncLocalStorage(rootStore/agentStore)并发安全模型不动。
5) eventBus 仅 UI 观测职责不变(反而修了定向消息正文不再经 SSE 广播的隐患)。
6) Python 系统(M:/OPC/agents/registry.yaml + engine/*.py)完全不碰。

向后兼容/迁移(不破现有测试):
- 全部新字段可选 + barrel export *:旧 agents.json 节点缺 card 靠 initOrchestrator 的 spread {framework,companyId,...a}(orchestrator.ts:138)兜底合成降级卡，零迁移。
- recordMessage 旧位置参数签名保留不动(8 处调用零改)，新能力走 recordA2A 重载。
- request_channel 默认 kind="peer-worker"——requestChannelTool.test.ts 第 13-29 用例断言 kind==="peer-worker"、无 agentId 拒绝、grant 后 canCommunicate 全部不破(afterEach 复位 hook 行为保留)。
- deliverToInboxes 只对定向 audience(agents:/role:/lead-only)投递，对 all/team 不点对点投递——channels.test.ts/visibility.test.ts/games.test.ts 断言的广播/隔离语义不受影响。
- 新行为一律加新测试文件(a2aBus.test.ts / a2a.test.ts)，不改已测纯函数(visibleTo/parseCeoPlan/parseReviewDecisions 等)签名。

## 八、风险

- 死锁:ask A→B→A 互等会吃满 MAX_TOOL_ROUNDS=5 卡死 run。必须 query 深度≤2 + 超时(复用 taskTimeoutMs)+ 环检测(B 对 A ask 时若 A 已阻塞于对 B 的 ask 直接拒)，三道闸缺一不可。
- Token 风暴:inbox 注入 + 同侪多轮 ask/share 线性放大每 agent prompt token，maxTokensPerRun 是 run 级总闸非 per-message 闸。须对 drainInbox 注入做条数(≤5)+字符(≤2000)上限，artifact 走 claim-check 引用而非内联全文。
- 投递风暴:若对 audience=team/all 也做点对点投递会 N² 爆炸。设计上严格限定只对定向 audience(agents:/role:/lead-only)真投递，广播仍走原 visibleMessagesFor 拉取——实现时必须守住这条边界。
- 可见性泄漏:若图省事让 A2A 复用 eventBus 投递，定向消息正文会经 /api/events SSE 漏给所有连接(现存已知隐患 + game/isolated 隔离被绕过)。A2ABus 必须与 eventBus 严格分离，SSE 只发 text 投影。另:断开 SSE 的 listener 未清理是已知泄漏，A2A 不应复用同一 listener 机制。
- Hermes 文本引擎一致性:buildToolInstructions(apiToolLoop.ts:44)只读静态 TOOL_PARAM_SCHEMAS(line 47)，新工具仅给 paramSchema 时文本提示缺参数签名(request_channel 当前已有此缺口)。必须同步补 TOOL_PARAM_SCHEMAS 条目，否则弱模型在 Hermes 下不会正确调用 A2A 工具。
- 并发多 run:inbox/pendingQueries/artifactStore/runMessages/runChannels 全是模块级单例 + 单 activeRunId，同进程并发多 run 会串消息。本设计维持单 run 假设;真要并发需整体收进 per-run context 对象(既有约束被新单例放大)。
- 误把 ask 当 handoff:模型可能用 ask 试图委派任务而非要信息。靠工具 description 明确语义边界(ask 不创建 Task、不转移所有权)，真委派仍走 lead request 派活。
- id 全局唯一性:ChannelRegistry.id/correlationId/artifactId 用 seq+runId 前6位，单进程单 run 够用，但任何跨 run/跨进程扩展不能依赖它做全局寻址。
- 过度设计风险:A2A 本为跨进程网络发现设计，套单机有 over-engineering(draco-eval/reports/a2a-synthesis.md 已指出)。故分阶段:先 capabilities+discover/send+inbox 投递(阶段0-4)，再 ask 双向(阶段5)，artifact/card 增强(阶段6)殿后;跨进程 framework='a2a' Engine 留作未来，本期不引入网络协议。
