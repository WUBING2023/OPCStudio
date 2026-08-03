// WS3 · 契约式 A2A handoff — ContractMessage 类型系统。
// 只允许这七种类型流经 a2aBus；payload 交摘要+引用，不交整段 transcript，
// 防上下文污染与 token 爆炸。本模块是 dormant 模块，未 wire 进 orchestrator。

// 七种合法消息类型（对应 PLAN §8 Phase 3 · WS3）。
export type ContractMessageType =
  | "review_request"
  | "review_result"
  | "artifact_request"
  | "artifact_response"
  | "handoff"
  | "blocker"
  | "revision_request";

// ContractMessage：点对点契约消息，只携带摘要与产物引用，不携带完整上下文。
export interface ContractMessage {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: ContractMessageType;
  summary: string;
  artifactRefs?: string[];          // ArtifactStore 中的 artifact id 列表
  unresolvedQuestions?: string[];   // 交接时仍待确认的问题
  deadlineHintMs?: number;          // 建议接收方在此毫秒数内回应（软提示，非强制）
}

// 合法转换表：某条消息发出后，下一条合法回应/跟进的类型集合。
// 语义：ALLOWED_TRANSITIONS[A] = B[] 意为"收到 A 之后，合法的后续消息类型为 B 中之一"。
export const ALLOWED_TRANSITIONS: Readonly<Record<ContractMessageType, ContractMessageType[]>> = {
  // 请求评审 → 评审者给出结果或抛出阻塞
  review_request:   ["review_result", "blocker"],
  // 评审完成 → 通过则 handoff，不通过则要求修订
  review_result:    ["handoff", "revision_request"],
  // 请求产物 → 被请求方提供或抛出阻塞
  artifact_request: ["artifact_response", "blocker"],
  // 产物响应 → 上游可继续评审或直接 handoff
  artifact_response: ["review_request", "handoff"],
  // handoff 完成后下一阶段可开启新评审或请求更多产物
  handoff:          ["review_request", "artifact_request"],
  // 阻塞 → 只能要求原来那一方修订后重新提交
  blocker:          ["revision_request"],
  // 修订请求 → 修订完成后重新发起评审或补充产物
  revision_request: ["review_request", "artifact_request"],
};

let _seq = 0;

// 工厂：生成带唯一 id 的 ContractMessage。id 格式 cm-<runId前6位>-<seq>。
export function buildContractMessage(
  fields: Omit<ContractMessage, "id"> & { id?: string },
): ContractMessage {
  const prefix = fields.runId.slice(0, 6);
  const id = fields.id ?? `cm-${prefix}-${++_seq}`;
  return {
    id,
    runId: fields.runId,
    from: fields.from,
    to: fields.to,
    type: fields.type,
    summary: fields.summary,
    ...(fields.artifactRefs !== undefined && { artifactRefs: fields.artifactRefs }),
    ...(fields.unresolvedQuestions !== undefined && { unresolvedQuestions: fields.unresolvedQuestions }),
    ...(fields.deadlineHintMs !== undefined && { deadlineHintMs: fields.deadlineHintMs }),
  };
}

const CONTRACT_MESSAGE_TYPES = new Set<ContractMessageType>([
  "review_request",
  "review_result",
  "artifact_request",
  "artifact_response",
  "handoff",
  "blocker",
  "revision_request",
]);

// 类型守卫：判断 unknown 值是否为合法的 ContractMessage。
export function isContractMessage(value: unknown): value is ContractMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["runId"] === "string" &&
    typeof v["from"] === "string" &&
    typeof v["to"] === "string" &&
    typeof v["summary"] === "string" &&
    typeof v["type"] === "string" &&
    CONTRACT_MESSAGE_TYPES.has(v["type"] as ContractMessageType) &&
    (v["artifactRefs"] === undefined || (Array.isArray(v["artifactRefs"]) && v["artifactRefs"].every((x: unknown) => typeof x === "string"))) &&
    (v["unresolvedQuestions"] === undefined || (Array.isArray(v["unresolvedQuestions"]) && v["unresolvedQuestions"].every((x: unknown) => typeof x === "string"))) &&
    (v["deadlineHintMs"] === undefined || typeof v["deadlineHintMs"] === "number")
  );
}

// 检查两种类型的跳转是否合法（便于 a2aBus 在投递前拦截违规序列）。
export function isAllowedTransition(from: ContractMessageType, to: ContractMessageType): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
