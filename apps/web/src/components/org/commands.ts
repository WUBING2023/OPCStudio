import { Wrench, Repeat, Square, Activity, FileText, Coins, Brain, Store, HelpCircle, Sparkles, type LucideIcon } from "lucide-react";
import type { SkillMeta } from "@opc/shared";
import * as api from "../../api/client.js";
import { DEFAULT_COMPANY, type GoalRecord, type LoopRecord } from "./automationTypes.js";

// 命令注册表(Claude Code 式 "/" 命令面板的数据源)——BriefingPanel 输入框打 "/" 弹出的菜单、以及
// Enter 发送时的实际执行,都读这一份。加一条命令 = 加一个 COMMANDS 里的对象,不用改面板 UI 代码。
// run(args, ctx) 是唯一执行入口；ctx 是宿主(BriefingPanel)注入的最小能力集，命令本身不直接碰
// useTaskChat/useCockpitStore，只通过 ctx 出口，保持数据(本文件)与宿主(渲染/状态)解耦。

// 最小行状态——只取 /stop /report 判断"是否在跑/是否已完成"需要的三个字段，不借用
// BriefingPanel 里那份更丰富的 RunRow(同样的理由：各处按自己需要声明最小形状，见该处注释)。
interface RunStatusRow { id: string; status: string; companyId?: string; }

export interface CommandContext {
  activeCompanyId: string;
  workingCount: number;
  runningCount: number;
  /** POST /api/goals(默认轮次;按钮模式的轮次覆盖由 BriefingPanel 直接调同名宿主函数，不经过命令)。 */
  startGoal: (goal: string) => void | Promise<void>;
  /** POST /api/loops(默认轮次)。 */
  startLoop: (prompt: string) => void | Promise<void>;
  /** api.chatTask(task, {companyId, skills:[skill.id]})——"/" 面板选中技能或手打 /skill 附加技能后下发。 */
  sendSkillTask: (task: string, skill: { id: string; title: string }) => void | Promise<void>;
  /** 派发一个 window CustomEvent(跨页契约，如 open-task-run / opc-navigate)。 */
  dispatch: (event: string, detail?: Record<string, unknown>) => void;
  /** 简报流里插一条本地系统气泡。 */
  systemMessage: (text: string) => void;
  /** 一次性轻提示(不进消息流的短反馈，如"当前没有进行中的任务")。 */
  toast: (text: string) => void;
  tr: (key: string, params?: Record<string, string | number>) => string;
}

export interface Command {
  name: string;
  aliases?: string[];
  icon: LucideIcon;
  descKey: string;
  argsHintKey?: string;
  run: (args: string, ctx: CommandContext) => void | Promise<void>;
}

function sameCompany(companyId: string | undefined, ctx: CommandContext): boolean {
  return (companyId || DEFAULT_COMPANY) === ctx.activeCompanyId;
}

// ── 技能(GET /api/skills)────────────────────────────────────────────────────────
// "/" 面板技能分组 与 手打 "/skill" 命令共用同一份拉取:只取 enabled、≤20 个、5 分钟内存缓存
// (模块级变量,跨组件重挂载存活;面板与命令各自触发拉取时大概率命中同一份缓存,不重复打接口)。
let skillsCache: { data: SkillMeta[]; ts: number } | null = null;
const SKILLS_CACHE_MS = 5 * 60 * 1000;

export async function fetchEnabledSkills(): Promise<SkillMeta[]> {
  const now = Date.now();
  if (skillsCache && now - skillsCache.ts < SKILLS_CACHE_MS) return skillsCache.data;
  const all = await api.get<SkillMeta[]>("/skills");
  const data = all.filter(s => s.enabled).slice(0, 20);
  skillsCache = { data, ts: now };
  return data;
}

/** "/" 面板输入过滤:标题或 id 命中子串(标题多为自然语言短语,子串比 matchCommands 的前缀匹配更好用)。 */
export function matchSkills(query: string, skills: SkillMeta[]): SkillMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(s => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
}

// 标题匹配打分:精确 > 前缀 > 子串 > 子序列(字符按序出现,弱兜底,按覆盖率给低分)。
function scoreTitleMatch(query: string, title: string): number {
  const q = query.trim().toLowerCase();
  const t = title.trim().toLowerCase();
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++;
  return qi === q.length ? Math.round(30 * (q.length / t.length)) : 0;
}

export interface SkillMatchResult { skill?: SkillMeta; task: string; ambiguous: boolean; }

/** "/skill <名字> <任务>" 的切分:名字可能是多词标题,贪心尝试取前 1..min(6,词数-1) 个词当"名字"去
 *  匹配技能标题/id,全局最高分的切分胜出,剩余词即任务文本。并列最高分 → ambiguous=true(仍取第一个
 *  ——调用方据此在气泡里说明"已选最接近的")。args 不足两个词(凑不出"名字+任务")直接判无匹配。 */
export function matchSkillFromArgs(args: string, skills: SkillMeta[]): SkillMatchResult {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || skills.length === 0) return { task: "", ambiguous: false };
  const maxWindow = Math.min(6, words.length - 1);
  const candidates: { skill: SkillMeta; score: number; windowSize: number }[] = [];
  for (let w = 1; w <= maxWindow; w++) {
    const nameQuery = words.slice(0, w).join(" ");
    for (const skill of skills) {
      const score = Math.max(scoreTitleMatch(nameQuery, skill.title), scoreTitleMatch(nameQuery, skill.id));
      if (score > 0) candidates.push({ skill, score, windowSize: w });
    }
  }
  if (candidates.length === 0) return { task: "", ambiguous: false };
  candidates.sort((a, b) => b.score - a.score || b.windowSize - a.windowSize);
  const top = candidates[0];
  const tiedTop = candidates.some(c => c.score === top.score && c.skill.id !== top.skill.id);
  return { skill: top.skill, task: words.slice(top.windowSize).join(" "), ambiguous: tiedTop };
}

export const COMMANDS: Command[] = [
  {
    // 命令名改 "harness"(范式改造后的正名),"goal" 降级为别名保留旧肌肉记忆;手打快速起跑,
    // 不带 acceptanceCriteria/confirmEachRound(那是模式按钮 Harness 的 setup 区专属,见 BriefingPanel)。
    name: "harness", aliases: ["goal"], icon: Wrench, descKey: "org.brief.cmd.desc.goal", argsHintKey: "org.brief.cmd.args.goal",
    run: (args, ctx) => {
      if (!args.trim()) { ctx.toast(ctx.tr("org.brief.cmd.argsRequired")); return; }
      return ctx.startGoal(args.trim());
    },
  },
  {
    name: "loop", icon: Repeat, descKey: "org.brief.cmd.desc.loop", argsHintKey: "org.brief.cmd.args.loop",
    run: (args, ctx) => {
      if (!args.trim()) { ctx.toast(ctx.tr("org.brief.cmd.argsRequired")); return; }
      return ctx.startLoop(args.trim());
    },
  },
  {
    name: "skill", icon: Sparkles, descKey: "org.brief.cmd.desc.skill", argsHintKey: "org.brief.cmd.args.skill",
    // 手打版:"/skill <名字> <任务>"——名字模糊匹配技能标题/id(matchSkillFromArgs)。选中技能后直接
    // 打任务文本发送的路径不经这里，走 BriefingPanel 的 selectedSkill 状态，两条路都落到 ctx.sendSkillTask。
    run: async (args, ctx) => {
      if (!args.trim()) { ctx.toast(ctx.tr("org.brief.cmd.argsRequired")); return; }
      try {
        const skills = await fetchEnabledSkills();
        const { skill, task, ambiguous } = matchSkillFromArgs(args, skills);
        if (!skill || !task.trim()) { ctx.toast(ctx.tr("org.brief.cmd.skill.noMatch")); return; }
        if (ambiguous) ctx.systemMessage(ctx.tr("org.brief.cmd.skill.ambiguous", { title: skill.title }));
        await ctx.sendSkillTask(task, { id: skill.id, title: skill.title });
      } catch (e: any) {
        ctx.toast(ctx.tr("org.brief.automation.error", { message: e?.message ?? String(e) }));
      }
    },
  },
  {
    name: "stop", icon: Square, descKey: "org.brief.cmd.desc.stop",
    // 依次尝试:活动连续任务 → 活动目标 → 进行中的 run。三者互斥推进(串行纪律),命中第一个就停,
    // 都没有则 toast 如实告知，不静默。
    run: async (_args, ctx) => {
      try {
        // waiting_user(每轮确认门等待中)也算"活动中"——用户此时说 /stop 该拦得住,不能因为
        // 状态字段不是 "running" 就假装没有活动的循环/目标。
        const loopsResp = await api.get<{ inFlight: boolean; loops: LoopRecord[] }>("/loops");
        const loop = loopsResp.loops.find(l => (l.status === "running" || l.status === "waiting_user") && sameCompany(l.companyId, ctx));
        if (loop) { await api.post(`/loops/${loop.id}/stop`, {}); ctx.systemMessage(ctx.tr("org.brief.cmd.stop.stoppedLoop")); return; }

        const goalsResp = await api.get<{ inFlight: boolean; goals: GoalRecord[] }>("/goals");
        const goal = goalsResp.goals.find(g => (g.status === "running" || g.status === "waiting_user") && sameCompany(g.companyId, ctx));
        if (goal) { await api.post(`/goals/${goal.id}/stop`, {}); ctx.systemMessage(ctx.tr("org.brief.cmd.stop.stoppedGoal")); return; }

        const runs = await api.get<RunStatusRow[]>("/runs");
        const run = runs.find(r => r.status === "running" && sameCompany(r.companyId, ctx));
        if (run) { await api.post(`/runs/${run.id}/stop`, {}); ctx.systemMessage(ctx.tr("org.brief.cmd.stop.stoppedRun")); return; }

        ctx.toast(ctx.tr("org.brief.cmd.stop.none"));
      } catch (e: any) {
        ctx.toast(ctx.tr("org.brief.automation.error", { message: e?.message ?? String(e) }));
      }
    },
  },
  {
    name: "status", icon: Activity, descKey: "org.brief.cmd.desc.status",
    run: async (_args, ctx) => {
      let goalLine = ctx.tr("org.brief.cmd.status.noGoal");
      let loopLine = ctx.tr("org.brief.cmd.status.noLoop");
      try {
        const r = await api.get<{ inFlight: boolean; goals: GoalRecord[] }>("/goals");
        const g = r.goals.find(x => (x.status === "running" || x.status === "waiting_user") && sameCompany(x.companyId, ctx));
        if (g) goalLine = ctx.tr("org.brief.cmd.status.goal", { n: Math.min(g.rounds.length + 1, g.maxRounds), m: g.maxRounds });
      } catch { /* best-effort */ }
      try {
        const r = await api.get<{ inFlight: boolean; loops: LoopRecord[] }>("/loops");
        const l = r.loops.find(x => (x.status === "running" || x.status === "waiting_user") && sameCompany(x.companyId, ctx));
        if (l) loopLine = ctx.tr("org.brief.cmd.status.loop", { n: Math.min(l.rounds.length + 1, l.maxRuns), m: l.maxRuns });
      } catch { /* best-effort */ }
      const lines = [
        `- ${ctx.tr("org.brief.cmd.status.working", { n: ctx.workingCount })}`,
        `- ${ctx.tr("org.brief.cmd.status.running", { n: ctx.runningCount })}`,
        `- ${goalLine}`,
        `- ${loopLine}`,
      ];
      ctx.systemMessage(lines.join("\n"));
    },
  },
  {
    name: "report", icon: FileText, descKey: "org.brief.cmd.desc.report",
    run: async (_args, ctx) => {
      try {
        const runs = await api.get<RunStatusRow[]>("/runs");
        const done = runs.find(r => r.status === "done" && sameCompany(r.companyId, ctx));
        if (!done) { ctx.toast(ctx.tr("org.brief.cmd.report.none")); return; }
        ctx.dispatch("open-task-run", { runId: done.id });
      } catch (e: any) {
        ctx.toast(ctx.tr("org.brief.automation.error", { message: e?.message ?? String(e) }));
      }
    },
  },
  // 跨页导航三连——contract: window "opc-navigate" {page[,tab]}，App.tsx 已挂监听(白名单校验后 setPage)。
  // cost 现在是"能力"页内部 tab,不再是顶级 page(C4:主导航 9→7)。
  { name: "cost", icon: Coins, descKey: "org.brief.cmd.desc.cost", run: (_args, ctx) => ctx.dispatch("opc-navigate", { page: "capability", tab: "cost" }) },
  { name: "memory", icon: Brain, descKey: "org.brief.cmd.desc.memory", run: (_args, ctx) => ctx.dispatch("opc-navigate", { page: "memory" }) },
  { name: "templates", icon: Store, descKey: "org.brief.cmd.desc.templates", run: (_args, ctx) => ctx.dispatch("opc-navigate", { page: "community" }) },
  {
    name: "help", icon: HelpCircle, descKey: "org.brief.cmd.desc.help",
    run: (_args, ctx) => {
      const lines = COMMANDS.map(c => `- **/${c.name}** — ${ctx.tr(c.descKey)}`);
      lines.push(`- ${ctx.tr("org.brief.cmd.help.skillUsage")}`);
      ctx.systemMessage(`${ctx.tr("org.brief.cmd.help.title")}\n${lines.join("\n")}`);
    },
  },
];

/** 是否仍在"输入命令名"阶段(名字后还没打空格)——popup 只在这个阶段显示；一旦打了空格，视为
 *  "命令已选定，后面是参数"，popup 收起，Enter 交给 parseSlash 真正执行。 */
export function isComposingSlash(text: string): boolean {
  if (!text.startsWith("/")) return false;
  return !/\s/.test(text.slice(1));
}

/** "/" 之后、尚未出现空白前的那段文字——喂给 matchCommands 做前缀过滤。 */
export function slashQuery(text: string): string {
  return text.startsWith("/") ? text.slice(1) : "";
}

export interface ParsedSlash { name: string; args: string; }

/** 发送时解析:text 以 "/" 开头才返回非 null；name 小写，args 是命令名后剩余文字(已 trim)。 */
export function parseSlash(text: string): ParsedSlash | null {
  if (!text.startsWith("/")) return null;
  const m = text.slice(1).match(/^(\S*)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

export function matchCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return COMMANDS.filter(c => c.name.startsWith(q) || (c.aliases ?? []).some(a => a.startsWith(q)));
}

export function findCommand(name: string): Command | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find(c => c.name === n || (c.aliases ?? []).includes(n));
}
