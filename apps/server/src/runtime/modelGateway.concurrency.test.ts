import { describe, it, expect, beforeAll } from "vitest";

// 并发稳定性硬化 · 确定性证据(非活体、非 flaky):证明网络错(fetch failed)在 provider 层退避重试自愈、
// 慢失败(ETIMEDOUT)不重试、瞬时分类纳入网络错。对照:fair-A/B 里 economy 8-agent 因 fetch failed 零退避
// 冒泡→retry_budget_exhausted 整队坍塌;此测试锁死修复逻辑,活体 DeepSeek 健康时无法复现 fetch failed 的缺口由此补上。
let mg: typeof import("./modelGateway.js");
beforeAll(async () => {
  process.env.OPC_MODEL_HTTP_BACKOFF_MS = "3";   // 测试用极小退避,避免真等 1s
  process.env.OPC_MODEL_HTTP_MAX_RETRIES = "2";
  mg = await import("./modelGateway.js");
});
const resp = (ok: boolean, status = ok ? 200 : 500) => ({ ok, status } as unknown as Response);
const netErr = (code = "ECONNRESET") => Object.assign(new Error("fetch failed"), { cause: { code } });

describe("并发稳定性硬化 · isTransientError 纳入网络错(不误记 provider 熔断)", () => {
  it("网络错关键词判瞬时(fetch failed/ENOTFOUND/EAI_AGAIN/socket hang up/UND_ERR)", () => {
    for (const m of ["fetch failed", "ENOTFOUND api.deepseek.com", "EAI_AGAIN", "socket hang up", "UND_ERR_SOCKET", "429 rate limit", "HTTP 503"]) {
      expect(mg.isTransientError(m)).toBe(true);
    }
  });
  it("真配置/权限错不判瞬时(不该被退避/豁免熔断)", () => {
    for (const m of ["HTTP 400 bad request", "HTTP 404 model not found", "invalid json schema"]) {
      expect(mg.isTransientError(m)).toBe(false);
    }
  });
});

describe("并发稳定性硬化 · fetchWithBackoff 退避重试", () => {
  it("一次 fetch failed(cause ECONNRESET)后自愈:退避重试第 2 次成功", async () => {
    let n = 0;
    const doFetch = async () => { n++; if (n === 1) throw netErr(); return resp(true); };
    const r = await mg.fetchWithBackoff(doFetch);
    expect(r.ok).toBe(true);
    expect(n).toBe(2); // 一次失败 + 一次成功(证明退避后重试,而非冒泡耗尽上层预算)
  });

  it("持续 fetch failed:退避到次数用尽才冒泡(共 maxRetries+1=3 次尝试)", async () => {
    let n = 0;
    const doFetch = async () => { n++; throw netErr("ENOTFOUND"); };
    await expect(mg.fetchWithBackoff(doFetch)).rejects.toThrow(/fetch failed/);
    expect(n).toBe(3); // OPC_MODEL_HTTP_MAX_RETRIES=2 → 1 初次 + 2 重试
  });

  it("慢失败 ETIMEDOUT 不退避重试(避免 90s×N 叠乘):立即冒泡,仅 1 次尝试", async () => {
    let n = 0;
    const doFetch = async () => { n++; throw new Error("ETIMEDOUT: model HTTP request exceeded 90000ms"); };
    await expect(mg.fetchWithBackoff(doFetch)).rejects.toThrow(/ETIMEDOUT/);
    expect(n).toBe(1); // ETIMEDOUT 非 fast-network-throw → 不重试
  });

  it("429 响应退避重试自愈;400 非瞬时状态原样返回不重试", async () => {
    let a = 0;
    const doFetch429 = async () => { a++; return a === 1 ? resp(false, 429) : resp(true); };
    expect((await mg.fetchWithBackoff(doFetch429)).ok).toBe(true);
    expect(a).toBe(2);
    let b = 0;
    const doFetch400 = async () => { b++; return resp(false, 400); };
    const r400 = await mg.fetchWithBackoff(doFetch400);
    expect(r400.status).toBe(400);
    expect(b).toBe(1); // 400 不退避(非 429/5xx)
  });
});
