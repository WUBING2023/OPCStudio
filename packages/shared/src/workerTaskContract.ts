// B3 · opc-worker CLI 的 task.json 输入契约(zod)。
// 与 run 目录内同名的 task.json(Run 实体快照,由 storage/projectStore.ts 的
// createRun/saveRunTask 写出,HTTP 路径和 CLI 路径共用同一份 writer)语义完全不同——
// 这里校验的是外部调用方通过 `opc-worker run --task <file>` 传入的**执行请求**。
// CEO/Lead/Worker/Reviewer 四种角色共用同一份契约结构:区别只在 agentId/role 解析出
// 哪个 agent、以及 systemPrompt 用哪个角色的 prompt,契约本身不因角色分叉出不同 schema。
import { z } from "zod";

export const WorkerTaskContractSchema = z
  .object({
    taskId: z.string().min(1, "taskId 不能为空"),
    goal: z.string().min(1, "goal 不能为空"),
    // 优先按 agentId 精确解析;缺省时按 role(+可选 companyId 限定范围)在 .opc/agents.json
    // 里找第一个匹配的已启用 agent。两者至少给一个,否则无法确定由谁执行。
    agentId: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    companyId: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
    // 缺省时 Runner 会新生成一个(crypto.randomUUID())。
    runId: z.string().min(1).optional(),
  })
  .refine((v) => !!v.agentId || !!v.role, {
    message: "task.json 必须提供 agentId 或 role 中至少一个,用于解析执行者",
    path: ["agentId"],
  });

export type WorkerTaskContract = z.infer<typeof WorkerTaskContractSchema>;
