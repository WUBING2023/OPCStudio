import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { genericCliConfigToAcpSpec, type GenericCliConfig } from "./GenericCliEngine.js";
import { __setCliInstalledCheckForTest } from "./probes.js";

// B4 二期迁移等价性证据(1条),镜像 ClaudeCodeEngine.acp.test.ts / CodexEngine.acp.test.ts 的姿势:
// genericCliConfigToAcpSpec(config).prepare() 组装的 env 仍然经过 filteredSpawnEnv(A1-V3),不是
// 迁移后被绕过。GenericCliEngine 没有单一固定的 spec 常量(9 份预设+裸配置各自现拼),这里对一份
// 最小 GenericCliConfig 直接调用适配出的 spec.prepare()。

const config: GenericCliConfig = {
  framework: "gemini-cli",
  command: "faketool",
  buildArgs: (prompt) => ["--prompt", prompt],
  trustExitCode: true,
  parseOutput: (stdout, _stderr, exitCode) => ({ content: stdout.trim(), ok: exitCode === 0 }),
};

const node: AgentNodeConfig = {
  id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
  model: "some-model", provider: "deepseek",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  editable: true, deletable: true, enabled: true,
};
const task: ExecTask = { taskId: "t1", goal: "goal text", systemPrompt: "sys text", maxTokens: 100 };
const ctx: ExecContext = {
  runId: "run-1", projectRoot: "irrelevant-root", workdir: "irrelevant-root",
  emit: () => {},
  budget: { maxTokensPerTask: 4096 },
};

describe("GenericCliEngine 迁移后 spec.prepare 仍走 filteredSpawnEnv", () => {
  beforeEach(() => {
    __setCliInstalledCheckForTest(() => ({ installed: true, version: "faketool 1.0.0" }));
    process.env.DEEPSEEK_API_KEY = "keep-me-deepseek";
    process.env.OPENAI_API_KEY = "strip-me-openai";
  });
  afterEach(() => {
    __setCliInstalledCheckForTest(null);
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("node.provider(deepseek)对应的 _API_KEY 保留,其它 provider 的 _API_KEY 被剥除", () => {
    const spec = genericCliConfigToAcpSpec(config);
    const prepared = spec.prepare(node, task, ctx);
    expect(prepared.restricted).toBeUndefined();
    expect(prepared.env.DEEPSEEK_API_KEY).toBe("keep-me-deepseek");
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
  });
});
