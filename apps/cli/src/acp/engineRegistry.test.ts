// 相1 · ACP 引擎注册表单测:纯 env/命令变换,不 spawn 任何进程、不碰真引擎。
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { buildEngineSpec, isAcpEngineId, ACP_ENGINE_IDS, killProcessTree, resolveWinGitBashPath } from "./engineRegistry.js";

const NPX_RE = /^npx(\.cmd)?$/;

describe("isAcpEngineId", () => {
  it("认可首发两家,拒绝其余", () => {
    expect(isAcpEngineId("claude-code")).toBe(true);
    expect(isAcpEngineId("codex")).toBe(true);
    expect(isAcpEngineId("gemini")).toBe(false);
    expect(isAcpEngineId("")).toBe(false);
    expect(ACP_ENGINE_IDS).toEqual(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
  });
});

describe("buildEngineSpec · claude-code", () => {
  it("删除 CLAUDECODE(探针 #4 嵌套会话自杀守卫),保留其它 env", () => {
    const spec = buildEngineSpec("claude-code", { env: { CLAUDECODE: "1", FOO: "bar", PATH: "/usr/bin" } });
    expect("CLAUDECODE" in spec.env).toBe(false);
    expect(spec.env.FOO).toBe("bar");
    expect(spec.env.PATH).toBe("/usr/bin");
    expect(spec.command).toMatch(NPX_RE);
    expect(spec.args).toEqual(["-y", "@zed-industries/claude-code-acp"]);
  });

  it("绝不注入任何 *_API_KEY", () => {
    const spec = buildEngineSpec("claude-code", { env: {} });
    expect("OPENAI_API_KEY" in spec.env).toBe(false);
    expect("CODEX_API_KEY" in spec.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in spec.env).toBe(false);
  });

  it("不原地修改传入的 env 对象(浅拷贝隔离)", () => {
    const src: NodeJS.ProcessEnv = { CLAUDECODE: "1" };
    buildEngineSpec("claude-code", { env: src });
    expect(src.CLAUDECODE).toBe("1");
  });
});

describe("buildEngineSpec · codex", () => {
  it("设 INITIAL_AGENT_MODE=read-only 且删除 OPENAI_API_KEY/CODEX_API_KEY(探针 #3/#5 + IRON RULE)", () => {
    const spec = buildEngineSpec("codex", {
      env: { OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "cx-y", KEEP: "1" },
    });
    expect(spec.env.INITIAL_AGENT_MODE).toBe("read-only");
    expect("OPENAI_API_KEY" in spec.env).toBe(false);
    expect("CODEX_API_KEY" in spec.env).toBe(false);
    expect(spec.env.KEEP).toBe("1");
    expect(spec.command).toMatch(NPX_RE);
    expect(spec.args).toEqual(["-y", "@agentclientprotocol/codex-acp"]);
  });

  it("不原地修改传入的 env(原对象仍持有被禁 key)", () => {
    const src: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-x" };
    buildEngineSpec("codex", { env: src });
    expect(src.OPENAI_API_KEY).toBe("sk-x");
  });
});

describe("buildEngineSpec · codex 对话场景低时延默认(reasoning effort)", () => {
  it("chat:true 且无 CODEX_CONFIG → 注入 model_reasoning_effort=low", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: "/usr/bin" }, chat: true });
    expect(JSON.parse(spec.env.CODEX_CONFIG!)).toEqual({ model_reasoning_effort: "low" });
  });

  it("非对话路径(缺省 chat)绝不注入 CODEX_CONFIG——任务执行链保留深推理默认", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: "/usr/bin" } });
    expect("CODEX_CONFIG" in spec.env).toBe(false);
  });

  it("OPC_CODEX_CHAT_EFFORT 显式指定合法档位 → 采用该档", () => {
    const spec = buildEngineSpec("codex", { env: { OPC_CODEX_CHAT_EFFORT: "medium" }, chat: true });
    expect(JSON.parse(spec.env.CODEX_CONFIG!).model_reasoning_effort).toBe("medium");
  });

  it("OPC_CODEX_CHAT_EFFORT 非法值 → 回退默认 low", () => {
    const spec = buildEngineSpec("codex", { env: { OPC_CODEX_CHAT_EFFORT: "turbo" }, chat: true });
    expect(JSON.parse(spec.env.CODEX_CONFIG!).model_reasoning_effort).toBe("low");
  });

  it("既有 CODEX_CONFIG 已显式写 model_reasoning_effort → 一律尊重不覆盖", () => {
    const src = JSON.stringify({ model_reasoning_effort: "high", model: "gpt-5.5" });
    const spec = buildEngineSpec("codex", { env: { CODEX_CONFIG: src }, chat: true });
    expect(JSON.parse(spec.env.CODEX_CONFIG!)).toEqual({ model_reasoning_effort: "high", model: "gpt-5.5" });
  });

  it("既有 CODEX_CONFIG 无 effort → 合并进默认 low 且保留其余键", () => {
    const spec = buildEngineSpec("codex", { env: { CODEX_CONFIG: JSON.stringify({ model: "gpt-5.6-luna" }) }, chat: true });
    expect(JSON.parse(spec.env.CODEX_CONFIG!)).toEqual({ model: "gpt-5.6-luna", model_reasoning_effort: "low" });
  });

  it("既有 CODEX_CONFIG 非法 JSON → 原样保留,绝不误改", () => {
    const spec = buildEngineSpec("codex", { env: { CODEX_CONFIG: "{not json" }, chat: true });
    expect(spec.env.CODEX_CONFIG).toBe("{not json");
  });

  it("claude-code 的 chat:true 不触发 codex 专属逻辑(不产生 CODEX_CONFIG)", () => {
    const spec = buildEngineSpec("claude-code", { env: { PATH: "/usr/bin" }, chat: true });
    expect("CODEX_CONFIG" in spec.env).toBe(false);
  });

  it("chat 降档不原地修改传入的 env 对象", () => {
    const src: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    buildEngineSpec("codex", { env: src, chat: true });
    expect("CODEX_CONFIG" in src).toBe(false);
  });
});

describe("buildEngineSpec · codex 显式推理档位(reasoningEffort:员工/系统模型设置)", () => {
  it("任务链(非 chat)显式 reasoningEffort=high → 注入 model_reasoning_effort=high", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: "/usr/bin" }, reasoningEffort: "high" });
    expect(JSON.parse(spec.env.CODEX_CONFIG!).model_reasoning_effort).toBe("high");
  });

  it("任务链(非 chat)且未设 reasoningEffort → 不注入 CODEX_CONFIG(保留引擎深推理默认)", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: "/usr/bin" } });
    expect("CODEX_CONFIG" in spec.env).toBe(false);
  });

  it("四档 low/medium/high/xhigh 均合法透传", () => {
    for (const e of ["low", "medium", "high", "xhigh"] as const) {
      const spec = buildEngineSpec("codex", { env: {}, reasoningEffort: e });
      expect(JSON.parse(spec.env.CODEX_CONFIG!).model_reasoning_effort).toBe(e);
    }
  });

  it("显式 reasoningEffort 优先于对话默认 low(chat:true 时以档位为准)", () => {
    const spec = buildEngineSpec("codex", { env: {}, chat: true, reasoningEffort: "xhigh" });
    expect(JSON.parse(spec.env.CODEX_CONFIG!).model_reasoning_effort).toBe("xhigh");
  });

  it("既有 CODEX_CONFIG 已显式写 effort → 即便传 reasoningEffort 也一律尊重不覆盖", () => {
    const src = JSON.stringify({ model_reasoning_effort: "medium", model: "gpt-5.5" });
    const spec = buildEngineSpec("codex", { env: { CODEX_CONFIG: src }, reasoningEffort: "xhigh" });
    expect(JSON.parse(spec.env.CODEX_CONFIG!)).toEqual({ model_reasoning_effort: "medium", model: "gpt-5.5" });
  });

  it("claude-code 显式 reasoningEffort → 注入 CLAUDE_CODE_EFFORT_LEVEL,绝不产生 codex 专属 CODEX_CONFIG", () => {
    const spec = buildEngineSpec("claude-code", { env: { PATH: "/usr/bin" }, reasoningEffort: "xhigh" });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("xhigh");
    expect("CODEX_CONFIG" in spec.env).toBe(false);
  });

  it("claude-code 四档 low/medium/high/xhigh 均透传给 CLAUDE_CODE_EFFORT_LEVEL", () => {
    for (const e of ["low", "medium", "high", "xhigh"] as const) {
      const spec = buildEngineSpec("claude-code", { env: {}, reasoningEffort: e });
      expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe(e);
    }
  });

  it("claude-code 未设 reasoningEffort → 不注入 CLAUDE_CODE_EFFORT_LEVEL(保留引擎默认)", () => {
    const spec = buildEngineSpec("claude-code", { env: { PATH: "/usr/bin" } });
    expect("CLAUDE_CODE_EFFORT_LEVEL" in spec.env).toBe(false);
  });
});

describe("buildEngineSpec · 订阅账号隔离登录目录(cliConfigDir → 多账号池真生效)", () => {
  it("claude-code + cliConfigDir → 注入 CLAUDE_CONFIG_DIR(选定账号凭证,不落回全局登录)", () => {
    const spec = buildEngineSpec("claude-code", { env: { PATH: "/usr/bin" }, cliConfigDir: "/opc/.opc/cli-accounts/a2" });
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe("/opc/.opc/cli-accounts/a2");
  });

  it("codex + cliConfigDir → 注入 CODEX_HOME", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: "/usr/bin" }, cliConfigDir: "/opc/.opc/cli-accounts/x9" });
    expect(spec.env.CODEX_HOME).toBe("/opc/.opc/cli-accounts/x9");
  });

  it("未设 cliConfigDir → 不注入(沿用全局登录/进程既有 env)", () => {
    const cc = buildEngineSpec("claude-code", { env: { PATH: "/usr/bin" } });
    const cx = buildEngineSpec("codex", { env: { PATH: "/usr/bin" } });
    expect("CLAUDE_CONFIG_DIR" in cc.env).toBe(false);
    expect("CODEX_HOME" in cx.env).toBe(false);
  });
});

describe("Fix3 · Windows git-bash 发现 + 注入 CLAUDE_CODE_GIT_BASH_PATH", () => {
  it("显式 CLAUDE_CODE_GIT_BASH_PATH 指向存在的文件 → 原样返回(win32)", () => {
    if (process.platform !== "win32") return; // win 专属:非 win 恒 null(下条覆盖)
    expect(resolveWinGitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: process.execPath } as NodeJS.ProcessEnv)).toBe(process.execPath);
  });

  it("非 win32 → null(绝不干预 mac/linux)", () => {
    if (process.platform === "win32") return;
    expect(resolveWinGitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: "/bin/sh" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("指向不存在的路径且 PATH 无 Git → null(不假报,不写死单机路径)", () => {
    if (process.platform !== "win32") return;
    expect(resolveWinGitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: "X:\\nope\\bash.exe", PATH: "C:\\Windows\\System32" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("win32 本机装了 git-bash → buildEngineSpec(claude-code) 自动注入 CLAUDE_CODE_GIT_BASH_PATH", () => {
    if (process.platform !== "win32") return;
    const gb = resolveWinGitBashPath(process.env);
    if (!gb) return; // 本机确无 git-bash 时跳过(诚实,不误判)
    const spec = buildEngineSpec("claude-code", { env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
    expect(spec.env.CLAUDE_CODE_GIT_BASH_PATH).toBeTruthy();
    expect(spec.env.CLAUDE_CODE_GIT_BASH_PATH!.toLowerCase()).toContain("bash.exe");
  });

  it("已显式设 CLAUDE_CODE_GIT_BASH_PATH → buildEngineSpec 尊重不覆盖", () => {
    const spec = buildEngineSpec("claude-code", { env: { CLAUDE_CODE_GIT_BASH_PATH: "X:\\custom\\bash.exe" } as NodeJS.ProcessEnv });
    expect(spec.env.CLAUDE_CODE_GIT_BASH_PATH).toBe("X:\\custom\\bash.exe");
  });

  it("codex 分支不注入 git-bash(只 claude-code 需要)", () => {
    const spec = buildEngineSpec("codex", { env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
    expect("CLAUDE_CODE_GIT_BASH_PATH" in spec.env).toBe(false);
  });
});

describe("buildEngineSpec · native subscription ACP engines", () => {
  it("gemini-cli uses the official --acp mode, isolates HOME and strips API keys", () => {
    const spec = buildEngineSpec("gemini-cli", {
      env: { GEMINI_API_KEY: "secret", GOOGLE_API_KEY: "secret" },
      cliConfigDir: "/opc/accounts/gemini",
    });
    expect(spec.args.slice(-2)).toEqual(["@google/gemini-cli", "--acp"]);
    expect(spec.env.GEMINI_CLI_HOME).toBe("/opc/accounts/gemini");
    expect(spec.env.GEMINI_API_KEY).toBeUndefined();
    expect(spec.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("kimi-cli uses kimi acp and KIMI_CODE_HOME without API credentials", () => {
    const spec = buildEngineSpec("kimi-cli", {
      env: { KIMI_API_KEY: "secret", MOONSHOT_API_KEY: "secret" },
      cliConfigDir: "/opc/accounts/kimi",
    });
    expect(spec).toMatchObject({ command: "kimi", args: ["acp"], shell: false });
    expect(spec.env.KIMI_CODE_HOME).toBe("/opc/accounts/kimi");
    expect(spec.env.KIMI_API_KEY).toBeUndefined();
    expect(spec.env.MOONSHOT_API_KEY).toBeUndefined();
  });

  it("grok-build uses grok agent stdio and GROK_HOME without XAI_API_KEY", () => {
    const spec = buildEngineSpec("grok-build", {
      env: { XAI_API_KEY: "secret" },
      cliConfigDir: "/opc/accounts/grok",
    });
    expect(spec).toMatchObject({ command: "grok", args: ["agent", "stdio"], shell: false });
    expect(spec.env.GROK_HOME).toBe("/opc/accounts/grok");
    expect(spec.env.XAI_API_KEY).toBeUndefined();
  });
});
describe("killProcessTree", () => {
  it("pid 缺失时静默返回,不抛", () => {
    expect(() => killProcessTree({ pid: undefined } as unknown as ChildProcess)).not.toThrow();
  });
});

describe("buildEngineSpec · packaged npx runtime", () => {
  it("uses bundled node + npx-cli with shell:false", () => {
    const spec = buildEngineSpec("codex", {
      env: { OPC_NODE_EXECUTABLE: process.execPath, OPC_NPX_CLI: process.execPath },
    });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args.slice(0, 2)).toEqual([process.execPath, "-y"]);
    expect(spec.shell).toBe(false);
  });

  it("fails closed when the packaged runtime is incomplete", () => {
    expect(() => buildEngineSpec("codex", { env: { OPC_NODE_EXECUTABLE: process.execPath } })).toThrow(/incomplete/);
  });
});