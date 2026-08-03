import { describe, it, expect } from "vitest";
import {
  GEMINI_CLI_PRESET,
  QWEN_CODE_PRESET,
  OPENCODE_PRESET,
  AIDER_PRESET,
  GOOSE_PRESET,
  OPENHANDS_PRESET,
  AMP_PRESET,
  PLANDEX_PRESET,
  OPEN_INTERPRETER_PRESET,
  GENERIC_CLI_PRESETS,
} from "./genericCliPresets.js";

// 9 份"12+1 CLI 框架"预设的 buildArgs/parseOutput 单元测试。fixture 依据研究阶段确认过的真实 JSON
// schema 片段构造(见 genericCliPresets.ts 顶部每个 preset 的注释)。诚实声明:本机没有安装任何一个
// 真实二进制,这些全部是"代码层面自洽"验证,不是活体 spawn 验证。

describe("GENERIC_CLI_PRESETS registry", () => {
  it("正好收录 9 个具名工具,不含 generic-cli 本身", () => {
    expect(Object.keys(GENERIC_CLI_PRESETS).sort()).toEqual(
      ["aider", "amp", "gemini-cli", "goose", "open-interpreter", "openhands", "opencode", "plandex", "qwen-code"].sort(),
    );
  });
});

describe("gemini-cli preset", () => {
  it("buildArgs: -p + --output-format json,带模型时追加 -m", () => {
    const args = GEMINI_CLI_PRESET.buildArgs("hello world", { model: "gemini-2.5-pro", cwd: "/tmp" });
    expect(args).toEqual(["-p", "hello world", "--output-format", "json", "-m", "gemini-2.5-pro"]);
  });
  it("buildArgs: 不安全的模型名(含空格/shell 元字符)被丢弃", () => {
    const args = GEMINI_CLI_PRESET.buildArgs("hi", { model: "bad model; rm -rf", cwd: "/tmp" });
    expect(args).toEqual(["-p", "hi", "--output-format", "json"]);
  });
  it("parseOutput: 成功响应 → content=response,累计 token", () => {
    const stdout = JSON.stringify({ response: "the answer is 42", stats: { promptTokens: 120, completionTokens: 30 } });
    const r = GEMINI_CLI_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("the answer is 42");
    expect(r.tokensUsed).toEqual({ prompt: 120, completion: 30 });
  });
  it("parseOutput: error 字段存在 → ok=false", () => {
    const stdout = JSON.stringify({ error: { message: "quota exceeded" } });
    const r = GEMINI_CLI_PRESET.parseOutput(stdout, "", 1);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("quota exceeded");
  });
  it("parseOutput: 非 JSON 输出(卡死/异常退出后仅有零星文本)→ 按 exitCode 兜底判断", () => {
    const r = GEMINI_CLI_PRESET.parseOutput("", "timeout", null as any);
    expect(r.ok).toBe(false);
  });
});

describe("qwen-code preset", () => {
  it("buildArgs 与 gemini-cli 同构(共享 fork 语法)", () => {
    const args = QWEN_CODE_PRESET.buildArgs("do task", { model: "qwen3-coder", cwd: "/tmp" });
    expect(args).toEqual(["-p", "do task", "--output-format", "json", "-m", "qwen3-coder"]);
  });
  it("stripEnvPrefixes 包含 CI_(防止 CI_TOKEN 等误判 CI 环境)", () => {
    expect(QWEN_CODE_PRESET.stripEnvPrefixes).toEqual(["CI_"]);
  });
  it("authEnvVar 同时列出 DASHSCOPE_API_KEY 与 OPENAI_API_KEY 两个候选名", () => {
    expect(QWEN_CODE_PRESET.authEnvVar).toEqual(["DASHSCOPE_API_KEY", "OPENAI_API_KEY"]);
  });
  it("parseOutput: is_error=true → ok=false(即便 exitCode 恰好是 0)", () => {
    const stdout = JSON.stringify({ is_error: true, result: "rate limited", duration_ms: 500 });
    const r = QWEN_CODE_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(false);
  });
  it("parseOutput: 正常响应", () => {
    const stdout = JSON.stringify({ response: "done", usage: { input_tokens: 10, output_tokens: 5 }, is_error: false });
    const r = QWEN_CODE_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("done");
    expect(r.tokensUsed).toEqual({ prompt: 10, completion: 5 });
  });
});

describe("opencode preset", () => {
  it("buildArgs 含 run + --auto(自动批准,issue #13851 要求)", () => {
    const args = OPENCODE_PRESET.buildArgs("build a widget", { model: "anthropic/claude-sonnet-5", cwd: "/tmp" });
    expect(args).toEqual(["run", "build a widget", "--format", "json", "--auto", "--model", "anthropic/claude-sonnet-5"]);
  });
  it("trustExitCode=false(#26855:JSON 流可能在完成前提前退出)", () => {
    expect(OPENCODE_PRESET.trustExitCode).toBe(false);
  });
  it("parseOutput: 读到 step_finish 终态事件 → ok=true", () => {
    const stdout = [
      JSON.stringify({ type: "text", text: "working on it" }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");
    const r = OPENCODE_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("working on it");
  });
  it("parseOutput: 显式 error 事件 → ok=false", () => {
    const stdout = JSON.stringify({ type: "error", error: { message: "boom" } });
    const r = OPENCODE_PRESET.parseOutput(stdout, "", 1);
    expect(r.ok).toBe(false);
  });
  it("parseOutput: 流被截断(无终态事件但有部分文本)→ 降级可用,不假装完整", () => {
    const stdout = JSON.stringify({ type: "text", text: "partial output" });
    const r = OPENCODE_PRESET.parseOutput(stdout, "", null as any);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("partial output");
    expect(r.content).toContain("不完整");
  });
  it("parseOutput: 完全没有可用内容且无终态事件 → ok=false", () => {
    const r = OPENCODE_PRESET.parseOutput("", "", null as any);
    expect(r.ok).toBe(false);
  });
});

describe("aider preset", () => {
  it("buildArgs: --message --yes-always --no-pretty --no-stream", () => {
    const args = AIDER_PRESET.buildArgs("fix the bug", { cwd: "/tmp" });
    expect(args).toEqual(["--message", "fix the bug", "--yes-always", "--no-pretty", "--no-stream"]);
  });
  it("无 JSON 输出——纯文本直接当 content", () => {
    const r = AIDER_PRESET.parseOutput("Applied edit to foo.py\n", "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("Applied edit to foo.py");
  });
  it("非 0 退出码一律当失败,不细分错误类型", () => {
    const r = AIDER_PRESET.parseOutput("", "some error", 1);
    expect(r.ok).toBe(false);
  });
});

describe("goose preset — 退出码不可信(#4612)", () => {
  it("trustExitCode=false", () => {
    expect(GOOSE_PRESET.trustExitCode).toBe(false);
  });
  it("buildArgs 显式给出小的 --max-turns(不用危险的默认 1000)", () => {
    const args = GOOSE_PRESET.buildArgs("do something", { cwd: "/tmp" });
    expect(args).toEqual(["run", "--no-session", "-t", "do something", "--output-format", "json", "--max-turns", "1"]);
  });
  it("extraEnv 注入 GOOSE_PROVIDER/GOOSE_MODEL", () => {
    const env = GOOSE_PRESET.extraEnv!({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(env).toEqual({ GOOSE_PROVIDER: "anthropic", GOOSE_MODEL: "claude-sonnet-5" });
  });
  it("parseOutput: exitCode=0 但 JSON 内容里带 error → ok=false(#4612 核心场景)", () => {
    const stdout = JSON.stringify({ error: "LLM call failed", success: false });
    const r = GOOSE_PRESET.parseOutput(stdout, "", 0); // 注意:exitCode 传 0,模拟"报错但退出码撒谎"
    expect(r.ok).toBe(false);
  });
  it("parseOutput: 正常 JSON 无错误标志 → ok=true", () => {
    const stdout = JSON.stringify({ response: "task complete" });
    const r = GOOSE_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("task complete");
  });
  it("parseOutput: 解析不出 JSON → 没有可信信号来源,保守判失败", () => {
    const r = GOOSE_PRESET.parseOutput("not json at all", "", 0);
    expect(r.ok).toBe(false);
  });
});

describe("openhands preset", () => {
  it("buildArgs 含 --override-with-envs(最容易踩的坑——不加 env 认证不生效)", () => {
    const args = OPENHANDS_PRESET.buildArgs("implement feature", { cwd: "/tmp" });
    expect(args).toEqual(["--headless", "--task", "implement feature", "--always-approve", "--json", "--override-with-envs"]);
  });
  it("extraEnv 注入 LLM_MODEL", () => {
    expect(OPENHANDS_PRESET.extraEnv!({ provider: "openai", model: "gpt-5-mini" })).toEqual({ LLM_MODEL: "gpt-5-mini" });
  });
  it("parseOutput: JSONL 事件流,取最后一条文本 + exitCode 0 且无 error 事件 → ok=true", () => {
    const stdout = [
      JSON.stringify({ observation: "reading file" }),
      JSON.stringify({ content: "task finished successfully" }),
    ].join("\n");
    const r = OPENHANDS_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("task finished successfully");
  });
  it("parseOutput: exitCode=1(文档明确的失败码)→ ok=false", () => {
    const r = OPENHANDS_PRESET.parseOutput(JSON.stringify({ content: "partial" }), "", 1);
    expect(r.ok).toBe(false);
  });
});

describe("amp preset", () => {
  it("buildArgs 含 -x(不加会被当交互会话首条消息)", () => {
    const args = AMP_PRESET.buildArgs("write a test", { cwd: "/tmp" });
    expect(args).toEqual(["-x", "write a test", "--stream-json"]);
  });
  it("trustExitCode=false(进程退出码未文档化)", () => {
    expect(AMP_PRESET.trustExitCode).toBe(false);
  });
  it("parseOutput: result 消息里 is_error 才是权威信号", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working..." }] } }),
      JSON.stringify({ type: "result", is_error: false, result: "done", usage: { input_tokens: 200, output_tokens: 50 } }),
    ].join("\n");
    const r = AMP_PRESET.parseOutput(stdout, "", null as any); // exitCode 未知也不影响判断
    expect(r.ok).toBe(true);
    expect(r.content).toBe("done");
    expect(r.tokensUsed).toEqual({ prompt: 200, completion: 50 });
  });
  it("parseOutput: result.is_error=true → ok=false", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "failed: bad request" });
    const r = AMP_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(false);
  });
  it("parseOutput: 没有 result 事件(流截断)→ 不假装成功", () => {
    const stdout = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
    const r = AMP_PRESET.parseOutput(stdout, "", 0);
    expect(r.ok).toBe(false);
    expect(r.content).toBe("partial");
  });
});

describe("plandex preset", () => {
  it("buildArgs: tell --apply --auto-exec --debug", () => {
    const args = PLANDEX_PRESET.buildArgs("add a feature", { cwd: "/tmp" });
    expect(args).toEqual(["tell", "add a feature", "--apply", "--auto-exec", "--debug"]);
  });
  it("notes 包含首次 sign-in 的已知限制", () => {
    expect(PLANDEX_PRESET.notes?.some((n) => n.includes("sign-in"))).toBe(true);
  });
  it("authEnvVar 按 provider 动态算 {PROVIDER}_API_KEY", () => {
    const fn = PLANDEX_PRESET.authEnvVar as (p: string) => string;
    expect(fn("openai")).toBe("OPENAI_API_KEY");
    expect(fn("anthropic")).toBe("ANTHROPIC_API_KEY");
  });
  it("无 JSON 输出,纯文本 + exitCode 判断", () => {
    const r = PLANDEX_PRESET.parseOutput("Plan applied.\n", "", 0);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("Plan applied.");
  });
});

describe("open-interpreter preset", () => {
  it("buildArgs 含 -y(跳过确认,文档确认过的参数)", () => {
    const args = OPEN_INTERPRETER_PRESET.buildArgs("run this code", { cwd: "/tmp" });
    expect(args).toEqual(["-y", "run this code"]);
  });
  it("notes 包含风险警告(真实执行本机代码)与接口未确认声明", () => {
    const notes = OPEN_INTERPRETER_PRESET.notes ?? [];
    expect(notes.some((n) => n.includes("未完全确认"))).toBe(true);
    expect(notes.some((n) => n.includes("真实执行本机代码"))).toBe(true);
  });
  it("authEnvVar 未设置(认证机制未确认,不假设)", () => {
    expect(OPEN_INTERPRETER_PRESET.authEnvVar).toBeUndefined();
  });
  it("无 JSON 输出,纯文本 + exitCode 判断", () => {
    const r = OPEN_INTERPRETER_PRESET.parseOutput("Executed.\n", "", 0);
    expect(r.ok).toBe(true);
  });
});
