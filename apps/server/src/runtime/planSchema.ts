import { z } from "zod";
import type { TaskGraphProposal } from "@opc/shared";

// Structured CEO plan (replaces fragile Markdown regex as the primary parse path).
export const WorkerAssignmentSchema = z.object({
  workerId: z.string(),
  task: z.string().min(1),
});
export const LeadAssignmentSchema = z.object({
  leadId: z.string(),
  task: z.string().min(1),
  // P2: CEO 只给团队级目标，不再分配 worker。workers 可空（默认 []）——由 Lead 自行拆解派发。
  // 若 CEO 仍点了 worker（旧格式/碰巧），保留作为 Lead 自拆失败时的兜底。
  workers: z.array(WorkerAssignmentSchema).default([]),
});
export const CeoPlanSchema = z.object({
  plan: z.string().default(""),
  leads: z.array(LeadAssignmentSchema).min(1),
  summary: z.string().default(""),
});
export type CeoPlan = z.infer<typeof CeoPlanSchema>;

// Parse a CEO response into a structured plan: strip an optional ```json fence, then validate.
// Returns null on any failure so the orchestrator can fall back (Markdown regex → keyword).
export function parseCeoPlanJson(text: string): CeoPlan | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  // also try the first {...} block as a fallback (model omitted the fence)
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed = CeoPlanSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch { /* try next candidate */ }
  }
  return null;
}

// —— A2 · Task Graph 提案(指南 9.2 JSON 形状,snake_case 保持模型输出原貌)——
export const TaskGraphProposalTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().optional(),
  assigned_role: z.string().optional(),
  assigned_agent_id: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  expected_artifacts: z.array(z.string()).optional(),
  // A3:kind 省略 = "work";kind="review" 时 review_of 必须能解析到本提案内的另一个任务(校验在 taskGraphScheduler)。
  kind: z.enum(["work", "review"]).optional(),
  review_of: z.string().optional(),
});
export const TaskGraphProposalSchema = z.object({
  proposal_type: z.string().optional(),
  mission_summary: z.string().default(""),
  tasks: z.array(TaskGraphProposalTaskSchema).min(1),
});

export const ReviewNodeProposalSchema = z.object({
  schema_version: z.literal("1"),
  verdict: z.enum(["accepted", "needs_revision"]),
  reason: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).optional(),
  evidence_refs: z.array(z.string().min(1).max(500)).max(50).default([]),
}).strict();
export type ReviewNodeProposal = z.infer<typeof ReviewNodeProposalSchema>;

export function parseReviewNodeProposal(text: string): ReviewNodeProposal | null {
  if (!text?.trim()) return null;
  const candidates: string[] = [];
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (let index = candidates.length - 1; index >= 0; index--) {
    try {
      const parsed = ReviewNodeProposalSchema.safeParse(JSON.parse(candidates[index]));
      if (parsed.success) return parsed.data;
    } catch { /* try the preceding structured candidate */ }
  }
  return null;
}

// 容错解析 CEO 的 task_graph_proposal:```json 块优先,退化到首个 {...};JSON.parse → zod。
// 失败返回 { proposal: null, reason },不抛错 —— 调用方(approve 路由)转 422 并附原因。
export function parseTaskGraphProposal(text: string): { proposal: TaskGraphProposal | null; reason?: string } {
  if (!text || !text.trim()) return { proposal: null, reason: "输出为空" };
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  if (!candidates.length) return { proposal: null, reason: `未找到 JSON 块:${text.slice(0, 200)}` };
  let lastReason = "";
  for (const c of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(c);
    } catch (e: any) {
      lastReason = `JSON 解析失败:${String(e?.message ?? e).slice(0, 120)}`;
      continue;
    }
    const parsed = TaskGraphProposalSchema.safeParse(raw);
    if (parsed.success) return { proposal: parsed.data as TaskGraphProposal };
    lastReason = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 300);
  }
  return { proposal: null, reason: lastReason || "解析失败" };
}
