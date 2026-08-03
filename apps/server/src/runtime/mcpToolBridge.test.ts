import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { callMcpTool, mcpToolToToolDef, findEscapingAbsolutePaths, type McpTool } from "./mcpToolBridge.js";
import { approveMcpServer, revokeMcpApproval } from "./mcpApproval.js";

// MUP Gate A#4 · MCP 文件边界:
//   ① 工具入参里的绝对路径必须落在 worker 隔离工作目录内,越界拒绝并诚实报错(findEscapingAbsolutePaths);
//   ② callMcpTool 的越界拒绝发生在 spawn 之前(错误文案是"已拒绝",不是"MCP call failed");
//   ③ mcpToolToToolDef 经 getWorkdir 取值器把 per-call workdir 绑定进 execute;
//   ④ 未传 workdir(发现期/历史路径)保持旧行为:不校验。

let projectRoot: string;
let workdir: string;
let outside: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bridge-"));
  workdir = path.join(projectRoot, "wt", "worker-1");
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-outside-"));
  fs.mkdirSync(path.join(projectRoot, ".opc"), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  const server = { id: "fsx", name: "fsx", description: "", transport: "stdio" as const, command: "definitely-not-a-real-cmd-opc", args: [], enabled: true, assignedAgents: [], createdAt: "2026-01-01" };
  fs.writeFileSync(path.join(projectRoot, ".opc", "mcp_servers.json"), JSON.stringify([server]));
  approveMcpServer(projectRoot, server);
});

afterEach(() => {
  for (const d of [projectRoot, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

describe("MCP approval execution boundary", () => {
  it("blocks a direct call before spawn when approval is missing", async () => {
    revokeMcpApproval(projectRoot, "fsx");
    const out = await callMcpTool(projectRoot, "mcp__fsx__read", { path: path.join(workdir, "a.txt") }, workdir);
    expect(out).toContain("requires a current configuration-bound approval");
    expect(out).not.toContain("MCP call failed");
  });
});

describe("findEscapingAbsolutePaths — 允许根判定(纯函数)", () => {
  it("workdir 内的绝对路径放行;workdir 外的绝对路径判越界(含嵌套 object/array)", () => {
    const inside = path.join(workdir, "sub", "a.txt");
    const evil = path.join(outside, "b.txt");
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    fs.writeFileSync(evil, "x", "utf-8");
    expect(findEscapingAbsolutePaths({ path: inside }, [workdir])).toEqual([]);
    expect(findEscapingAbsolutePaths({ path: evil }, [workdir])).toEqual([evil]);
    expect(findEscapingAbsolutePaths({ nested: { list: ["rel.txt", evil] } }, [workdir])).toEqual([evil]);
  });

  it("相对路径/普通字符串不参与校验;根本身也放行", () => {
    expect(findEscapingAbsolutePaths({ path: "src/a.ts", note: "hello world" }, [workdir])).toEqual([]);
    expect(findEscapingAbsolutePaths({ path: workdir }, [workdir])).toEqual([]);
  });

  it("前缀碰撞不放行:workdir-evil 不属于 workdir", () => {
    const collide = `${workdir}-evil`;
    fs.mkdirSync(collide, { recursive: true });
    expect(findEscapingAbsolutePaths({ path: path.join(collide, "x.txt") }, [workdir])).toEqual([path.join(collide, "x.txt")]);
  });
});

describe("callMcpTool — 越界拒绝先于 spawn(诚实报错)", () => {
  it("绑定 workdir 时,越界绝对路径入参 → 返回'已拒绝'错误,不是 spawn 失败", async () => {
    const evil = path.join(outside, "secret.txt");
    fs.writeFileSync(evil, "s", "utf-8");
    const out = await callMcpTool(projectRoot, "mcp__fsx__read", { path: evil }, workdir);
    expect(out).toContain("已拒绝");
    expect(out).toContain("绝对路径");
    expect(out).not.toContain("MCP call failed");
  });

  it("workdir 内的绝对路径入参 → 放行,继续走真实调用链(此处 spawn 不存在的命令 → 诚实的 call failed)", async () => {
    const inside = path.join(workdir, "a.txt");
    const out = await callMcpTool(projectRoot, "mcp__fsx__read", { path: inside }, workdir);
    expect(out).toContain("MCP call failed");
  });

  it("未传 workdir(发现期/历史调用路径)→ 不做入参校验(向后兼容旧行为)", async () => {
    const evil = path.join(outside, "secret.txt");
    fs.writeFileSync(evil, "s", "utf-8");
    const out = await callMcpTool(projectRoot, "mcp__fsx__read", { path: evil });
    expect(out).toContain("MCP call failed"); // 走到 spawn 失败,而不是被边界拒绝
  });
});

describe("mcpToolToToolDef — getWorkdir 取值器绑定 per-call 工作目录", () => {
  const tool: McpTool = { serverId: "fsx", name: "mcp__fsx__read", description: "read", inputSchema: { properties: {}, required: [] } };

  it("传入 getWorkdir → execute 内的越界入参被拒绝", async () => {
    const evil = path.join(outside, "c.txt");
    fs.writeFileSync(evil, "x", "utf-8");
    const def = mcpToolToToolDef(tool, projectRoot, () => workdir);
    const out = await def.execute({ path: evil });
    expect(out).toContain("已拒绝");
  });

  it("不传 getWorkdir → 维持旧行为(不校验)", async () => {
    const evil = path.join(outside, "c.txt");
    fs.writeFileSync(evil, "x", "utf-8");
    const def = mcpToolToToolDef(tool, projectRoot);
    const out = await def.execute({ path: evil });
    expect(out).toContain("MCP call failed");
  });
});
