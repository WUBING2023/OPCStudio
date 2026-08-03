import { createHash, randomUUID } from "node:crypto";
import type { CompanyTemplate, AgentNodeConfig } from "@opc/shared";

// 边界一句话:Template Doctor(templateDoctor.ts)体检"一份模板在导入/安装前是否安全兼容";
// Global Doctor(globalDoctor.ts)体检"本机运行环境/当前配置是否健康"——两者互不替代,本文件只服务前者。
// Stage 8 · 模板供应链信任(本地优先,D5 无 PKI)。sha256 内容指纹做**完整性校验**(防篡改,非身份认证)。
// signature 字段 = hash 占位,Stage 9 再升 HMAC/Ed25519。复用思路同 mcpGovernance,但模板独立实现避免耦合。

const EXCLUDED = new Set(["hash", "signature", "trustLevel"]);
// 注:signature 当前 = hash(无非对称密钥),任谁都能自算 → **不能**据 author 自封 "official"(会误导)。
// 本地优先 D5 下:hash 一致 = "community"(完整性 OK,非身份背书);"official" 留给 Stage 9 真签名(服务端持验证密钥)。

// 递归对每层对象 key 排序 → 字段顺序无关的确定性 JSON。
function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, (key, val) => {
    // framework 的 "hermes"/"api" 是同一执行器(ApiEngine)的别名——schema preprocess 在导入时把 hermes
    // 归一成 api,会改变 parse 后的模板内容;hash 若不同步归一,存量 hermes 签名的模板导入(parse→api)后
    // 会与存储 hash(基于 hermes)不匹配而被误判篡改。故 hash 计算里也把 hermes 归一为 api。
    if (key === "framework" && val === "hermes") return "api";
    return val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val;
  });
}

export function computeTemplateHash(t: CompanyTemplate): string {
  const body: Record<string, unknown> = { ...t };
  for (const k of EXCLUDED) delete body[k];
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

// 导出/fork 时:算 hash + 占位签名 + 补 version。trust=community(完整性指纹,非身份背书)。
export function signTemplate(t: CompanyTemplate): CompanyTemplate {
  const withVersion = { ...t, version: t.version ?? "1.0.0" };
  const hash = computeTemplateHash(withVersion);
  return { ...withVersion, hash, signature: hash, trustLevel: "community" };
}

// D8(指南 11.17 Trust Level)· 5 级判定选项:调用方明确"这是一份本地导入、无社区来源的 manifest"
// (用户从磁盘选文件/粘贴 JSON,不经过 GitHub 社区浏览/安装管线)时传 localImport:true——无 hash 时
// 判 local_import 而非笼统的 untrusted。不传(缺省)= 维持既有行为,无 hash 一律 untrusted。
export interface VerifyTrustOptions {
  localImport?: boolean;
}

// 导入时:有 hash 且重算一致 → community(完整性 OK);无 hash / 篡改 → untrusted
// (仍允许导入,只标注),但若调用方标明是本地导入 → local_import。
// 绝不据 author 自封 official(无真签名,会误导);official 留给 Stage 9 真签名。
// verified_community 同理不能自我声明:verifiedAuthor 是模板内容里的自带布尔且参与 hash 计算,
// 攻击者在 JSON 里写 verifiedAuthor:true 后用公开算法重算 hash 即可"通过校验"——与"不能自封
// official"是同一个问题。hash-only 校验路径一律封顶 community;verified_community 等 Stage 9
// 服务端持可信信号(真签名/白名单)后才可能被赋出,本函数当前不产出该级。
export function verifyAndAssignTrust(
  t: CompanyTemplate,
  opts: VerifyTrustOptions = {},
): { template: CompanyTemplate; hashVerified: boolean } {
  if (!t.hash) {
    return { template: { ...t, trustLevel: opts.localImport ? "local_import" : "untrusted" }, hashVerified: false };
  }
  const recomputed = computeTemplateHash(t);
  const ok = recomputed === t.hash;
  if (!ok) return { template: { ...t, trustLevel: "untrusted" }, hashVerified: false };
  return { template: { ...t, trustLevel: "community" }, hashVerified: true };
}

export interface ForkOptions {
  author?: string;
  authorGitHub?: string;
  title?: string;
  description?: string;
  tags?: string[];
  agentPatches?: Record<string, Partial<AgentNodeConfig>>;
  exampleTrace?: CompanyTemplate["exampleTrace"];
  exampleArtifacts?: CompanyTemplate["exampleArtifacts"];
}

// fork:克隆 + 改 agent + 新 id/version + forkedFrom 溯源 + 重新签名。
export function forkTemplate(source: CompanyTemplate, opts: ForkOptions = {}): CompanyTemplate {
  const newId = `${source.id.slice(0, 40)}-fork-${randomUUID().slice(0, 8)}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const agents = source.agents.map(a => {
    const patch = opts.agentPatches?.[a.id];
    return patch ? { ...a, ...patch, id: a.id } : { ...a };
  });
  const tags = Array.from(new Set([...(opts.tags ?? source.tags), "forked"]));
  const forked: CompanyTemplate = {
    ...source,
    id: newId,
    title: opts.title ?? `${source.title} (Fork)`,
    description: opts.description ?? source.description,
    author: opts.author ?? "local",
    authorGitHub: opts.authorGitHub,
    createdAt: new Date().toISOString(),
    tags,
    downloads: 0,
    stars: 0,
    version: "1.0.0",
    forkedFrom: source.id,
    agents,
    exampleTrace: opts.exampleTrace ?? source.exampleTrace,
    exampleArtifacts: opts.exampleArtifacts ?? source.exampleArtifacts,
    hash: undefined,
    signature: undefined,
    trustLevel: undefined,
    // D8:verifiedAuthor 是对**原作者**身份的外部背书,fork 换了作者(opts.author ?? "local")+ 改了
    // 内容,不能把这枚徽章带到新的、未经审查的衍生品上——同 hash/signature/trustLevel 一起清零,
    // 新副本要重新走 verifyAndAssignTrust 才能拿到任何信任等级(默认就是没验证过)。
    verifiedAuthor: undefined,
  };
  return signTemplate(forked);
}

// 从 recommendedConfig.permissions 派生 required_permissions + MCP 依赖。
export function deriveRequiredPermissions(t: CompanyTemplate): NonNullable<CompanyTemplate["requiredPermissions"]> {
  const p = t.recommendedConfig?.permissions;
  const shellFrameworks = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
  return {
    allowShell: p?.allowShell ?? t.agents.some(a => !!a.framework && shellFrameworks.has(a.framework)),
    allowFileWrite: p?.allowFileWrite ?? t.agents.some(a => a.role === "dev" || a.role === "coder" || a.role === "code"),
    allowWebAccess: p?.allowWebAccess,
    mcpServers: t.toolRequirements?.requiredMcpServers ?? [],
  };
}

// 导入前给用户看的危险权限旗标(高风险 → UI 弹 consent;后端不自动授权)。
export function dangerFlags(t: CompanyTemplate): string[] {
  const rp = t.requiredPermissions ?? deriveRequiredPermissions(t);
  const flags: string[] = [];
  if (rp.allowShell) flags.push("shell-access");
  if (rp.allowFileWrite) flags.push("file-write");
  if (rp.allowWebAccess) flags.push("web-access");
  if ((rp.mcpServers?.length ?? 0) > 0) flags.push("mcp-dependency");
  return flags;
}
