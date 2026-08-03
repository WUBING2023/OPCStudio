// P0#7 单 run 互斥闸的错误契约。startRun 撞闸抛的就是这条文案;路由层(governance 批准派发、
// 任务图节点派发)需要可靠识别"撞闸"并走保留审批/退避重试路径,而不是把它当成普通失败烧掉
// run/审批。独立成小模块:orchestrator 依赖极重,消费方(含其单测)不该为一个字符串谓词背上
// 整个 orchestrator 的依赖面(路由测试普遍 mock orchestrator,谓词必须是真实实现)。
export const RUN_IN_FLIGHT_ERROR = "已有 run 正在进行(OPC 单 run 约束):请等待当前 run 完成后再发起";

/** 该错误是否为"撞上单 run 互斥闸"(可等待/可重试),而非节点/派发本身的失败。 */
export function isRunInFlightError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("已有 run 正在进行");
}

// ─── P1-5 · 派发队列协调器 ────────────────────────────────────────────────────────────
// 撞上单 run 互斥闸时不再直接抛错,而是把派发入持久化队列;run 结束(orchestrator finally)自动出队
// 派发下一单。协调器不 import orchestrator(保持本模块轻依赖,见文件头注释):真实的"起 run"函数
// (start)与"是否有活 run"探针(isInFlight)由组合根(missionRoutes.register)注入,队列本身经
// dispatchQueueStore 落盘。orchestrator 只 import drainDispatchQueue(方向与已有 RUN_IN_FLIGHT_ERROR
// 相同,不构成新循环依赖)。
import { enqueueDispatch, dequeueDispatch, type DispatchQueueItem } from "../storage/dispatchQueueStore.js";

export type { DispatchQueueItem };

type DispatchStarter = (item: DispatchQueueItem) => void;
let dispatchStarter: DispatchStarter | null = null;
let inFlightProbe: () => boolean = () => false;

/** 组合根注入:start=真实起 run(fire-and-forget,自带 .catch);isInFlight=当前是否有活 run。 */
export function configureDispatchCoordinator(deps: { start: DispatchStarter; isInFlight: () => boolean }): void {
  dispatchStarter = deps.start;
  inFlightProbe = deps.isInFlight;
}

/** 仅测试用:重置协调器注入态,避免测试间串扰。 */
export function resetDispatchCoordinator(): void {
  dispatchStarter = null;
  inFlightProbe = () => false;
}

/** 当前是否有活 run(组合根注入的探针)。消费方(如 chatRoutes 派发点)据此决定"立即起跑还是入队":
 *  无活 run 才走本地直接起跑路径(可携带 forceSkills 等队列项不落盘的参数),撞忙则入持久化队列。
 *  协调器未接线时恒为 false(退化为无队列的直接起跑,由单 run 互斥闸自行兜底)。 */
export function isDispatchInFlight(): boolean {
  return inFlightProbe();
}

export interface DispatchDecision {
  started: boolean;   // true=立即起跑(无活 run)
  queued: boolean;    // true=已入队(有活 run 撞忙)
  position: number;   // queued 时的 1 基位次;started 时为 0
}

// 派发一单:无活 run → 立即起跑;有活 run → 入队。协调器未配置(如纯单测未接线)时:无活 run 也仅入队
// 保底(不丢单),有 start 才起跑。
export function dispatchOrEnqueue(projectRoot: string, item: DispatchQueueItem): DispatchDecision {
  if (dispatchStarter && !inFlightProbe()) {
    dispatchStarter(item);
    return { started: true, queued: false, position: 0 };
  }
  const items = enqueueDispatch(projectRoot, item);
  const idx = items.findIndex((i) => i.runId === item.runId);
  return { started: false, queued: true, position: idx < 0 ? items.length : idx + 1 };
}

// 出队派发下一单(run 结束 / 启动恢复时调用)。有活 run 或未配置 start 则不动队列(fail-safe:绝不在
// 无人接手时把队首 shift 掉丢单)。返回被起跑的队列项,无可派发返回 null。
export function drainDispatchQueue(projectRoot: string): DispatchQueueItem | null {
  if (!dispatchStarter || inFlightProbe()) return null;
  const next = dequeueDispatch(projectRoot);
  if (next) dispatchStarter(next);
  return next;
}
