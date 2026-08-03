import { describe, it, expect, beforeAll } from "vitest";

// 超时分类(用户复核)· 确定性证据:socket/network ETIMEDOUT=瞬时→有限重试;本地 90s HTTP 死线=慢失败→不重试
// (防叠乘);AbortError=显式取消/run 死线→立即终止不重试。三类必须分开,不能因共用 "ETIMEDOUT" 文本而混为一类。
let mg: typeof import("./modelGateway.js");
beforeAll(async () => {
  process.env.OPC_MODEL_HTTP_BACKOFF_MS = "3";
  process.env.OPC_MODEL_HTTP_MAX_RETRIES = "2";
  mg = await import("./modelGateway.js");
});
const ok = () => ({ ok: true, status: 200 } as unknown as Response);

describe("超时分类 · socket/network ETIMEDOUT 属瞬时 → 有限重试自愈", () => {
  it("undici 形态(message='fetch failed', cause.code='ETIMEDOUT')→ 退避重试第2次成功", async () => {
    let n = 0;
    const doFetch = async () => { n++; if (n === 1) throw Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } }); return ok(); };
    expect((await mg.fetchWithBackoff(doFetch)).ok).toBe(true);
    expect(n).toBe(2);
  });
  it("非 undici 裸形态(message='connect ETIMEDOUT 1.2.3.4:443', e.code='ETIMEDOUT', 无 'fetch failed')→ 仍被结构化判瞬时重试", async () => {
    let n = 0;
    const doFetch = async () => { n++; if (n === 1) throw Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" }); return ok(); };
    expect((await mg.fetchWithBackoff(doFetch)).ok).toBe(true);
    expect(n).toBe(2); // 结构化 e.code 判据命中,不再依赖 "fetch failed" 文本巧合
  });
});

describe("超时分类 · 本地 90s HTTP 死线(慢失败)→ 不重试(防叠乘)", () => {
  it("归一化的 'ETIMEDOUT: model HTTP request exceeded 90000ms'(无 cause.code)→ 立即冒泡,仅 1 次尝试", async () => {
    let n = 0;
    const doFetch = async () => { n++; throw new Error("ETIMEDOUT: model HTTP request exceeded 90000ms"); };
    await expect(mg.fetchWithBackoff(doFetch)).rejects.toThrow(/model HTTP request exceeded/);
    expect(n).toBe(1); // 慢失败不退避重试
  });
});

describe("超时分类 · AbortError(显式取消/run 死线)→ 立即终止,绝不当瞬时错重试", () => {
  it("name='AbortError' → 立即冒泡,仅 1 次尝试(与 socket ETIMEDOUT 区分开)", async () => {
    let n = 0;
    const doFetch = async () => { n++; throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); };
    await expect(mg.fetchWithBackoff(doFetch)).rejects.toThrow(/aborted/);
    expect(n).toBe(1); // AbortError 不重试(立即终止)
  });
  it("AbortError 即便携带 cause.code=ETIMEDOUT 也优先判取消(不因 code 被误重试)", async () => {
    let n = 0;
    const doFetch = async () => { n++; throw Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "ETIMEDOUT" } }); };
    await expect(mg.fetchWithBackoff(doFetch)).rejects.toThrow(/aborted/);
    expect(n).toBe(1); // name==='AbortError' 的排除先于结构化 code 判据
  });
});
