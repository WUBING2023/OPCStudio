import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach } from "vitest";
import {
  extractAcpModels,
  probeAcpModels,
  __setProbeSpawnForTest,
  __setAcpProbeCommandResolverForTest,
  __resetAcpModelCacheForTest,
  buildProbeSpec,
  type AcpProbeSpec,
} from "./acpModelProbe.js";

// 假 ACP adapter:一个真讲 ndjson JSON-RPC 的极小 agent。它读 stdin 的每行 JSON-RPC,对 initialize 回
// 应答,对 session/new 回带 configOptions(model select)的应答——由此覆盖 probeAcpModels 的握手全链路,
// 零真实模型调用(铁律)。scenario 决定 session/new 应答形状。
function makeFakeAdapter(scenario: "models" | "grouped" | "no-model-option" | "init-error" | "die-early" | "banner" | "avail-models" | "both-shapes" | "auth-required", requests: any[] = []): any {
  const proc: any = new EventEmitter();
  proc.pid = undefined; // pid 留空 → killTree 短路,测试绝不对真实 PID 跑 taskkill
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let buf = "";
  const emit = (obj: unknown) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  proc.stdin = {
    write: (s: string) => {
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        requests.push(msg);
        if (msg.id === 0) {
          if (scenario === "init-error") { emit({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: "boom" } }); continue; }
          if (scenario === "die-early") { setImmediate(() => proc.emit("close", 1)); continue; }
          if (scenario === "banner") emit("Starting adapter… (this is a non-JSON banner line)");
          emit({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, agentCapabilities: {}, ...(scenario === "auth-required" ? { authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }] } : {}) } });
        } else if (msg.id === 2) {
          emit({ jsonrpc: "2.0", id: 2, result: {} });
        } else if (msg.id === 1) {
          emit({ jsonrpc: "2.0", id: 1, result: newSessionResult(scenario) });
        }
      }
      return true;
    },
    end: () => {},
  };
  return proc;
}

function newSessionResult(scenario: string): any {
  const base = { sessionId: "s1", modes: null };
  if (scenario === "grouped") {
    return {
      ...base,
      configOptions: [
        {
          id: "model", name: "Model", type: "select", category: "model", currentValue: "opus",
          options: [
            { group: "g1", name: "Claude", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] },
          ],
        },
      ],
    };
  }
  if (scenario === "no-model-option") {
    return { ...base, configOptions: [{ id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "x", options: [{ value: "x", name: "X" }] }] };
  }
  if (scenario === "avail-models") {
    // claude-code 活体形状(相0.5 探针 2026-07-10 dump):无 configOptions,模型表在 result.models。
    return {
      ...base,
      models: {
        currentModelId: "default",
        availableModels: [
          { modelId: "default", name: "Default (recommended)", description: "Opus 4.6 · Most capable" },
          { modelId: "sonnet", name: "Sonnet", description: "Sonnet 4.5 · everyday" },
          { modelId: "haiku", name: "Haiku", description: "Haiku 4.5 · fastest" },
        ],
      },
    };
  }
  if (scenario === "both-shapes") {
    // codex 活体形状(同 dump):configOptions 与 models.availableModels 并存——应优先取 configOptions 的
    // clean 基座名(gpt-5.5 等),而非 availableModels 里的 effort 后缀变体(gpt-5.5[xhigh] 等)。
    return {
      ...base,
      models: {
        currentModelId: "gpt-5.5[xhigh]",
        availableModels: [
          { modelId: "gpt-5.5[low]", name: "GPT-5.5 (low)" },
          { modelId: "gpt-5.5[xhigh]", name: "GPT-5.5 (xhigh)" },
        ],
      },
      configOptions: [
        {
          id: "model", name: "Model", type: "select", category: "model", currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.6-terra", name: "GPT-5.6-Terra" }, { value: "gpt-5.5", name: "GPT-5.5" }],
        },
      ],
    };
  }
  // "models" (+ "banner" reuse this)
  return {
    ...base,
    configOptions: [
      { id: "thought", name: "Thinking", type: "select", category: "thought_level", currentValue: "low", options: [{ value: "low", name: "Low" }] },
      {
        id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet",
        options: [
          { value: "sonnet", name: "Claude Sonnet" },
          { value: "opus", name: "Claude Opus" },
        ],
      },
    ],
  };
}

beforeEach(() => {
  __resetAcpModelCacheForTest();
  __setProbeSpawnForTest(null);
  __setAcpProbeCommandResolverForTest((command) => ({ file: command, prefixArgs: [] }));
});

describe("extractAcpModels · 从 session/new.configOptions 抽模型", () => {
  it("扁平 model select → id/label/isDefault(=currentValue)", () => {
    const models = extractAcpModels([
      { id: "model", type: "select", category: "model", currentValue: "opus", options: [{ value: "sonnet", name: "S" }, { value: "opus", name: "O" }] },
    ]);
    expect(models).toEqual([
      { id: "sonnet", label: "S" },
      { id: "opus", label: "O", isDefault: true },
    ]);
  });
  it("分组 select → 拍平各组 options", () => {
    const models = extractAcpModels([
      { id: "m", type: "select", category: "model", currentValue: "b", options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] },
    ]);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("无 model 类 option / 非数组 → 空表", () => {
    expect(extractAcpModels([{ id: "mode", type: "select", category: "mode", currentValue: "x", options: [{ value: "x", name: "X" }] }])).toEqual([]);
    expect(extractAcpModels(null)).toEqual([]);
    expect(extractAcpModels(undefined)).toEqual([]);
  });
  it("无 category 但 id/name 含 model 的 select 也命中", () => {
    const models = extractAcpModels([{ id: "modelSelector", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] }]);
    expect(models.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("extractAcpModels · result.models.availableModels 形状(claude-code)", () => {
  it("传整个 result:availableModels[{modelId,name}] + currentModelId → id/label/isDefault", () => {
    const models = extractAcpModels({
      sessionId: "s1",
      models: {
        currentModelId: "default",
        availableModels: [
          { modelId: "default", name: "Default (recommended)", description: "Opus 4.6" },
          { modelId: "sonnet", name: "Sonnet" },
          { modelId: "haiku", name: "Haiku" },
        ],
      },
    });
    expect(models).toEqual([
      { id: "default", label: "Default (recommended)", isDefault: true },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ]);
  });

  it("configOptions 与 models 并存(codex)→ 优先 configOptions 的 clean 基座名,不取 effort 后缀变体", () => {
    const models = extractAcpModels({
      sessionId: "s1",
      models: {
        currentModelId: "gpt-5.5[xhigh]",
        availableModels: [{ modelId: "gpt-5.5[low]", name: "GPT-5.5 (low)" }, { modelId: "gpt-5.5[xhigh]", name: "GPT-5.5 (xhigh)" }],
      },
      configOptions: [
        { id: "model", type: "select", category: "model", currentValue: "gpt-5.5", options: [{ value: "gpt-5.6-terra", name: "T" }, { value: "gpt-5.5", name: "GPT-5.5" }] },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-5.5"]);
    expect(models.find((m) => m.id === "gpt-5.5")?.isDefault).toBe(true);
  });

  it("modelId 缺失/重复/name 缺失稳健", () => {
    const models = extractAcpModels({
      models: {
        currentModelId: "a",
        availableModels: [{ modelId: "a" }, { modelId: "a", name: "dup" }, { name: "no-id" }, { modelId: "b", name: "B" }],
      },
    });
    expect(models).toEqual([
      { id: "a", label: "a", isDefault: true },
      { id: "b", label: "B" },
    ]);
  });

  it("result 无 configOptions 且无 models / 空对象 → 空表", () => {
    expect(extractAcpModels({ sessionId: "s1" })).toEqual([]);
    expect(extractAcpModels({})).toEqual([]);
  });
});

describe("buildProbeSpec · 原生订阅 ACP 启动语义", () => {
  it("Gemini/Kimi/Grok 使用 shell:false 与官方 ACP 参数", () => {
    const gemini = buildProbeSpec("gemini-cli", {});
    const kimi = buildProbeSpec("kimi-cli", {});
    const grok = buildProbeSpec("grok-build", {});
    expect(gemini.args.slice(-1)).toEqual(["--acp"]);
    expect(kimi.args.slice(-1)).toEqual(["acp"]);
    expect(grok.args.slice(-2)).toEqual(["agent", "stdio"]);
    expect([gemini.shell, kimi.shell, grok.shell]).toEqual([false, false, false]);
  });

  it("订阅探针删除可能切到按量计费的 API Key 环境", () => {
    const gemini = buildProbeSpec("gemini-cli", { GEMINI_API_KEY: "secret", GOOGLE_APPLICATION_CREDENTIALS: "service.json" });
    const kimi = buildProbeSpec("kimi-cli", { KIMI_API_KEY: "secret", MOONSHOT_API_KEY: "secret" });
    const grok = buildProbeSpec("grok-build", { XAI_API_KEY: "secret" });
    expect(gemini.env.GEMINI_API_KEY).toBeUndefined();
    expect(gemini.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(kimi.env.KIMI_API_KEY).toBeUndefined();
    expect(kimi.env.MOONSHOT_API_KEY).toBeUndefined();
    expect(grok.env.XAI_API_KEY).toBeUndefined();
  });
});

describe("probeAcpModels · ACP 握手(注入假 adapter,零模型消耗)", () => {
  it("握手成功 → 返回活体模型表", async () => {
    __setProbeSpawnForTest((_spec: AcpProbeSpec) => makeFakeAdapter("models"));
    const models = await probeAcpModels("claude-code", { noCache: true });
    expect(models).not.toBeNull();
    expect(models!.map((m) => m.id)).toEqual(["sonnet", "opus"]);
    expect(models!.find((m) => m.id === "sonnet")?.isDefault).toBe(true);
  });

  it("claude-code 活体形状(result.models.availableModels)→ 返回真实模型表", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("avail-models"));
    const models = await probeAcpModels("claude-code", { noCache: true });
    expect(models!.map((m) => m.id)).toEqual(["default", "sonnet", "haiku"]);
    expect(models!.find((m) => m.id === "default")?.isDefault).toBe(true);
  });

  it("codex 活体形状(configOptions + models 并存)→ 走 configOptions clean 基座名,不回归", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("both-shapes"));
    const models = await probeAcpModels("codex", { noCache: true });
    expect(models!.map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-5.5"]);
    expect(models!.find((m) => m.id === "gpt-5.5")?.isDefault).toBe(true);
  });

  it("认证型 ACP 优先使用缓存订阅凭据，再创建 session", async () => {
    const requests: any[] = [];
    __setProbeSpawnForTest(() => makeFakeAdapter("auth-required", requests));
    const models = await probeAcpModels("grok-build", { noCache: true });
    expect(models).not.toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["initialize", "authenticate", "session/new"]);
    expect(requests.find((request) => request.method === "authenticate")?.params?.methodId).toBe("cached_token");
  });

  it("只有 API Key 认证方式时不假报订阅登录", async () => {
    __setProbeSpawnForTest(() => {
      const proc: any = new EventEmitter();
      proc.pid = undefined; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = {
        write: (line: string) => {
          const msg = JSON.parse(line);
          if (msg.id === 0) {
            proc.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { authMethods: [{ id: "xai.api_key" }] } }) + "\n"));
          }
          return true;
        },
        end: () => {},
      };
      return proc;
    });
    expect(await probeAcpModels("grok-build", { noCache: true })).toBeNull();
  });

  it("stdout 混入非 JSON 横幅行也不影响解析", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("banner"));
    const models = await probeAcpModels("codex", { noCache: true });
    expect(models!.map((m) => m.id)).toEqual(["sonnet", "opus"]);
  });

  it("session/new 无 model option → 空表(调用方回退静态)", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("no-model-option"));
    expect(await probeAcpModels("claude-code", { noCache: true })).toEqual([]);
  });

  it("initialize 报错 → null", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("init-error"));
    expect(await probeAcpModels("claude-code", { noCache: true })).toBeNull();
  });

  it("进程握手前早退 → null(绝不挂死)", async () => {
    __setProbeSpawnForTest(() => makeFakeAdapter("die-early"));
    expect(await probeAcpModels("claude-code", { noCache: true })).toBeNull();
  });

  it("握手超时 → null", async () => {
    __setProbeSpawnForTest(() => {
      const proc: any = new EventEmitter();
      proc.pid = undefined; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = { write: () => true, end: () => {} }; // 从不应答
      return proc;
    });
    expect(await probeAcpModels("claude-code", { noCache: true, timeoutMs: 80 })).toBeNull();
  });

  it("结果按引擎缓存(TTL 内第二次不再 spawn)", async () => {
    let spawns = 0;
    __setProbeSpawnForTest(() => { spawns++; return makeFakeAdapter("models"); });
    const a = await probeAcpModels("claude-code");
    const b = await probeAcpModels("claude-code");
    expect(a).toEqual(b);
    expect(spawns).toBe(1);
  });
});
