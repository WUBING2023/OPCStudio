import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "@opc/shared";
import { listMcpServers } from "../storage/mcpStore.js";
import { evaluateServer, governMcpServersAsync, loadPolicy } from "./mcpGovernance.js";
import { validMcpApproval } from "./mcpApproval.js";
import type { ToolDef, ToolParamSchema } from "./tools.js";
import { normalizeStdioCommand, validateCommandArgs, validateProcessEnvPatch } from "../security/localGuards.js";

// Minimal MCP stdio client (newline-delimited JSON-RPC 2.0) — no @modelcontextprotocol/sdk
// dependency. One short-lived session per discovery/call: spawn → initialize → method → kill.
// Bounded by a timeout; unreachable/slow servers are skipped (never block the run).

export interface McpTool {
  serverId: string;
  name: string;            // namespaced: mcp__<serverId>__<toolName>
  description: string;
  inputSchema: ToolParamSchema;
}

// Bug 排查(端到端验证抓出研究团队完全降级归零,追查根因):每次 MCP 调用都是全新 spawn 子进程,完全没有
// 进程复用("One short-lived session per discovery/call")——uvx 冷启动(解析 Python 环境)+ 真实网络往返,
// 在 5 个 worker 并发抢 CPU 时,8 秒的默认超时大概率不够,连接被杀后 worker 拿到空结果,LLM 面对空结果编出
// "DNS 解析失败"这类像模像样但未必真实的诊断。调大到 25s——tools/call(真正干活,含冷启动+网络往返)需要
// 比 tools/list(纯发现/握手)更宽裕的窗口,仍然"超时即跳过、绝不卡死整个 run"的既有设计哲学不变。
// MUP Gate A#4 · MCP 文件边界(第一道):spawn MCP 子进程时把 cwd 钉在 worker 的隔离工作目录
// (opts.cwd,tools/call 由 callMcpTool 透传;tools/list 发现阶段传 projectRoot)——相对路径型
// server 的文件读写落点因此进入 worker workdir 而非 OPC server 进程目录。cwd 目录不存在时不传
// (spawn ENOENT 会把"目录没了"伪装成"server 不可用",诚实回退继承并保留既有行为)。
// initialize 握手时序与 25s 超时契约不变。
function mcpSession(server: McpServerConfig, method: string, params: unknown, timeoutMs = 25000, opts?: { cwd?: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    if (server.transport !== "stdio" || !server.command) {
      return reject(new Error("only stdio MCP servers are supported"));
    }
    const command = normalizeStdioCommand(server.command);
    const args = validateCommandArgs(server.args ?? [], command);
    const envPatch = validateProcessEnvPatch(server.env ?? {});
    let cwd: string | undefined;
    try { cwd = (opts?.cwd && fs.statSync(opts.cwd).isDirectory()) ? opts.cwd : undefined; } catch { cwd = undefined; }
    const child: any = spawn(command, args, {
      env: { ...process.env, ...envPatch },
      ...(cwd ? { cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let buf = "";
    let settled = false;
    const finish = (err: Error | null, val?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`mcp ${method} timeout`)), timeoutMs);
    const send = (msg: unknown) => { try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* closed */ } };

    child.on("error", (e: any) => finish(e instanceof Error ? e : new Error(String(e))));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // initialize ack → announce initialized, then invoke the real method
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method, params });
        } else if (msg.id === 2) {
          if (msg.error) finish(new Error(msg.error.message || "mcp error"));
          else finish(null, msg.result);
        }
      }
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "opc-studio", version: "1" } } });
  });
}

export async function discoverMcpTools(projectRoot: string): Promise<McpTool[]> {
  const all = listMcpServers(projectRoot).filter((s) => s.enabled && s.transport === "stdio" && s.command);

  // P7/WS7 供应链治理：加载前评估一次（绝不抛）。默认策略只标记不拦截；
  // 仅当 enforcing 开启且策略 deny（managedOnly / onViolation=deny / 签名不符 /
  // 注册表不符）时才真正跳过对应 server。enforce 默认 true，但默认策略为
  // mark-and-allow 不产生 deny，故既有加载语义在默认配置下完全不变（零回归）。
  // probe 做轻量健康探测（命令存在性 / url 可达性，带超时），不可达只标记 unhealthy。
  let servers = all;
  try {
    const gov = await governMcpServersAsync(projectRoot, all, undefined, {
      recordBaseline: true,
      probe: true,
      probeTimeoutMs: 2000,
    });
    const denied = new Set(gov.enforcedDeniedIds);
    for (const finding of gov.findings) {
      if (finding.permission === "needs-confirmation") {
        const server = all.find((candidate) => candidate.id === finding.serverId);
        if (!server || !validMcpApproval(projectRoot, server)) denied.add(finding.serverId);
      }
    }
    servers = all.filter((s) => !denied.has(s.id));
    for (const f of gov.findings) {
      if (f.decision !== "allow" || f.health === "unhealthy") {
        const enforced = gov.enforce && f.decision === "deny" ? " [enforced:skipped]" : "";
        console.warn(
          `[mcp-governance] ${f.serverId}: ${f.decision} (${f.permission}, ${f.signatureStatus}, ${f.health})${enforced} — ${f.reasons.join("; ")}`,
        );
      }
    }
  } catch {
    /* 治理失败绝不阻断加载 */
  }

  const out: McpTool[] = [];
  for (const s of servers) {
    try {
      // 发现阶段无 worker 上下文 → cwd 用 projectRoot(A#4:发现/握手也不再继承 server 进程目录)。
      const res = await mcpSession(s, "tools/list", {}, undefined, { cwd: projectRoot });
      for (const t of res?.tools ?? []) {
        out.push({
          serverId: s.id,
          name: `mcp__${s.id}__${t.name}`,
          description: t.description ?? t.name,
          inputSchema: { properties: t.inputSchema?.properties ?? {}, required: t.inputSchema?.required ?? [] },
        });
      }
    } catch { /* skip unreachable/slow server */ }
  }
  return out;
}

// MUP Gate A#4 · MCP 文件边界(第二道):cwd 只能约束相对路径型 server,工具入参里的**绝对路径**
// 必须落在 allowed roots(worker workdir/worktree)之内,越界一律拒绝。递归扫 args 里的字符串值
// (含嵌套 object/array,限深防环),用与 pathGuard.resolveSafe 同款的 base+sep 前缀判定
// (Windows 大小写不敏感归一)。导出为纯函数供单测直接验证。
export function findEscapingAbsolutePaths(args: unknown, allowedRoots: string[], depth = 0): string[] {
  if (depth > 6 || args == null) return [];
  if (typeof args === "string") {
    if (!path.isAbsolute(args)) return [];
    // Windows 上 "/x/y" 形态的字符串多半是 URL path(GitHub API 类 MCP 工具入参)而非文件系统路径
    // (path.isAbsolute 对它也返回 true)——只有它在本机真实存在时才按路径对待,否则放行;
    // 盘符/UNC 形态无歧义,一律按路径校验。诚实边界:不存在的 "/x" 写入面留给 cwd 边界兜底。
    if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(args) && !args.startsWith("\\\\")) {
      try { if (!fs.existsSync(path.resolve(args))) return []; } catch { return []; }
    }
    const norm = (p: string) => {
      const r = path.resolve(p).replace(/[\\/]+$/, "");
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    const target = norm(args);
    const inside = allowedRoots.some((root) => {
      const base = norm(root);
      return target === base || target.startsWith(base + path.sep);
    });
    return inside ? [] : [args];
  }
  if (Array.isArray(args)) return args.flatMap((v) => findEscapingAbsolutePaths(v, allowedRoots, depth + 1));
  if (typeof args === "object") return Object.values(args as Record<string, unknown>).flatMap((v) => findEscapingAbsolutePaths(v, allowedRoots, depth + 1));
  return [];
}

// workdir(可选)= 本次调用所属 worker 的隔离工作目录(经 tools.ts 的 ALS root 透传):
// ① 作为 MCP 子进程 spawn cwd(相对路径边界);② 作为绝对路径入参的 allowed root(越界拒绝,
// 诚实报错给模型而不是静默放行)。缺省(发现期/历史调用路径)保持旧行为:不校验、cwd 回退 projectRoot。
export async function callMcpTool(projectRoot: string, fullName: string, args: Record<string, any>, workdir?: string): Promise<string> {
  const m = fullName.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return `Error: not an MCP tool: ${fullName}`;
  const [, serverId, toolName] = m;
  const server = listMcpServers(projectRoot).find((s) => s.id === serverId);
  if (!server) return `Error: MCP server ${serverId} not found`;
  if (!server.enabled) return `Error: MCP server ${serverId} is disabled`;
  try {
    const finding = evaluateServer(server, loadPolicy(projectRoot));
    if (finding.decision === "deny") return `Error: MCP server ${serverId} is denied by governance policy`;
    if (finding.permission === "needs-confirmation" && !validMcpApproval(projectRoot, server)) {
      return `Error: MCP server ${serverId} requires a current configuration-bound approval`;
    }
  } catch {
    return `Error: MCP server ${serverId} governance evaluation failed`;
  }
  if (workdir) {
    const escaping = findEscapingAbsolutePaths(args, [workdir]);
    if (escaping.length > 0) {
      return `Error: MCP 参数包含隔离工作目录之外的绝对路径,已拒绝(请改用相对当前工作目录的路径): ${escaping.slice(0, 3).join(", ")}`;
    }
  }
  try {
    const res = await mcpSession(server, "tools/call", { name: toolName, arguments: args }, undefined, { cwd: workdir || projectRoot });
    const content = res?.content;
    if (Array.isArray(content)) return content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n").slice(0, 4000);
    return JSON.stringify(res ?? {}).slice(0, 4000);
  } catch (e: any) {
    return `Error: MCP call failed: ${e?.message || e}`;
  }
}

// getWorkdir(可选):调用期现取 worker 隔离工作目录的取值器——tools.ts 组装 ToolDef 时应传
// `() => currentRoot()`(runTool 的 AsyncLocalStorage per-call root),让并发 worker 各自的
// MCP 调用绑定各自的 workdir。缺省 = 旧行为(不绑定,cwd 回退 projectRoot)。
export function mcpToolToToolDef(t: McpTool, projectRoot: string, getWorkdir?: () => string | undefined): ToolDef {
  return {
    name: t.name,
    description: t.description,
    paramSchema: t.inputSchema,
    source: "mcp",
    mcpServerId: t.serverId,
    execute: async (args) => callMcpTool(projectRoot, t.name, args, getWorkdir?.()),
  };
}
