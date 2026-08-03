import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// 真实 orchestrator 单例(不 mock):验证 updateAgent 保存侧对 workingDirectory 的阻断/归一。
import { initOrchestrator, updateAgent, getAgents } from "./orchestrator.js";

// 五.3(收口作战令)· updateAgent 保存侧 workingDirectory 阻断:
//   · 非法值(绝对路径/盘符/.. 逃逸/等价于根)→ 抛错,绝不落盘(路由侧转 400 由泳道 V 做);
//   · 合法值 → 归一为规范 POSIX 相对路径再落盘;
//   · 空串/未提供 → 放行(清除该字段,不校验)。

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wd-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    { id: "dev-1", name: "开发", role: "dev", companyId: "default", provider: "deepseek", model: "x", framework: "api", childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
  ]), "utf-8");
  initOrchestrator(root);
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("updateAgent workingDirectory 保存侧阻断", () => {
  it("绝对路径 → 抛错,内存里的 workingDirectory 未被写入", () => {
    expect(() => updateAgent("dev-1", { workingDirectory: "C:\\evil\\abs" })).toThrow(/invalid_working_directory/);
    expect(getAgents().find((a) => a.id === "dev-1")?.workingDirectory).toBeUndefined();
  });

  it(".. 逃逸 → 抛错", () => {
    expect(() => updateAgent("dev-1", { workingDirectory: "../escape" })).toThrow(/invalid_working_directory/);
  });

  it("等价于根(.)→ 抛错", () => {
    expect(() => updateAgent("dev-1", { workingDirectory: "." })).toThrow(/invalid_working_directory/);
  });

  it("合法相对路径 → 归一后落盘(反斜杠转正斜杠、消 ./)", () => {
    updateAgent("dev-1", { workingDirectory: "./svc\\alpha/" });
    expect(getAgents().find((a) => a.id === "dev-1")?.workingDirectory).toBe("svc/alpha");
  });

  it("空串 → 放行(清除/不校验,不抛错)", () => {
    expect(() => updateAgent("dev-1", { workingDirectory: "" })).not.toThrow();
  });

  it("其它字段更新不受影响(未带 workingDirectory)", () => {
    expect(() => updateAgent("dev-1", { lastAction: "普通存盘" })).not.toThrow();
    expect(getAgents().find((a) => a.id === "dev-1")?.lastAction).toBe("普通存盘");
  });
});
