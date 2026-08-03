import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskComplexityEstimate } from "@opc/shared";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { invokeSystemModel } from "./systemModelInvoke.js";
import { getAgents } from "./orchestrator.js";
import { loadCompanies } from "../storage/companyStore.js";

// Mission Brief:用户一句模糊 idea → 便宜模型展开成结构化简报(目标/成功标准/风险/建议执行方式),
// 用户在 Plan 阶段可编辑,approve 后才真正调度执行(quick run / team run / harness goal)。
// 存储写法与 goalRunner.ts 的 loadGoals/saveGoals 同款:.opc/missions.json 数组,上限 100 条。

export type RequiredDepartment = "research" | "product" | "launch";
export type SuggestedRunType = "quick" | "team";
export type SuggestedTeamMode = "economy" | "balanced" | "maxQuality";
export type PermissionNeeds = "no_code" | "propose_only" | "write_code" | "external_actions";
export type ApprovalStatus = "draft" | "approved" | "stopped";

export interface MissionBrief {
  id: string;
  companyId?: string;
  createdAt: string;
  originalIdea: string;
  interpretedGoal: string;
  targetUser?: string;
  problemStatement?: string;
  proposedDirection?: string;
  successCriteria: string[];
  nonGoals: string[];
  assumptions: string[];
  risks: string[];
  requiredDepartments: RequiredDepartment[];
  expectedArtifacts: string[];
  suggestedRunType: SuggestedRunType;
  suggestedTeamMode?: SuggestedTeamMode;
  permissionNeeds: PermissionNeeds;
  approvalStatus: ApprovalStatus;
  /** E1 复杂度预估快照:创建时算一次,approve 派发前重算(goal 可能被 PATCH 过);旧 mission 无此字段 */
  complexityEstimate?: TaskComplexityEstimate;
}

const missionsPath = (root: string) => path.join(root, ".opc", "missions.json");

export function loadMissions(root: string): MissionBrief[] {
  return readJSON<MissionBrief[]>(missionsPath(root), []);
}

export function saveMissions(root: string, missions: MissionBrief[]) {
  writeJSON(missionsPath(root), missions);
}

export function upsertMission(root: string, rec: MissionBrief): MissionBrief {
  const all = loadMissions(root);
  const i = all.findIndex(m => m.id === rec.id);
  if (i >= 0) all[i] = rec; else all.unshift(rec);
  saveMissions(root, all.slice(0, 100));
  return rec;
}

export function getMission(root: string, id: string): MissionBrief | undefined {
  return loadMissions(root).find(m => m.id === id);
}

const REQUIRED_DEPARTMENTS: RequiredDepartment[] = ["research", "product", "launch"];
const PERMISSION_LEVELS: PermissionNeeds[] = ["no_code", "propose_only", "write_code", "external_actions"];
const TEAM_MODES: SuggestedTeamMode[] = ["economy", "balanced", "maxQuality"];

function toStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim().slice(0, 300)).slice(0, max);
}

// 模型输出的健壮性解析:与 /api/clarify 同一套姿势——正则找 JSON 片段,解析失败直接报错(带原文),
// 不编造兜底数据。调用方(路由)负责把 Error 转成 400 + raw。
export function parseMissionBriefLLMOutput(raw: string, originalIdea: string): Omit<MissionBrief, "id" | "createdAt" | "companyId" | "approvalStatus"> {
  const cleaned = raw.replace(/^\s*DIRECT_ANSWER:\s*/, "");
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Mission Brief 输出无法解析为 JSON:${cleaned.slice(0, 400)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    throw new Error(`Mission Brief 输出 JSON 解析失败:${cleaned.slice(0, 400)}`);
  }

  const interpretedGoal = typeof parsed?.interpretedGoal === "string" ? parsed.interpretedGoal.trim().slice(0, 500) : "";
  if (!interpretedGoal) throw new Error(`Mission Brief 输出缺少 interpretedGoal:${cleaned.slice(0, 400)}`);

  const requiredDepartments = toStringArray(parsed?.requiredDepartments, 3)
    .filter((d): d is RequiredDepartment => (REQUIRED_DEPARTMENTS as string[]).includes(d));

  const suggestedRunType: SuggestedRunType = parsed?.suggestedRunType === "team" ? "team" : "quick";
  const suggestedTeamModeRaw = typeof parsed?.suggestedTeamMode === "string" ? parsed.suggestedTeamMode : undefined;
  const suggestedTeamMode = suggestedRunType === "team" && suggestedTeamModeRaw && (TEAM_MODES as string[]).includes(suggestedTeamModeRaw)
    ? (suggestedTeamModeRaw as SuggestedTeamMode)
    : undefined;

  const permissionNeeds: PermissionNeeds = (PERMISSION_LEVELS as string[]).includes(parsed?.permissionNeeds)
    ? (parsed.permissionNeeds as PermissionNeeds)
    : "propose_only";

  return {
    originalIdea,
    interpretedGoal,
    targetUser: typeof parsed?.targetUser === "string" && parsed.targetUser.trim() ? parsed.targetUser.trim().slice(0, 200) : undefined,
    problemStatement: typeof parsed?.problemStatement === "string" && parsed.problemStatement.trim() ? parsed.problemStatement.trim().slice(0, 500) : undefined,
    proposedDirection: typeof parsed?.proposedDirection === "string" && parsed.proposedDirection.trim() ? parsed.proposedDirection.trim().slice(0, 500) : undefined,
    successCriteria: toStringArray(parsed?.successCriteria, 5),
    nonGoals: toStringArray(parsed?.nonGoals, 5),
    assumptions: toStringArray(parsed?.assumptions, 5),
    risks: toStringArray(parsed?.risks, 5),
    requiredDepartments,
    expectedArtifacts: toStringArray(parsed?.expectedArtifacts, 3),
    suggestedRunType,
    suggestedTeamMode,
    permissionNeeds,
  };
}

// Bug 修复(端到端验证抓出):原 prompt 零语境,模型把"OPC Studio"这个项目名幻觉成工业 OPC-UA 协议客户端,
// 整份简报编造成"巡检工程师"场景。修法与 chatRoutes.ts 的 CEO/员工对话同款——注入固定锚点句 + 真实公司/
// 团队语境(如果给了 companyId),防止模型自己脑补一个不存在的领域。
function missionContextBlock(root: string, companyId?: string): string {
  const anchor = "OPC Studio 是一个本地桌面 AI 多 Agent 协作平台:用户下达目标,由 AI 组成的公司(CEO/Lead/Worker)拆解任务、并行执行、交叉验证、产出成果。它与工业 OPC-UA/OPC-DA 协议无关,不要把 \"OPC\" 理解成那个含义。";
  if (!companyId) return anchor;
  try {
    const companyName = loadCompanies(root).find(c => c.id === companyId)?.name;
    const roster = getAgents().filter(a => (a.companyId || "default") === companyId);
    if (!companyName) return anchor;
    const rosterLines = roster.slice(0, 15).map(a => `- ${a.name}(${a.role})`).join("\n");
    return `${anchor}\n\n本次 idea 所属公司:「${companyName}」,现有团队(${roster.length} 人):\n${rosterLines || "(暂无成员)"}`;
  } catch {
    return anchor;
  }
}

const MISSION_BRIEF_PROMPT = (root: string, ideaText: string, companyId?: string) => `你是一名经验丰富的创业公司 CEO 顾问,负责把用户一句模糊的 idea 展开成一份完整、可执行的任务简报(Mission Brief),供用户确认后交给团队执行。

## 真实语境(以此为准,不要脑补/联想成其他领域)
${missionContextBlock(root, companyId)}

用户的 idea:
${ideaText.slice(0, 1000)}

请输出以下字段:
- interpretedGoal:你理解后的清晰目标(一句话到几句话)
- targetUser:目标用户是谁(不确定可省略)
- problemStatement:这个 idea 要解决什么问题(不确定可省略)
- proposedDirection:建议的实现方向(不确定可省略)
- successCriteria:2-5 条具体、可验收的成功标准
- nonGoals:2-5 条明确不做的事(划清边界)
- assumptions:2-5 条你做出的假设
- risks:2-5 条潜在风险
- requiredDepartments:从 ["research","product","launch"] 里选 0-3 个——判断这个 idea 是否需要调研/产品设计/上线发布这几个部门参与,不确定就都不选,允许空数组
- expectedArtifacts:1-3 个预计产出物的文件名猜测(如 "market_research.md"、"landing_page.html")
- suggestedRunType:"quick"(单 agent 快速直答即可)或 "team"(需要多角色协作)
- suggestedTeamMode:仅当 suggestedRunType 是 "team" 时给出,从 ["economy","balanced","maxQuality"] 选一个建议档位
- permissionNeeds:这个 idea 大概率需要的权限程度,从 ["no_code","propose_only","write_code","external_actions"] 选一个

只输出一个 JSON 对象,不要 markdown 代码块、不要任何其他文字:
{"interpretedGoal": "...", "targetUser": "...", "problemStatement": "...", "proposedDirection": "...", "successCriteria": ["..."], "nonGoals": ["..."], "assumptions": ["..."], "risks": ["..."], "requiredDepartments": ["research"], "expectedArtifacts": ["..."], "suggestedRunType": "quick", "suggestedTeamMode": "balanced", "permissionNeeds": "propose_only"}`;

// 生成 Mission Brief:调便宜模型(systemModel.creative 档)把一句模糊 idea 展开成结构化简报。
// 解析失败时抛错(路由层转 400 + raw),不编造兜底数据。
export async function generateMissionBrief(root: string, ideaText: string, companyId?: string): Promise<MissionBrief> {
  const record = await invokeSystemModel(root, "creative", {
    agentId: "mission-brief-advisor",
    messages: [{ role: "user", content: MISSION_BRIEF_PROMPT(root, ideaText, companyId) }], maxTokens: 1500, agentRole: "advisor",
  });
  const fields = parseMissionBriefLLMOutput(record.content ?? "", ideaText);
  const brief: MissionBrief = {
    id: randomUUID().slice(0, 8),
    companyId,
    createdAt: new Date().toISOString(),
    approvalStatus: "draft",
    ...fields,
  };
  return brief;
}

// 可编辑字段白名单(PATCH 用):id/createdAt/approvalStatus 即使传了也忽略。
const EDITABLE_FIELDS: (keyof MissionBrief)[] = [
  "companyId", "originalIdea", "interpretedGoal", "targetUser", "problemStatement", "proposedDirection",
  "successCriteria", "nonGoals", "assumptions", "risks", "requiredDepartments", "expectedArtifacts",
  "suggestedRunType", "suggestedTeamMode", "permissionNeeds",
];

// 集成验证抓出的潜在缺口(当时判定"今天 UI 不会送坏值,但端点本身没防"):枚举/受限数组字段做校验,
// 拒绝就整条 patch 忽略该字段而不是让脏值混进去——不是"契约不一致",是"端点自身该有的防线"。
const PATCH_RUN_TYPES: SuggestedRunType[] = ["quick", "team"];
const PATCH_PERMISSIONS: PermissionNeeds[] = ["no_code", "propose_only", "write_code", "external_actions"];

export function applyMissionPatch(mission: MissionBrief, patch: Record<string, unknown>): MissionBrief {
  const next: MissionBrief = { ...mission };
  for (const key of EDITABLE_FIELDS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (key === "suggestedRunType" && !(PATCH_RUN_TYPES as string[]).includes(v as string)) continue;
    if (key === "suggestedTeamMode" && v !== undefined && !(TEAM_MODES as string[]).includes(v as string)) continue;
    if (key === "permissionNeeds" && !(PATCH_PERMISSIONS as string[]).includes(v as string)) continue;
    if (key === "requiredDepartments") {
      if (!Array.isArray(v)) continue;
      (next as any)[key] = v.filter((d) => (REQUIRED_DEPARTMENTS as string[]).includes(d));
      continue;
    }
    (next as any)[key] = v;
  }
  return next;
}
