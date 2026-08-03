import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGlobalDoctor, type DoctorDeps, type DoctorReport } from "./globalDoctor.js";
import type { FolderCheck } from "./workspaceGuard.js";

// 五.1 + 五.3(收口作战令)· globalDoctor 新增两项体检:
//   ① workspace.agent_working_dirs:逐 agent workingDirectory 合法性(非法 → error);
//   ② workspace.coding_needs_git:绑定了非 git(needsInit)工作目录的公司 → warning + 指引。

let root: string;

function setupRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gd-ws-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  return root;
}

afterEach(() => {
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function writeAgents(agents: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
}
function writeCompanies(companies: Array<Record<string, unknown>>) {
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify(companies));
}

function baseDeps(over: DoctorDeps = {}): DoctorDeps {
  return {
    probeEngine: async (fw) => ({ framework: fw as any, installed: true, loggedIn: true, version: "1.0.0" }),
    syncProviders: () => { /* no-op */ },
    providerRegistered: (p) => p === "deepseek",
    // 默认:所有绑定目录都判为已就绪 git（needsInit=false）——按需在用例里覆盖。
    checkWorkspaceFolder: (_root, folder): FolderCheck => ({ ok: true, realPath: folder, isGitRepo: true, hasCommit: true, needsInit: false }),
    ...over,
  };
}

function check(report: DoctorReport, id: string) {
  const c = report.checks.find(x => x.id === id);
  expect(c, `check ${id} 应存在`).toBeDefined();
  return c!;
}

describe("workspace.agent_working_dirs — 逐 agent workingDirectory 合法性", () => {
  it("全部 agent workingDirectory 合法/未设置 → ok", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "api", enabled: true, workingDirectory: "svc/alpha" },
      { id: "a2", name: "B", role: "dev", provider: "deepseek", framework: "api", enabled: true },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps());
    expect(check(report, "workspace.agent_working_dirs").status).toBe("ok");
  });

  it("某 agent workingDirectory 非法(.. 逃逸)→ failed + error 级 + overall error", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "好的", role: "dev", provider: "deepseek", framework: "api", enabled: true, workingDirectory: "svc/alpha" },
      { id: "a2", name: "越界的", role: "dev", provider: "deepseek", framework: "api", enabled: true, workingDirectory: "../escape" },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps());
    const c = check(report, "workspace.agent_working_dirs");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("error");
    expect(c.message).toContain("越界的");
    expect(report.status).toBe("error");
  });

  it("绝对路径 workingDirectory 同样 failed", async () => {
    setupRoot();
    writeAgents([
      { id: "a1", name: "盘符的", role: "dev", provider: "deepseek", framework: "api", enabled: true, workingDirectory: "C:\\abs" },
    ]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps());
    expect(check(report, "workspace.agent_working_dirs").status).toBe("failed");
  });
});

describe("workspace.coding_needs_git — 编码任务 Git 工作区就绪", () => {
  it("公司绑定了非 git 工作目录(needsInit)→ failed(warning)+ 指引", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "api", enabled: true }]);
    writeCompanies([{ id: "c1", name: "绑定公司", folder: "/some/bound/dir", createdAt: "2026-01-01" }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps({
      checkWorkspaceFolder: (_r, folder): FolderCheck => ({ ok: true, realPath: folder, isGitRepo: false, hasCommit: false, needsInit: true }),
    }));
    const c = check(report, "workspace.coding_needs_git");
    expect(c.status).toBe("failed");
    expect(c.severity).toBe("warning");
    expect(c.message).toContain("绑定公司");
    expect(c.message).toContain("初始化为 OPC 管理的 Git 工作区");
  });

  it("未绑定目录的公司(默认托管沙箱)不告警 → ok", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "api", enabled: true }]);
    writeCompanies([{ id: "c1", name: "沙箱公司", createdAt: "2026-01-01" }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps());
    expect(check(report, "workspace.coding_needs_git").status).toBe("ok");
  });

  it("绑定目录已就绪 git(needsInit=false)→ ok", async () => {
    setupRoot();
    writeAgents([{ id: "a1", name: "A", role: "dev", provider: "deepseek", framework: "api", enabled: true }]);
    writeCompanies([{ id: "c1", name: "就绪公司", folder: "/ready/git/dir", createdAt: "2026-01-01" }]);
    const report = await runGlobalDoctor(root, { level: "basic" }, baseDeps());
    expect(check(report, "workspace.coding_needs_git").status).toBe("ok");
  });
});
