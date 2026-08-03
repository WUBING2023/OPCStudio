import type { AgentNodeConfig, CompanyTemplate, CompanyBundle } from "@opc/shared";
import { CompanyTemplateSchema, deriveOrgTeamsAndEdges } from "@opc/shared";
import { verifyAndAssignTrust, dangerFlags } from "./templateTrust.js";
import { checkTemplateRequirements } from "./companyTemplate.js";

// D1 · Template Doctor 最小版(指南 11.13):把导入/安装前的 4 处零散检查收拢成统一的 checks[] 报告
// (schema_valid / hash_valid / danger_permissions / missing_required_capabilities / no_cycle_in_org)。
// D2 追加三项内容级检查(no_secrets_detected / local_paths_redacted / template_size_warning,见下方
// SECRET_PATTERNS/LOCAL_PATH_PATTERNS 与⑥⑦⑧)——新检查只是往 checks 里多 push 几条,一条一个 id,
// 聚合逻辑(aggregate)不变。
// 与 Global Doctor(E2,机器环境体检)边界:这里只体检"一份模板内容",不探测本机环境健康。

export type TemplateDoctorStatus = "pass" | "warning" | "error";

export interface TemplateDoctorCheck {
  id: string;
  status: TemplateDoctorStatus;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface TemplateDoctorReport {
  status: TemplateDoctorStatus;
  checks: TemplateDoctorCheck[];
  warnings: number;
  errors: number;
  install_allowed: boolean;
}

// 汇报链成环检测(服务端版)。web 工坊的 workshopTypes.hasCycle 查的是草稿卡片的 reportsTo,
// 这里对最终模板 agents 的 parentId 链做同类检查:任一节点沿 parentId 上溯若重访节点即成环。
export function orgHasCycle(agents: Array<Pick<AgentNodeConfig, "id" | "parentId">>): boolean {
  const byId = new Map(agents.map(a => [a.id, a]));
  for (const start of agents) {
    const seen = new Set<string>();
    let cur: Pick<AgentNodeConfig, "id" | "parentId"> | undefined = start;
    while (cur) {
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return false;
}

// C9-P1 · parentId↔childrenIds 互指一致性诊断(warning 级,不拦装)。以 parentId 为真源重算每个节点的
// 期望子集,与声明的 childrenIds 逐节点比对,返回可读的失配描述(最多前若干条)。只在给定集合内解析,
// 悬空引用不计入(childrenIds 里指向不存在 id 的边、parentId 指向不存在 id 的边一并如实报为失配)。
export function detectOrgChildrenMismatches(agents: Array<Pick<AgentNodeConfig, "id" | "parentId" | "childrenIds">>): string[] {
  const idSet = new Set(agents.map(a => a.id));
  const expectedChildren = new Map<string, Set<string>>(agents.map(a => [a.id, new Set<string>()]));
  for (const a of agents) {
    if (a.parentId && idSet.has(a.parentId)) expectedChildren.get(a.parentId)!.add(a.id);
  }
  const mismatches: string[] = [];
  for (const a of agents) {
    const expected = expectedChildren.get(a.id)!;
    const declared = new Set(a.childrenIds ?? []);
    // 声明了但 parentId 不指回来(含指向不存在 id)。
    for (const c of declared) {
      if (!expected.has(c)) mismatches.push(`${a.id}→${c}(childrenIds 声明但子的 parentId 未指回)`);
    }
    // parentId 指来了但没进父的 childrenIds。
    for (const c of expected) {
      if (!declared.has(c)) mismatches.push(`${a.id}→${c}(子 parentId 指来但未进 childrenIds)`);
    }
    if (mismatches.length >= 10) break;
  }
  return mismatches.slice(0, 10);
}

// D2 · 密钥形态扫描(复用 security/redact.ts 的 SECRET 正则思路;不直接 import 该文件,避免与
// 该文件的其它并行改动耦合——两处正则各自独立维护,含义一致即可)。命中任一条 = error 级,拒绝导入。
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bark-[A-Za-z0-9_-]{8,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,          // GitHub personal access token(classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,  // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/,              // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /(["']?(?:api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|access[_-]?token|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/i,
];

function containsSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// D2 · 本机绝对路径形态(warning 级,提示脱敏后再分享;不像密钥那样拒绝安装)。text 来自
// JSON.stringify,Windows 路径里的反斜杠会被转义成 "\\",两种写法都要能命中。
const WIN_PATH_RE = /\b[A-Za-z]:\\{1,2}[^\s"'\\]+(?:\\{1,2}[^\s"'\\]+)*/g;
const UNIX_PATH_RE = /\/(?:home|Users|root|mnt|var|etc|tmp|opt)\/[^\s"']+/g;

function detectLocalPaths(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(WIN_PATH_RE)) hits.add(m[0]);
  for (const m of text.matchAll(UNIX_PATH_RE)) hits.add(m[0]);
  return [...hits].slice(0, 5);
}

function aggregate(checks: TemplateDoctorCheck[]): TemplateDoctorReport {
  const errors = checks.filter(c => c.status === "error").length;
  const warnings = checks.filter(c => c.status === "warning").length;
  return {
    status: errors > 0 ? "error" : warnings > 0 ? "warning" : "pass",
    checks,
    warnings,
    errors,
    install_allowed: errors === 0,
  };
}

// 统一体检入口。input 收 unknown(导入路径拿到的是陌生 JSON);projectRoot 供能力检查读本机
// provider 配置,不传则该项如实标注"跳过"(纯内容检查仍全部执行)。
// C2 · opts.bundle:导入物是 canonical Company Bundle 时,路由把 parse 出的 bundle 一并递进来——
// input(桥接后的扁平模板)不携带 org 信封字段,org 投影一致性检查(⑨)只能对原始 bundle 做。
export function runTemplateDoctor(input: unknown, opts: { projectRoot?: string; bundle?: CompanyBundle } = {}): TemplateDoctorReport {
  const checks: TemplateDoctorCheck[] = [];

  // ① schema_valid —— 坏 schema 时后续检查没有可靠输入,只回这一条 error(不对垃圾数据硬跑其余检查)。
  const parsed = CompanyTemplateSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map(i => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
    const more = parsed.error.issues.length - issues.length;
    checks.push({
      id: "schema_valid", status: "error", severity: "error",
      message: `manifest 校验失败:${issues.join("; ")}${more > 0 ? `(另 ${more} 条)` : ""}`,
    });
    return aggregate(checks);
  }
  checks.push({ id: "schema_valid", status: "pass", severity: "info", message: "manifest 结构合法" });
  const t = parsed.data as unknown as CompanyTemplate;

  // ② hash_valid —— 完整性指纹:无 hash = 未签名(warning,按 untrusted 对待,不阻断);
  // 有 hash 但重算不符 = 签名后内容被改动(error,拒绝安装)。
  if (!t.hash) {
    checks.push({ id: "hash_valid", status: "warning", severity: "warning", message: "模板未签名(无完整性指纹),按 untrusted 处理" });
  } else if (verifyAndAssignTrust(t).hashVerified) {
    checks.push({ id: "hash_valid", status: "pass", severity: "info", message: "完整性校验通过(hash 一致)" });
  } else {
    checks.push({ id: "hash_valid", status: "error", severity: "error", message: "完整性校验失败:内容与 hash 不符,模板可能被篡改" });
  }

  // ③ danger_permissions —— 高危权限旗标(shell/文件写/联网/MCP 依赖)。warning 级:不阻断,
  // 交 UI 确认(V4)+ Safe Install 默认剥离(install.applySafeInstall)。
  const flags = dangerFlags(t);
  if (flags.length > 0) {
    checks.push({ id: "danger_permissions", status: "warning", severity: "warning", message: `声明了高危权限:${flags.join(", ")}(安装前需用户确认)` });
  } else {
    checks.push({ id: "danger_permissions", status: "pass", severity: "info", message: "无高危权限声明" });
  }

  // ④ missing_required_capabilities —— 本机是否配齐所需 provider(warning 级:缺 key 不阻断安装,
  // 装完再配也行;engine/CLI 就绪性属 Stage 5 能力扫描,不在此重复)。
  if (opts.projectRoot) {
    try {
      const rc = checkTemplateRequirements(opts.projectRoot, t);
      if (rc.ok) {
        checks.push({ id: "missing_required_capabilities", status: "pass", severity: "info", message: "所需 provider 均已配置" });
      } else {
        checks.push({ id: "missing_required_capabilities", status: "warning", severity: "warning", message: `缺少能力:${rc.missing.map(m => m.reason).join("; ")}` });
      }
    } catch (e) {
      checks.push({ id: "missing_required_capabilities", status: "warning", severity: "warning", message: `能力检查未完成:${(e as Error).message}` });
    }
  } else {
    checks.push({ id: "missing_required_capabilities", status: "pass", severity: "info", message: "跳过(无项目上下文,未检查本机 provider 配置)" });
  }

  // ⑤ no_cycle_in_org —— 组织汇报链成环(error 级:成环的组织装进去 orchestrator 无法调度)。
  if (orgHasCycle(t.agents)) {
    checks.push({ id: "no_cycle_in_org", status: "error", severity: "error", message: "组织汇报链成环:parentId 链存在循环,无法安装" });
  } else {
    checks.push({ id: "no_cycle_in_org", status: "pass", severity: "info", message: "组织汇报链无环" });
  }

  // C9-P1 ⑤b org_children_consistent —— parentId↔childrenIds 互指一致性(warning 级:不拦装,先可见)。
  // 契约第9条:parentId 是组织关系真源,childrenIds 必须由其生成或强制双向同步。schema 合法但父子失配的
  // 模板(childrenIds 里有 parentId 不指回来的子 / 有 parent 声明了却没进父 childrenIds 的子)会让调度按
  // lead.childrenIds 取队员时静默丢人。此处只诊断可见,安装以 parentId 为准(installMerge.rebuildChildrenIds
  // 在落地时重建)。**仅在检出失配时才 push 一条**(照 ⑨ org_projection_consistent 的先例——无谎可查时不加
  // 噪音,也不改动"干净模板恒 8 项 checks"的既有测试口径)。
  const orgMismatches = detectOrgChildrenMismatches(t.agents);
  if (orgMismatches.length > 0) {
    checks.push({
      id: "org_children_consistent", status: "warning", severity: "warning",
      message: `parentId↔childrenIds 互指不一致(${orgMismatches.length} 处,如「${orgMismatches[0]}」)——安装以 parentId 为真源重建 childrenIds,建议修正模板`,
    });
  }

  // D2 ⑥⑦⑧ —— 对"bundle 全文"(即传给本函数的原始 input,而非上面已被 zod 剥掉未知字段的 t)
  // 做内容级扫描:即便未来 bundle 信封字段(privacy/compatibility/metadata 等)混进密钥/本机路径,
  // 也照样能扫到,不因为它们不属于 CompanyTemplateSchema 就被漏检。
  const serialized = JSON.stringify(input) ?? "";

  // ⑥ no_secrets_detected —— error 级:检出疑似 API Key/Bearer Token/密钥字段值,直接拒绝导入。
  if (containsSecretPattern(serialized)) {
    checks.push({ id: "no_secrets_detected", status: "error", severity: "error", message: "内容中检测到疑似 API Key / Bearer Token / 密钥字段值,禁止导入(先脱敏再分享)" });
  } else {
    checks.push({ id: "no_secrets_detected", status: "pass", severity: "info", message: "未发现 API Key 或 Token 形态的敏感信息" });
  }

  // ⑦ local_paths_redacted —— warning 级:检出本机绝对路径(Windows/Unix),提示脱敏,不阻断安装。
  const paths = detectLocalPaths(serialized);
  if (paths.length > 0) {
    checks.push({ id: "local_paths_redacted", status: "warning", severity: "warning", message: `内容中检测到本机绝对路径(如「${paths[0]}」),分享前建议脱敏` });
  } else {
    checks.push({ id: "local_paths_redacted", status: "pass", severity: "info", message: "未发现本机绝对路径" });
  }

  // ⑧ template_size_warning —— 序列化体积 >2MB warning,>10MB error(11.14:大 bundle 提示 + 拒装)。
  const bytes = Buffer.byteLength(serialized, "utf-8");
  const MB = 1024 * 1024;
  if (bytes > 10 * MB) {
    checks.push({ id: "template_size_warning", status: "error", severity: "error", message: `模板体积 ${(bytes / MB).toFixed(1)}MB,超过 10MB 上限,拒绝导入` });
  } else if (bytes > 2 * MB) {
    checks.push({ id: "template_size_warning", status: "warning", severity: "warning", message: `模板体积 ${(bytes / MB).toFixed(1)}MB 较大,导入可能需要较长时间` });
  } else {
    checks.push({ id: "template_size_warning", status: "pass", severity: "info", message: `模板体积 ${(bytes / 1024).toFixed(0)}KB` });
  }

  // C2 ⑨ org_projection_consistent —— canonical bundle 的 org.teams/edges 是 agents 的派生投影
  // (deriveOrgTeamsAndEdges),不是第二事实源;声明与派生不一致 = bundle 被手改/第三方工具生成的
  // 投影在说谎。warning 级、不拦装:导入结构永远从顶层 agents 重建,说谎的投影只误导"读 bundle 的人"。
  // 比对口径按语义:teams 只比 lead+成员集合(team_id/name 是展示位,第三方命名不同不算说谎);
  // edges 只比 type|from|to(purpose 是人读注释,导出脱敏可能改写它,不算结构不一致)。
  // 仅当 bundle 真带 teams/edges 时才检(旧 bundle/V0 产物无这两字段,无声明即无谎可查,不加噪音)。
  const org = opts.bundle?.org;
  if (opts.bundle && org && (org.teams !== undefined || org.edges !== undefined)) {
    const declaredTeams = org.teams ?? [];
    const declaredEdges = org.edges ?? [];
    const derived = deriveOrgTeamsAndEdges(opts.bundle.agents, opts.bundle.a2aChannels, opts.bundle.workflow);
    const teamKey = (tm: { lead_agent_id: string; member_agent_ids: string[] }) =>
      `${tm.lead_agent_id}|${[...tm.member_agent_ids].sort().join(",")}`;
    const edgeKey = (e: { type: string; from: string; to: string }) => `${e.type}|${e.from}|${e.to}`;
    const setEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
    const teamsOk = setEq(declaredTeams.map(teamKey), derived.teams.map(teamKey));
    const edgesOk = setEq(declaredEdges.map(edgeKey), derived.edges.map(edgeKey));
    if (teamsOk && edgesOk) {
      checks.push({ id: "org_projection_consistent", status: "pass", severity: "info", message: "org.teams/edges 与 agents 派生投影一致" });
    } else {
      const parts: string[] = [];
      if (!teamsOk) parts.push(`teams 声明 ${declaredTeams.length} 队 / 派生 ${derived.teams.length} 队`);
      if (!edgesOk) parts.push(`edges 声明 ${declaredEdges.length} 条 / 派生 ${derived.edges.length} 条`);
      checks.push({
        id: "org_projection_consistent", status: "warning", severity: "warning",
        message: `bundle 的 org.teams/edges 与 agents 派生结果不一致(${parts.join(";")})——org 是派生投影,安装以顶层 agents 为准,不拦截`,
      });
    }
  }

  return aggregate(checks);
}

// ── P0-5 · 分享 / 工坊保存安全闸 ──────────────────────────────────────────────────
//
// runTemplateDoctor 面向"导入/安装"(本机路径只 warning、危险权限交 Safe Install 兜底)。分享到公开
// 社区 / 落工坊库是"内容要外发或被别人拉取"的方向,判定要更严:密钥与本机绝对路径必须硬拦。这里给
// 分享/保存路由一个独立的闸门,不改动导入侧 runTemplateDoctor 的既有语义。

export interface ShareSafetyFinding {
  id: string;
  severity: "error";
  message: string;
}

export interface ShareSafetyResult {
  ok: boolean;
  findings: ShareSafetyFinding[];
}

// schema-agnostic 内容级扫描:序列化整份内容后扫密钥 + 本机绝对路径。JSON.stringify 会把 persona /
// bundledSkills / memory 等所有嵌套正文都摊平进字符串,一次扫描全覆盖,不需要按字段逐个遍历。
export function scanContentSafety(input: unknown): ShareSafetyFinding[] {
  const serialized = JSON.stringify(input) ?? "";
  const findings: ShareSafetyFinding[] = [];
  if (containsSecretPattern(serialized)) {
    findings.push({
      id: "no_secrets_detected", severity: "error",
      message: "检测到疑似 API Key / Token / 密钥字段值(sk-/ghp_/AKIA/Bearer/api_key=… 等形态),禁止分享,请先脱敏",
    });
  }
  const paths = detectLocalPaths(serialized);
  if (paths.length > 0) {
    findings.push({
      id: "local_paths_redacted", severity: "error",
      message: `检测到本机绝对路径(如「${paths[0]}」),禁止分享到公开社区,请先脱敏`,
    });
  }
  return findings;
}

// 分享/工坊保存的统一安全闸。
//   · 内容级(密钥 / 本机路径)对任何将要外发或入库的内容强制执行,覆盖 worker/prompt/company 各类型。
//   · 若 input 还能被 CompanyTemplateSchema 解析(company 分享/工坊模板),叠加结构级 error 项
//     (坏 schema / 组织成环 / 超体积);危险权限**不拦**(安装侧 Safe Install 兜底,干净公司照常可分享)。
//   · extraContent:与主体一并落盘/外发的附属内容(如工坊表单里独立于 template 的 persona 数组),
//     一并纳入内容级扫描,避免密钥/路径藏在附属正文里绕过。
export function runShareSafetyGate(
  input: unknown,
  opts: { projectRoot?: string; extraContent?: unknown[] } = {},
): ShareSafetyResult {
  const byId = new Map<string, ShareSafetyFinding>();
  const add = (f: ShareSafetyFinding) => { if (!byId.has(f.id)) byId.set(f.id, f); };

  for (const f of scanContentSafety([input, ...(opts.extraContent ?? [])])) add(f);

  if (CompanyTemplateSchema.safeParse(input).success) {
    const report = runTemplateDoctor(input, { projectRoot: opts.projectRoot });
    for (const c of report.checks) {
      if (c.status !== "error") continue;
      // 密钥 / 本机路径已由内容级扫描统一报过(且 local_paths 在通用 doctor 里只是 warning),不重复。
      if (c.id === "no_secrets_detected" || c.id === "local_paths_redacted") continue;
      add({ id: c.id, severity: "error", message: c.message });
    }
  }

  const findings = [...byId.values()];
  return { ok: findings.length === 0, findings };
}

// ── C2 · 外发内容脱敏(员工卡导出等轻量外发面)──────────────────────────────────────
//
// runShareSafetyGate 是"拦"(检出即 422),适用于分享入库;员工卡导出(agentRoutes /export-card)
// 是"导出"方向,按公司 bundle 导出的先例(memoryBundle.sanitizeBundleForExport)应当**脱敏放行**:
// 深扫全部字符串,密钥/本机路径占位化([REDACTED_SECRET]/[REDACTED_PATH],与该文件占位口径一致;
// 不 import 该文件,理由同上方 SECRET_PATTERNS 的独立维护说明)。用扫描正则的全局克隆做替换,
// 不污染共享正则对象的 lastIndex。
const REDACT_SECRET_RES = SECRET_PATTERNS.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
const REDACT_PATH_RES = [WIN_PATH_RE, UNIX_PATH_RE].map((re) => new RegExp(re.source, re.flags));

function redactStringForShare(text: string): { text: string; hit: boolean } {
  let out = text;
  let hit = false;
  for (const re of REDACT_SECRET_RES) {
    re.lastIndex = 0;
    if (re.test(out)) { hit = true; re.lastIndex = 0; out = out.replace(re, "[REDACTED_SECRET]"); }
  }
  for (const re of REDACT_PATH_RES) {
    re.lastIndex = 0;
    if (re.test(out)) { hit = true; re.lastIndex = 0; out = out.replace(re, "[REDACTED_PATH]"); }
  }
  return { text: out, hit };
}

export interface RedactShareContentResult<T> {
  value: T;
  redactedFields: string[]; // 命中字段路径,如 "agent.systemPrompt"
}

/** 深扫任意 JSON 值,密钥/本机路径占位化;未命中的分支原样引用返回(幂等,重复调用零改写)。 */
export function redactShareContent<T>(input: T): RedactShareContentResult<T> {
  const redactedFields = new Set<string>();
  const walk = (value: unknown, fieldPath: string): unknown => {
    if (typeof value === "string") {
      const scan = redactStringForShare(value);
      if (!scan.hit) return value;
      redactedFields.add(fieldPath);
      return scan.text;
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v, i) => {
        const r = walk(v, `${fieldPath}[${i}]`);
        if (r !== v) changed = true;
        return r;
      });
      return changed ? out : value;
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const r = walk(v, fieldPath ? `${fieldPath}.${k}` : k);
        if (r !== v) changed = true;
        out[k] = r;
      }
      return changed ? out : value;
    }
    return value;
  };
  return { value: walk(input, "") as T, redactedFields: [...redactedFields] };
}
