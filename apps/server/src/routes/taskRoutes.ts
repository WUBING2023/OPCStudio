import type { Express } from "express";
import type { AgentNodeConfig, Company } from "@opc/shared";
import { getAgents } from "../runtime/orchestrator.js";
import { getCompany } from "../storage/companyStore.js";
import { type ChatMessage } from "../runtime/modelGateway.js";
import { invokeAgentModel } from "../runtime/systemModelInvoke.js";
import { resolveDecomposer, parseDecomposeReply, type Decomposer } from "../runtime/taskDecomposer.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { stripDirectAnswerHeader } from "../runtime/outputSanitizer.js";

const ORIGINAL_TASK_SENTINEL = "__USE_ORIGINAL_USER_MESSAGE__";

// 日常任务对话的"执行模式"三段式,stage①②(2026-07 新增,从架构助手挪出的决策拆解骨架首次落地
// 到一个新场景):①用户一句话描述日常工作需求 → ②该公司 Leader(没有则 CEO 兜底)判断是否存在
// 真正需要用户决定的分歧点:有就出选择题确认,没有就直接给出一段可以交给团队执行的最终任务描述。
// 这一步纯只读,不派发任何任务、不判断/不阻断 run 在跑与否。
//
// stage③(用户确认后真正派发)不在这里——直接复用已有的 POST /api/chat/task(chatRoutes.ts,内部
// 调 startRun),前端拿到 finalTask 文本后直接调那个端点,不新建一套派发逻辑。
export function register(app: Express, projectRoot: string) {
  function mapHistory(history: unknown): ChatMessage[] {
    if (!Array.isArray(history)) return [];
    return history
      .filter((h: unknown): h is { role: unknown; content: unknown } => !!h && typeof (h as any).content === "string")
      .slice(-20)
      .map((h: { role: unknown; content: unknown }) => ({
        role: h.role === "assistant" ? "assistant" : "user",
        content: String(h.content).slice(0, 4000),
      }));
  }

  // 拼给模型看的真实团队语境——只列成员/角色,不像架构对话那样带验证关系/A2A 通道(拆解日常任务不
  // 需要那么细的组织结构细节)。
  function buildTaskContext(company: Company, roster: AgentNodeConfig[]): string {
    const lines = roster.map(a => `- ${a.name}(角色:${a.role}${a.enabled === false ? "·已停用" : ""})`);
    return `## 团队(公司:${company.name})\n${lines.join("\n") || "(暂无成员)"}`;
  }

  function buildTaskDecomposeSystemPrompt(decomposer: Decomposer): string {
    const roleLabel = decomposer.role === "lead" ? "Leader" : "CEO";
    const fallbackNote = decomposer.fallbackToCeo ? "(这家公司目前没有配置 Leader,由 CEO 兜底负责这次拆解)" : "";
    return `你现在负责把用户一句话描述的日常工作需求,拆解成一份清晰、可以直接交给团队执行的任务说明。这个需求由这家公司的 ${roleLabel}「${decomposer.agent.name}」${fallbackNote}负责拆解。

你每次回复必须是且只是一个 JSON 对象(不要 markdown 代码块、不要代码块之外的任何文字),严格按下面两种情况二选一:

情况 A——这个需求存在真正需要用户决定的关键分歧点(比如范围边界、优先级、具体产出形式,这类"选哪个都合理但结果不同"的点):不要自己替用户拍板,输出:
{"summary": "你理解的需求概要(一两句话)", "needsChoice": true, "questions": [{"question": "问题文本", "options": ["A. 选项一", "B. 选项二", "C. 选项三"]}], "finalTask": ""}
questions 最多 3 条,每条 options 给 2-4 个、每个都已经写成"A. ……"这种可以直接展示的完整句子。

情况 B——需求已经足够明确,没有真正需要用户决定的分歧点(包括:这是你已经问过澄清问题、用户已经在对话历史里给出回答的这一轮):直接给出最终任务说明:
{"summary": "你打算怎么做、为什么这么做(一两句话)", "needsChoice": false, "questions": [], "finalTask": "一段完整、具体、可以直接交给团队执行的任务描述,包含关键细节和约束"}

硬规则:所有字符串值内部禁止出现英文双引号 " (会破坏 JSON 解析);需要引用或强调某个词时,一律改用中文书名号「」包裹。

不要为了"走流程"而在需求已经明确时硬凑一个没有意义的选择题;也不要在用户已经回答过你的问题后,还拿同一个问题反复追问用户。`;
  }

  app.post("/api/companies/:id/task-decompose", async (req, res) => {
    try {
      const companyId = req.params.id;
      const company = getCompany(projectRoot, companyId);
      if (!company) return res.status(404).json({ error: "company not found" });

      const { message, history } = req.body ?? {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message required" });
      }
      const integrity = checkTextIntegrity(message);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });

      const roster = getAgents().filter(a => (a.companyId || "default") === companyId);
      const decomposer = resolveDecomposer(roster);
      if (!decomposer) return res.status(400).json({ error: "这家公司还没有 Leader 或 CEO,无法拆解任务" });

      const system = `${buildTaskDecomposeSystemPrompt(decomposer)}\n\n${buildTaskContext(company, roster)}\n\n若用户原始需求已经完整且无需改写,不要在 finalTask 中复制整段需求;请返回 finalTask: "${ORIGINAL_TASK_SENTINEL}",服务端会无损使用原始任务文本。`;
      const messages: ChatMessage[] = [...mapHistory(history), { role: "user", content: message.trim().slice(0, 4000) }];

      // 用该真实 decomposer(Leader,没有则 CEO 兜底)自己配置的 provider/model 推理,而不是项目级
      // 「系统模型」——和架构对话当初的用户纠正同一个道理:拆解的推理本身也该是这个人自己的能力在做。
      const invokeDecomposer = (prompt: string, maxTokens: number) => invokeAgentModel(projectRoot, decomposer.agent, {
        agentId: decomposer.agent.id, system: prompt, messages, maxTokens, agentRole: decomposer.agent.role,
      });
      const parseReply = (rawReply: string) => parseDecomposeReply<string>(
        rawReply,
        p => {
          if (p?.finalTask === ORIGINAL_TASK_SENTINEL) return message.trim().slice(0, 4000);
          return typeof p?.finalTask === "string" ? p.finalTask.trim().slice(0, 4000) : "";
        },
        "",
      );

      let record = await invokeDecomposer(system, 3200);
      let raw = stripDirectAnswerHeader(record.content ?? "");
      let parsed;
      try {
        parsed = parseReply(raw);
      } catch (firstError: any) {
        // Complex, already-specific requests can make a model waste its entire completion by
        // echoing the task inside JSON. Retry once with a compact protocol; the sentinel keeps
        // the user's exact contract instead of accepting a truncated paraphrase.
        const compactSystem = `${system}\n\n上一次结构化输出无效或被截断。只返回紧凑 JSON：如果确需用户选择,给最多 3 个短问题；否则 finalTask 必须精确写成 "${ORIGINAL_TASK_SENTINEL}"。不要复述原始任务。`;
        record = await invokeDecomposer(compactSystem, 1200);
        raw = stripDirectAnswerHeader(record.content ?? "");
        try {
          parsed = parseReply(raw);
        } catch (retryError: any) {
          return res.status(400).json({ error: retryError.message || firstError.message || "任务拆解失败", raw: raw.slice(0, 400) });
        }
      }
      // 情况 B(needsChoice=false)理应给出非空的最终任务描述——和架构场景不同,"什么都不用做"不是
      // 日常任务拆解的合法结果,模型没给出来就是没拆解成,诚实报错而不是让用户拿着一段空文本去派发。
      if (!parsed.needsChoice && !parsed.result.trim()) {
        return res.status(400).json({ error: "任务拆解输出缺少 finalTask", raw: raw.slice(0, 400) });
      }

      res.json({
        summary: parsed.summary, needsChoice: parsed.needsChoice, questions: parsed.questions,
        finalTask: parsed.result,
        decomposer: { agentId: decomposer.agent.id, name: decomposer.agent.name, role: decomposer.role, fallbackToCeo: decomposer.fallbackToCeo },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "task decompose failed" });
    }
  });
}
