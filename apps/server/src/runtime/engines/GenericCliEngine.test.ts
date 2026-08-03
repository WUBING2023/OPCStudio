import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { GenericCliEngine, type GenericCliConfig } from "./GenericCliEngine.js";
import { __setSpawnForTest } from "./cliEngineBase.js";
import { __setCliInstalledCheckForTest } from "./probes.js";

// GenericCliEngine 是"12+1 框架"扩展的通用调度骨架:9 个具名预设(genericCliPresets.ts)与裸
// generic-cli 配置共用同一份 run() 逻辑,这里只测调度/超时/认证/trustExitCode 分支本身是否正确——
// buildArgs/parseOutput 各自的真实内容在 genericCliPresets.test.ts 里单独测。
//
// 诚实声明:全部用注入的假 spawn + 假安装探测——本机没有装任何一个真实二进制,这不是活体验证。

function fakeSpawnSeq(responses: Array<{ code?: number | null; stdout?: string; stderr?: string; neverClose?: boolean }>) {
  const calls: { n: number; lastArgs?: readonly string[]; lastEnv?: NodeJS.ProcessEnv; lastCmd?: string } = { n: 0 };
  const fn = (cmd: string, args: readonly string[], opts: any) => {
    calls.lastArgs = args;
    calls.lastEnv = opts?.env;
    calls.lastCmd = cmd;
    const resp = responses[Math.min(calls.n, responses.length - 1)];
    calls.n++;
    const handlers: Record<string, (arg?: any) => void> = {};
    const child: any = {
      stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stdout) cb(Buffer.from(resp.stdout)); } },
      stderr: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stderr) cb(Buffer.from(resp.stderr)); } },
      stdin: { write: () => {}, end: () => {} },
      on: (e: string, cb: (arg?: any) => void) => { handlers[e] = cb; },
      kill: () => {},
      pid: 4242,
    };
    if (!resp.neverClose) setImmediate(() => handlers["close"]?.(resp.code ?? null));
    return child;
  };
  return { fn, calls };
}

function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
    model: "some-model", provider: "testprov",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

const emitted: Array<{ type: string; agentId?: string; payload: unknown }> = [];
function ctx(over: Partial<ExecContext> = {}): ExecContext {
  return {
    runId: "run-1", projectRoot: os.tmpdir(), workdir: os.tmpdir(),
    emit: (type, agentId, payload) => { emitted.push({ type, agentId, payload }); },
    budget: { maxTokensPerTask: 4096 },
    ...over,
  };
}

const task: ExecTask = { taskId: "t1", goal: "do the thing", systemPrompt: "sys prompt", maxTokens: 100 };

function basePreset(over: Partial<GenericCliConfig> = {}): GenericCliConfig {
  return {
    framework: "gemini-cli",
    command: "faketool",
    buildArgs: (prompt) => ["--prompt", prompt],
    trustExitCode: true,
    parseOutput: (stdout, _stderr, exitCode) => ({ content: stdout.trim(), ok: exitCode === 0 }),
    ...over,
  };
}

beforeEach(() => {
  emitted.length = 0;
  __setCliInstalledCheckForTest(() => ({ installed: true, version: "faketool 1.0.0" }));
});
afterEach(() => {
  __setSpawnForTest(null);
  __setCliInstalledCheckForTest(null);
  delete process.env.GEMINI_API_KEY;
  delete process.env.TESTPROV_API_KEY;
  delete process.env.CI_TOKEN;
  delete process.env.OPC_ENVGUARD_LEAK_VAR;
});

describe("GenericCliEngine — 调度到 preset", () => {
  it("成功路径:拼出 buildArgs 的参数,parseOutput.ok=true + exitCode=0 → status=done", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "hello from cli" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset());
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("done");
    expect(res.content).toBe("hello from cli");
    expect(calls.lastCmd).toBe("faketool");
    expect(calls.lastArgs).toEqual(["--prompt", "sys prompt\n\ndo the thing"]);
  });

  it("未安装 → restricted,且从不 spawn", async () => {
    __setCliInstalledCheckForTest(() => ({ installed: false, version: "" }));
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "should not run" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset());
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("restricted");
    expect(calls.n).toBe(0);
  });

  it("需要认证但找不到 provider key → restricted,不 spawn", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "should not run" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ authEnvVar: "GEMINI_API_KEY" }));
    const res = await engine.run(agent({ provider: "gemini" }), task, ctx());
    expect(res.status).toBe("restricted");
    expect(res.error).toContain("GEMINI_API_KEY");
    expect(calls.n).toBe(0);
  });

  it("认证 key 存在(env 最高优先级)→ 注入到 authEnvVar 指定的名字下", async () => {
    process.env.GEMINI_API_KEY = "sk-fake-gemini-key";
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ authEnvVar: "GEMINI_API_KEY" }));
    const res = await engine.run(agent({ provider: "gemini" }), task, ctx());
    expect(res.status).toBe("done");
    expect(calls.lastEnv?.GEMINI_API_KEY).toBe("sk-fake-gemini-key");
  });

  it("authEnvVar 为按 provider 动态计算的函数(如 plandex/aider)→ 用算出来的名字注入", async () => {
    process.env.TESTPROV_API_KEY = "sk-dynamic";
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ authEnvVar: (p) => `${p.toUpperCase()}_API_KEY` }));
    const res = await engine.run(agent({ provider: "testprov" }), task, ctx());
    expect(res.status).toBe("done");
    expect(calls.lastEnv?.TESTPROV_API_KEY).toBe("sk-dynamic");
  });

  it("stripEnvPrefixes:剔除指定前缀的 env(qwen-code 的 CI_* 场景)", async () => {
    process.env.CI_TOKEN = "leaked-ci-token";
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ stripEnvPrefixes: ["CI_"] }));
    await engine.run(agent(), task, ctx());
    expect(calls.lastEnv?.CI_TOKEN).toBeUndefined();
  });

  it("A1-V3 envAllowlist:worker 角色(research profile)→ 不在白名单/基线的普通 env 不进子进程;白名单命中保留", async () => {
    process.env.OPC_ENVGUARD_LEAK_VAR = "should-not-reach-child"; // 非密钥、非基线、不在 research allowlist
    const prevLcAll = process.env.LC_ALL;
    process.env.LC_ALL = "C"; // 在 research_profile_v1.envAllowlist 里
    try {
      const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
      __setSpawnForTest(fn);
      const engine = new GenericCliEngine(basePreset());
      const res = await engine.run(agent(), task, ctx()); // role="worker" → research_profile_v1
      expect(res.status).toBe("done");
      expect(calls.lastEnv?.OPC_ENVGUARD_LEAK_VAR).toBeUndefined();
      expect(calls.lastEnv?.LC_ALL).toBe("C");
      // 进程基线仍在(不搞坏子进程):PATH 一定存在
      expect(Object.keys(calls.lastEnv ?? {}).map((k) => k.toUpperCase())).toContain("PATH");
    } finally {
      if (prevLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = prevLcAll;
    }
  });

  it("extraEnv:按 node 派生的非密钥 env(goose 的 GOOSE_PROVIDER/GOOSE_MODEL 场景)", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ extraEnv: (n) => ({ FAKE_PROVIDER: n.provider, FAKE_MODEL: n.model }) }));
    await engine.run(agent({ provider: "anthropic", model: "sonnet" }), task, ctx());
    expect(calls.lastEnv?.FAKE_PROVIDER).toBe("anthropic");
    expect(calls.lastEnv?.FAKE_MODEL).toBe("sonnet");
  });

  it("trustExitCode=true:exitCode!=0 → 失败,即便 parseOutput.ok 恰好是 true", async () => {
    const { fn } = fakeSpawnSeq([{ code: 1, stdout: "partial" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ trustExitCode: true, parseOutput: () => ({ content: "partial", ok: true }) }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("failed");
  });

  it("trustExitCode=false(goose/opencode/amp 场景):exitCode!=0 但 parseOutput.ok=true → 仍算成功", async () => {
    const { fn } = fakeSpawnSeq([{ code: 1, stdout: "actually fine" }]); // 模拟"退出码撒谎"
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ trustExitCode: false, parseOutput: (stdout) => ({ content: stdout, ok: true }) }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("done");
  });

  it("trustExitCode=false:exitCode=0 但 parseOutput.ok=false(如 goose #4612 JSON 内容里有 error)→ 仍算失败", async () => {
    const { fn } = fakeSpawnSeq([{ code: 0, stdout: '{"error":"boom"}' }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ trustExitCode: false, parseOutput: () => ({ content: "boom", ok: false }) }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("failed");
  });

  it("超时 → status=failed,标注超时错误信息", async () => {
    const { fn } = fakeSpawnSeq([{ neverClose: true }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ timeoutMs: 10 }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("failed");
    expect(res.error).toContain("超时");
    // 20s 显式时限:本用例必然吃一次 timeoutRetries=1 的真实退避(2-3s);此前 5s 缺省时限在
    // 高负载下被顶爆,且超时后的异步续跑会把 spawn 调用打进下一个用例的 fake(跨用例污染)。
    // 根治二件套:cliEngineBase 注入态跳过真实 executable resolution(去掉数秒级 PATH 全扫)+ 本时限。
  }, 20000);

  it("parseOutput 抛异常 → 防御性兜底成失败,不让整个 run 崩溃", async () => {
    const { fn } = fakeSpawnSeq([{ code: 0, stdout: "whatever" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ parseOutput: () => { throw new Error("boom"); } }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.status).toBe("failed");
  });

  it("tokensUsed 有值时正确写入 result.tokens", async () => {
    const { fn } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine(basePreset({ parseOutput: (stdout) => ({ content: stdout, ok: true, tokensUsed: { prompt: 100, completion: 40 } }) }));
    const res = await engine.run(agent(), task, ctx());
    expect(res.tokens).toEqual({ prompt: 100, completion: 40, total: 140 });
  });
});

describe("GenericCliEngine — 裸 generic-cli 模式(preset 留空,读 node.genericCli)", () => {
  it("未配置 node.genericCli.command → restricted,不 spawn", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0 }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine();
    const res = await engine.run(agent({ framework: "generic-cli" }), task, ctx());
    expect(res.status).toBe("restricted");
    expect(calls.n).toBe(0);
  });

  it("配置了 command/args,含 {{PROMPT}} 占位符 → 替换而不追加", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine();
    const res = await engine.run(
      agent({ framework: "generic-cli", genericCli: { command: "mytool", args: ["run", "--input", "{{PROMPT}}", "--json"] } }),
      task,
      ctx(),
    );
    expect(res.status).toBe("done");
    expect(calls.lastCmd).toBe("mytool");
    expect(calls.lastArgs).toEqual(["run", "--input", "sys prompt\n\ndo the thing", "--json"]);
  });

  it("配置了 command/args,不含占位符 → prompt 追加到最后", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine();
    await engine.run(
      agent({ framework: "generic-cli", genericCli: { command: "mytool", args: ["--flag"] } }),
      task,
      ctx(),
    );
    expect(calls.lastArgs).toEqual(["--flag", "sys prompt\n\ndo the thing"]);
  });

  it("裸配置的 authEnvVar 生效", async () => {
    process.env.TESTPROV_API_KEY = "sk-bare";
    const { fn, calls } = fakeSpawnSeq([{ code: 0, stdout: "ok" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine();
    await engine.run(
      agent({ framework: "generic-cli", provider: "testprov", genericCli: { command: "mytool", args: ["{{PROMPT}}"], authEnvVar: "TESTPROV_API_KEY" } }),
      task,
      ctx(),
    );
    expect(calls.lastEnv?.TESTPROV_API_KEY).toBe("sk-bare");
  });

  it("裸配置无 JSON 输出——纯文本 stdout 即 content,exitCode 判断成败", async () => {
    const { fn } = fakeSpawnSeq([{ code: 1, stdout: "boom" }]);
    __setSpawnForTest(fn);
    const engine = new GenericCliEngine();
    const res = await engine.run(
      agent({ framework: "generic-cli", genericCli: { command: "mytool", args: ["{{PROMPT}}"] } }),
      task,
      ctx(),
    );
    expect(res.status).toBe("failed");
  });
});

describe("GenericCliEngine.probe()", () => {
  it("带 preset:委托给 probeGenericCliAsync(installed 反映真实安装探测)", async () => {
    __setCliInstalledCheckForTest(() => ({ installed: true, version: "v1" })); // 不影响 probe(),probe 走 tryCmdAsync 而非这个 seam
    const engine = new GenericCliEngine(basePreset());
    const av = await engine.probe();
    expect(av.framework).toBe("gemini-cli");
  });

  it("不带 preset(裸 generic-cli):installed/loggedIn 恒 true,detail 提示需按节点确认", async () => {
    const engine = new GenericCliEngine();
    const av = await engine.probe();
    expect(av.framework).toBe("generic-cli");
    expect(av.installed).toBe(true);
    expect(av.detail).toContain("自定义 CLI");
  });
});
