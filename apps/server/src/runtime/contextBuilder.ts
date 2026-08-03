import type { AgentNodeConfig } from "@opc/shared";
import { normalizeCompanyId } from "@opc/shared";
import { listSkills, getSkill } from "../storage/skillStore.js";
import { isBundledSkillOwnedByCompany } from "./install.js";
import { loadInstallTransactions } from "../storage/installTransactionStore.js";
import { getCompany } from "../storage/companyStore.js";
import { a2aPromptNote } from "./a2aSdk.js";
import { buildMemoryPack, type MemoryPackResult, type InjectedMemoryRef } from "./memoryPack.js";
import { buildProgressiveMemoryIndexContext, freezeAgentContext, restoreCachedPrompt } from "./contextBroker.js";

export interface InjectionContext {
  projectRoot: string;
  runId: string;
  injectedSkillIds: string[];
  injectedMemoryIds: string[];
  // 注入即引用(诚实版):每注入一条记忆就登记一条 {id, kind, title};citeMemories 从此清单派生 UI 引用,
  // 保证"依据经验《X》"里的 X 真的进了 prompt(见 memoryPack.citeMemories)。加性可选字段,未赋值时按空处理。
  injectedMemories?: InjectedMemoryRef[];
  // Memory Pack(统一投影,加性字段——不参与实际注入文本,只记录"这轮聚合视图里有什么可审计",供
  // orchestrator 存进 run 数据 / Run Story 展示。未赋值时消费方按"该次未产出"处理,不破坏既有调用点。
  memoryPack?: MemoryPackResult;
  // C1:bundled 技能因公司归属未决(legacy 且 install tx 已滚出上限、manifestTemplateId 前缀也不匹配)
  // 而被排除注入的 id——"residual 停注入不静默"的落点。加性可选审计字段,未赋值时按空处理。
  excludedBundledSkillIds?: string[];
}

// Hard caps to keep weak models from being dragged off-task / inflating cost by an over-long prompt.
const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 500;
const MAX_LAYERED_MEMORY_CHARS = 600;
const MAX_TOTAL_INJECTION = 2000;

// 效率闸 · 记忆注入全局上限:各段已有独立字符预算,但它们的**总和**仍可能把 ~十几条/数千字记忆反复灌进
// 每次 prompt(用户"46 条记忆反复进 prompt"的对治)。这里再加一道跨段的全局闸——单次注入的记忆【总条数】
// 与【总字符】封顶;各段按既有优先级顺序(历史经验→md→失败教训→结论→推荐工作流→已审批经验)先到先得地
// 消耗该全局预算,超限即停止后续记忆注入(=按相关性/优先级截断,保留最相关的靠前段)。默认生效;
// env(OPC_MAX_MEM_ITEMS / OPC_MAX_MEM_CHARS)可在调用时放宽为高级模式(在 buildSystemPrompt 内按次读取)。
// export:供效率治理测试(contextBuilder.memoryBudget.test.ts)对着真实 buildSystemPrompt 断言"注入不超预算"。
export const MAX_INJECTED_MEMORY_ITEMS = 20;
export const MAX_INJECTED_MEMORY_CHARS = 8000;

// P3: 统一的"工作方式"提示——让每个节点都先思考、再主动用自己的工具/Skill/MCP 去拿事实并完成工作，
// 而不是凭空臆测。对所有 agent(CEO/Lead/worker)生效；很短(不挤占 skill/memory 注入预算)；
// bare 变体(injectionEnabled=false)走早返回不受影响。
const THINKING_NUDGE =
  "\n\n## 工作方式\n" +
  "- 先思考再动手：拆解问题、想清楚关键步骤和未知项，再执行。\n" +
  "- 主动使用你可用的工具 / Skill / MCP(文件读写、网页抓取与搜索、记忆、Git 等)去核实事实、获取最新信息并真正完成工作，不要凭记忆臆测。\n" +
  "- 用工具核实关键信息后再下结论；产出要具体、可执行、可验证。\n" +
  "- A2A 协作:若你**缺少同事(其他 worker)的信息**或被卡住,不要瞎猜——在产出里**明确写一行** `需要协作: <向哪个角色/谁> — <你具体需要什么>`,交给团队负责人(lead)协调补齐后再继续。";

// Global injection switch (R2 fallback + benchmark "bare" variant). When off, buildSystemPrompt
// returns the base role prompt unchanged (no skills/memory) — equivalent to pre-Phase-4 behavior.
// A/B 实验开关:OPC_MEMORY_INJECTION=off → 启动即关闭全部记忆/技能注入(bare 臂),零新增 API 面。
let injectionEnabled = process.env.OPC_MEMORY_INJECTION !== "off";
export function setInjectionEnabled(on: boolean): void { injectionEnabled = on; }
export function isInjectionEnabled(): boolean { return injectionEnabled; }

// "/" 命令面板点技能 → 本次 run 对全员强制注入该技能(无视角色过滤;仍占注入预算)。
// startRun 开始时设置、finally 清空;按 id 或标题(忽略大小写)匹配。
let forceSkillNames: string[] = [];
export function setForceSkills(names: string[]): void { forceSkillNames = names.map(n => n.toLowerCase()); }

// Assemble the final system prompt: role prompt + enabled skills (role-filtered) + retrieved
// memories. Records injected ids into `out` (for trace assertions). Injection is additive — with
// no skills/memories it returns the base role prompt unchanged.
export function buildSystemPrompt(
  agent: AgentNodeConfig,
  baseRolePrompt: string,
  goal: string,
  projectRoot: string,
  out: InjectionContext,
): string {
  if (!injectionEnabled) return baseRolePrompt; // bare variant / kill-switch
  const cached = restoreCachedPrompt(projectRoot, out.runId, agent, goal, baseRolePrompt, out);
  if (cached) return cached;
  let injectionBudget = MAX_TOTAL_INJECTION;
  // 令二.3 · 注入检索的公司作用域统一归一化(缺省=DEFAULT_COMPANY_ID):无公司归属的 agent 也只检索
  // "default" 公司记忆,不再落回"无隔离"看全部(legacy 无归属条目对任何公司不注入,由各检索函数保证)。
  const companyId = normalizeCompanyId(agent.companyId);
  const leadId = agent.role === "lead" ? agent.id : agent.parentId;
  const progressive = buildProgressiveMemoryIndexContext(projectRoot, agent, goal, out.runId);

  // 注入即引用(诚实版):每登记一条真正拼进 prompt 的记忆——id 进 injectedMemoryIds(既有事件/派生),
  // {id,kind,title} 进 injectedMemories(citeMemories 的唯一引用来源)。二者由此一处同步,不再分叉。
  const register = (id: string, kind: string, text: unknown): void => {
    if (!id) return;
    out.injectedMemoryIds.push(id);
    (out.injectedMemories ??= []).push({ id, kind, title: String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 80) });
  };

  // 效率闸 · 记忆注入全局预算(跨所有记忆段共享):每段在真正拼进 prompt 前调 memGate(本条字符数),
  // 返回 false 说明已达全局条数/字符上限——该段停止注入更多记忆(break),后续段亦自然让位。先到先得 =
  // 靠前(更相关/更基础)的段优先占用预算,尾部低价值段在压力下被截断。技能(§1)不属"记忆",不计入此闸。
  let injectedMemItems = 0;
  let injectedMemChars = 0;
  const maxMemItems = Number(process.env.OPC_MAX_MEM_ITEMS) || MAX_INJECTED_MEMORY_ITEMS; // 按次读 env → 高级模式放宽 + 可测
  const maxMemChars = Number(process.env.OPC_MAX_MEM_CHARS) || MAX_INJECTED_MEMORY_CHARS;
  const memGate = (len: number): boolean => {
    if (injectedMemItems >= maxMemItems) return false;
    if (injectedMemChars + len > maxMemChars) return false;
    injectedMemItems++;
    injectedMemChars += len;
    return true;
  };

  // 1) Enabled skills for this role (or wildcard);"/" 面板强制指定的技能排最前(无视角色)。
  // origin:"memory" 技能(旧 C 层 skillEvolution.ts 沉淀的 workflow-<role>-<goal>)不参与注入——
  // C 层已砍掉,不再有新的 memory 来源技能;这里的过滤是防御性的(万一有历史遗留或未来别的路径又
  // 写出 origin:memory 的技能,也不会混进"已学得的 Skill"这段,与用户自建/人设/打包技能抢名额)。
  // C1:bundled 技能按公司归属过滤——堵"任意公司装的 bundled skill 注入所有公司同 role agent"的泄漏。
  // origin!=="bundled" 行为完全不变;归属判定抽在 install.isBundledSkillOwnedByCompany(纯函数,可单测)。
  // tx/company 读盘只在确有 bundled 技能时发生(常规公司无 bundled 技能则零额外读盘)。
  const rawMetas = listSkills(projectRoot).filter((s) =>
    s.enabled && (s.origin ?? "user") !== "memory" && (s.origin ?? "user") !== "persona"
  );
  const hasBundled = rawMetas.some((s) => (s.origin ?? "user") === "bundled");
  const bundledTxs = hasBundled ? loadInstallTransactions(projectRoot) : [];
  const agentCompany = hasBundled && agent.companyId ? getCompany(projectRoot, agent.companyId) : undefined;
  const allMetas = rawMetas.filter((s) => {
    if ((s.origin ?? "user") !== "bundled") return true;
    if (isBundledSkillOwnedByCompany(s, agent.companyId, bundledTxs, agentCompany)) return true;
    if (!s.companyId) (out.excludedBundledSkillIds ??= []).push(s.id); // residual,如实登记不静默
    return false;
  });
  const forced = forceSkillNames.length
    ? allMetas.filter((s) => forceSkillNames.includes(s.id.toLowerCase()) || forceSkillNames.includes(s.title.toLowerCase()))
    : [];
  const roleMatched = allMetas.filter((s) => (s.role === agent.role || s.role === "*") && !forced.some(f => f.id === s.id));
  const skillMetas = [...forced, ...roleMatched].slice(0, Math.max(MAX_SKILLS, forced.length));
  const skillBlocks: string[] = [];
  for (const meta of skillMetas) {
    const skill = getSkill(projectRoot, meta.id);
    if (!skill) continue;
    const body = skill.content.slice(0, MAX_SKILL_CHARS);
    if (body.length > injectionBudget) break;
    skillBlocks.push(`### ${skill.title}\n${body}`);
    out.injectedSkillIds.push(skill.id);
    injectionBudget -= body.length;
  }

  // 2) Progressive disclosure: preload bounded structural batches and inject
  // only the selected detail records. MEMORY.md remains a navigation index.
  let prompt = baseRolePrompt;
  const deferredMemorySections: string[] = [];
  if (progressive.text) prompt += `\n\n${progressive.text}`;
  if (skillBlocks.length) prompt += `\n\n## Selected Skills\n${skillBlocks.join("\n\n")}`;

  if (progressive.selectedMemories.length > 0) {
    const picked: string[] = [];
    for (const memory of progressive.selectedMemories) {
      const content = memory.content.replace(/\s+/g, " ").trim().slice(0, MAX_LAYERED_MEMORY_CHARS);
      const location = memory.scope
        ? `${memory.scope}/${memory.id}`
        : `${memory.source}/${memory.id}`;
      const line = `- [${location}] ${memory.title}: ${content}`;
      // The memory budget measures retrieved knowledge, not deterministic
      // provenance labels added by the renderer.
      if (!memGate(content.length)) break;
      picked.push(line);
      register(memory.id, memory.kind, memory.title);
    }
    if (picked.length) {
      const heading = progressive.retrievalMode === "legacy_fallback"
        ? "## Legacy memory compatibility fallback"
        : "## Retrieved approved memories";
      deferredMemorySections.push(`${heading}\n${picked.join("\n")}`);
    }
  }
  // The selected detail records above replace their navigation-only MEMORY.md
  // summaries. Do not inject both forms, otherwise one memory appears twice.
  if (deferredMemorySections.length) prompt += `\n\n${deferredMemorySections.join("\n\n")}`;

  prompt += THINKING_NUDGE; // P3: 每个节点都"先思考、再用工具/Skill/MCP"
  prompt += a2aPromptNote(); // Phase 4: A2A code SDK 使用说明(SDK 未就绪时为空串)

  // Memory Pack · 统一投影(顺手记录,不改变上面任何注入文本/顺序/截断逻辑,零行为回归风险):
  // 把 6 套记忆子系统的检索结果聚合成带 provenance 的可审计视图,挂到 out.memoryPack 供
  // orchestrator 存进 run 数据 / Run Story 展示"这轮用了哪些记忆、为什么选中"。best-effort。
  try {
    out.memoryPack = buildMemoryPack(projectRoot, { goal, companyId, teamId: leadId, agentId: agent.id, role: agent.role });
  } catch { /* best-effort: memoryPack 聚合失败绝不影响已生成的 prompt */ }

  freezeAgentContext(projectRoot, out.runId, agent, goal, baseRolePrompt, prompt, out, progressive);

  return prompt;
}
