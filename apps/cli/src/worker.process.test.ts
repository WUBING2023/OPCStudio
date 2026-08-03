// B3 · opc-worker CLI 进程级 smoke test:真的通过 tsx 起一个子进程跑 worker.ts 入口(而不只是调用
// workerRunner 里的函数),验证 commander 参数解析 → task.json 读取/zod 校验 → projectRoot 解析/
// 校验 → 落 run 目录证据文件这条链路整体可用。
//
// 用一个未注册的 framework("not-a-real-framework")让 frameworkPolicy 在 runEngineCore 最开头就
// 短路返回 restricted——见 workerRuntime.ts runEngineCore 的第一段:policy 检查在 routeEngine/
// resolveApiKey/engine.run 之前。这样进程级 smoke 能跑通整条链路,同时保证绝不会真的 spawn 引擎、
// 不打真模型、不碰任何凭据文件。
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(__dirname, "..");
const workerEntry = path.join(__dirname, "worker.ts");

function setupProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-worker-cli-smoke-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".opc", "agents.json"),
    JSON.stringify([
      {
        id: "worker-1", name: "Worker One", role: "dev", childrenIds: [],
        model: "m", provider: "p", framework: "not-a-real-framework",
        status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
        editable: true, deletable: true, enabled: true,
      },
    ], null, 2),
    "utf-8",
  );
  return root;
}

function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("npx", ["tsx", workerEntry, ...args], {
    cwd: cliDir, encoding: "utf-8", timeout: 60_000, shell: true,
  });
}

describe("opc-worker CLI(进程级 smoke · 不打真模型)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("run --task ... --project-root ... 真跑通 CLI 进程,产出证据文件集", () => {
    root = setupProjectRoot();
    const taskFile = path.join(root, "task-input.json");
    fs.writeFileSync(taskFile, JSON.stringify({ taskId: "t-1", goal: "smoke goal", agentId: "worker-1" }), "utf-8");

    const res = runCli(["run", "--task", taskFile, "--project-root", root]);

    expect(res.error).toBeUndefined();
    expect(res.stderr).toContain("projectRoot =");
    // frameworkPolicy 拒绝未知框架 → runEngineCore 返回 status:"restricted" → CLI 以非零码退出
    // (诚实反映"未成功",不伪装成功)。
    expect(res.status).toBe(1);

    const outcome = JSON.parse(res.stdout.trim());
    expect(outcome.agentId).toBe("worker-1");
    expect(outcome.status).toBe("restricted");
    expect(fs.existsSync(outcome.runDir)).toBe(true);

    const files = fs.readdirSync(outcome.runDir);
    for (const f of ["task.json", "result.json", "events.jsonl", "worker.config.json"]) {
      expect(files).toContain(f);
    }
  }, 60_000);

  it("projectRoot 下没有 .opc 目录时硬失败(已知陷阱防御,不静默空跑)", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-worker-cli-smoke-noopc-"));
    const taskFile = path.join(root, "task-input.json");
    fs.writeFileSync(taskFile, JSON.stringify({ taskId: "t-1", goal: "g", agentId: "x" }), "utf-8");

    const res = runCli(["run", "--task", taskFile, "--project-root", root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("没有 .opc 目录");
  }, 60_000);

  it("task.json 不合法(zod 校验失败)时硬失败并打印字段级原因", () => {
    root = setupProjectRoot();
    const taskFile = path.join(root, "task-input.json");
    fs.writeFileSync(taskFile, JSON.stringify({ taskId: "t-1" }), "utf-8"); // 缺 goal 和 agentId/role

    const res = runCli(["run", "--task", taskFile, "--project-root", root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("未通过契约校验");
  }, 60_000);
});
