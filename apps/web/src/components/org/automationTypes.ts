// 目标模式(goal)/连续模式(loop)前端类型——镜像服务端 apps/server/src/runtime/goalRunner.ts
// (GoalRecord/GoalRound) 与 loopRunner.ts(LoopRecord/LoopRound,CC /loop 式"按下即连轴转"，
// 已非旧的固定间隔定时任务)。web 不跨包引入 server 类型，这里手动保持字段同步。
// BriefingPanel(输入区模式切换 + 发起 POST /api/goals /api/loops)与 AutomationPanel(活动目标/
// 连续任务卡，GET 轮询)共用同一份，避免两处各写一份走样。

export interface GoalRound {
  round: number;
  runId: string;
  achieved: boolean;
  gap?: string;
  doneSummary?: string;
  error?: string;
}

export interface GoalRecord {
  id: string;
  goal: string;
  companyId?: string;
  status: "running" | "waiting_user" | "achieved" | "exhausted" | "stopped" | "failed";
  maxRounds: number;
  rounds: GoalRound[];
  createdAt: string;
  endedAt?: string;
  /** harness 范式:用户写下的显式验收标准(≤8 条)——验收官按这些判定,不靠 LLM 猜。 */
  acceptanceCriteria?: string[];
  /** 每轮确认门:开启后每轮判定完停在 waiting_user,等用户 继续/带反馈继续/停止。 */
  confirmEachRound?: boolean;
  /** 方向盘:用户异步捎给下一轮的话(服务端取用后清空)。 */
  pendingFeedback?: string;
}

export interface LoopRound {
  round: number;
  runId: string;
  note?: string;
  next?: string;
  error?: string;
}

export interface LoopRecord {
  id: string;
  prompt: string;
  companyId?: string;
  status: "running" | "waiting_user" | "stopped" | "exhausted" | "failed";
  maxRuns: number;
  maxHours: number;
  rounds: LoopRound[];
  createdAt: string;
  endedAt?: string;
  stopReason?: string;
  /** 每轮确认门(与 GoalRecord 同款契约)。 */
  confirmEachRound?: boolean;
  /** 方向盘(与 GoalRecord 同款契约)。 */
  pendingFeedback?: string;
}

// 面板/公司过滤用的默认公司 id——与 BriefingPanel 事件流公司过滤同一口径(记录缺 companyId 视为默认公司)。
export const DEFAULT_COMPANY = "default";

// 自动化队列前端类型——镜像服务端 apps/server/src/runtime/harness.ts 的 QueuedAutomation(agent 工具
// schedule_goal/schedule_loop 的落点;AutomationPanel 只读展示 + 允许删除队列项,不下发起跑请求)。
export interface QueuedAutomation {
  id: string;
  kind: "goal" | "loop";
  prompt: string;
  companyId?: string;
  maxRounds?: number;
  maxHours?: number;
  source: string; // "user" | "agent:<agentId>"
  enqueuedAt: string;
}
