import { describe, it, expect, beforeEach, vi } from "vitest";

// token 两步流 + rollback + unlist 的纯运行时代理测试(zustand,无 DOM):把 api client 整体 mock 掉,
// 直接跑 store 动作,锁住三条契约——① install 请求只在带 installConfirmationToken(令四.1:preview
// 签发的一次性凭据,替代已废的客户端布尔 unsafeAcknowledged)时才携带它,不带恒走 Safe Install;
// ② 安装 txId 落进本地记录且 rollback 打到正确端点并标记已撤销;③ 本地库下架按内容类型映射到
// templates/teams/agents 端点。沿用 useCockpitStore.test.ts 的直连 store 做法。
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("../api/client.js", () => mocks);

import { useCommunityStore } from "./useCommunityStore.js";

const lastPost = () => mocks.post.mock.calls[0];

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.del.mockReset();
  // refreshOrg/loadAll 里的 GET 一律给空数组,避免撞空引用(它们本身也被 try/catch 兜住)。
  mocks.get.mockResolvedValue([]);
  useCommunityStore.setState({ installRecords: [] });
});

describe("useCommunityStore · installConfirmationToken 请求契约(令四.1)", () => {
  it("带 preview 签发的一次性 token → install 请求携带 installConfirmationToken", async () => {
    mocks.post.mockResolvedValue({ companyId: "c1", ceoId: null, agentCount: 3, txId: "tx1" });
    await useCommunityStore.getState().installCompany("tmpl-a", { installConfirmationToken: "tok-1" });
    const [path, body] = lastPost();
    expect(path).toBe("/community/install/company");
    expect(body).toMatchObject({ templateId: "tmpl-a", installConfirmationToken: "tok-1" });
    // 已废的客户端布尔绝不回潮
    expect(Object.prototype.hasOwnProperty.call(body, "unsafeAcknowledged")).toBe(false);
  });

  it("不带 token → install 请求体只有 templateId(服务端恒走 Safe Install 默认剥离)", async () => {
    mocks.post.mockResolvedValue({ companyId: "c1", agentCount: 1 });
    await useCommunityStore.getState().installCompany("tmpl-b");
    const [, body] = lastPost();
    expect(body).toEqual({ templateId: "tmpl-b" });
    expect(Object.prototype.hasOwnProperty.call(body, "installConfirmationToken")).toBe(false);
  });

  it("token 为 undefined/空串也不带字段(等价 Safe Install)", async () => {
    mocks.post.mockResolvedValue({ companyId: "c1", agentCount: 1 });
    await useCommunityStore.getState().installCompany("tmpl-c", { installConfirmationToken: undefined });
    const [, body] = lastPost();
    expect(Object.prototype.hasOwnProperty.call(body, "installConfirmationToken")).toBe(false);
  });
});

describe("useCommunityStore · 安装记录 + rollback 调用链", () => {
  it("recordInstall 把 txId 与展示信息落进本地记录(带时间戳,未撤销)", () => {
    useCommunityStore.getState().recordInstall({ txId: "tx9", name: "Acme", agentCount: 4, mode: "new-company" });
    const rec = useCommunityStore.getState().installRecords[0];
    expect(rec).toMatchObject({ txId: "tx9", name: "Acme", agentCount: 4, mode: "new-company" });
    expect(rec.at).toBeTruthy();
    expect(rec.rolledBack).toBeFalsy();
  });

  it("recordInstall 同 txId 去重(不重复堆叠)", () => {
    const s = useCommunityStore.getState();
    s.recordInstall({ txId: "tx9", name: "A", agentCount: 1, mode: "new-company" });
    s.recordInstall({ txId: "tx9", name: "A-v2", agentCount: 2, mode: "merge" });
    const recs = useCommunityStore.getState().installRecords.filter(r => r.txId === "tx9");
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("A-v2");
  });

  it("rollbackInstall 打到 /community/install/:txId/rollback 并把记录标记为已撤销", async () => {
    useCommunityStore.setState({ installRecords: [{ txId: "tx1", name: "A", agentCount: 2, mode: "new-company", at: "2026-01-01T00:00:00.000Z" }] });
    mocks.post.mockResolvedValue({ ok: true });
    const r = await useCommunityStore.getState().rollbackInstall("tx1");
    expect(mocks.post).toHaveBeenCalledWith("/community/install/tx1/rollback", {});
    expect(r).toEqual({ ok: true });
    expect(useCommunityStore.getState().installRecords[0].rolledBack).toBe(true);
  });

  it("rollback 的 txId 做 URL 编码(带特殊字符不破坏路径)", async () => {
    useCommunityStore.setState({ installRecords: [{ txId: "tx/1 a", name: "A", agentCount: 1, mode: "merge", at: "2026-01-01T00:00:00.000Z" }] });
    mocks.post.mockResolvedValue({ ok: true });
    await useCommunityStore.getState().rollbackInstall("tx/1 a");
    expect(mocks.post).toHaveBeenCalledWith("/community/install/tx%2F1%20a/rollback", {});
  });
});

describe("useCommunityStore · 本地库下架端点映射", () => {
  it("company → templates 端点", async () => {
    mocks.post.mockResolvedValue({ ok: true, unlisted: true });
    await useCommunityStore.getState().unlistLocal("company", "my-tmpl");
    expect(mocks.post).toHaveBeenCalledWith("/community/local/templates/my-tmpl/unlist", {});
  });

  it("team → teams,worker → agents", async () => {
    mocks.post.mockResolvedValue({ ok: true, unlisted: true });
    await useCommunityStore.getState().unlistLocal("team", "t1");
    await useCommunityStore.getState().unlistLocal("worker", "w1");
    const paths = mocks.post.mock.calls.map(c => c[0]);
    expect(paths).toContain("/community/local/teams/t1/unlist");
    expect(paths).toContain("/community/local/agents/w1/unlist");
  });
});
