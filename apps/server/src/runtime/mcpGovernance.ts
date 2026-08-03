import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { McpServerConfig } from "@opc/shared";
import { listMcpServers } from "../storage/mcpStore.js";
import { writeJSON } from "../storage/jsonFile.js";

// P7/WS7 — MCP / 插件供应链治理（代码实现，非仅文档）。
//
// 设计红线：本模块的所有导出函数 **绝不抛异常**。治理检查本身失败（读不到
// 文件、配置损坏、字段缺失）只会降级为"标记 + 按策略放行/保守拒绝"，永远不会
// 让一次 run 崩溃。mcpToolBridge 在加载 server 前调用一次 evaluateGovernance，
// 仅做加性的标记/可选跳过，不改变既有加载语义（默认策略下不跳过任何 server）。

export type McpTrustLevel = "trusted" | "untrusted";

// 最小权限默认标记：只读 < 受限 < 需确认（越往后越保守）。
export type McpPermissionLevel = "read-only" | "restricted" | "needs-confirmation";

// 钉住（版本固定）状态。
export type McpPinStatus =
  | "pinned-ok"   // 与钉住清单一致
  | "drift"       // 与钉住清单不一致（疑似供应链替换）
  | "baseline"    // 清单中无此 server，本次记为基线
  | "unknown";    // 检查过程出错，降级

// 治理裁决：放行 / 标记后放行 / 拒绝加载。
export type McpDecision = "allow" | "mark-and-allow" | "deny";

// 违规（未在白名单 / 描述符漂移）时的处置策略。
export type McpViolationMode = "mark-and-allow" | "deny";

// 描述符签名校验状态（HMAC-SHA256）。
export type McpSignatureStatus =
  | "signed-ok"     // 签名存在且校验通过
  | "sig-mismatch"  // 签名存在但校验失败（疑似篡改）
  | "unsigned"      // 有密钥但此 server 无签名记录
  | "no-key"        // 无签名密钥，降级为仅 hash 钉住
  | "unknown";      // 检查过程出错

// 轻量健康探测状态。
export type McpHealthStatus =
  | "healthy"    // 命令存在 / url 可达
  | "unhealthy"  // 命令缺失 / url 不可达 / 超时
  | "unknown";   // 未探测或无法判定（默认）

// managed registry 匹配状态。
export type McpRegistryMatch =
  | "match"     // 在注册表中且元数据一致
  | "mismatch"  // 在注册表中但 hash/包名不符
  | "absent";   // 不在注册表中

export interface McpProvenance {
  // 来源类别：npm（npx）、pypi（uvx/pipx）、remote（http url）、local（直接可执行）、unknown。
  source: "npm" | "pypi" | "remote" | "local" | "unknown";
  // 人类可读的来源串（命令行或 url）。
  origin: string;
  // 尽力解析出的包名（npm/pypi 包，便于审计）。
  packageName?: string;
}

export interface McpPinEntry {
  hash: string;
  pinnedAt: string;
  // 可选：记录钉住时的来源，便于审计对比。
  origin?: string;
}

export type McpPinManifest = Record<string, McpPinEntry>;

// serverId → 签名串（"hmac-sha256:<hex>"）。
export type McpSignatureManifest = Record<string, string>;

export interface McpRegistryEntry {
  id: string;
  name?: string;
  // 期望的描述符 hash（钉到注册表，强信号）。
  expectedHash?: string;
  // 期望的来源包名（npm/pypi）。
  packageName?: string;
  source?: string;
  notes?: string;
}

export type McpRegistry = Record<string, McpRegistryEntry>;

export interface McpGovernancePolicy {
  // 允许的 server id 白名单。未在其中的 server 视为不可信。
  allowlist: string[];
  // managed-only：开启后，未在白名单的 server 一律 deny（不仅是标记）。
  managedOnly: boolean;
  // 违规处置：默认 mark-and-allow（加性、不破坏既有加载）。
  onViolation: McpViolationMode;
  // 已知钉住清单（缺失 → 视为空，所有 server 记基线）。
  pins: McpPinManifest;
  // enforcing 总开关：true 时 deny 裁决会被 bridge 真正执行（跳过 server）；
  // false 时退化为仅报告（report-only），即使 managedOnly/onViolation=deny 也不跳过。
  // 缺省 true —— 保持既有"deny 即跳过"语义，默认 mark-and-allow 下无 deny → 零回归。
  enforce?: boolean;
  // HMAC 签名密钥（来自 env/.opc）。缺失 → 签名校验降级为仅 hash 钉住。
  signingKey?: string;
  // 签名清单（serverId → 签名串）。缺失视为空。
  signatures?: McpSignatureManifest;
  // managed registry（已知良好 server + 元数据）。缺失视为空。
  registry?: McpRegistry;
}

export interface McpGovernanceFinding {
  serverId: string;
  name: string;
  enabled: boolean;
  trust: McpTrustLevel;
  allowlisted: boolean;
  descriptorHash: string;
  pinStatus: McpPinStatus;
  provenance: McpProvenance;
  permission: McpPermissionLevel;
  // 描述符签名校验结果。
  signatureStatus: McpSignatureStatus;
  // 健康探测结果（默认 unknown，未探测即不影响裁决）。
  health: McpHealthStatus;
  // managed registry 匹配结果。
  registry: { known: boolean; match: McpRegistryMatch; entry?: McpRegistryEntry };
  decision: McpDecision;
  // 人类可读的标记原因（供 UI / 日志 / 审计展示）。
  reasons: string[];
}

export interface McpGovernanceReport {
  findings: McpGovernanceFinding[];
  // 便捷索引：裁决为 deny 的 server id（审计口径，无论是否 enforcing）。
  deniedIds: string[];
  // 实际会被跳过的 server id：enforce 关闭时为空（report-only），开启时同 deniedIds。
  enforcedDeniedIds: string[];
  // 当前是否处于 enforcing（true 时 deny 真正生效）。
  enforce: boolean;
  // 出现任何非 allow 裁决（标记或拒绝）。
  flagged: boolean;
  // 用于回写基线：钉住清单中缺失、本次记为基线的 server。
  newBaselines: McpPinManifest;
}

const OPC_DIR = ".opc";
const ALLOWLIST_FILE = "mcp_allowlist.json";
const PINS_FILE = "mcp_pins.json";
const SIGNING_KEY_FILE = "mcp_signing.key";
const SIGNATURES_FILE = "mcp_signatures.json";
const REGISTRY_FILE = "mcp_registry.json";
const SIGNING_KEY_ENV = "OPC_MCP_SIGNING_KEY";
const ENFORCE_ENV = "OPC_MCP_ENFORCE";

// ── 稳定哈希 ────────────────────────────────────────────────────────────────

// 递归按 key 排序生成规范化 JSON，保证字段顺序不影响哈希。
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

// 描述符身份 = 决定"这个 server 实际会执行什么 / 注入什么描述"的字段。
// 刻意排除 id / createdAt / enabled / assignedAgents 等运行期元数据，
// 让 name/description（tool-poisoning 的高发位）与启动方式纳入指纹。
function descriptorIdentity(server: McpServerConfig): Record<string, unknown> {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env ?? {},
    name: server.name,
    description: server.description,
  };
}

export function descriptorHash(server: McpServerConfig): string {
  try {
    const canon = JSON.stringify(canonicalize(descriptorIdentity(server)));
    return "sha256:" + createHash("sha256").update(canon).digest("hex");
  } catch {
    // 永不抛：极端情况下退化为一个稳定但标注的占位哈希。
    return "sha256:unhashable";
  }
}

// ── 描述符签名（HMAC-SHA256，对称密钥） ──────────────────────────────────────
//
// 设计：用 env/.opc 提供的对称密钥对"描述符身份"（与 hash 同口径）做 HMAC 签名。
// 校验时重新计算并常数时间比对。密钥缺失 → 不视为篡改，仅降级为 hash 钉住。
// 所有函数绝不抛。

// 读取 HMAC 密钥：优先 env，其次 .opc/mcp_signing.key。缺失返回 undefined（降级）。
export function loadSigningKey(projectRoot: string): string | undefined {
  try {
    const env = process.env[SIGNING_KEY_ENV];
    if (typeof env === "string" && env.trim()) return env.trim();
    const fp = path.join(projectRoot, OPC_DIR, SIGNING_KEY_FILE);
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8").trim();
      if (raw) return raw;
    }
  } catch {
    /* 读取失败 → 降级为无密钥 */
  }
  return undefined;
}

// 对描述符身份签名。绝不抛：极端情况下退化为标注占位串。
export function signDescriptor(server: McpServerConfig, key: string): string {
  try {
    const canon = JSON.stringify(canonicalize(descriptorIdentity(server)));
    return "hmac-sha256:" + createHmac("sha256", key).update(canon).digest("hex");
  } catch {
    return "hmac-sha256:unsignable";
  }
}

// 校验签名：重算后常数时间比对。任何异常 → false（保守，视为不匹配）。
export function verifyDescriptorSignature(
  server: McpServerConfig,
  signature: string | undefined,
  key: string | undefined,
): boolean {
  try {
    if (!signature || !key) return false;
    const expected = signDescriptor(server, key);
    const a = Buffer.from(expected, "utf-8");
    const b = Buffer.from(signature, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// 计算单个 server 的签名状态（纯函数）。
export function signatureStatusFor(
  server: McpServerConfig,
  policy: McpGovernancePolicy,
): McpSignatureStatus {
  try {
    const key = policy.signingKey;
    if (!key) return "no-key";
    const sig = (policy.signatures ?? {})[server.id];
    if (!sig) return "unsigned";
    return verifyDescriptorSignature(server, sig, key) ? "signed-ok" : "sig-mismatch";
  } catch {
    return "unknown";
  }
}

// 读取签名清单：支持 Record<id,string> 或 { signatures: {...} } 两种形态。
export function loadSignatures(projectRoot: string, sigPath?: string): McpSignatureManifest {
  const fp = sigPath ?? path.join(projectRoot, OPC_DIR, SIGNATURES_FILE);
  const raw = readJsonSafe<any>(fp);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw.signatures && typeof raw.signatures === "object" ? raw.signatures : raw;
  const out: McpSignatureManifest = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

// 用给定密钥为一批 server 生成签名清单（供 CLI/初始化签发）。绝不抛。
export function buildSignatureManifest(servers: McpServerConfig[], key: string): McpSignatureManifest {
  const out: McpSignatureManifest = {};
  for (const s of servers) {
    try {
      if (s && typeof s.id === "string") out[s.id] = signDescriptor(s, key);
    } catch {
      /* 跳过畸形条目 */
    }
  }
  return out;
}

export function saveSignatures(
  projectRoot: string,
  signatures: McpSignatureManifest,
  sigPath?: string,
): boolean {
  const fp = sigPath ?? path.join(projectRoot, OPC_DIR, SIGNATURES_FILE);
  try {
    writeJSON(fp, signatures);
    return true;
  } catch {
    return false;
  }
}

// ── managed registry（已知良好 server + 元数据） ─────────────────────────────

// 读取 .opc/mcp_registry.json。支持 Record<id,entry>、数组、{ servers: [...] } 三种形态。
export function loadRegistry(projectRoot: string, registryPath?: string): McpRegistry {
  const fp = registryPath ?? path.join(projectRoot, OPC_DIR, REGISTRY_FILE);
  const raw = readJsonSafe<any>(fp);
  if (!raw || typeof raw !== "object") return {};
  const out: McpRegistry = {};
  const ingest = (entry: any) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return;
    out[entry.id] = {
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : undefined,
      expectedHash: typeof entry.expectedHash === "string" ? entry.expectedHash : undefined,
      packageName: typeof entry.packageName === "string" ? entry.packageName : undefined,
      source: typeof entry.source === "string" ? entry.source : undefined,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
    };
  };
  if (Array.isArray(raw)) {
    raw.forEach(ingest);
  } else if (Array.isArray(raw.servers)) {
    raw.servers.forEach(ingest);
  } else {
    for (const [id, v] of Object.entries(raw)) {
      if (v && typeof v === "object") ingest({ id, ...(v as object) });
    }
  }
  return out;
}

// 匹配 server 与注册表。绝不抛。
export function matchRegistry(
  server: McpServerConfig,
  registry: McpRegistry,
  hash: string,
  provenance?: McpProvenance,
): { known: boolean; match: McpRegistryMatch; entry?: McpRegistryEntry } {
  try {
    const entry = registry[server.id];
    if (!entry) return { known: false, match: "absent" };
    if (entry.expectedHash && entry.expectedHash !== hash) {
      return { known: true, match: "mismatch", entry };
    }
    if (entry.packageName && provenance?.packageName && entry.packageName !== provenance.packageName) {
      return { known: true, match: "mismatch", entry };
    }
    return { known: true, match: "match", entry };
  } catch {
    return { known: false, match: "absent" };
  }
}

// ── 健康探测（轻量、带超时、绝不抛、绝不阻塞 run） ──────────────────────────────

// 命令是否存在于 PATH（或为存在的绝对/相对路径）。同步、纯查文件系统，不 spawn。
function commandExists(cmd: string): boolean {
  try {
    const c = cmd.trim();
    if (!c) return false;
    const exts =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
    const hasSep = c.includes("/") || c.includes("\\");
    const tryPath = (base: string): boolean => {
      if (fs.existsSync(base)) return true;
      for (const ext of exts) {
        if (ext && fs.existsSync(base + ext)) return true;
      }
      return false;
    };
    if (hasSep) return tryPath(path.resolve(c));
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
      if (tryPath(path.join(d, c))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// url 可达性：发起一次 HEAD（失败则 GET）请求，任何 HTTP 响应都算可达。
// 连接错误/超时 → unhealthy。绝不抛。
function probeUrl(url: string, timeoutMs: number): Promise<McpHealthStatus> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: McpHealthStatus) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === "http:" ? http : https;
      const req = mod.request(
        url,
        { method: "HEAD", timeout: timeoutMs },
        (res) => {
          res.resume();
          finish("healthy"); // 收到任何响应即视为可达
        },
      );
      req.on("timeout", () => {
        try { req.destroy(); } catch { /* ignore */ }
        finish("unhealthy");
      });
      req.on("error", () => finish("unhealthy"));
      req.end();
    } catch {
      finish("unknown");
    }
  });
}

// 探测单个 server。stdio → 命令存在性；http/url → 可达性。绝不抛。
export async function probeServerHealth(
  server: McpServerConfig,
  opts?: { timeoutMs?: number },
): Promise<McpHealthStatus> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  try {
    if (server.transport === "http" || server.url) {
      const url = server.url;
      if (!url) return "unknown";
      return await probeUrl(url, timeoutMs);
    }
    const cmd = (server.command ?? "").trim();
    if (!cmd) return "unknown";
    return commandExists(cmd) ? "healthy" : "unhealthy";
  } catch {
    return "unknown";
  }
}

// 批量探测，返回 serverId → 状态。并发、单个失败不影响其他。绝不抛。
export async function probeHealth(
  servers: McpServerConfig[],
  opts?: { timeoutMs?: number },
): Promise<Record<string, McpHealthStatus>> {
  const out: Record<string, McpHealthStatus> = {};
  try {
    await Promise.all(
      servers.map(async (s) => {
        try {
          if (s && typeof s.id === "string") out[s.id] = await probeServerHealth(s, opts);
        } catch {
          if (s && typeof s.id === "string") out[s.id] = "unknown";
        }
      }),
    );
  } catch {
    /* 整体失败也返回已收集到的部分 */
  }
  return out;
}

// ── provenance ──────────────────────────────────────────────────────────────

export function serverProvenance(server: McpServerConfig): McpProvenance {
  try {
    if (server.transport === "http" || server.url) {
      return { source: "remote", origin: server.url ?? "(remote)" };
    }
    const cmd = (server.command ?? "").trim();
    const args = server.args ?? [];
    const origin = [cmd, ...args].filter(Boolean).join(" ").trim() || "(local)";
    const base = path.basename(cmd).toLowerCase();

    if (base === "npx" || base === "npx.cmd") {
      // npx [-y] <pkg> ... —— 取第一个非 flag 参数作为包名。
      const pkg = args.find((a) => a && !a.startsWith("-"));
      return { source: "npm", origin, packageName: pkg };
    }
    if (base === "uvx" || base === "pipx" || base === "uv") {
      const pkg = args.find((a) => a && !a.startsWith("-"));
      return { source: "pypi", origin, packageName: pkg };
    }
    if (!cmd) return { source: "unknown", origin };
    return { source: "local", origin };
  } catch {
    return { source: "unknown", origin: "(error)" };
  }
}

// ── 最小权限默认 ──────────────────────────────────────────────────────────────

const WRITE_HINTS = ["write", "commit", "delete", "exec", "shell", "filesystem", "fs", "edit", "push", "remove"];
const READ_HINTS = ["search", "fetch", "read", "memory", "thinking", "list", "get", "query", "lookup"];

// 不可信 / 漂移的 server 一律 needs-confirmation；可信则按关键词做最小权限推断，
// 无法判定时保守落到 restricted（最小权限优先，而非默认放开）。
export function defaultPermission(server: McpServerConfig, trust: McpTrustLevel): McpPermissionLevel {
  if (trust !== "trusted") return "needs-confirmation";
  try {
    const hay = `${server.id} ${server.name} ${server.description} ${(server.args ?? []).join(" ")}`.toLowerCase();
    if (WRITE_HINTS.some((w) => hay.includes(w))) return "restricted";
    if (READ_HINTS.some((r) => hay.includes(r))) return "read-only";
    return "restricted";
  } catch {
    return "restricted";
  }
}

// ── 策略加载（绝不抛） ────────────────────────────────────────────────────────

function readJsonSafe<T>(filepath: string): T | undefined {
  try {
    if (!fs.existsSync(filepath)) return undefined;
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function loadPins(projectRoot: string, pinsPath?: string): McpPinManifest {
  const fp = pinsPath ?? path.join(projectRoot, OPC_DIR, PINS_FILE);
  const raw = readJsonSafe<McpPinManifest>(fp);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // 过滤掉结构不合法的条目，避免后续误判。
  const out: McpPinManifest = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && typeof (v as any).hash === "string") {
      out[k] = { hash: (v as any).hash, pinnedAt: (v as any).pinnedAt ?? "", origin: (v as any).origin };
    }
  }
  return out;
}

export function savePins(projectRoot: string, pins: McpPinManifest, pinsPath?: string): boolean {
  const fp = pinsPath ?? path.join(projectRoot, OPC_DIR, PINS_FILE);
  try {
    writeJSON(fp, pins);
    return true;
  } catch {
    return false;
  }
}

// allowlist 文件支持两种形态：纯 id 数组，或 { servers, managedOnly }。
function loadAllowlist(projectRoot: string): { allowlist: string[]; managedOnly: boolean; found: boolean } {
  const fp = path.join(projectRoot, OPC_DIR, ALLOWLIST_FILE);
  const raw = readJsonSafe<unknown>(fp);
  if (raw === undefined) return { allowlist: [], managedOnly: false, found: false };
  if (Array.isArray(raw)) {
    return { allowlist: raw.filter((x) => typeof x === "string"), managedOnly: false, found: true };
  }
  if (raw && typeof raw === "object") {
    const o = raw as any;
    const list = Array.isArray(o.servers) ? o.servers.filter((x: unknown) => typeof x === "string") : [];
    return { allowlist: list, managedOnly: o.managedOnly === true, found: true };
  }
  return { allowlist: [], managedOnly: false, found: false };
}

// enforce 解析优先级：override > env(OPC_MCP_ENFORCE=0/false 关闭) > 缺省 true。
function resolveEnforce(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  const env = process.env[ENFORCE_ENV];
  if (typeof env === "string") {
    const v = env.trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  }
  return true;
}

export function loadPolicy(projectRoot: string, overrides?: Partial<McpGovernancePolicy>): McpGovernancePolicy {
  const { allowlist, managedOnly } = loadAllowlist(projectRoot);
  const pins = loadPins(projectRoot);
  const signingKey = overrides?.signingKey ?? loadSigningKey(projectRoot);
  const signatures = overrides?.signatures ?? loadSignatures(projectRoot);
  const registry = overrides?.registry ?? loadRegistry(projectRoot);
  return {
    allowlist: overrides?.allowlist ?? allowlist,
    managedOnly: overrides?.managedOnly ?? managedOnly,
    onViolation: overrides?.onViolation ?? "mark-and-allow",
    pins: overrides?.pins ?? pins,
    enforce: resolveEnforce(overrides?.enforce),
    signingKey,
    signatures,
    registry,
  };
}

// ── 单 server 评估（纯函数，绝不抛） ───────────────────────────────────────────

export function evaluateServer(
  server: McpServerConfig,
  policy: McpGovernancePolicy,
  health: McpHealthStatus = "unknown",
): McpGovernanceFinding {
  const reasons: string[] = [];
  let hash = "sha256:unhashable";
  let provenance: McpProvenance = { source: "unknown", origin: "(error)" };
  let allowlisted = false;
  let pinStatus: McpPinStatus = "unknown";
  let signatureStatus: McpSignatureStatus = "unknown";
  let registry: { known: boolean; match: McpRegistryMatch; entry?: McpRegistryEntry } = {
    known: false,
    match: "absent",
  };

  try {
    hash = descriptorHash(server);
    provenance = serverProvenance(server);
    allowlisted = policy.allowlist.includes(server.id);

    if (!allowlisted) {
      reasons.push("not in allowlist — untrusted server");
    }

    const pin = policy.pins[server.id];
    if (!pin) {
      pinStatus = "baseline";
      reasons.push("no pin recorded — captured current descriptor as baseline");
    } else if (pin.hash === hash) {
      pinStatus = "pinned-ok";
    } else {
      pinStatus = "drift";
      reasons.push(`descriptor drift — pinned ${pin.hash.slice(0, 16)} != current ${hash.slice(0, 16)}`);
    }

    // 描述符签名校验（HMAC）。无密钥 → no-key（仅 hash 钉住，不视为违规）。
    signatureStatus = signatureStatusFor(server, policy);
    if (signatureStatus === "sig-mismatch") {
      reasons.push("descriptor signature mismatch — possible tampering");
    }

    // managed registry 匹配。
    registry = matchRegistry(server, policy.registry ?? {}, hash, provenance);
    if (registry.match === "mismatch") {
      reasons.push("registry mismatch — descriptor diverges from known-good entry");
    }

    // 健康探测结果（由调用方传入；默认 unknown 不影响裁决）。
    if (health === "unhealthy") {
      reasons.push("health probe failed — server unreachable/unhealthy");
    }
  } catch {
    reasons.push("governance check errored — conservatively flagged");
  }

  const trust: McpTrustLevel = allowlisted ? "trusted" : "untrusted";
  const permission = defaultPermission(server, trust);

  // 裁决：白名单未命中 / 描述符漂移 / 签名不符 / 注册表不符 → 违规。
  // managedOnly 对未授权强制 deny；其余按 onViolation。
  // 健康探测失败仅标记（mark-and-allow），不单独 deny —— 探测属尽力而为，避免误杀。
  let decision: McpDecision = "allow";
  const untrustedViolation = !allowlisted;
  const driftViolation = pinStatus === "drift";
  const signatureViolation = signatureStatus === "sig-mismatch";
  const registryViolation = registry.match === "mismatch";
  const anyViolation = untrustedViolation || driftViolation || signatureViolation || registryViolation;

  if (untrustedViolation && policy.managedOnly) {
    decision = "deny";
    reasons.push("managed-only mode: unlisted server denied");
  } else if (anyViolation) {
    decision = policy.onViolation === "deny" ? "deny" : "mark-and-allow";
  } else if (health === "unhealthy") {
    decision = "mark-and-allow";
  }

  return {
    serverId: server.id,
    name: server.name,
    enabled: server.enabled,
    trust,
    allowlisted,
    descriptorHash: hash,
    pinStatus,
    provenance,
    permission,
    signatureStatus,
    health,
    registry,
    decision,
    reasons,
  };
}

// ── 批量评估 ──────────────────────────────────────────────────────────────────

export function evaluateGovernance(
  servers: McpServerConfig[],
  policy: McpGovernancePolicy,
  healthMap?: Record<string, McpHealthStatus>,
): McpGovernanceReport {
  const findings: McpGovernanceFinding[] = [];
  const newBaselines: McpPinManifest = {};
  for (const s of servers) {
    let f: McpGovernanceFinding;
    try {
      const health = (s && healthMap && healthMap[s.id]) || "unknown";
      f = evaluateServer(s, policy, health);
    } catch {
      // evaluateServer 已内部兜底，这里是双保险：任何意外都不让批量评估中断。
      f = {
        serverId: s?.id ?? "(unknown)",
        name: s?.name ?? "(unknown)",
        enabled: !!s?.enabled,
        trust: "untrusted",
        allowlisted: false,
        descriptorHash: "sha256:unhashable",
        pinStatus: "unknown",
        provenance: { source: "unknown", origin: "(error)" },
        permission: "needs-confirmation",
        signatureStatus: "unknown",
        health: "unknown",
        registry: { known: false, match: "absent" },
        decision: policy.onViolation === "deny" ? "deny" : "mark-and-allow",
        reasons: ["fatal governance error — conservatively flagged"],
      };
    }
    if (f.pinStatus === "baseline") {
      newBaselines[f.serverId] = {
        hash: f.descriptorHash,
        pinnedAt: new Date().toISOString(),
        origin: f.provenance.origin,
      };
    }
    findings.push(f);
  }
  const deniedIds = findings.filter((f) => f.decision === "deny").map((f) => f.serverId);
  const enforce = policy.enforce !== false; // 缺省 true
  const enforcedDeniedIds = enforce ? deniedIds : [];
  const flagged = findings.some((f) => f.decision !== "allow");
  return { findings, deniedIds, enforcedDeniedIds, enforce, flagged, newBaselines };
}

// ── 便捷入口：从磁盘加载策略 + 评估 + （可选）回写基线 ─────────────────────────

export interface GovernMcpServersResult extends McpGovernanceReport {
  policy: McpGovernancePolicy;
}

// mcpToolBridge 在加载前调用。绝不抛：任何失败都返回一个"全部标记放行"的保守报告。
export function governMcpServers(
  projectRoot: string,
  servers: McpServerConfig[],
  overrides?: Partial<McpGovernancePolicy>,
  opts?: { recordBaseline?: boolean; health?: Record<string, McpHealthStatus> },
): GovernMcpServersResult {
  let policy: McpGovernancePolicy;
  try {
    policy = loadPolicy(projectRoot, overrides);
  } catch {
    policy = {
      allowlist: [],
      managedOnly: false,
      onViolation: "mark-and-allow",
      pins: {},
      enforce: true,
      signatures: {},
      registry: {},
    };
  }
  const report = evaluateGovernance(servers, policy, opts?.health);

  // 缺失的钉住条目可选地回写为基线（首次见到即固定，便于后续检测替换）。
  if (opts?.recordBaseline && Object.keys(report.newBaselines).length > 0) {
    try {
      const merged: McpPinManifest = { ...policy.pins, ...report.newBaselines };
      savePins(projectRoot, merged);
    } catch {
      /* 回写失败不影响裁决 */
    }
  }

  return { ...report, policy };
}

// ── B5 · MCP 能力版本摘要（Run Ledger 写入用） ─────────────────────────────────
//
// serverId → "版本+hash 短串"。版本尽力从包名 spec（pkg@1.2.3 / @scope/pkg@2.0.0）解析,
// 解析不出只留 hash 短串（诚实,不虚构版本号）;hash 取 descriptorHash 前 12 位 hex,
// 短到能进 ledger、又足以区分描述符替换。只含 enabled server —— 摘要口径是
// "本次 run 实际可用的 MCP 能力"。本批只建函数,不接 orchestrator。绝不抛:任何失败返回 {}。

export type McpCapabilityVersions = Record<string, string>;

function shortDescriptorHash(hash: string): string {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return "sha256:" + hex.slice(0, 12);
}

// 从 provenance.packageName 解析显式版本:最后一个 "@"(位置 >0,排除 scope 前缀)之后的部分。
function parsePackageVersion(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined;
  const at = packageName.lastIndexOf("@");
  if (at <= 0) return undefined;
  const ver = packageName.slice(at + 1).trim();
  return ver || undefined;
}

export function getMcpCapabilityVersions(projectRoot: string): McpCapabilityVersions {
  const out: McpCapabilityVersions = {};
  try {
    for (const s of listMcpServers(projectRoot)) {
      try {
        if (!s || typeof s.id !== "string" || !s.id || !s.enabled) continue;
        const h = shortDescriptorHash(descriptorHash(s));
        const ver = parsePackageVersion(serverProvenance(s).packageName);
        out[s.id] = ver ? `${ver}+${h}` : h;
      } catch {
        /* 单个 server 失败不影响其它 */
      }
    }
  } catch {
    /* 读取失败 → 空摘要 */
  }
  return out;
}

// 异步便捷入口：先（可选）做轻量健康探测，再评估。供 mcpToolBridge 加载前调用。
// 绝不抛、绝不阻塞 run：探测失败/超时只标记 unhealthy，不改变默认放行语义。
export async function governMcpServersAsync(
  projectRoot: string,
  servers: McpServerConfig[],
  overrides?: Partial<McpGovernancePolicy>,
  opts?: { recordBaseline?: boolean; probe?: boolean; probeTimeoutMs?: number },
): Promise<GovernMcpServersResult> {
  let health: Record<string, McpHealthStatus> | undefined;
  if (opts?.probe) {
    try {
      health = await probeHealth(servers, { timeoutMs: opts.probeTimeoutMs });
    } catch {
      health = undefined; // 探测整体失败 → 退化为不带健康信息（全部 unknown）
    }
  }
  return governMcpServers(projectRoot, servers, overrides, {
    recordBaseline: opts?.recordBaseline,
    health,
  });
}
