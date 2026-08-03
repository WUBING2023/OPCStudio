import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";

// 令四.1(活体路由证据)· 后端签发的一次性安装确认 token 两步流,走**真实** communityRoutes.install/company:
//   ① 不带 token → 恒走 Safe Install(社区非 official 模板的预置 A2A 被剥离,presetChannelsInstalled=0);
//   ② preview 拿 token → 带 token 真装 → unsafe 保留(A2A 落地,safeInstall.applied=false);
//   ③ 同一 token 重放 → 409;④ token 绑 templateHash:预览后模板被换 → 409。
// 用有状态 orchestrator mock 让 getAgents 反映 addAgents,断言 presetChannels 真落公司。

let agentStore: AgentNodeConfig[] = [];
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => agentStore),
  addAgents: vi.fn((nodes: AgentNodeConfig[]) => {
    let n = 0; for (const a of nodes) if (!agentStore.some((x) => x.id === a.id)) { agentStore.push(a); n++; } return n;
  }),
  updateAgent: vi.fn(),
  removeAgentsByCompany: vi.fn((cid: string) => { const b = agentStore.length; agentStore = agentStore.filter((a) => (a.companyId ?? "default") !== cid); return b - agentStore.length; }),
  removeAgentsByIds: vi.fn((ids: string[]) => { const s = new Set(ids); const b = agentStore.length; agentStore = agentStore.filter((a) => !s.has(a.id)); return b - agentStore.length; }),
  restoreAgentsInPlace: vi.fn(),
}));

import { register } from "./communityRoutes.js";
import { signTemplate } from "../runtime/templateTrust.js";

const realFetch = globalThis.fetch;
let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tokenflow-"));
  vi.stubEnv("OPC_SKILLS_DIR", skillsTmp);
  vi.stubGlobal("fetch", (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.includes("api.github.com")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as unknown as Response;
    return realFetch(input, init);
  }) as typeof fetch);
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ } });

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return { name: over.id, role: "dev", childrenIds: [], model: "m", provider: "prov-x", framework: "api",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true, ...over };
}
function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return { id: "t-token", title: "token 模板", description: "d", author: "alice", createdAt: "2026-07-01T00:00:00Z",
    tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }), agent({ id: "dev-0", parentId: "ceo-0" })],
    a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }], ...over };
}
function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenflow-"));
  fs.mkdirSync(path.join(root, ".opc", "community", "templates"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { "prov-x": "test-key" } }));
  return root;
}
function seed(root: string, t: CompanyTemplate) { fs.writeFileSync(path.join(root, ".opc", "community", "templates", `${t.id}.json`), JSON.stringify(t)); }
async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express(); app.use(express.json({ limit: "10mb" })); register(app, root);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address(); const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}
const post = (baseUrl: string, body: unknown) => fetch(`${baseUrl}/api/community/install/company`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

let root: string, server: Server, baseUrl: string;
beforeEach(async () => { agentStore = []; root = setupRoot(); ({ server, baseUrl } = await startServer(root)); });
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("令四.1 · install/company 一次性 token 两步流(活体路由)", () => {
  it("不带 token → Safe Install 剥离预置 A2A(presetChannelsInstalled=0)", async () => {
    seed(root, signTemplate(tpl({ id: "t-notoken" })));
    const r = await post(baseUrl, { templateId: "t-notoken" });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.safeInstall.applied).toBe(true);
    expect(body.presetChannelsInstalled).toBe(0);
  });

  it("preview 签发 token → 带 token 真装 → unsafe 保留(A2A 落地)", async () => {
    seed(root, signTemplate(tpl({ id: "t-two" })));
    const pv = await post(baseUrl, { templateId: "t-two", mode: "preview" });
    const pvBody = await pv.json() as any;
    expect(pvBody.preview).toBe(true);
    expect(pvBody.installConfirmationToken).toBeTruthy();
    expect(new Date(pvBody.installConfirmationExpiresAt).getTime()).toBeGreaterThan(Date.now());
    // preview 恒展示 Safe 视图(剥离 A2A)
    expect(pvBody.safeInstallPreview.some((s: any) => s.id === "preset-a2a-channels")).toBe(true);

    const inst = await post(baseUrl, { templateId: "t-two", installConfirmationToken: pvBody.installConfirmationToken });
    expect(inst.status).toBe(200);
    const body = await inst.json() as any;
    expect(body.safeInstall.applied).toBe(false);
    expect(body.presetChannelsInstalled).toBe(1);
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies[0].presetChannels).toHaveLength(1);
  });

  it("同一 token 重放 → 409", async () => {
    seed(root, signTemplate(tpl({ id: "t-replay" })));
    const pv = await (await post(baseUrl, { templateId: "t-replay", mode: "preview" })).json() as any;
    const t = pv.installConfirmationToken;
    expect((await post(baseUrl, { templateId: "t-replay", installConfirmationToken: t })).status).toBe(200);
    const replay = await post(baseUrl, { templateId: "t-replay", installConfirmationToken: t });
    expect(replay.status).toBe(409);
  });

  it("预览后模板被换(templateHash 不符)→ 409,要求重新预览", async () => {
    seed(root, signTemplate(tpl({ id: "t-swap" })));
    const pv = await (await post(baseUrl, { templateId: "t-swap", mode: "preview" })).json() as any;
    // 预览后替换磁盘上的模板文件(内容变 → hash 变)
    seed(root, signTemplate(tpl({ id: "t-swap", description: "偷偷改了内容" })));
    const r = await post(baseUrl, { templateId: "t-swap", installConfirmationToken: pv.installConfirmationToken });
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.requiresRepreview).toBe(true);
  });
});
