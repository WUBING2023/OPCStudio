import type { ApiError } from "../api/client.js";

// C(波4)· 高危二次确认门共用件:apply 命中删除员工/变更 A2A/变更能力需求/权限扩大时,服务端回
// 428 + 高危明细清单(本地镜像服务端 CompanyEditHighRiskFlag 形状,不跨包引 server 内部类型)。
// 草稿侧(AiEditPanel → /company-architect/apply)与活公司侧(ArchitectChatPanel → /architect-apply)
// 两个确认层共用同一套形状/文案映射/428 解包逻辑。
export interface HighRiskFlag {
  op: string;
  kind: "remove_agent" | "a2a" | "mcp" | "permission_expansion";
  detail: string;
}

export function describeHighRisk(f: HighRiskFlag, tr: (k: string, p?: Record<string, string | number>) => string): string {
  switch (f.kind) {
    case "remove_agent": return tr("cae.highRisk.removeAgent", { detail: f.detail });
    case "a2a": return tr("cae.highRisk.a2a", { detail: f.detail });
    case "mcp": return tr("cae.highRisk.mcp", { detail: f.detail });
    case "permission_expansion": return tr("cae.highRisk.permission");
    default: return f.detail || f.op;
  }
}

// 从 428 响应体里取出高危清单(client.ts 已把非 2xx 响应体挂到 ApiError.body)。取不到 → null。
export function extractHighRisk(e: unknown): HighRiskFlag[] | null {
  const body = (e as ApiError)?.body as { highRisk?: unknown } | undefined;
  if (!body || !Array.isArray(body.highRisk)) return null;
  const flags = body.highRisk.filter(
    (f): f is HighRiskFlag => !!f && typeof f === "object" && typeof (f as { kind?: unknown }).kind === "string",
  );
  return flags.length > 0 ? flags : null;
}

// 令三.4:从 428 响应体取出后端签发的一次性 confirmation token(替换旧的客户端布尔 confirmHighRisk)。
// 前端二次确认时把它原样带回 apply 请求;后端校验一次性 + 绑定 + 过期后放行。取不到 → null。
export function extractConfirmationToken(e: unknown): string | null {
  const body = (e as ApiError)?.body as { confirmationToken?: unknown } | undefined;
  const t = body?.confirmationToken;
  return typeof t === "string" && t ? t : null;
}
