import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";

// B4 迁移等价性证据(1条):CLAUDE_CODE_SPEC.prepare() 组装的 env 仍然经过 filteredSpawnEnv
// (A1-V3),不是迁移后被绕过。直接单测 prepare() 而不走完整 run()——真实 probeClaudeCode() 会
// execSync 真机器状态(是否装了 claude / 是否登录),在不同开发机上不确定,mock 掉才能让这条断言
// 在任意机器上确定性成立(镜像 companyRoutes.test.ts 对 probes.js/providerStore.js/apiKeyAccount.js
// 的既有 vi.mock 姿势)。
vi.mock("./probes.js", () => ({
  probeClaudeCode: vi.fn(() => ({ framework: "claude-code", installed: true, loggedIn: true, version: "1.0.0" })),
}));
vi.mock("../../storage/providerStore.js", () => ({
  loadAccounts: vi.fn(() => []),
}));
vi.mock("./apiKeyAccount.js", () => ({
  resolveApiKeyOverride: vi.fn(() => undefined),
}));

import { CLAUDE_CODE_SPEC } from "./ClaudeCodeEngine.js";

const node: AgentNodeConfig = {
  id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
  model: "claude-3-5-sonnet-latest", provider: "deepseek",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  editable: true, deletable: true, enabled: true,
};
const task: ExecTask = { taskId: "t1", goal: "goal text", systemPrompt: "sys text", maxTokens: 100 };
const ctx: ExecContext = {
  runId: "run-1", projectRoot: "irrelevant-root", workdir: "irrelevant-root",
  emit: () => {},
  budget: { maxTokensPerTask: 4096 },
};

describe("ClaudeCodeEngine 迁移后仍走 filteredSpawnEnv", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "keep-me-deepseek";
    process.env.OPENAI_API_KEY = "strip-me-openai";
  });
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("node.provider(deepseek)对应的 _API_KEY 保留,其它 provider 的 _API_KEY 被剥除", () => {
    const prepared = CLAUDE_CODE_SPEC.prepare(node, task, ctx);
    expect(prepared.restricted).toBeUndefined();
    expect(prepared.env.DEEPSEEK_API_KEY).toBe("keep-me-deepseek");
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
  });
});
