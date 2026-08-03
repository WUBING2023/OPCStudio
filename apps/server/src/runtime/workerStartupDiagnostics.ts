import type {
  WorkerStartupDiagnostic,
  WorkerStartupFailureClassification,
} from '@opc/shared';
import { redactSecrets } from '../security/redact.js';
import { appendWorkerStartupDiagnosticRecord } from '../storage/projectStore.js';

export interface WorkerStartupDiagnosticInput {
  projectRoot: string;
  runId: string;
  agentId: string;
  taskId: string;
  attempt: number;
  framework: string;
  error: unknown;
  phase?: WorkerStartupDiagnostic['phase'];
}

function classify(message: string): WorkerStartupFailureClassification {
  if (/(trust (this|the) (folder|workspace)|workspace trust|确认.*信任|需要.*信任|approval prompt)/i.test(message)) {
    return 'trust_prompt';
  }
  if (/(permission denied|eacces|access is denied|拒绝访问|tool .*not allowed|write .*ok=false|operation not permitted)/i.test(message)) {
    return 'tool_permission';
  }
  if (/(prompt|request).*(timed out|timeout|未.*响应)|timed out.*(before|waiting).*(prompt|response)/i.test(message)) {
    return 'prompt_acceptance_timeout';
  }
  if (/(prompt.*(not delivered|delivery failed)|session closed.*before.*prompt|stdin.*closed|broken pipe.*prompt)/i.test(message)) {
    return 'prompt_misdelivery';
  }
  if (/(websocket|reconnect|econnreset|econnrefused|socket hang up|handshake|named pipe|transport|channel closed)/i.test(message)) {
    return 'transport';
  }
  if (/(429|rate limit|overloaded|service unavailable|provider unavailable|http 5\d\d)/i.test(message)) {
    return 'provider_unavailable';
  }
  if (/(enoent|command not found|not installed|not logged in|authentication|unauthorized|invalid api[_ -]?key|missing .*config|配置.*缺失)/i.test(message)) {
    return 'configuration';
  }
  return 'worker_crash';
}

function suggestedAction(kind: WorkerStartupFailureClassification): string {
  switch (kind) {
    case 'transport': return '检查 ACP/CLI 进程与传输通道，重建会话后有限重试';
    case 'trust_prompt': return '在受控终端完成一次工作区信任确认，再重新运行';
    case 'tool_permission': return '检查角色权限、工作目录和 provider 文件工具 canary';
    case 'prompt_acceptance_timeout': return '检查 provider 是否接受 prompt；不要直接增加整任务超时';
    case 'prompt_misdelivery': return '重建会话并确认 prompt 已送达，再允许执行';
    case 'provider_unavailable': return '切换健康账号或 provider，并保留本次失败证据';
    case 'configuration': return '运行深度体检，补齐 CLI、登录或 provider 配置';
    default: return '查看 worker 进程退出码与原始事件，修复后再重试';
  }
}

export function buildWorkerStartupDiagnostic(input: Omit<WorkerStartupDiagnosticInput, 'projectRoot'>): WorkerStartupDiagnostic {
  const message = redactSecrets(input.error instanceof Error ? input.error.message : input.error).slice(0, 800);
  const classification = classify(message);
  return {
    at: new Date().toISOString(),
    runId: input.runId,
    agentId: input.agentId,
    taskId: input.taskId,
    attempt: input.attempt,
    framework: input.framework,
    phase: input.phase ?? 'launch',
    classification,
    message,
    suggestedAction: suggestedAction(classification),
    activityObserved: false,
  };
}

export function appendWorkerStartupDiagnostic(input: WorkerStartupDiagnosticInput): WorkerStartupDiagnostic {
  const diagnostic = buildWorkerStartupDiagnostic(input);
  try {
    appendWorkerStartupDiagnosticRecord(input.projectRoot, input.runId, diagnostic);
  } catch {
    // Best effort. The same diagnostic is also emitted into the canonical run event stream.
  }
  return diagnostic;
}
