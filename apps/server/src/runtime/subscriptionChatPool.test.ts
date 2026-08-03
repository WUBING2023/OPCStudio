// 订阅对话会话池 · 池逻辑单测。注入假 worker(不 spawn 真进程、不打真模型),覆盖:
//   get-or-spawn(至多 1 worker)/ 请求串行(并发只 1 在途)/ 空闲 TTL 杀树(fake timers)/ 进程死亡自动重启 /
//   send 失败与 worker 回错误后杀重置 / spawn 失败摘除重试 / chatPoolEnabled 逃生门与 VITEST 默认关。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SubscriptionChatPool,
  chatPoolEnabled,
  type ChatWorkerHandle,
  type ChatPoolRequest,
  type ChatWorkerResponse,
} from "./subscriptionChatPool.js";

function req(id: string, prompt = "p-" + id): ChatPoolRequest {
  return { id, prompt, maxTokens: 100 };
}
function okResp(r: ChatPoolRequest): ChatWorkerResponse {
  return { id: r.id, content: "ok:" + r.prompt, tokens: 10, promptTokens: 6, completionTokens: 4, estimated: false };
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// send 立即(微任务)解析的假 worker。
function autoWorker(makeResp: (r: ChatPoolRequest) => ChatWorkerResponse = okResp) {
  let killed = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((r) => (resolveExited = r));
  const worker: ChatWorkerHandle = {
    send: (r) => Promise.resolve(makeResp(r)),
    kill: () => { if (!killed) { killed = true; resolveExited(); } },
    exited,
  };
  return { worker, get killed() { return killed; }, die: () => resolveExited() };
}

// send 挂在闸门上、需手动 release 的假 worker(验证串行:同一时刻只 1 在途)。
function gatedWorker() {
  const gates: Array<{ r: ChatPoolRequest; resolve: (x: ChatWorkerResponse) => void }> = [];
  const arrivalWaiters: Array<() => void> = [];
  let inFlight = 0, maxInFlight = 0, killed = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((r) => (resolveExited = r));
  const worker: ChatWorkerHandle = {
    send: (r) =>
      new Promise<ChatWorkerResponse>((resolve) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        gates.push({ r, resolve: (x) => { inFlight--; resolve(x); } });
        const w = arrivalWaiters.shift(); if (w) w();
      }),
    kill: () => { if (!killed) { killed = true; resolveExited(); } },
    exited,
  };
  return {
    worker,
    get maxInFlight() { return maxInFlight; },
    get pending() { return gates.length; },
    waitForSend: () => new Promise<void>((res) => { if (gates.length) res(); else arrivalWaiters.push(res); }),
    releaseNext: () => { const g = gates.shift()!; g.resolve(okResp(g.r)); },
  };
}

describe("SubscriptionChatPool", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("get-or-spawn:连续请求复用同一常驻 worker(spawn 恰一次)", async () => {
    let spawnCount = 0;
    const pool = new SubscriptionChatPool({ spawnWorker: async () => { spawnCount++; return autoWorker().worker; } });
    const a = await pool.invoke("claude-code", req("1"));
    const b = await pool.invoke("claude-code", req("2"));
    expect(spawnCount).toBe(1);
    expect(a.content).toBe("ok:p-1");
    expect(b.content).toBe("ok:p-2");
    expect(a.promptTokens).toBe(6);
    expect(a.tokens).toBe(10);
    pool.shutdown();
  });

  it("并发请求经串行链:同一时刻只 1 个 send 在途", async () => {
    const g = gatedWorker();
    const pool = new SubscriptionChatPool({ spawnWorker: async () => g.worker, requestTimeoutMs: 60_000 });

    const p1 = pool.invoke("claude-code", req("a"));
    const p2 = pool.invoke("claude-code", req("b"));

    await g.waitForSend();
    expect(g.pending).toBe(1);        // 第二个还没进 send(排队中)
    expect(g.maxInFlight).toBe(1);
    g.releaseNext();
    await p1;

    await g.waitForSend();
    expect(g.pending).toBe(1);
    g.releaseNext();
    await p2;

    expect(g.maxInFlight).toBe(1);    // 全程并发 1
    pool.shutdown();
  });

  it("空闲 TTL 到点杀树回收,下次请求冷启动一次(fake timers)", async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    const workers: ReturnType<typeof autoWorker>[] = [];
    const pool = new SubscriptionChatPool({
      spawnWorker: async () => { spawnCount++; const w = autoWorker(); workers.push(w); return w.worker; },
      idleTtlMs: 5000,
    });

    await pool.invoke("claude-code", req("1"));
    expect(spawnCount).toBe(1);
    expect(workers[0].killed).toBe(false);

    await vi.advanceTimersByTimeAsync(5000); // 空闲到点
    expect(workers[0].killed).toBe(true);

    await pool.invoke("claude-code", req("2")); // 已回收 → 冷启动一次
    expect(spawnCount).toBe(2);
    pool.shutdown();
  });

  it("worker 进程死亡自动从池摘除,下次请求冷启动一次", async () => {
    let spawnCount = 0;
    const workers: ReturnType<typeof autoWorker>[] = [];
    const pool = new SubscriptionChatPool({ spawnWorker: async () => { spawnCount++; const w = autoWorker(); workers.push(w); return w.worker; } });

    await pool.invoke("claude-code", req("1"));
    expect(spawnCount).toBe(1);

    workers[0].die();        // 进程退出
    await sleep(0);          // 让 exited.then 的摘除跑掉

    await pool.invoke("claude-code", req("2"));
    expect(spawnCount).toBe(2);
    pool.shutdown();
  });

  it("worker 回 error → 杀掉重置并 throw,下次请求冷启动一次", async () => {
    let n = 0;
    const pool = new SubscriptionChatPool({
      spawnWorker: async () => {
        n++;
        return n === 1
          ? autoWorker((r) => ({ id: r.id, content: "", tokens: 0, promptTokens: 0, completionTokens: 0, estimated: false, error: "会话失效" })).worker
          : autoWorker().worker;
      },
    });
    await expect(pool.invoke("claude-code", req("1"))).rejects.toThrow(/会话失效/);
    const ok = await pool.invoke("claude-code", req("2")); // 已摘除 → 重启
    expect(n).toBe(2);
    expect(ok.content).toBe("ok:p-2");
    pool.shutdown();
  });

  it("spawn 失败 → throw 且从池摘除,下次请求重试 spawn", async () => {
    let n = 0;
    const pool = new SubscriptionChatPool({
      spawnWorker: async () => { n++; if (n === 1) throw new Error("adapter 未装"); return autoWorker().worker; },
    });
    await expect(pool.invoke("claude-code", req("1"))).rejects.toThrow(/spawn worker 失败.*adapter 未装/);
    const ok = await pool.invoke("claude-code", req("2"));
    expect(n).toBe(2);
    expect(ok.content).toBe("ok:p-2");
    pool.shutdown();
  });

  it("每引擎各一个 lane:claude-code 与 codex 各自 spawn", async () => {
    const seen: string[] = [];
    const pool = new SubscriptionChatPool({ spawnWorker: async (e) => { seen.push(e); return autoWorker().worker; } });
    await pool.invoke("claude-code", req("1"));
    await pool.invoke("codex", req("2"));
    expect(seen).toEqual(["claude-code", "codex"]);
    pool.shutdown();
  });

  it("推理档位透传给 spawnWorker;同档复用暖 worker(spawn 恰一次)", async () => {
    const seen: Array<string | undefined> = [];
    const pool = new SubscriptionChatPool({ spawnWorker: async (_e, eff) => { seen.push(eff); return autoWorker().worker; } });
    await pool.invoke("codex", req("1"), "high");
    await pool.invoke("codex", req("2"), "high"); // 同档 → 复用
    expect(seen).toEqual(["high"]); // 只 spawn 一次,档位 high
    pool.shutdown();
  });

  it("档位变更 → 摘除旧 worker 冷启动新档(每引擎至多 1 常驻)", async () => {
    const seen: Array<string | undefined> = [];
    const workers: ReturnType<typeof autoWorker>[] = [];
    const pool = new SubscriptionChatPool({
      spawnWorker: async (_e, eff) => { seen.push(eff); const w = autoWorker(); workers.push(w); return w.worker; },
    });
    await pool.invoke("codex", req("1"), "low");
    await pool.invoke("codex", req("2"), "xhigh"); // 档位变更 → 旧 worker 被杀,按新档重启
    expect(seen).toEqual(["low", "xhigh"]);
    expect(workers[0].killed).toBe(true);  // 旧档 worker 已摘除
    expect(workers[1].killed).toBe(false); // 新档 worker 在役
    pool.shutdown();
  });

  it("chatPoolEnabled:逃生门 OPC_ACP_CHAT_POOL=0/false 关;VITEST 环境默认关;都无则开", () => {
    const savedPool = process.env.OPC_ACP_CHAT_POOL;
    const savedVitest = process.env.VITEST;
    try {
      process.env.VITEST = "true";
      delete process.env.OPC_ACP_CHAT_POOL;
      expect(chatPoolEnabled()).toBe(false); // VITEST → 默认关

      delete process.env.VITEST;
      delete process.env.OPC_ACP_CHAT_POOL;
      expect(chatPoolEnabled()).toBe(true); // 非测试环境默认开

      process.env.OPC_ACP_CHAT_POOL = "0";
      expect(chatPoolEnabled()).toBe(false);
      process.env.OPC_ACP_CHAT_POOL = "false";
      expect(chatPoolEnabled()).toBe(false);
    } finally {
      if (savedPool === undefined) delete process.env.OPC_ACP_CHAT_POOL; else process.env.OPC_ACP_CHAT_POOL = savedPool;
      if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
    }
  });
});
