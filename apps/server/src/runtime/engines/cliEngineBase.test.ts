import { describe, it, expect, afterEach } from "vitest";
import { __setSpawnForTest, spawnCliWithRetry, isOverloadFailure } from "./cliEngineBase.js";

// ③ 协调者可靠性:CLI 引擎对 529/过载/超时退避重试,硬失败立即返回。这层是"不再把崩溃产物当有效结果"
// 的第一道闸——验证它确实重试瞬时失败、不重试硬失败,并正确标记 overloaded。

// 用一个不会被 `where` 解析到的假命令名,使 resolveCliExe 快速返回 null(走 shell 分支,但我们替换了
// spawnImpl,真实进程不会启动)。每次调用按序返回下一个预设响应。
function fakeSpawnSeq(responses: Array<{ code?: number | null; stdout?: string; stderr?: string; neverClose?: boolean; spawnError?: string }>) {
  const calls = { n: 0 };
  const fn = (_cmd: string, _args: string[], _opts: any) => {
    const resp = responses[Math.min(calls.n, responses.length - 1)];
    calls.n++;
    const handlers: Record<string, (arg?: any) => void> = {};
    const child: any = {
      stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stdout) cb(Buffer.from(resp.stdout)); } },
      stderr: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stderr) cb(Buffer.from(resp.stderr)); } },
      stdin: { write: () => {}, end: () => {} },
      on: (e: string, cb: (arg?: any) => void) => { handlers[e] = cb; },
      kill: () => {},
    };
    if (resp.spawnError) setImmediate(() => handlers["error"]?.(new Error(resp.spawnError)));
    else if (!resp.neverClose) setImmediate(() => handlers["close"]?.(resp.code ?? null));
    return child;
  };
  return { fn, calls };
}

afterEach(() => __setSpawnForTest(null));

describe("isOverloadFailure", () => {
  it("成功(code 0)永不算过载", () => {
    expect(isOverloadFailure({ code: 0, stdout: "overloaded", stderr: "", timedOut: false })).toBe(false);
  });
  it("超时单独处理,不算过载", () => {
    expect(isOverloadFailure({ code: null, stdout: "", stderr: "", timedOut: true })).toBe(false);
  });
  it("失败 + 529/overloaded 文案(stderr 或 stdout)→ 过载", () => {
    expect(isOverloadFailure({ code: 1, stdout: "", stderr: "Error: 529 Overloaded", timedOut: false })).toBe(true);
    expect(isOverloadFailure({ code: 1, stdout: '{"is_error":true,"result":"Overloaded"}', stderr: "", timedOut: false })).toBe(true);
  });
  it("失败但非过载文案 → 不算过载(硬失败)", () => {
    expect(isOverloadFailure({ code: 1, stdout: "", stderr: "invalid api key", timedOut: false })).toBe(false);
  });
  // claude/codex CLI 二进制里实测抓到的官方错误文案(见 OVERLOAD_RE 注释):额度耗尽也算过载,
  // 应走同一条"暂时不健康,换账号"的路径,而不是被当成硬失败直接放弃。
  it("claude 官方文案 usage limit reached / credit balance too low → 过载", () => {
    expect(isOverloadFailure({ code: 1, stdout: "", stderr: "Claude AI usage limit reached|1735689600", timedOut: false })).toBe(true);
    expect(isOverloadFailure({ code: 1, stdout: "", stderr: "Your credit balance is too low", timedOut: false })).toBe(true);
  });
  it("codex 官方错误类型 UsageLimitExceeded/usage_limit_exceeded → 过载", () => {
    expect(isOverloadFailure({ code: 1, stdout: '{"type":"error","error":{"code":"usage_limit_exceeded"}}', stderr: "", timedOut: false })).toBe(true);
  });
});

describe("spawnCliWithRetry", () => {
  it("过载后成功 → 重试并最终返回成功", async () => {
    const { fn, calls } = fakeSpawnSeq([
      { code: 1, stderr: "529 Overloaded" },
      { code: 0, stdout: "OK" },
    ]);
    __setSpawnForTest(fn);
    const res = await spawnCliWithRetry("faketestcli-a", [], {}, { overloadRetries: 3, baseBackoffMs: 1 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
    expect(calls.n).toBe(2); // 重试了一次
  });

  it("持续过载 → 用尽重试,返回 overloaded 标记", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: 1, stderr: "rate limit exceeded" }]);
    __setSpawnForTest(fn);
    const res = await spawnCliWithRetry("faketestcli-b", [], {}, { overloadRetries: 2, baseBackoffMs: 1 });
    expect(res.code).toBe(1);
    expect(res.overloaded).toBe(true);
    expect(calls.n).toBe(3); // 1 次初始 + 2 次重试
  });

  it("硬失败 → 立即返回,不重试", async () => {
    const { fn, calls } = fakeSpawnSeq([
      { code: 1, stderr: "invalid api key" },
      { code: 0, stdout: "should-not-reach" },
    ]);
    __setSpawnForTest(fn);
    const res = await spawnCliWithRetry("faketestcli-c", [], {}, { overloadRetries: 3, baseBackoffMs: 1 });
    expect(res.code).toBe(1);
    expect(res.overloaded).toBe(false);
    expect(calls.n).toBe(1); // 没有重试
  });

  it("spawn ENOENT(二进制瞬时不可用,如自动更新)→ 清缓存重试并成功", async () => {
    const { fn, calls } = fakeSpawnSeq([
      { spawnError: "spawn faketestcli-e ENOENT" },
      { code: 0, stdout: "OK" },
    ]);
    __setSpawnForTest(fn);
    const res = await spawnCliWithRetry("faketestcli-e", [], {}, { spawnRetries: 3, baseBackoffMs: 1 });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
    expect(calls.n).toBe(2); // 重试了一次
  });

  it("超时 → 按 timeoutRetries 重试一次", async () => {
    const { fn, calls } = fakeSpawnSeq([{ code: null, neverClose: true }]);
    __setSpawnForTest(fn);
    const res = await spawnCliWithRetry("faketestcli-d", [], { timeoutMs: 5 }, { timeoutRetries: 1, baseBackoffMs: 1 });
    expect(res.timedOut).toBe(true);
    expect(calls.n).toBe(2); // 初始 + 1 次超时重试
  });
});
