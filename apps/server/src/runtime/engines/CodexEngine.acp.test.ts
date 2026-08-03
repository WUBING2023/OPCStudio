import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";

// B4 二期迁移等价性证据(1条),镜像 ClaudeCodeEngine.acp.test.ts 的姿势:CODEX_SPEC.prepare() 组装
// 的 env 仍然经过 filteredSpawnEnv(A1-V3),不是迁移后被绕过。直接单测 prepare() 而不走完整
// run()——真实 probeCodex() 会 execSync 真机器状态(是否装了 codex / 是否登录),在不同开发机上不
// 确定,mock 掉才能让这条断言在任意机器上确定性成立。
vi.mock("./probes.js", () => ({
  probeCodex: vi.fn(() => ({ framework: "codex", installed: true, loggedIn: true, version: "1.0.0" })),
}));

import { CODEX_SPEC } from "./CodexEngine.js";

const node: AgentNodeConfig = {
  id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
  model: "gpt-5-codex", provider: "deepseek",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  editable: true, deletable: true, enabled: true,
};
const task: ExecTask = { taskId: "t1", goal: "goal text", systemPrompt: "sys text", maxTokens: 100 };
const ctx: ExecContext = {
  runId: "run-1", projectRoot: "irrelevant-root", workdir: "irrelevant-root",
  emit: () => {},
  budget: { maxTokensPerTask: 4096 },
};

describe("CodexEngine 迁移后仍走 filteredSpawnEnv", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "keep-me-deepseek";
    process.env.OPENAI_API_KEY = "strip-me-openai";
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("node.provider(deepseek)对应的 _API_KEY 保留,其它 provider 的 _API_KEY 被剥除", () => {
    const prepared = CODEX_SPEC.prepare(node, task, ctx);
    expect(prepared.restricted).toBeUndefined();
    expect(prepared.env.DEEPSEEK_API_KEY).toBe("keep-me-deepseek");
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("legacy Codex uses native workspace-write sandbox and never bypasses it", () => {
    const prepared = CODEX_SPEC.prepare(node, task, ctx);
    expect(prepared.args).toContain("workspace-write");
    expect(prepared.args).toContain("--ignore-user-config");
    expect(prepared.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});
