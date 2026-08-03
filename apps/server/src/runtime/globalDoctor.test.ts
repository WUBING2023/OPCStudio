import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runGlobalDoctor, readLatestDoctorReport, checkProviderEnvironment, type DoctorDeps, type DoctorReport } from "./globalDoctor.js";

// E2 Global Doctor 单测:全部探针经 DoctorDeps 注入 fake——不打外网、不依赖本机装没装 CLI、
// 不读任何真实 key。文件系统类检查(store/workdir/runs/落盘)走临时目录真实读写。

let root: string;

function setupRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "global-doctor-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  return root;
}

afterEach(() => {
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function writeAgents(agents: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
}

function writeConfig(config: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify(config));
}

function fakeDeps(over: DoctorDeps = {}): DoctorDeps {
  return {
    probeEngine: async (fw) => ({ framework: fw as any, installed: true, loggedIn: true, version: "1.0.0" }),
    syncProviders: () => { /* no-op */ },
    providerRegistered: (p) => p === "deepseek",
    testProviderConnectivity: async () => ({ ok: true, message: "HTTP 200 · 10ms" }),
    probeMcp: async () => ({}),
    // deep 层(E5)默认 fake:全部离线可控,不真占端口/不真起进程/不打外网。
    checkPortOccupancy: async (port) => port === 3100,
    checkOrphanWorktreeProcesses: () => ({ hasRegistry: false, orphans: [] }),
    resolveModule: (id) => `/fake/node_modules/${id}/index.js`,
    checkFileLock: () => ({ ok: true, message: "可获取写锁" }),
    fetchCommunityRegistryReachable: async () => ({ ok: true, message: "HTTP 200 · 5ms" }),
    ...over,
  };
}

function check(report: DoctorReport, id: string) {
  const c = report.checks.find(x => x.id === id);
  expect(c, `check ${id} 应存在`).toBeDefined();
  return c!;
}

describe("runGlobalDoctor — basic 全绿路径", () => {
  it("文件系统/引擎/provider key/MCP/systemModel 全 ok → status ok,并落盘 latest + 时间戳文件", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true },
      { id: "a2", name: "B", role: "dev", provider: "anthropic", framework: "claude-code", enabled: true },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());

    expect(report.status).toBe("ok");
    expect(report.level).toBe("basic");
    expect(typeof report.checked_at).toBe("string");
    expect(check(report, "store.json_rw").status).toBe("ok");
    expect(check(report, "fs.workdir_writable").status).toBe("ok");
    expect(check(report, "fs.runs_writable").status).toBe("ok");
    // 引擎体检只覆盖三大订阅:claude-code 员工被探,hermes 员工不进报告(用户实测反馈)
    expect(check(report, "engine.claude-code").status).toBe("ok");
    expect(report.checks.find(c => c.id === "engine.hermes")).toBeUndefined();
    expect(check(report, "provider.keys").status).toBe("ok");
    expect(check(report, "mcp.config").status).toBe("ok");
    expect(check(report, "system_model_provider_registered").status).toBe("ok");

    // 落盘:doctor-reports 下 1 个时间戳文件 + latest.json,latest 与返回值一致
    const dir = path.join(root, ".opc", "doctor-reports");
    const files = fs.readdirSync(dir);
    expect(files).toContain("latest.json");
    expect(files.filter(f => f !== "latest.json")).toHaveLength(1);
    expect(readLatestDoctorReport(root)).toEqual(report);

    // 探测文件已清理,不留垃圾
    expect(fs.readdirSync(path.join(root, ".opc")).filter(f => f.startsWith("doctor-probe-"))).toHaveLength(0);
    // 报告体里绝不出现任何 key 值形态的内容(只查有无,不读值)
    expect(JSON.stringify(report)).not.toMatch(/sk-|api[_-]?key["':\s]*[A-Za-z0-9]{8}/i);
  });
});

describe("runGlobalDoctor — basic degraded 路径", () => {
  it("引擎未安装 → engine.<fw> failed(warning),整体 warning", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "claude-code", enabled: true }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      probeEngine: async (fw) => ({ framework: fw as any, installed: false, loggedIn: false, version: "", detail: "未检测到 claude CLI" }),
    }));
    const c = check(report, "engine.claude-code");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("未检测到");
    // claude-code 是 CLI 订阅制框架,不需要 provider key → provider.keys 不因它报缺
    expect(check(report, "provider.keys").status).toBe("ok");
    expect(report.status).toBe("warning");
  });

  it("引擎探测超时(null)→ skipped(info),不误报未安装、不降级整体状态", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "anthropic", framework: "claude-code", enabled: true }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ probeEngine: async () => null }));
    const c = check(report, "engine.claude-code");
    expect(c.status).toBe("skipped");
    expect(c.severity).toBe("info");
    expect(report.status).toBe("ok");
  });

  it("引擎体检只保留三订阅:hermes 与第三方 CLI(opencode 等)员工不产出 engine.* 检查项", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true },
      { id: "a2", name: "B", role: "dev", provider: "openai", framework: "opencode", enabled: true },
      { id: "a3", name: "C", role: "dev", provider: "openai", framework: "codex", enabled: true },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    // 用户实测反馈:hermes / opencode 都不应出现在体检报告里
    expect(report.checks.find(c => c.id === "engine.hermes")).toBeUndefined();
    expect(report.checks.find(c => c.id === "engine.opencode")).toBeUndefined();
    // 三大订阅里被真正使用的(codex)照常体检
    expect(check(report, "engine.codex").status).toBe("ok");
  });

  it("非 CLI 员工的 provider 未注册 → provider.keys failed(warning),消息点名缺谁", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "A", role: "dev", provider: "minimax", framework: "hermes", enabled: true },
      { id: "a2", name: "B", role: "test", provider: "deepseek", framework: "hermes", enabled: true },
      { id: "a3", name: "C", role: "dev", provider: "doubao", framework: "hermes", enabled: false }, // disabled 不参与
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    const c = check(report, "provider.keys");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("minimax");
    expect(c.message).not.toContain("doubao");
    expect(report.status).toBe("warning");
  });

  it(".opc 被文件占位(store 不可用)→ store.json_rw / fs.runs_writable failed(error),整体 error;落盘失败仍返回报告", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "global-doctor-"));
    fs.writeFileSync(path.join(root, ".opc"), "not a directory");
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    expect(check(report, "store.json_rw").status).toBe("failed");
    expect(check(report, "store.json_rw").severity).toBe("error");
    expect(check(report, "fs.runs_writable").status).toBe("failed");
    expect(check(report, "fs.workdir_writable").status).toBe("ok");
    expect(report.status).toBe("error");
    // doctor-reports 无法创建 → persistReport 静默失败,但体检结果照常返回、latest 读取不抛
    expect(readLatestDoctorReport(root)).toBeNull();
  });

  it("mcp_servers.json 损坏 → mcp.config failed(warning)", async () => {
    setupRoot();
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), "{ not valid json");
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    const c = check(report, "mcp.config");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(report.status).toBe("warning");
  });
});

describe("runGlobalDoctor — system_model_provider_registered(无 key 自动订阅替换三态)", () => {
  // 三态里的 API 面配置需显式标 framework:hermes,否则 creative→anthropic 会被推断成 claude-code 订阅态。
  function writeApiSystemModel(creativeProvider: string) {
    writeConfig({
      version: "0.1.0", projectName: "t", apiKeys: {}, defaultModel: "deepseek-chat",
      systemModel: {
        creative: { framework: "hermes", provider: creativeProvider, model: "some-model" },
        judge: { framework: "hermes", provider: "deepseek", model: "deepseek-chat" },
      },
    });
  }

  it("无 key 且未装对应订阅 → failed(error),整体 error(点名 provider + 订阅)", async () => {
    setupRoot();
    writeApiSystemModel("anthropic");
    // registered 只有 deepseek;claude-code 订阅未安装 → creative 无处可去
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      probeEngine: async (fw) => ({ framework: fw as any, installed: false, loggedIn: false, version: "" }),
    }));
    const c = check(report, "system_model_provider_registered");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("error");
    expect(c.message).toContain("默认模型");
    expect(c.message).toContain("anthropic");
    expect(c.message).toContain("claude-code");
    expect(report.status).toBe("error");
  });

  it("无 key 但已装对应订阅 → ok(info),消息含「已自动使用 claude-code 订阅」,不降级整体状态", async () => {
    setupRoot();
    writeApiSystemModel("anthropic");
    // deepseek 有 key、anthropic 没有;claude-code 订阅已装 → creative 自动落订阅
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      probeEngine: async (fw) => ({ framework: fw as any, installed: true, loggedIn: true, version: "1.0.0" }),
    }));
    const c = check(report, "system_model_provider_registered");
    expect(c.status).toBe("ok");
    expect(c.severity).toBe("info");
    expect(c.message).toContain("claude-code");
    expect(c.message).toContain("自动");
    expect(report.status).toBe("ok");
  });

  it("有 key → ok(error 级),照旧视为均已注册", async () => {
    setupRoot();
    writeApiSystemModel("deepseek"); // creative/judge 都是 deepseek,已注册
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    const c = check(report, "system_model_provider_registered");
    expect(c.status).toBe("ok");
    expect(report.status).toBe("ok");
  });

  it("未配置 systemModel → fallback deepseek 已注册 → ok;deepseek 无 key 且无订阅映射 → error", async () => {
    setupRoot();
    const ok = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    expect(check(ok, "system_model_provider_registered").status).toBe("ok");

    // deepseek 没注册、也没有对应订阅可替(无映射)→ 真漂移
    const bad = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ providerRegistered: () => false }));
    const c = check(bad, "system_model_provider_registered");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("error");
    expect(bad.status).toBe("error");
  });
});

describe("runGlobalDoctor — 落盘与 latest 更新", () => {
  it("连跑两次 → 两个时间戳文件互不覆盖,latest.json 指向第二次", async () => {
    setupRoot();
    const t1 = new Date("2026-07-07T01:00:00.000Z");
    const t2 = new Date("2026-07-07T02:00:00.000Z");
    await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ now: () => t1 }));
    await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ now: () => t2 }));

    const dir = path.join(root, ".opc", "doctor-reports");
    const stamped = fs.readdirSync(dir).filter(f => f !== "latest.json");
    expect(stamped).toHaveLength(2);
    expect(readLatestDoctorReport(root)?.checked_at).toBe(t2.toISOString());
  });

  it("同一时间戳连跑两次 → 追加序号不互相覆盖", async () => {
    setupRoot();
    const t = new Date("2026-07-07T03:00:00.000Z");
    await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ now: () => t }));
    await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ now: () => t }));
    const dir = path.join(root, ".opc", "doctor-reports");
    expect(fs.readdirSync(dir).filter(f => f !== "latest.json")).toHaveLength(2);
  });

  it("latest.json 缺失/损坏 → readLatestDoctorReport 返回 null,不抛", () => {
    setupRoot();
    expect(readLatestDoctorReport(root)).toBeNull();
    const dir = path.join(root, ".opc", "doctor-reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), "{ broken");
    expect(readLatestDoctorReport(root)).toBeNull();
  });
});

describe("runGlobalDoctor — capability 层", () => {
  it("已注册 provider 测连通(去重,systemModel 与员工共用只测一次);enabled MCP 探测 healthy → ok", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true }]);
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), JSON.stringify([
      { id: "m1", name: "fs", description: "", transport: "stdio", command: "npx", args: [], enabled: true, assignedAgents: [], createdAt: "2026-01-01" },
      { id: "m2", name: "off", description: "", transport: "stdio", command: "npx", args: [], enabled: false, assignedAgents: [], createdAt: "2026-01-01" },
    ]));
    const connectivity = vi.fn(async () => ({ ok: true, message: "HTTP 200 · 12ms" }));
    const report = await runGlobalDoctor(root, { level: "capability" }, fakeDeps({
      testProviderConnectivity: connectivity,
      probeMcp: async (servers) => Object.fromEntries(servers.map(s => [s.id, "healthy" as const])),
    }));

    expect(report.level).toBe("capability");
    // deepseek 同时是员工 provider 和 systemModel fallback → 只测一次
    expect(connectivity).toHaveBeenCalledTimes(1);
    expect(check(report, "provider.connectivity.deepseek").status).toBe("ok");
    expect(check(report, "mcp.server.m1").status).toBe("ok");
    // disabled 的 server 不探
    expect(report.checks.find(c => c.id === "mcp.server.m2")).toBeUndefined();
    expect(report.status).toBe("ok");
  });

  it("连通失败/MCP unhealthy → failed(warning);未注册 provider 不发起连通测试", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true },
      { id: "a2", name: "B", role: "dev", provider: "minimax", framework: "hermes", enabled: true }, // 未注册 → 不测
    ]);
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), JSON.stringify([
      { id: "m1", name: "fs", description: "", transport: "stdio", command: "definitely-not-a-cmd", args: [], enabled: true, assignedAgents: [], createdAt: "2026-01-01" },
    ]));
    const connectivity = vi.fn(async () => ({ ok: false, message: "HTTP 503 · 3000ms" }));
    const report = await runGlobalDoctor(root, { level: "capability" }, fakeDeps({
      testProviderConnectivity: connectivity,
      probeMcp: async () => ({ m1: "unhealthy" as const }),
    }));

    expect(connectivity).toHaveBeenCalledTimes(1); // 只测已注册的 deepseek
    const conn = check(report, "provider.connectivity.deepseek");
    expect(conn.status).toBe("failed");
    expect(conn.severity).toBe("warning");
    const mcp = check(report, "mcp.server.m1");
    expect(mcp.status).toBe("failed");
    expect(mcp.severity).toBe("warning");
    // provider.keys(basic 层)对 minimax 报缺 → 整体 warning(capability 失败也是 warning)
    expect(report.status).toBe("warning");
  });
});

// ── E5:Deep Doctor 新探针 ────────────────────────────────────────────────────

describe("runGlobalDoctor — deep 层聚合", () => {
  it("level=deep → 叠加 basic + capability + 7 类新探针,report.level 为 deep", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true }]);
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());

    expect(report.level).toBe("deep");
    // basic 层的 check 仍在
    expect(check(report, "store.json_rw").status).toBe("ok");
    // capability 层的 check 也在(deep 是最全的一层,不是替代 capability)
    expect(check(report, "provider.connectivity.deepseek").status).toBe("ok");
    // deep 层 7 类新探针全部出现
    for (const id of [
      "port.occupancy", "process.orphan_worktree", "toolchain.node", "toolchain.tsx",
      "toolchain.esbuild", "fs.file_lock", "store.deep_parse", "fs.worktree_root_writable",
      "network.community_registry",
    ]) {
      check(report, id);
    }
  });

  it("非法 level 兜底为 basic(同既有行为,deep 需显式传入)", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "nonsense" as any }, fakeDeps());
    expect(report.level).toBe("basic");
    expect(report.checks.find(c => c.id === "port.occupancy")).toBeUndefined();
  });
});

describe("runGlobalDoctor — deep 层:端口占用(绝不 kill)", () => {
  it("占用/空闲混合 → ok(info),消息报告每个端口的状态,不判定为问题", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkPortOccupancy: async (port) => port === 3100, // 3100 占用(本进程)、5173 空闲
    }));
    const c = check(report, "port.occupancy");
    expect(c.status).toBe("ok");
    expect(c.severity).toBe("info");
    expect(c.message).toContain("3100");
    expect(c.message).toContain("占用");
    expect(c.message).toContain("5173");
    expect(c.message).toContain("空闲");
    // 端口被判定"占用"(如本进程自己占着 3100)绝不会让整体状态降级
    expect(report.status).toBe("ok");
  });

  it("探测函数抛错(无法判定)→ skipped(info),不误判成问题", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkPortOccupancy: async () => { throw new Error("probe crashed"); },
    }));
    const c = check(report, "port.occupancy");
    expect(c.status).toBe("skipped");
    expect(c.severity).toBe("info");
    expect(report.status).toBe("ok");
  });

  it("绝不 kill:globalDoctor.ts 源码不含 spawn/exec/taskkill/kill( 等进程终止相关代码", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "globalDoctor.ts"), "utf-8");
    expect(src).not.toMatch(/child_process|spawn|execSync|taskkill|killProcessTree|\bkill\(/i);
  });
});

describe("runGlobalDoctor — deep 层:残留 worktree 子进程", () => {
  it("未注入(默认无 pid registry)→ skipped,如实标注跳过", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkOrphanWorktreeProcesses: undefined as any, // 走 runGlobalDoctor 内的默认值
    }));
    const c = check(report, "process.orphan_worktree");
    expect(c.status).toBe("skipped");
    expect(c.message).toContain("暂无 pid registry");
  });

  it("有 registry 且发现残留 → failed(warning),消息声明仅报告不终止", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkOrphanWorktreeProcesses: () => ({ hasRegistry: true, orphans: ["run-abc12345"] }),
    }));
    const c = check(report, "process.orphan_worktree");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("run-abc12345");
    expect(c.message).toContain("不自动终止");
    expect(report.status).toBe("warning");
  });

  it("有 registry 且无残留 → ok", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkOrphanWorktreeProcesses: () => ({ hasRegistry: true, orphans: [] }),
    }));
    expect(check(report, "process.orphan_worktree").status).toBe("ok");
  });
});

describe("runGlobalDoctor — deep 层:Node/tsx/esbuild 工具链", () => {
  it("Node 版本达标 + tsx/esbuild 可解析 → 三项均 ok", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    expect(check(report, "toolchain.node").status).toBe("ok");
    expect(check(report, "toolchain.tsx").status).toBe("ok");
    expect(check(report, "toolchain.esbuild").status).toBe("ok");
  });

  it("Node 版本过低 → toolchain.node failed(warning)", async () => {
    setupRoot();
    const originalVersion = Object.getOwnPropertyDescriptor(process, "version");
    Object.defineProperty(process, "version", { value: "v16.20.0", configurable: true });
    try {
      const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
      const c = check(report, "toolchain.node");
      expect(c.status).toBe("failed");
      expect(c.severity).toBe("warning");
      expect(c.message).toContain("v16.20.0");
    } finally {
      if (originalVersion) Object.defineProperty(process, "version", originalVersion);
    }
  });

  it("tsx/esbuild 不可解析 → 对应 check failed(warning)", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      resolveModule: () => null,
    }));
    expect(check(report, "toolchain.tsx").status).toBe("failed");
    expect(check(report, "toolchain.esbuild").status).toBe("failed");
    expect(report.status).toBe("warning");
  });
});

describe("runGlobalDoctor — deep 层:文件锁", () => {
  it("真实 .opc 文件可正常 r+ 打开 → ok(不注入,走默认实现)", async () => {
    setupRoot();
    writeConfig({ version: "0.1.0", projectName: "t", apiKeys: {} });
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({ checkFileLock: undefined as any }));
    expect(check(report, "fs.file_lock").status).toBe("ok");
  });

  it("注入锁占用 → failed(warning),消息点名哪个文件", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      checkFileLock: (file) => (file.endsWith("config.json") ? { ok: false, message: "EBUSY" } : { ok: true, message: "可获取写锁" }),
    }));
    const c = check(report, "fs.file_lock");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("config.json");
    expect(c.message).toContain("EBUSY");
  });
});

describe("runGlobalDoctor — deep 层:JSON store 深度校验", () => {
  it("关键 store 文件均不存在(全新项目)→ ok", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    const c = check(report, "store.deep_parse");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("全新项目");
  });

  it("关键 store 文件均可解析 → ok,报告抽查数量", async () => {
    setupRoot();
    writeConfig({ version: "0.1.0", projectName: "t", apiKeys: {} });
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "hermes", enabled: true }]);
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    const c = check(report, "store.deep_parse");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("2");
  });

  it("providers.json 损坏 → failed(error),整体 error", async () => {
    setupRoot();
    fs.writeFileSync(path.join(root, ".opc", "providers.json"), "{ not valid json");
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    const c = check(report, "store.deep_parse");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("error");
    expect(c.message).toContain("providers.json");
    expect(report.status).toBe("error");
  });
});

describe("runGlobalDoctor — deep 层:worktree 根目录可写", () => {
  it(".opc/wt 可正常创建/写入 → ok", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    const c = check(report, "fs.worktree_root_writable");
    expect(c.status).toBe("ok");
    expect(fs.existsSync(path.join(root, ".opc", "wt"))).toBe(true);
  });

  it(".opc/wt 路径被同名文件占位 → failed(error),整体 error", async () => {
    setupRoot();
    fs.writeFileSync(path.join(root, ".opc", "wt"), "not a directory");
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps());
    const c = check(report, "fs.worktree_root_writable");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("error");
    expect(report.status).toBe("error");
  });
});

// ── MUP Gate A#4:逐公司 workspace root 体检 ─────────────────────────────────

function writeCompanies(companies: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify(companies));
}

describe("runGlobalDoctor — basic 层:公司 workspace root 体检(workspace.company.<id>)", () => {
  it("绑定目录可用且 git 就绪 → ok;未绑定且默认沙箱未创建 → ok(首次起跑自动创建,不误报)", async () => {
    setupRoot();
    writeCompanies([
      { id: "co-bound", name: "绑定公司", description: "", createdAt: "2026-01-01", folder: "M:\\some\\bound-dir" },
      { id: "co-free", name: "未绑定公司", description: "", createdAt: "2026-01-01" },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      checkWorkspaceFolder: (_r, folder) => ({ ok: true, realPath: folder, isGitRepo: true, hasCommit: true, needsInit: false }),
    }));
    const bound = check(report, "workspace.company.co-bound");
    expect(bound.status).toBe("ok");
    expect(bound.message).toContain("git 就绪");
    const free = check(report, "workspace.company.co-free");
    expect(free.status).toBe("ok");
    expect(free.message).toContain("首次起跑");
    expect(report.status).toBe("ok");
  });

  it("绑定目录失效(被删/失权)→ failed(warning),消息引导去公司架构页重新绑定,整体 warning", async () => {
    setupRoot();
    writeCompanies([{ id: "co-broken", name: "坏公司", description: "", createdAt: "2026-01-01", folder: "M:\\gone" }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      checkWorkspaceFolder: () => ({ ok: false, code: "not_found", error: "目录不存在:M:\\gone" }),
    }));
    const c = check(report, "workspace.company.co-broken");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("目录不存在");
    expect(c.message).toContain("重新绑定");
    expect(report.status).toBe("warning");
  });

  it("绑定目录可用但 needsInit(非 git/无首 commit)→ 逐公司项本身 ok(如实标注需显式确认初始化),但五.1 新增的『编码任务需 git』项 warning+指引(整体降级为 warning)", async () => {
    setupRoot();
    writeCompanies([{ id: "co-init", name: "待初始化", description: "", createdAt: "2026-01-01", folder: "M:\\plain-dir" }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({
      checkWorkspaceFolder: (_r, folder) => ({ ok: true, realPath: folder, isGitRepo: false, hasCommit: false, needsInit: true }),
    }));
    const c = check(report, "workspace.company.co-init");
    expect(c.status).toBe("ok"); // 逐公司体检项本身不降级(如实标注需初始化)
    expect(c.message).toContain("初始化");
    // 五.1(收口作战令):新增专项体检——绑定非 git 目录的公司在派编码团队任务时会被起跑前拦死,warning+指引。
    const coding = check(report, "workspace.coding_needs_git");
    expect(coding.status).toBe("failed");
    expect(coding.severity).toBe("warning");
    expect(coding.message).toContain("待初始化");
    expect(report.status).toBe("warning"); // 该专项 warning 使整体降级为 warning(语义变更,如实编码)
  });

  it("无公司(companies.json 缺失)→ 不产出任何 workspace.company.* 检查项(既有报告零扰动)", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    expect(report.checks.find(c => c.id.startsWith("workspace.company."))).toBeUndefined();
  });

  it("未绑定公司但默认沙箱已存在 → 真实写探针(可写 ok)", async () => {
    setupRoot();
    writeCompanies([{ id: "co-sandbox", name: "沙箱公司", description: "", createdAt: "2026-01-01" }]);
    // 默认沙箱 <root>/.opc-studio/<slug> 预先建好 → 走 checkDirWritable 真实探针
    fs.mkdirSync(path.join(root, ".opc-studio", "沙箱公司"), { recursive: true });
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps());
    const c = check(report, "workspace.company.co-sandbox");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("可写");
  });
});

describe("runGlobalDoctor — deep 层:社区 registry 可达性", () => {
  it("可达 → ok,消息含延迟信息", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      fetchCommunityRegistryReachable: async () => ({ ok: true, message: "HTTP 200 · 42ms" }),
    }));
    const c = check(report, "network.community_registry");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("42ms");
  });

  it("不可达 → failed(warning),沿用大陆网络合规措辞且不用\"翻墙\"", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      fetchCommunityRegistryReachable: async () => ({ ok: false, message: "超时(3000ms)" }),
    }));
    const c = check(report, "network.community_registry");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("当地法律法规");
    expect(c.message).not.toContain("翻墙");
    expect(report.status).toBe("warning");
  });

  it("fetch 函数本身 reject(未被内部 catch)→ 仍不抛,归为 failed", async () => {
    setupRoot();
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({
      fetchCommunityRegistryReachable: async () => { throw new Error("network stack error"); },
    }));
    const c = check(report, "network.community_registry");
    expect(c.status).toBe("failed");
    expect(c.message).toContain("network stack error");
  });
});

// G4 · Provider 执行环境 canary(FS 往返 + Windows git-bash 前置)。
describe("checkProviderEnvironment — Provider 执行环境 canary", () => {
  it("宿主 FS canary → host.fs_canary ok(消息声明仅宿主、不代表 provider);非 CLI 无 git-bash/tool_canary", () => {
    const out = checkProviderEnvironment(false, { platform: "linux", tmpDir: os.tmpdir(), detectGitBash: () => null });
    const host = out.find(c => c.id === "host.fs_canary");
    expect(host?.status).toBe("ok");
    expect(host?.message).toMatch(/仅宿主|不代表 provider/);
    expect(out.find(c => c.id === "provider.claude_code_gitbash")).toBeUndefined();
    expect(out.find(c => c.id === "provider.tool_canary")).toBeUndefined(); // 非 CLI 框架不做 provider tool canary
  });
  it("[P1-4] CLI 框架但未注入真实 canary → provider.tool_canary = not_tested(skipped),绝不判 provider 可用", () => {
    const out = checkProviderEnvironment(true, { platform: "linux", tmpDir: os.tmpdir(), detectGitBash: () => null });
    const tc = out.find(c => c.id === "provider.tool_canary");
    expect(tc?.status).toBe("skipped");        // not_tested,不是 ok
    expect(tc?.message).toMatch(/not_tested/);
    expect(tc?.message).toMatch(/绝不据此判 provider 可用|≠ provider/);
  });
  it("[P1-4] 注入真实 canary:失败 → provider.tool_canary failed(不伪装可用);通过 → ok", () => {
    const bad = checkProviderEnvironment(true, { platform: "linux", tmpDir: os.tmpdir(), detectGitBash: () => null, providerToolCanary: () => ({ ok: false, detail: "claude-code Write ok=false" }) });
    expect(bad.find(c => c.id === "provider.tool_canary")?.status).toBe("failed");
    const good = checkProviderEnvironment(true, { platform: "linux", tmpDir: os.tmpdir(), detectGitBash: () => null, providerToolCanary: () => ({ ok: true, detail: "write/read/delete ok" }) });
    expect(good.find(c => c.id === "provider.tool_canary")?.status).toBe("ok");
  });
  it("Windows + CLI 框架 + git-bash 缺失 → failed(准确原因含 git-bash + 修复指引)", () => {
    const out = checkProviderEnvironment(true, { platform: "win32", tmpDir: os.tmpdir(), gitBashPath: undefined, detectGitBash: () => null });
    const gb = out.find(c => c.id === "provider.claude_code_gitbash");
    expect(gb?.status).toBe("failed");
    expect(gb?.message).toMatch(/git-bash/i);
    expect(gb?.message).toMatch(/CLAUDE_CODE_GIT_BASH_PATH/);
  });
  it("Windows + CLI + git-bash 已定位 → ok", () => {
    const out = checkProviderEnvironment(true, { platform: "win32", tmpDir: os.tmpdir(), detectGitBash: () => "C:/Git/bin/bash.exe" });
    expect(out.find(c => c.id === "provider.claude_code_gitbash")?.status).toBe("ok");
  });
  it("非 CLI 框架 → 即便 Windows 也不做 git-bash 检查(只 FS canary)", () => {
    const out = checkProviderEnvironment(false, { platform: "win32", tmpDir: os.tmpdir(), detectGitBash: () => null });
    expect(out.some(c => c.id === "provider.claude_code_gitbash")).toBe(false);
    expect(out).toHaveLength(1);
  });
});

// 审计 P1-4 · runGlobalDoctor 真实注入 provider.tool_canary(deep 才跑,basic 不跑=not_tested)。
describe("runGlobalDoctor · provider.tool_canary 真实注入", () => {
  it("deep 层 + 注入真实 canary(失败)→ provider.tool_canary failed(检出 provider 写盘不可用)", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "anthropic", framework: "claude-code", enabled: true }]);
    const canary = vi.fn(async () => ({ ok: false, detail: "claude-code Write ok=false" }));
    const report = await runGlobalDoctor(root, { level: "deep" }, fakeDeps({ providerToolCanary: canary }));
    expect(canary).toHaveBeenCalled();
    expect(check(report, "provider.tool_canary").status).toBe("failed");
  });
  it("basic 层 → 不跑真实 canary(dep 不被调用),provider.tool_canary = not_tested(skipped)", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "anthropic", framework: "claude-code", enabled: true }]);
    const canary = vi.fn(async () => ({ ok: true, detail: "x" }));
    const report = await runGlobalDoctor(root, { level: "basic" }, fakeDeps({ providerToolCanary: canary }));
    expect(canary).not.toHaveBeenCalled();
    expect(check(report, "provider.tool_canary").status).toBe("skipped");
  });
});
