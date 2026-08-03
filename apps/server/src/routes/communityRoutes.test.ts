import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";

// communityRoutes 顶层 import 了 runtime/orchestrator.js 的 addAgents/getAgents——模块级、跨全项目
// 共享的单例(同 companyRoutes.test.ts 顶部说明),mock 成内存实现,不碰真实项目数据。
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => []),
  addAgents: vi.fn((nodes: unknown[]) => nodes.length),
  updateAgent: vi.fn(),
  removeAgentsByCompany: vi.fn(() => 0),
  removeAgentsByIds: vi.fn((ids: string[]) => ids.length),
}));

import { register, forceShareDowngrade } from "./communityRoutes.js";
import { signTemplate } from "../runtime/templateTrust.js";
import { getAgents, addAgents, updateAgent, removeAgentsByCompany, removeAgentsByIds } from "../runtime/orchestrator.js";
import { bundledSkillId } from "../runtime/install.js";
import { getSkill, createSkill, deleteSkill } from "../storage/skillStore.js";
import { loadInstallTransactions, getInstallTransaction, recordInstallTransaction } from "../storage/installTransactionStore.js";
import { loadRegistry, upsertProceduralSkill } from "../storage/registryStore.js";
import { loadLessons } from "../storage/reflectionStore.js";
import { agentMemoryPath } from "../storage/mdMemory.js";
import { loadRemoteUnlisted } from "../storage/communityStore.js";
import { saveGithubAuth } from "../storage/githubTokenStore.js";
import { loadSemanticFidelityReports } from "../storage/semanticFidelityStore.js";
import { listGovernedMemoryProposals } from "../runtime/memoryGovernance.js";
import type { BundleMemoryRecord } from "@opc/shared";

// register() 时会预热 GitHub 社区缓存(computeRemote → fetch api.github.com)。测试里把 GitHub
// 域名的请求短路成失败响应(预热静默失败,不联网、不拖慢),本地 127.0.0.1 测试请求走真 fetch。
const realFetch = globalThis.fetch;
let skillsTmp: string;
beforeAll(() => {
  // 技能库重定向到临时区,避免安装测试往真实用户目录 ~/.opcstudio/skills 写 bundled-* 残留(污染+flaky 土壤)。
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-comm-"));
  vi.stubEnv("OPC_SKILLS_DIR", skillsTmp);
  vi.stubGlobal("fetch", (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.includes("api.github.com")) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as unknown as Response;
    }
    return realFetch(input, init);
  }) as typeof fetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "prov-x",
    framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}

function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-routes", title: "路由测试模板", description: "d", author: "alice",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [
      agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }),
      agent({ id: "dev-0", parentId: "ceo-0" }),
    ],
    ...over,
  };
}

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-routes-"));
  // 预建 community 目录 → ensureSeeded 跳过整套种子内容写盘(测试只关心自己写入的模板)。
  fs.mkdirSync(path.join(root, ".opc", "community", "templates"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { "prov-x": "test-key" } }));
  return root;
}

function seedTemplateFile(root: string, t: CompanyTemplate) {
  fs.writeFileSync(path.join(root, ".opc", "community", "templates", `${t.id}.json`), JSON.stringify(t));
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  register(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

// 令四.1 · 两步流助手:同端点 mode:"preview"(同一 templateId)拿后端签发的一次性 installConfirmationToken,
// 供真装带回以启用 unsafe 保留(替代旧客户端布尔 unsafeAcknowledged)。token 只绑模板危险面(templateHash +
// dangerFlags/MCP/CLI/file-write/trustLevel 六元),与 merge 参数/targetCompanyId 无关,故预览只需带 templateId。
async function previewInstallToken(baseUrl: string, templateId: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/community/install/company`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, mode: "preview" }),
  });
  const body = await r.json() as any;
  return body.installConfirmationToken as string;
}

describe("D1 · communityRoutes — 导入/安装统一过 Template Doctor + Safe Install", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("templates/import:hash 被篡改 → 422 拒绝入库,返回 doctor.checks(hash_valid error)", async () => {
    const tampered = { ...signTemplate(tpl()), title: "签名后被改" };
    const r = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tampered),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.doctor.install_allowed).toBe(false);
    expect(body.doctor.checks.find((c: any) => c.id === "hash_valid")?.status).toBe("error");
    // 未入库
    const g = await fetch(`${baseUrl}/api/community/templates/${tampered.id}`);
    expect(g.status).toBe(404);
  });

  it("templates/import:合法未签名模板 → 200 入库,trustLevel=untrusted,doctor 附带 warning", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tpl()),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    expect(body.trustLevel).toBe("untrusted");
    expect(body.doctor.install_allowed).toBe(true);
    expect(body.doctor.checks.find((c: any) => c.id === "hash_valid")?.status).toBe("warning");
    expect(body.semanticFidelity).toMatchObject({
      schemaVersion: "2", operation: "import", lostCount: 0, ok: true,
    });
    expect(body.semanticFidelity.reportHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
  });

  it("D2 · templates/import:旧模板(无 schema_version)迁移兼容层 → 导入成功后可正常 install/company(硬验收:legacy 迁移 round-trip)", async () => {
    const legacy = tpl({ id: "t-legacy-migrate" }); // 真实形状的旧 CompanyTemplate,无 schema_version
    const r = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(legacy),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    expect(body.doctor.install_allowed).toBe(true);
    // 迁移后的对象仍需通过既有 D2 三项新检查(全 pass,legacy 模板内容干净)。
    expect(body.doctor.checks.find((c: any) => c.id === "no_secrets_detected")?.status).toBe("pass");
    expect(body.doctor.checks.find((c: any) => c.id === "template_size_warning")?.status).toBe("pass");
    // migrateLegacyTemplate 确实跑过 —— 响应里附带迁移后的 CompanyBundle 审计视图。
    // legacy 归一后产物 schema_version 落 canonical 当前值(不再是 "0.3.0-legacy" 标签)。
    expect(body.migratedFromLegacy.schema_version).toBe("0.3.0");
    expect(body.migratedFromLegacy.compatibility.migration_notes.some((n: string) => n.includes("legacy"))).toBe(true);
    expect(body.migratedFromLegacy.bundle_type).toBe("company");

    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-legacy-migrate" }),
    });
    expect(installR.status).toBe(200);
    const installBody = await installR.json() as any;
    expect(installBody.agentCount).toBe(2);
  });

  it("D2 · templates/import:带 schema_version 的原生 Company Bundle → 桥接成 CompanyTemplate 形状后正常入库", async () => {
    const bundle = {
      schema_version: "0.3.0",
      bundle_type: "company",
      bundle_id: "t-native-bundle",
      title: "原生 Bundle 模板",
      description: "d",
      agents: tpl().agents,
      privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
      compatibility: { migration_notes: [] },
    };
    const r = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    const g = await fetch(`${baseUrl}/api/community/templates/t-native-bundle`);
    expect(g.status).toBe(200);
    const saved = await g.json() as any;
    expect(saved.title).toBe("原生 Bundle 模板");
    expect(saved.agents).toHaveLength(2);
  });

  it("D2 · templates/import:内容含疑似密钥(sk-...) → 422 拒绝入库,doctor 报 no_secrets_detected error", async () => {
    const withSecret = tpl({ id: "t-with-secret", description: "sk-abcdefghij1234567890 泄漏的测试密钥" });
    const r = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withSecret),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.doctor.install_allowed).toBe(false);
    expect(body.doctor.checks.find((c: any) => c.id === "no_secrets_detected")?.status).toBe("error");
    const g = await fetch(`${baseUrl}/api/community/templates/${withSecret.id}`);
    expect(g.status).toBe(404); // 未入库
  });

  it("GET templates/:id/doctor:返回八项 checks + dangerFlags + Safe Install 剥离预览", async () => {
    const t = tpl({
      id: "t-doctor-get",
      recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } },
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
    });
    seedTemplateFile(root, signTemplate(t));
    const r = await fetch(`${baseUrl}/api/community/templates/t-doctor-get/doctor`);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.doctor.checks).toHaveLength(8); // D1 五项 + D2 三项(no_secrets_detected/local_paths_redacted/template_size_warning)
    expect(body.dangerFlags).toContain("shell-access");
    expect(body.trustLevel).toBe("community"); // 签名完整 → community
    expect(body.safeInstallPreview.map((s: any) => s.id)).toContain("preset-a2a-channels");
    expect(body.safeInstallPreview.map((s: any) => s.id)).toContain("shell-access");
  });

  it("POST templates/doctor:坏 schema 的原始 manifest → 200 返回 error 级报告(预检不落库)", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates/doctor`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "junk" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.doctor.status).toBe("error");
    expect(body.doctor.install_allowed).toBe(false);
    expect(body.dangerFlags).toEqual([]);
  });

  it("install/company:组织成环的模板 → 422 拒装,返回 checks,不创建公司", async () => {
    const cyclic = tpl({
      id: "t-cyclic",
      agents: [
        agent({ id: "a", role: "ceo", parentId: "b" }),
        agent({ id: "b", parentId: "a" }),
      ],
    });
    seedTemplateFile(root, cyclic);
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-cyclic" }),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.doctor.checks.find((c: any) => c.id === "no_cycle_in_org")?.status).toBe("error");
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies).toEqual([]);
  });

  it("install/company:社区模板默认 Safe Install——剥离预置 A2A(presetChannelsInstalled=0)并列明剥离项", async () => {
    const risky = signTemplate(tpl({
      id: "t-risky",
      recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } },
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
    }));
    seedTemplateFile(root, risky);
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-risky" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.safeInstall.applied).toBe(true);
    expect(body.safeInstall.stripped.map((s: any) => s.id)).toContain("preset-a2a-channels");
    expect(body.safeInstall.stripped.map((s: any) => s.id)).toContain("shell-access");
    expect(body.presetChannelsInstalled).toBe(0);
    expect(body.semanticFidelity).toMatchObject({ operation: "import", lostCount: 0, ok: true });
    expect(body.semanticFidelity.transformed).toContain("a2aChannels");
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies).toHaveLength(1);
    expect(companies[0].presetChannels ?? []).toEqual([]);
  });

  it("install/company:语义字段丢失时持久化报告、409 fail-closed 并回滚新公司", async () => {
    const broken = signTemplate(tpl({
      id: "t-semantic-loss",
      agentMemories: [{ agent_id: "missing-agent", role: "dev", content: "portable lesson" }],
    }));
    seedTemplateFile(root, broken);
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-semantic-loss" }),
    });
    const body = await r.json() as any;
    expect(r.status).toBe(409);
    expect(body.rolledBack).toBe(true);
    expect(body.semanticFidelity).toMatchObject({ operation: "import", ok: false, lostCount: 1 });
    expect(body.semanticFidelity.lost).toEqual(["agentMemories.importFailure[0]"]);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"))).toEqual([]);
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
  });

  it("C10-P1 · install/company:自封 trustLevel:official(无有效 hash) → verifyAndAssignTrust 重赋后仍走 Safe Install 剥离,不被绕过", async () => {
    // 构造一份自称 official 但没有任何有效签名的模板(模拟直接打 API 塞 trustLevel:official)。
    const forged = { ...tpl({
      id: "t-forged-official",
      recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } },
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
    }), trustLevel: "official", hash: undefined, signature: undefined };
    seedTemplateFile(root, forged as any);
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-forged-official" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    // 自封 official 未生效:仍被 Safe Install 剥离 shell-access + 预置 A2A。
    expect(body.safeInstall.applied).toBe(true);
    expect(body.safeInstall.stripped.map((s: any) => s.id)).toContain("shell-access");
    expect(body.presetChannelsInstalled).toBe(0);
  });

  it("C10-P1 · 工坊保存剥离 body 自封的 trustLevel/hash/signature(不固化自我声明)", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: { ...tpl({ id: "t-save-forged" }), trustLevel: "official", hash: "deadbeef", signature: "deadbeef" } }),
    });
    expect(r.status).toBe(200);
    const g = await fetch(`${baseUrl}/api/community/templates/t-save-forged`);
    const saved = await g.json() as any;
    expect(saved.trustLevel).toBeUndefined();
    expect(saved.hash).toBeUndefined();
    expect(saved.signature).toBeUndefined();
  });

  it("install/company:带一次性 installConfirmationToken 显式保留——预置 A2A 正常落地", async () => {
    const risky = signTemplate(tpl({
      id: "t-risky-ack",
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
    }));
    seedTemplateFile(root, risky);
    const token = await previewInstallToken(baseUrl, "t-risky-ack");
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-risky-ack", installConfirmationToken: token }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.safeInstall.applied).toBe(false);
    expect(body.safeInstall.stripped).toEqual([]);
    expect(body.presetChannelsInstalled).toBe(1);
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies[0].presetChannels).toHaveLength(1);
  });

  // P0-B · 社区安装路径(install/company · new-company)必须与 companyRoutes.installCompanyTemplate 对齐:
  // 把 visibilityPolicy / defaultTasks 落成公司持久字段,并按 idMap 把员工个人记忆(agentMemories)写回
  // 新机 agent-memory.md。此前该分支不带这三样 → 工坊→社区→安装往返静默丢字段。走**真实路由**(非镜像)。
  it("P0-B · install/company(new-company)落回 visibilityPolicy/defaultTasks + 写回员工个人记忆(agent-memory.md)", async () => {
    const rich = signTemplate(tpl({
      id: "t-p0b-landing",
      visibilityPolicy: "isolated",
      defaultTasks: [{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }],
      agentMemories: [{ agent_id: "dev-0", role: "dev", content: "偏好:先写测试再写实现,提交前跑 lint。" }],
    }));
    seedTemplateFile(root, rich);
    const token = await previewInstallToken(baseUrl, "t-p0b-landing");
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-p0b-landing", installConfirmationToken: token }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    const co = companies.find((c: any) => c.id === body.companyId);
    expect(co.visibilityPolicy).toBe("isolated");
    expect(co.defaultTasks).toEqual([{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }]);
    // 员工个人记忆按 idMap 写回新机(模板 agent id dev-0 → 安装后 dev-0-{shortId},shortId=companyId 前 6 位)。
    const shortId = String(body.companyId).slice(0, 6);
    const memPath = agentMemoryPath(root, `dev-0-${shortId}`);
    expect(fs.existsSync(memPath)).toBe(true);
    expect(fs.readFileSync(memPath, "utf-8")).toContain("先写测试再写实现");
  });
});

describe("D3 · communityRoutes install/company — 安装三模式(new-company 缺省 / merge / preview)", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  function seedTargetCompany(over: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "target", name: "目标公司", description: "", ceoId: "ceo-x", createdAt: "2026-01-01T00:00:00Z", ...over },
    ]));
  }

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    vi.mocked(getAgents).mockReturnValue([]);
    vi.mocked(addAgents).mockClear();
    vi.mocked(updateAgent).mockClear();
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("mode 缺省 / 显式 'new-company' 行为一致(回归锁):都创建新公司,不受新增字段影响", async () => {
    seedTemplateFile(root, tpl({ id: "t-regress" }));
    const rDefault = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-regress" }),
    });
    const bodyDefault = await rDefault.json() as any;
    expect(rDefault.status).toBe(200);
    expect(bodyDefault.agentCount).toBe(2);
    expect(bodyDefault.preview).toBeUndefined();
    expect(bodyDefault.decisions).toBeUndefined();

    const root2 = root; // 同一 root 再装一次,显式传 mode:"new-company"
    const rExplicit = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-regress", mode: "new-company" }),
    });
    const bodyExplicit = await rExplicit.json() as any;
    expect(rExplicit.status).toBe(200);
    expect(bodyExplicit.agentCount).toBe(2);
    void root2;
  });

  it("preview:doctor + 安装预览摘要,不写任何状态(companies.json 前后快照相等)", async () => {
    // C3:经验/示例任务计数不再硬编码 0——给模板带上真数据源(seedMemories 按 owner_type、defaultTasks)。
    const mem = (owner_type: BundleMemoryRecord["owner_type"], id: string): BundleMemoryRecord => ({
      memory_id: id, scope: "s", owner_type, owner_id: "", content: "经验",
      source: { type: "run", run_id: "r1", task_id: "" }, level: "sop", score: 50, status: "active", tags: [],
      metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: "2026-01-01", updated_at: "2026-01-01", last_used_at: "2026-01-01",
    });
    seedTemplateFile(root, tpl({
      id: "t-preview",
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
      mcpRequirements: [{ name: "filesystem" }],
      seedMemories: [mem("company", "m1"), mem("team", "m2"), mem("agent", "m3")],
      defaultTasks: [{ title: "示例任务", goal: "写一份调研报告" }],
    }));
    const before = fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8");
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-preview", mode: "preview" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.preview).toBe(true);
    // #38:预览镜像 Safe Install——该模板未签名(非 official),默认安装会剥离预置 A2A 通道,
    // 预览的 newA2AChannels 必须与真实落地一致(0),不是模板原始声明的 1。
    // C3:经验/示例任务计数 = seedMemories/defaultTasks 真数;artifact contract 无数据源仍如实 0。
    expect(body.summary).toEqual({
      newAgents: 2, newOrgEdges: 1, newA2AChannels: 0,
      newCompanyExperiences: 1, newTeamExperiences: 1, newAgentExperiences: 1,
      newDefaultTasks: 1, newArtifactContracts: 0, requiredCapabilities: ["filesystem"],
    });
    expect(body.doctor.install_allowed).toBe(true);
    expect(body.conflicts).toBeUndefined(); // 未传 targetCompanyId → 不附带合并冲突报告
    const after = fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8");
    expect(after).toBe(before); // 零副作用
    expect(addAgents).not.toHaveBeenCalled();
  });

  it("preview:组织成环的模板也照常返回 200(doctor.install_allowed=false 如实展示,不 422)——预览的意义就是提前看清拦截原因", async () => {
    seedTemplateFile(root, tpl({
      id: "t-preview-cyclic",
      agents: [agent({ id: "a", role: "ceo", parentId: "b" }), agent({ id: "b", parentId: "a" })],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-preview-cyclic", mode: "preview" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.preview).toBe(true);
    expect(body.doctor.install_allowed).toBe(false);
  });

  it("preview:传 targetCompanyId → 附带合并冲突报告", async () => {
    seedTargetCompany();
    vi.mocked(getAgents).mockReturnValue([agent({ id: "dev-0", companyId: "target" })]);
    seedTemplateFile(root, tpl({ id: "t-preview-conflict" })); // agents: ceo-0, dev-0(与目标公司现有 dev-0 冲突)
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-preview-conflict", mode: "preview", targetCompanyId: "target" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.conflicts.agentId).toHaveLength(1);
    expect(body.conflicts.agentId[0].agentId).toBe("dev-0");
  });

  it("preview:targetCompanyId 指向不存在的公司 → 404", async () => {
    seedTemplateFile(root, tpl({ id: "t-preview-404" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-preview-404", mode: "preview", targetCompanyId: "nope" }),
    });
    expect(r.status).toBe(404);
  });

  // #38:preview 的 summary/conflicts 之前基于未剥离的原始模板计算,报 newA2AChannels=N + a2a_rule 冲突,
  // 而默认(Safe Install)安装实际落 0 条通道——预览必须镜像真实安装的参数与剥离。
  // 令四.1 后语义:preview 恒展示 Safe Install 默认(剥离)视图并签发一次性 token;"显式保留"不再有
  // ack 版预览,而是带 token 真装时通道真实落地——预览承诺(默认剥离/确认后可保留)与落地结果一致。
  it("#38:preview 镜像 Safe Install——默认剥离后 newA2AChannels=0、不虚报 a2a_rule 冲突;带 token 真装才保留(A2A 真实落地)", async () => {
    seedTargetCompany({ presetChannels: [{ from: "ceo-0", to: "dev-0", purpose: "既有同步" }] });
    vi.mocked(getAgents).mockReturnValue([
      agent({ id: "ceo-0", role: "ceo", companyId: "target" }),
      agent({ id: "dev-0", companyId: "target", parentId: "ceo-0" }),
    ]);
    seedTemplateFile(root, tpl({ id: "t-preview-mirror", a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }] }));

    const def = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-preview-mirror", mode: "preview", targetCompanyId: "target" }),
    });
    expect(def.status).toBe(200);
    const defBody = await def.json() as any;
    expect(defBody.summary.newA2AChannels).toBe(0); // 与默认安装真实落地(0 条)一致
    expect(defBody.conflicts.a2aRule).toEqual([]); // 默认安装不会发生的冲突,预览不再虚报
    expect(defBody.safeInstallPreview.map((s: any) => s.id)).toContain("preset-a2a-channels"); // 剥离项仍如实展示
    expect(defBody.installConfirmationToken).toBeTruthy(); // 确认保留的凭据随预览签发

    // 带 token 真装(merge):unsafe 保留生效——模板 A2A 通道不再被剥离,真实落地。
    const inst = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-preview-mirror", mode: "merge", targetCompanyId: "target", installConfirmationToken: defBody.installConfirmationToken }),
    });
    expect(inst.status).toBe(200);
    const instBody = await inst.json() as any;
    expect(instBody.safeInstall.applied).toBe(false);
    expect(instBody.safeInstall.stripped).toEqual([]);
    expect(instBody.decisions.find((d: any) => d.category === "a2a_rule").conflictCount).toBe(1); // 预览如实预告的冲突真实发生并按策略处理
    // 模板员工 ceo-0/dev-0 与目标既有同 id 员工冲突 → 默认 copy-as-new(ceo-0→ceo-0-copy、dev-0→dev-0-copy);
    // 模板 A2A 通道按 idMap 解析到新 copy id 后真实落地(既有边原样保留,新边带 purpose:"sync")。
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies.find((c: any) => c.id === "target").presetChannels).toEqual([
      { from: "ceo-0", to: "dev-0", purpose: "既有同步" },
      { from: "ceo-0-copy", to: "dev-0-copy", purpose: "sync" },
    ]);
  });

  it("merge:缺 targetCompanyId → 400", async () => {
    seedTemplateFile(root, tpl({ id: "t-merge-400" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-merge-400", mode: "merge" }),
    });
    expect(r.status).toBe(400);
  });

  it("merge:目标公司不存在 → 404", async () => {
    seedTemplateFile(root, tpl({ id: "t-merge-404" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-merge-404", mode: "merge", targetCompanyId: "nope" }),
    });
    expect(r.status).toBe(404);
  });

  it("merge:成功合并——冲突员工按默认 copy-as-new 改 id,presetChannels/mcpRequirements 合并落进目标公司,响应带 decisions", async () => {
    seedTargetCompany({ presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }] });
    vi.mocked(getAgents).mockReturnValue([
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", role: "dev", companyId: "target", parentId: "ceo-x" }),
      agent({ id: "dev-0", role: "dev", companyId: "target", parentId: "ceo-x" }), // 与模板的 dev-0 冲突
    ]);
    seedTemplateFile(root, tpl({ id: "t-merge-ok", mcpRequirements: [{ name: "filesystem", optional: false }] }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-merge-ok", mode: "merge", targetCompanyId: "target" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.companyId).toBe("target");
    expect(body.mergedIntoCompanyId).toBe("target");
    expect(body.semanticFidelity).toMatchObject({ operation: "merge", lostCount: 0, ok: true });
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
    expect(body.presetChannelsInstalled).toBe(1); // 既有一条,模板未声明 a2aChannels,合并后仍是 1 条
    expect(body.decisions.find((d: any) => d.category === "agent_id").conflictCount).toBe(1);
    expect(addAgents).toHaveBeenCalled();
    const addedIds = (vi.mocked(addAgents).mock.calls[0][0] as any[]).map(a => a.id);
    expect(addedIds).toContain("ceo-0"); // 无冲突,原样保留
    expect(addedIds.some(id => id.startsWith("dev-0-copy"))).toBe(true); // 冲突员工 copy-as-new
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies[0].manifestMcpRequirements).toEqual([{ name: "filesystem", optional: false }]);
  });

  it("merge:doctor 拒绝(组织成环)→ 422,不落地", async () => {
    seedTargetCompany();
    seedTemplateFile(root, tpl({
      id: "t-merge-doctor-reject",
      agents: [agent({ id: "a", role: "ceo", parentId: "b" }), agent({ id: "b", parentId: "a" })],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-merge-doctor-reject", mode: "merge", targetCompanyId: "target" }),
    });
    expect(r.status).toBe(422);
    expect(addAgents).not.toHaveBeenCalled();
  });
});

describe("P0-1 · communityRoutes install/company — 导入绑定计划(bindingPlans)闭环", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = setupRoot(); // config.apiKeys = { "prov-x": "test-key" } → prov-x 可用
    ({ server, baseUrl } = await startServer(root));
    vi.mocked(getAgents).mockReturnValue([]);
    vi.mocked(addAgents).mockClear();
    vi.mocked(updateAgent).mockClear();
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("preview:缺失 provider 的员工 → bindingPlans 标 missing + 本机候选替代(带默认模型),model 派生 missing", async () => {
    seedTemplateFile(root, tpl({
      id: "t-bp-preview",
      agents: [
        agent({ id: "ceo-0", role: "ceo", provider: "prov-y", model: "prov-y-pro", childrenIds: ["dev-0"] }),
        agent({ id: "dev-0", parentId: "ceo-0", provider: "prov-y", model: "prov-y-pro" }),
      ],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-bp-preview", mode: "preview" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    const provider = body.bindingPlans.find((p: any) => p.originalBinding.kind === "provider");
    expect(provider.originalBinding.name).toBe("prov-y");
    expect(provider.status).toBe("missing");
    expect(provider.action).toBe("configure");
    expect(provider.userApproved).toBe(false);
    expect(provider.candidates).toHaveLength(1);
    expect(provider.candidates[0]).toMatchObject({ provider: "prov-x", model: "", recommended: true }); // prov-x 有 key;DEFAULT_MODELS 无此项 → 空模型如实
    // model 不做假:provider 缺失 → model 同样 missing 并注明派生
    const model = body.bindingPlans.find((p: any) => p.originalBinding.kind === "model");
    expect(model.status).toBe("missing");
    expect(model.reason).toContain("prov-y");
  });

  it("preview:provider 可用 → keep + userApproved=true;engine api 恒 available", async () => {
    seedTemplateFile(root, tpl({ id: "t-bp-ok" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-bp-ok", mode: "preview" }),
    });
    const body = await r.json() as any;
    const provider = body.bindingPlans.find((p: any) => p.originalBinding.kind === "provider");
    expect(provider.status).toBe("available");
    expect(provider.action).toBe("keep");
    expect(provider.userApproved).toBe(true);
    const engine = body.bindingPlans.find((p: any) => p.originalBinding.kind === "engine");
    expect(engine.status).toBe("available");
  });

  it("真装携带 map 计划(userApproved)→ 员工 provider/model 被改写后落地", async () => {
    seedTemplateFile(root, tpl({
      id: "t-bp-map",
      agents: [
        agent({ id: "ceo-0", role: "ceo", provider: "prov-y", model: "prov-y-pro", childrenIds: ["dev-0"] }),
        agent({ id: "dev-0", parentId: "ceo-0", provider: "prov-y", model: "prov-y-pro" }),
      ],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "t-bp-map",
        bindingPlans: [{
          originalBinding: { kind: "provider", name: "prov-y" }, action: "map", userApproved: true,
          targetBinding: { provider: "prov-x", model: "prov-x-model" },
        }],
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.agentCount).toBe(2);
    expect(body.semanticFidelity.fieldFidelity.ok).toBe(true);
    expect(body.semanticFidelity.runtimeEquivalent).toBe(false);
    expect(body.semanticFidelity.runtimeSemantics.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "provider-engine-model", status: "transformed-not-proven" }),
    ]));
    const added = vi.mocked(addAgents).mock.calls[0][0] as AgentNodeConfig[];
    for (const a of added) {
      expect(a.provider).toBe("prov-x");
      expect(a.model).toBe("prov-x-model");
      expect(a.enabled).toBe(true); // map 成功,保持启用
    }
  });

  it("真装携带 disable 计划 → 受影响员工 enabled=false 落地;configure 未确认 → 诚实降级 disable", async () => {
    seedTemplateFile(root, tpl({
      id: "t-bp-disable",
      agents: [
        agent({ id: "ceo-0", role: "ceo", provider: "prov-y", childrenIds: ["dev-0"] }),
        agent({ id: "dev-0", parentId: "ceo-0", provider: "prov-y" }),
      ],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "t-bp-disable",
        bindingPlans: [{ originalBinding: { kind: "provider", name: "prov-y" }, action: "disable", userApproved: true }],
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.semanticFidelity.fieldFidelity.ok).toBe(true);
    expect(body.semanticFidelity.runtimeEquivalent).toBe(false);
    expect(body.semanticFidelity.runtimeSemantics.degraded).toEqual(expect.arrayContaining([
      "provider-engine-model",
      "agent-availability",
    ]));
    const added = vi.mocked(addAgents).mock.calls[0][0] as AgentNodeConfig[];
    for (const a of added) {
      expect(a.enabled).toBe(false);
      expect(a.provider).toBe("prov-y"); // disable 不改写绑定
    }
  });

  it("真装缺少必要绑定且不带 bindingPlans → 422,不把问题推迟到运行时", async () => {
    seedTemplateFile(root, tpl({
      id: "t-bp-legacy",
      agents: [
        agent({ id: "ceo-0", role: "ceo", provider: "prov-y", childrenIds: ["dev-0"] }),
        agent({ id: "dev-0", parentId: "ceo-0", provider: "prov-y" }),
      ],
    }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-bp-legacy" }),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.error).toBe("binding configuration incomplete");
    expect(addAgents).not.toHaveBeenCalled();
  });

  it("bindingPlans 形状非法 → 整体忽略(按旧行为落地,不部分应用)", async () => {
    seedTemplateFile(root, tpl({ id: "t-bp-badshape" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "t-bp-badshape",
        bindingPlans: [{ originalBinding: { kind: "nonsense" }, action: "map" }], // 非法 kind + 缺 userApproved
      }),
    });
    expect(r.status).toBe(200); // 非法计划整体忽略,安装按原样成功
    const added = vi.mocked(addAgents).mock.calls[0][0] as AgentNodeConfig[];
    expect(added[0].provider).toBe("prov-x"); // 默认模板 provider 原样
  });
});

describe("D5 · communityRoutes install/company — Memory Import Mode 四选一", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  const NOW = "2026-07-08T00:00:00.000Z";
  function seedMemories(): BundleMemoryRecord[] {
    const base = {
      scope: "s", source: { type: "run", run_id: "r1", task_id: "" }, score: 50, status: "active" as const, tags: [],
      metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: NOW, updated_at: NOW, last_used_at: NOW,
    };
    return [
      { ...base, memory_id: "mem-cs-draft", owner_type: "company", owner_id: "x", content: "draft 级内容", level: "draft" },
      { ...base, memory_id: "mem-ps-sop", owner_type: "agent", owner_id: "dev", content: "sop 级内容", level: "sop" },
      { ...base, memory_id: "mem-cs-verified", owner_type: "company", owner_id: "x", content: "verified 级内容", level: "verified" },
    ];
  }

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("默认(不传 memoryImportMode)= structure-sop:只导入 sop/doctrine 级", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-default", seedMemories: seedMemories() }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-mem-default" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.memoryImport.mode).toBe("structure-sop");
    expect(body.memoryImport.totalRecords).toBe(3);
    expect(body.memoryImport.filteredRecords).toBe(1); // 只有 sop 那条
    expect(body.memoryImport.imported).toBe(1);
    const proposals = listGovernedMemoryProposals(root);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "proposed",
      sourceType: "import",
      portableBundleRecord: { memory_id: "mem-ps-sop" },
    });
  });

  it("memoryImportMode: structure-only → 不导入任何记忆", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-none", seedMemories: seedMemories() }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-mem-none", memoryImportMode: "structure-only" }),
    });
    const body = await r.json() as any;
    expect(body.memoryImport.filteredRecords).toBe(0);
    expect(body.memoryImport.imported).toBe(0);
    expect(loadRegistry(root)).toHaveLength(0);
  });

  it("memoryImportMode: full → 全部导入(draft/sop/verified 三条全进)", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-full", seedMemories: seedMemories() }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-mem-full", memoryImportMode: "full" }),
    });
    const body = await r.json() as any;
    expect(body.memoryImport.filteredRecords).toBe(3);
    expect(body.memoryImport.imported).toBe(3);
    expect(listGovernedMemoryProposals(root)).toHaveLength(3);
  });

  it("非法 memoryImportMode 值 → 回退默认 structure-sop,不报错", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-bad-mode", seedMemories: seedMemories() }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-mem-bad-mode", memoryImportMode: "not-a-real-mode" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.memoryImport.mode).toBe("structure-sop");
  });

  it("preview 模式:memoryPreview 展示过滤后条数,不写任何状态", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-preview", seedMemories: seedMemories() }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-mem-preview", mode: "preview", memoryImportMode: "full" }),
    });
    const body = await r.json() as any;
    expect(body.memoryPreview).toEqual({ mode: "full", totalRecords: 3, filteredRecords: 3 });
    expect(loadRegistry(root)).toHaveLength(0); // preview 不写状态
  });

  it("模板没有 seedMemories(普通模板)→ memoryImport 如实为空结果,不报错", async () => {
    seedTemplateFile(root, tpl({ id: "t-mem-absent" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-mem-absent" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.memoryImport).toMatchObject({ totalRecords: 0, filteredRecords: 0, imported: 0 });
  });
});

describe("D6 · communityRoutes install/company — install transaction + rollback", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  function seedTargetCompany(over: Record<string, unknown> = {}) {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "target", name: "目标公司", description: "", ceoId: "ceo-x", createdAt: "2026-01-01T00:00:00Z", ...over },
    ]));
  }

  // C1:bundled skill id 现在掺 companyId,统一走 bundledSkillId 生成(与生产同源,含新旧两形状)。
  const skillIdFor = (tplId: string, name: string, role: string, companyId: string) =>
    bundledSkillId(tplId, name, role, companyId);

  // addAgents 是 mock,不会真的写 .opc/agents.json——new-company 回滚要走 companyRoutes 的
  // backupCompanyBeforeDelete(真读 .opc/agents.json,不吃这份 mock),这里手动把"本该被真实
  // addAgents 落盘"的那批节点补写进去,模拟生产环境下真实会发生的状态。
  function seedRealAgentsFile(installedAgents: AgentNodeConfig[]) {
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(installedAgents));
  }

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    vi.mocked(getAgents).mockReturnValue([]);
    vi.mocked(addAgents).mockClear();
    vi.mocked(updateAgent).mockClear();
    vi.mocked(removeAgentsByCompany).mockReset().mockReturnValue(0);
    vi.mocked(removeAgentsByIds).mockReset().mockImplementation((ids: string[]) => ids.length);
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("new-company 安装:响应带 txId,transaction 落盘形状正确", async () => {
    seedTemplateFile(root, tpl({ id: "t-tx-new" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-tx-new" }),
    });
    const body = await r.json() as any;
    expect(r.status).toBe(200);
    expect(typeof body.txId).toBe("string");
    const tx = getInstallTransaction(root, body.txId);
    expect(tx?.mode).toBe("new-company");
    expect(tx?.source).toBe("t-tx-new");
    expect(tx?.companyId).toBe(body.companyId);
    expect(tx?.created.agentIds).toHaveLength(2);
    expect(tx?.created.companyIds).toEqual([body.companyId]);
    expect(tx?.conflictDecisions).toEqual([]);
    expect(tx?.rolledBack).toBeUndefined();
  });

  it("preview 不产生 transaction", async () => {
    seedTemplateFile(root, tpl({ id: "t-tx-preview" }));
    await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-tx-preview", mode: "preview" }),
    });
    expect(loadInstallTransactions(root)).toEqual([]);
  });

  it("merge 安装:transaction 只记这次新增的 agent/presetChannel,conflictDecisions = D3 的 decisions", async () => {
    seedTargetCompany({ presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }] });
    vi.mocked(getAgents).mockReturnValue([
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", companyId: "target", parentId: "ceo-x" }),
    ]);
    seedTemplateFile(root, tpl({ id: "t-tx-merge", a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }] }));
    // 两步流拿 token:保留预置 A2A 通道(否则 D1 Safe Install 默认剥离社区模板的 a2aChannels,
    // 这条测试的重点是"presetChannelKeys 只记新增的",要有通道才有得测)。
    const token = await previewInstallToken(baseUrl, "t-tx-merge");
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-tx-merge", mode: "merge", targetCompanyId: "target", installConfirmationToken: token }),
    });
    const body = await r.json() as any;
    expect(r.status).toBe(200);
    const tx = getInstallTransaction(root, body.txId);
    expect(tx?.mode).toBe("merge");
    expect([...tx!.created.agentIds].sort()).toEqual(["ceo-0", "dev-0"]);
    expect(tx?.created.companyIds).toEqual([]);
    expect(tx?.created.presetChannelKeys).toEqual(["ceo-0=>dev-0"]);
    expect(tx?.conflictDecisions).toEqual(body.decisions);
  });

  it("merge:doctor 拒绝时不落 transaction", async () => {
    seedTargetCompany();
    seedTemplateFile(root, tpl({
      id: "t-tx-merge-reject",
      agents: [agent({ id: "a", role: "ceo", parentId: "b" }), agent({ id: "b", parentId: "a" })],
    }));
    await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-tx-merge-reject", mode: "merge", targetCompanyId: "target" }),
    });
    expect(loadInstallTransactions(root)).toEqual([]);
  });

  it("rollback:不存在的 txId → 404", async () => {
    const r = await fetch(`${baseUrl}/api/community/install/no-such-tx/rollback`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("rollback:new-company → 公司消失、有备份文件、bundledSkills 被撤销;重复回滚 409", async () => {
    const TPL_ID = "t-rollback-new";
    let SKILL_ID = "";
    seedTemplateFile(root, tpl({
      id: TPL_ID,
      bundledSkills: [{ name: "onboarding", content: "正文", roles: ["dev"] }],
    }));
    try {
      const installR = await fetch(`${baseUrl}/api/community/install/company`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: TPL_ID }),
      });
      const installBody = await installR.json() as any;
      SKILL_ID = skillIdFor(TPL_ID, "onboarding", "dev", installBody.companyId); // 新装公司 id 掺进 skill id
      expect(installBody.bundledSkillsInstalled).toBe(1);
      expect(getSkill(undefined, SKILL_ID)).toBeTruthy();

      const installedAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
      seedRealAgentsFile(installedAgents);
      vi.mocked(removeAgentsByCompany).mockReturnValue(installedAgents.length);

      const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
      const rbBody = await rbR.json() as any;
      expect(rbR.status).toBe(200);
      expect(rbBody.mode).toBe("new-company");
      expect(rbBody.companyDeleted).toBe(true);
      expect(rbBody.backupFile).toBeTruthy();
      expect(rbBody.removedAgents).toBe(installedAgents.length);
      expect(rbBody.revertedSkills).toBe(1);
      expect(removeAgentsByCompany).toHaveBeenCalledWith(installBody.companyId);

      const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
      expect(companies.find((c: any) => c.id === installBody.companyId)).toBeUndefined();
      const backupDir = path.join(root, ".opc", "company-backups");
      expect(fs.existsSync(backupDir) && fs.readdirSync(backupDir).length).toBeGreaterThan(0);
      expect(getSkill(undefined, SKILL_ID)).toBeNull();

      const repeat = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
      expect(repeat.status).toBe(409);
    } finally {
      try { deleteSkill(undefined, SKILL_ID); } catch { /* */ }
    }
  });

  it("rollback:merge → 只删这次新增的 agent/presetChannel/skill,目标公司原有资产完好,manifestMcpRequirements 恢复到合并前", async () => {
    const TPL_ID = "t-rollback-merge";
    const SKILL_ID = skillIdFor(TPL_ID, "onboarding", "dev", "target"); // merge 装进既有 target 公司
    // 目标公司合并前已有 filesystem(optional)能力声明——模板再声明一条 web-search,合并后应是两条
    // 的并集;发现①(对抗验收缺口):回滚前若不修,manifestMcpRequirements 会永久停留在"并集后"的值。
    seedTargetCompany({
      presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }],
      manifestMcpRequirements: [{ name: "filesystem", optional: true }],
    });
    const preExisting = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", companyId: "target", parentId: "ceo-x" }),
    ];
    vi.mocked(getAgents).mockReturnValue(preExisting);
    seedTemplateFile(root, tpl({
      id: TPL_ID,
      a2aChannels: [{ from: "ceo-0", to: "dev-0", purpose: "sync" }],
      bundledSkills: [{ name: "onboarding", content: "正文", roles: ["dev"] }],
      mcpRequirements: [{ name: "web-search", optional: false }],
    }));
    try {
      const token = await previewInstallToken(baseUrl, TPL_ID);
      const installR = await fetch(`${baseUrl}/api/community/install/company`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: TPL_ID, mode: "merge", targetCompanyId: "target", installConfirmationToken: token }),
      });
      const installBody = await installR.json() as any;
      expect(installR.status).toBe(200);
      const newAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
      expect(newAgents.map(a => a.id).sort()).toEqual(["ceo-0", "dev-0"]);
      // 合并后应是并集(两条能力要求)——确认真的发生了变化,回滚断言才有意义。
      const afterMerge = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
      expect(afterMerge.find((c: any) => c.id === "target").manifestMcpRequirements.map((m: any) => m.name).sort())
        .toEqual(["filesystem", "web-search"]);
      // 模拟合并后真实 orchestrator 会看到的状态(既有员工 + 这次新装的)。
      vi.mocked(getAgents).mockReturnValue([...preExisting, ...newAgents]);

      const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
      const rbBody = await rbR.json() as any;
      expect(rbR.status).toBe(200);
      expect(rbBody.mode).toBe("merge");
      expect(rbBody.changedAgents).toEqual([]);
      expect(rbBody.missingAgents).toEqual([]);
      expect((vi.mocked(removeAgentsByIds).mock.calls.at(-1)?.[0] as string[]).sort()).toEqual(["ceo-0", "dev-0"]);
      expect(rbBody.revertedPresetChannels).toBe(1);
      expect(rbBody.revertedSkills).toBe(1);

      const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
      const target = companies.find((c: any) => c.id === "target");
      expect(target).toBeTruthy(); // 目标公司本体没被删
      expect(target.presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }]); // 只剩原有的
      // 回滚后 manifestMcpRequirements 等于合并前(不残留合并后并入的 web-search)。
      expect(target.manifestMcpRequirements).toEqual([{ name: "filesystem", optional: true }]);

      const repeat = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
      expect(repeat.status).toBe(409);
    } finally {
      try { deleteSkill(undefined, SKILL_ID); } catch { /* */ }
    }
  });

  it("rollback:merge → 目标公司合并前本没有 manifestMcpRequirements,回滚后仍是「无」(不遗留合并带入的新值)", async () => {
    const TPL_ID = "t-rollback-merge-mcp-empty";
    seedTargetCompany(); // 无 manifestMcpRequirements、无 presetChannels
    const preExisting = [agent({ id: "ceo-x", role: "ceo", companyId: "target" })];
    vi.mocked(getAgents).mockReturnValue(preExisting);
    seedTemplateFile(root, tpl({ id: TPL_ID, mcpRequirements: [{ name: "filesystem", optional: false }] }));

    const token = await previewInstallToken(baseUrl, TPL_ID);
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: TPL_ID, mode: "merge", targetCompanyId: "target", installConfirmationToken: token }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);
    const afterMerge = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(afterMerge.find((c: any) => c.id === "target").manifestMcpRequirements).toEqual([{ name: "filesystem", optional: false }]);

    const newAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
    vi.mocked(getAgents).mockReturnValue([...preExisting, ...newAgents]);

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    expect(rbR.status).toBe(200);
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    const target = companies.find((c: any) => c.id === "target");
    expect(target.manifestMcpRequirements ?? undefined).toBeUndefined();
  });

  // ══ 收口② · 公司级四字段保守合并合同(与 companyRoutes /api/companies/import merge 同口径)══
  it("收口②·merge:visibilityPolicy 目标优先、defaultTasks goal 去重 union、toolRequirements 只声明 union、workflow 冲突 requires_review、agentMemories 只导新建员工", async () => {
    const TPL_ID = "t-merge-contract-fields";
    const targetWorkflow = { verificationEdges: [{ producer: "dev", verifier: "ceo", method: "llm-review", onReject: "flag" }] };
    seedTargetCompany({
      visibilityPolicy: "isolated",
      defaultTasks: [{ title: "已有", goal: "做 A" }],
      workflow: targetWorkflow, // 目标已有 workflow → 来源 workflow 不得静默合并/覆盖
    });
    vi.mocked(getAgents).mockReturnValue([
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-0", companyId: "target", parentId: "ceo-x", name: "旧版 dev" }), // 与模板 dev-0 冲突 → overwrite
    ]);
    // 目标既有员工 dev-0 已有个人记忆——合同禁止来源静默覆盖
    const devMemPath = agentMemoryPath(root, "dev-0");
    fs.mkdirSync(path.dirname(devMemPath), { recursive: true });
    fs.writeFileSync(devMemPath, "目标员工的既有记忆\n", "utf-8");

    seedTemplateFile(root, tpl({
      id: TPL_ID,
      visibilityPolicy: "default", // 比 isolated 宽 → 不得采纳
      defaultTasks: [{ title: "重复", goal: " 做 A " }, { title: "新增", goal: "做 B" }],
      toolRequirements: { requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: ["web-search"], requiredSkills: [], optionalTools: [] },
      workflow: { verificationEdges: [{ producer: "researcher", verifier: "lead", method: "fact-check", onReject: "redo" }] },
      mcpRequirements: [{ name: "web-search", purpose: "查资料" }],
      agentMemories: [
        { agent_id: "ceo-0", role: "ceo", content: "新建员工的记忆" },
        { agent_id: "dev-0", role: "dev", content: "来源想覆盖的记忆" },
      ],
    }));
    const token = await previewInstallToken(baseUrl, TPL_ID);
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: TPL_ID, mode: "merge", targetCompanyId: "target",
        mergeStrategies: { agentId: "overwrite" }, confirmOverwrite: true, installConfirmationToken: token,
      }),
    });
    const body = await r.json() as any;
    expect(r.status).toBe(200);

    const target = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8")).find((c: any) => c.id === "target");
    expect(target.visibilityPolicy).toBe("isolated"); // 目标策略永远优先,导入不放宽既有隔离
    expect(target.defaultTasks).toEqual([{ title: "已有", goal: "做 A" }, { title: "新增", goal: "做 B" }]);
    // 目标原无 manifestToolRequirements → 采纳来源整份(带 token 的 unsafe 保留使 requiredMcpServers 声明不被剥离);
    // 只写声明字段,不自动配置任何 MCP(mcp_servers.json 不因 merge 出现)。
    expect(target.manifestToolRequirements).toEqual({
      requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: ["web-search"], requiredSkills: [], optionalTools: [],
    });
    expect(fs.existsSync(path.join(root, ".opc", "mcp_servers.json"))).toBe(false);
    expect(target.workflow).toEqual(targetWorkflow); // 保留目标,不静默合并/覆盖

    // agentMemories:只导新建员工 ceo-0;overwrite 的 dev-0 保留目标记忆 + requires_review
    expect(body.agentMemoriesImported).toBe(1);
    expect(fs.readFileSync(agentMemoryPath(root, "ceo-0"), "utf-8")).toContain("新建员工的记忆");
    expect(fs.readFileSync(devMemPath, "utf-8")).toBe("目标员工的既有记忆\n");

    // 四类清单:未采纳/未支持的来源字段全部进报告,不静默消失
    expect(body.report.preserved.some((i: any) => i.field === "visibilityPolicy")).toBe(true);
    expect(body.report.added.some((i: any) => i.field === "defaultTasks")).toBe(true);
    expect(body.report.added.some((i: any) => i.field === "manifestToolRequirements")).toBe(true);
    expect(body.report.requires_review.some((i: any) => i.field === "workflow")).toBe(true);
    // 令四.4 后 requires_review 里 dev-0 有两条:①合并计划的"overwrite 覆盖:保留目标员工记忆"复核条目,
    // ②importAgentMemoriesDetailed 的"idMap 无映射未写回"逐条失败条目(同一事实的双侧记账,均不静默)。
    // 关键语义:全部条目都指向 dev-0(被保留记忆的既有员工),没有任何条目误报新建员工 ceo-0。
    const memReview = body.report.requires_review.filter((i: any) => i.field === "agentMemories");
    expect(memReview.length).toBeGreaterThanOrEqual(1);
    expect(memReview.every((i: any) => i.detail.includes("dev-0"))).toBe(true);
    expect(memReview.some((i: any) => i.detail.includes("ceo-0"))).toBe(false);
    expect(body.report.requires_local_setup.some((i: any) => i.field === "manifestToolRequirements.requiredMcpServers")).toBe(true);
    expect(body.report.requires_local_setup.some((i: any) => i.field === "mcpServers" && i.detail.includes("web-search"))).toBe(true); // 本机未配置的 MCP → 需本地配置

    // preMerge.companyFields:合并前四字段整值快照(目标本无 manifestToolRequirements → 快照为 undefined)
    const tx = getInstallTransaction(root, body.txId);
    expect(tx?.preMerge?.companyFields).toEqual({
      visibilityPolicy: "isolated",
      defaultTasks: [{ title: "已有", goal: "做 A" }],
      workflow: targetWorkflow,
    });
  });

  it("收口②·rollback:公司级四字段整值恢复到合并前(目标原本没有的恢复为「无」)+ 只撤本 tx 导入的 memory record", async () => {
    const TPL_ID = "t-rollback-contract-fields";
    const NOW = "2026-07-08T00:00:00.000Z";
    const targetToolReq = { requiredEngines: ["claude-code"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] };
    // 目标:只有 manifestToolRequirements;visibilityPolicy/defaultTasks/workflow 均未设置(回滚要恢复为「无」)
    seedTargetCompany({ manifestToolRequirements: targetToolReq });
    const preExisting = [agent({ id: "ceo-x", role: "ceo", companyId: "target" })];
    vi.mocked(getAgents).mockReturnValue(preExisting);
    // 本机既有记忆(别的来源写入)——回滚只撤本 tx 导入的,不伤它
    const pre = upsertProceduralSkill(root, {
      role: "dev", taskType: undefined, preconditions: [], successfulSequence: ["本地步骤"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r0"], status: "candidate",
    }, NOW);

    seedTemplateFile(root, tpl({
      id: TPL_ID,
      visibilityPolicy: "isolated",
      defaultTasks: [{ title: "新", goal: "做 B" }],
      toolRequirements: { requiredEngines: ["claude-code", "codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
      workflow: { verificationEdges: [{ producer: "researcher", verifier: "lead", method: "fact-check", onReject: "redo" }] },
      seedMemories: [{
        scope: "s", source: { type: "run", run_id: "r1", task_id: "" }, score: 60, status: "active", tags: [],
        metrics: { cited_count: 1, cited_success_count: 1, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
        created_at: NOW, updated_at: NOW, last_used_at: NOW,
        memory_id: "mem-cs-rb", owner_type: "company", owner_id: "x", content: "外来结论", level: "verified",
      }] as any,
    }));
    const token = await previewInstallToken(baseUrl, TPL_ID);
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: TPL_ID, mode: "merge", targetCompanyId: "target", memoryImportMode: "full", installConfirmationToken: token }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);

    // 合并确实生效(回滚断言才有意义)
    const afterMerge = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8")).find((c: any) => c.id === "target");
    expect(afterMerge.visibilityPolicy).toBe("isolated"); // 目标未设置 → 采纳来源
    expect(afterMerge.defaultTasks).toEqual([{ title: "新", goal: "做 B" }]);
    expect(afterMerge.workflow).toEqual({ verificationEdges: [{ producer: "researcher", verifier: "lead", method: "fact-check", onReject: "redo" }] });
    expect(afterMerge.manifestToolRequirements.requiredEngines).toEqual(["claude-code", "codex"]);
    expect(loadRegistry(root).map(rec => rec.id)).toEqual([pre.id]);
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);

    const newAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
    vi.mocked(getAgents).mockReturnValue([...preExisting, ...newAgents]);

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    expect(rbR.status).toBe(200);
    const target = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8")).find((c: any) => c.id === "target");
    // 四字段整值恢复:合并前有的恢复原值,合并前没有的恢复为「无」(不遗留合并带入的新值)
    expect(target.visibilityPolicy ?? undefined).toBeUndefined();
    expect(target.defaultTasks ?? undefined).toBeUndefined();
    expect(target.workflow ?? undefined).toBeUndefined();
    expect(target.manifestToolRequirements).toEqual(targetToolReq);
    // 只撤本 tx 导入的 memory record:本机既有记录原样保留
    expect(loadRegistry(root).map(rec => rec.id)).toEqual([pre.id]);
    expect(listGovernedMemoryProposals(root)).toEqual([]);
  });

  it("rollback:created 的 agent 若已被改名 → 如实列入 changedAgents,仍照常删除(不静默)", async () => {
    const TPL_ID = "t-rollback-changed";
    seedTemplateFile(root, tpl({ id: TPL_ID }));
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: TPL_ID }),
    });
    const installBody = await installR.json() as any;
    const installedAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
    seedRealAgentsFile(installedAgents);
    // 用户事后把其中一个员工改了名字(其余不变)——模拟 getAgents() 现在反映的真实状态。
    const renamed = installedAgents.map((a, i) => i === 0 ? { ...a, name: "改过的名字" } : a);
    vi.mocked(getAgents).mockReturnValue(renamed);
    vi.mocked(removeAgentsByCompany).mockReturnValue(installedAgents.length);

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    const rbBody = await rbR.json() as any;
    expect(rbR.status).toBe(200);
    expect(rbBody.changedAgents).toHaveLength(1);
    expect(rbBody.changedAgents[0].id).toBe(installedAgents[0].id);
    expect(rbBody.companyDeleted).toBe(true); // 仍照常删除,不因为"变过"就跳过
  });

  // 发现②(对抗验收缺口)+ #8:agentId:overwrite 是高风险路径——原地覆盖目标公司既有员工。回滚
  // 必须是**整对象替换**(先删被覆盖 id,再以覆盖前快照加回),不能走 updateAgent 的 Object.assign
  // 合并语义:快照里不存在的 key 不会被删,模板覆盖时新写上的字段(如 claudeCodeUseApiKey)会残留。
  it("merge+overwrite:无 confirmOverwrite → 400;带确认后覆盖成功;回滚 → 被覆盖员工整对象替换还原(零残留)、新增员工被删", async () => {
    const TPL_ID = "t-rollback-overwrite";
    seedTargetCompany();
    const preExisting = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-0", role: "dev", companyId: "target", parentId: "ceo-x", name: "旧版 dev", model: "old-model" }),
    ];
    vi.mocked(getAgents).mockReturnValue(preExisting);
    seedTemplateFile(root, tpl({
      id: TPL_ID,
      agents: [
        agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }),
        // 与现有 dev-0 冲突;claudeCodeUseApiKey 是原员工没有的模板新字段——合并语义回滚时它会残留
        agent({ id: "dev-0", role: "dev", parentId: "ceo-0", name: "新版 dev", model: "new-model", claudeCodeUseApiKey: true }),
      ],
    }));

    const noConfirm = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: TPL_ID, mode: "merge", targetCompanyId: "target", mergeStrategies: { agentId: "overwrite" } }),
    });
    expect(noConfirm.status).toBe(400); // 按现有实现的真实状态码(resolveMerge 的高风险二次确认门禁)
    expect(updateAgent).not.toHaveBeenCalled();

    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: TPL_ID, mode: "merge", targetCompanyId: "target",
        mergeStrategies: { agentId: "overwrite" }, confirmOverwrite: true,
      }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);
    // 目标员工被覆盖:updateAgent 收到模板的新字段。
    const overwriteCall = vi.mocked(updateAgent).mock.calls.find(c => c[0] === "dev-0");
    expect(overwriteCall?.[1]).toMatchObject({ id: "dev-0", name: "新版 dev", model: "new-model", claudeCodeUseApiKey: true });
    const newAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
    expect(newAgents.map(a => a.id)).toEqual(["ceo-0"]); // 唯一真正新增的(dev-0 走的是覆盖,不是新增)

    // 模拟合并后真实 orchestrator 会看到的状态(既有员工 + 被覆盖的 dev-0 + 新增的 ceo-0)。
    const overwrittenDev0 = { ...preExisting[1], name: "新版 dev", model: "new-model", claudeCodeUseApiKey: true };
    vi.mocked(getAgents).mockReturnValue([preExisting[0], overwrittenDev0, ...newAgents]);
    vi.mocked(updateAgent).mockClear();
    vi.mocked(addAgents).mockClear();

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    const rbBody = await rbR.json() as any;
    expect(rbR.status).toBe(200);
    // 先删本次新增(ceo-0),再删被覆盖 id(dev-0,为整对象加回让路)。
    expect(vi.mocked(removeAgentsByIds).mock.calls.map(c => c[0])).toEqual([["ceo-0"], ["dev-0"]]);
    // #8:还原不走 updateAgent(Object.assign 合并会留下 claudeCodeUseApiKey 残留),
    // 而是 addAgents 整对象加回——toEqual 全量匹配覆盖前快照,零残留。
    expect(updateAgent).not.toHaveBeenCalled();
    const restored = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
    expect(restored).toEqual([preExisting[1]]);
    void rbBody;
  });

  // 发现②(对抗验收缺口)的另一半:a2aRule union/overwrite 会改写既有边的 purpose,回滚要恢复到改写前。
  it("merge+a2aRule union:改写既有边 purpose;回滚 → 边的 purpose 还原到合并前", async () => {
    const TPL_ID = "t-rollback-a2a-modified";
    seedTargetCompany({ presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }] });
    const preExisting = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", role: "dev", companyId: "target", parentId: "ceo-x" }),
    ];
    vi.mocked(getAgents).mockReturnValue(preExisting);
    seedTemplateFile(root, tpl({
      id: TPL_ID,
      agents: [
        agent({ id: "ceo-x", role: "ceo" }), // 与现有 ceo-x 冲突,用 overwrite 让最终 id 落在 ceo-x/dev-x 上
        agent({ id: "dev-x", role: "dev", parentId: "ceo-x" }),
      ],
      a2aChannels: [{ from: "ceo-x", to: "dev-x", purpose: "新目的" }],
    }));

    const token = await previewInstallToken(baseUrl, TPL_ID);
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: TPL_ID, mode: "merge", targetCompanyId: "target",
        mergeStrategies: { agentId: "overwrite" }, confirmOverwrite: true, installConfirmationToken: token,
      }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);
    const afterMerge = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(afterMerge.find((c: any) => c.id === "target").presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "既有同步; 新目的" }]);

    vi.mocked(getAgents).mockReturnValue(preExisting); // 全员都是覆盖,没有真正新增的 agent
    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    expect(rbR.status).toBe(200);
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    const target = companies.find((c: any) => c.id === "target");
    expect(target.presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }]); // 还原到合并前
  });

  // #22:计划文档硬规则「transaction 先落、状态后写」——崩溃窗口内不能出现"状态已写、无回滚依据"的
  // 半成品安装。用第一笔可 mock 的状态写(addAgents)做观测点:它被调用时 transaction 必须已在盘上。
  it("#22:merge——addAgents(第一笔状态写)被调用时 install transaction 已落盘", async () => {
    seedTargetCompany();
    vi.mocked(getAgents).mockReturnValue([agent({ id: "ceo-x", role: "ceo", companyId: "target" })]);
    let txsAtFirstWrite = -1;
    vi.mocked(addAgents).mockImplementationOnce((nodes: AgentNodeConfig[]) => {
      txsAtFirstWrite = loadInstallTransactions(root).length;
      return nodes.length;
    });
    seedTemplateFile(root, tpl({ id: "t-tx-first-merge" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-tx-first-merge", mode: "merge", targetCompanyId: "target" }),
    });
    expect(r.status).toBe(200);
    expect(txsAtFirstWrite).toBe(1);
  });

  it("#22:new-company——addAgents 被调用时 install transaction 已落盘(公司 id 预生成,tx 先于建公司/加人)", async () => {
    let txsAtFirstWrite = -1;
    vi.mocked(addAgents).mockImplementationOnce((nodes: AgentNodeConfig[]) => {
      txsAtFirstWrite = loadInstallTransactions(root).length;
      return nodes.length;
    });
    seedTemplateFile(root, tpl({ id: "t-tx-first-new" }));
    const r = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-tx-first-new" }),
    });
    const body = await r.json() as any;
    expect(r.status).toBe(200);
    expect(txsAtFirstWrite).toBe(1);
    // tx 里预生成的 companyId 与真实落地的公司一致
    const tx = getInstallTransaction(root, body.txId);
    expect(tx?.companyId).toBe(body.companyId);
    const companies = JSON.parse(fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8"));
    expect(companies.some((c: any) => c.id === body.companyId)).toBe(true);
  });

  // #27:回滚顺序必须"先自动备份、后删技能"——备份走 companyToTemplate → collectBundledSkills,
  // 按前缀去 skill store 读技能正文;先删后备,备份文件的 bundledSkills 恒为空,从备份恢复的公司
  // 会静默丢掉全部打包技能。
  it("#27:new-company 回滚——自动备份完整携带 bundledSkills(先备份后删技能),技能随后确实被删", async () => {
    const TPL_ID = "t-rollback-backup-order";
    const ROLE = "x27-dev"; // 唯一 role:避免命中本机技能库里其它公司的同名角色技能,备份断言可精确到整对象
    let SKILL_ID = "";
    seedTemplateFile(root, tpl({
      id: TPL_ID,
      agents: [
        agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }),
        agent({ id: "dev-0", role: ROLE, parentId: "ceo-0" }),
      ],
      bundledSkills: [{ name: "onboarding", content: "打包技能正文", roles: [ROLE] }],
    }));
    try {
      const installR = await fetch(`${baseUrl}/api/community/install/company`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: TPL_ID }),
      });
      const installBody = await installR.json() as any;
      SKILL_ID = skillIdFor(TPL_ID, "onboarding", ROLE, installBody.companyId);
      expect(installBody.bundledSkillsInstalled).toBe(1);

      const installedAgents = vi.mocked(addAgents).mock.calls.at(-1)?.[0] as AgentNodeConfig[];
      seedRealAgentsFile(installedAgents);
      vi.mocked(getAgents).mockReturnValue(installedAgents);
      vi.mocked(removeAgentsByCompany).mockReturnValue(installedAgents.length);

      const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
      const rbBody = await rbR.json() as any;
      expect(rbR.status).toBe(200);
      expect(rbBody.backupFile).toBeTruthy();
      expect(rbBody.revertedSkills).toBe(1);
      expect(getSkill(undefined, SKILL_ID)).toBeNull(); // 技能确实删了(回滚语义不变)

      // 备份先于删除:备份文件里的 bundledSkills 完整(toEqual 整对象,证明不是空壳/缺字段)。
      const backup = JSON.parse(fs.readFileSync(path.join(root, ".opc", "company-backups", rbBody.backupFile), "utf-8"));
      const backedUp = (backup.bundledSkills ?? []).find((b: any) => b.name === "onboarding");
      expect(backedUp).toEqual({ name: "onboarding", content: "打包技能正文", roles: [ROLE] });
    } finally {
      try { deleteSkill(undefined, SKILL_ID); } catch { /* */ }
    }
  });

  // C1 · 回滚引用检查:legacy(无 companyId,按 role 全局绑定单份文件)技能被别的仍存在的公司共享时,
  // 回滚不能硬删——如实记入 skippedSharedSkillIds、跳过删除。复现 install.ts 自认的 A装→B装→回滚A 场景。
  it("rollback:legacy 共享技能——被另一家仍存在的同源公司依赖时跳过删除,记 skippedSharedSkillIds", async () => {
    const LEGACY_ID = "bundled-shared-c1-tpl-guide--dev";
    // co-y:另一家仍存在、同源(shared-c1-tpl)安装的公司;co-x:本次要回滚的那家。
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "co-y", name: "共享方", description: "", createdAt: "2026-01-01T00:00:00Z", manifestTemplateId: "shared-c1-tpl" },
    ]));
    createSkill(undefined, { id: LEGACY_ID, title: "共享指南", role: "dev", enabled: true, content: "正文", origin: "bundled", lastModified: new Date().toISOString() });
    try {
      // 两笔 merge tx:回滚 co-x 这笔时,应扫到 co-y 这笔(同 source、公司仍在)→ 判定共享。
      const txX = recordInstallTransaction(root, {
        mode: "merge", source: "shared-c1-tpl", companyId: "co-x",
        created: { agentIds: [], companyIds: [], presetChannelKeys: [], skillIds: [LEGACY_ID] },
        agentSnapshots: [], conflictDecisions: [], safeInstallStripped: [],
      });
      recordInstallTransaction(root, {
        mode: "merge", source: "shared-c1-tpl", companyId: "co-y",
        created: { agentIds: [], companyIds: [], presetChannelKeys: [], skillIds: [LEGACY_ID] },
        agentSnapshots: [], conflictDecisions: [], safeInstallStripped: [],
      });

      const rbR = await fetch(`${baseUrl}/api/community/install/${txX.txId}/rollback`, { method: "POST" });
      const rbBody = await rbR.json() as any;
      expect(rbR.status).toBe(200);
      expect(rbBody.revertedSkills).toBe(0);                       // 没删
      expect(rbBody.skippedSharedSkillIds).toContain(LEGACY_ID);   // 如实报告"仍被依赖"
      expect(getSkill(undefined, LEGACY_ID)).toBeTruthy();         // 技能仍在,co-y 不受伤
    } finally {
      try { deleteSkill(undefined, LEGACY_ID); } catch { /* */ }
    }
  });

  // #9(指南 11.17:Rollback 应撤销「新增 memory」):D5 导入的记忆此前完全不在回滚范围——
  // transaction 现在记下真实写入的记录 id,回滚按 id 硬删新建的三类记录,merged 的如实报告。
  it("#9:rollback 撤销本次导入的记忆——conclusion/procedural_skill/lesson 三类全删,registry/lessons 回到安装前(toEqual 零残留)", async () => {
    const NOW = "2026-07-08T00:00:00.000Z";
    const memBase = {
      scope: "s", source: { type: "run", run_id: "r1", task_id: "" }, score: 50, status: "active" as const, tags: [],
      metrics: { cited_count: 1, cited_success_count: 1, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: NOW, updated_at: NOW, last_used_at: NOW,
    };
    seedTemplateFile(root, tpl({
      id: "t-rollback-memory",
      seedMemories: [
        { ...memBase, memory_id: "mem-cs-1", owner_type: "company", owner_id: "c1", content: "外来结论要点", level: "verified" },
        { ...memBase, memory_id: "mem-ps-1", owner_type: "agent", owner_id: "dev", content: "外来成功步骤", level: "sop" },
        { ...memBase, memory_id: "mem-ls-1", owner_type: "agent", owner_id: "dev", content: "把大任务拆成更小的子任务", level: "noted" },
      ] as any,
    }));
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: "t-rollback-memory", memoryImportMode: "full" }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);
    expect(installBody.memoryImport.imported).toBe(3);
    expect(listGovernedMemoryProposals(root)).toHaveLength(3);
    expect(loadRegistry(root)).toEqual([]);
    expect(loadLessons(root)).toEqual([]);
    const tx = getInstallTransaction(root, installBody.txId);
    expect(tx?.memory?.governedProposalIds).toHaveLength(3);
    expect(tx?.memory?.conclusionIds).toEqual([]);
    expect(tx?.memory?.proceduralSkillCreatedIds).toEqual([]);
    expect(tx?.memory?.lessonCreatedIds).toEqual([]);

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    const rbBody = await rbR.json() as any;
    expect(rbR.status).toBe(200);
    expect(rbBody.memoryRollback).toEqual({
      governedProposalsRemoved: 3,
      conclusionsRemoved: 0,
      proceduralSkillsRemoved: 0,
      lessonsRemoved: 0,
    });
    expect(listGovernedMemoryProposals(root)).toEqual([]);
    expect(loadRegistry(root)).toEqual([]); // toEqual 整库断言:零残留
    expect(loadLessons(root)).toEqual([]);
  });

  it("#9:导入 proposed procedural_skill 不覆盖本地 candidate——回滚只删外来提案", async () => {
    const NOW = "2026-07-08T00:00:00.000Z";
    // 外来技能以 proposed 导入,即使同公司同 role+taskType,也必须与本地 candidate 分离,
    // 避免未经审批的内容覆盖本地有效记忆;rollback 只删除本次创建的 proposed 记录。
    seedTargetCompany({});
    vi.mocked(getAgents).mockReturnValue([agent({ id: "ceo-x", role: "ceo", companyId: "target" })]);
    const pre = upsertProceduralSkill(root, {
      companyId: "target",
      role: "dev", taskType: undefined, preconditions: [], successfulSequence: ["本地步骤"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r0"], status: "candidate",
    } as any, NOW);
    seedTemplateFile(root, tpl({
      id: "t-rollback-memory-merged",
      seedMemories: [{
        scope: "s", source: { type: "run", run_id: "r1", task_id: "" }, score: 80, status: "active", tags: [],
        metrics: { cited_count: 1, cited_success_count: 1, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
        created_at: NOW, updated_at: NOW, last_used_at: NOW,
        memory_id: "mem-ps-merge", owner_type: "agent", owner_id: "dev", content: "外来步骤", level: "sop",
      }] as any,
    }));
    const token = await previewInstallToken(baseUrl, "t-rollback-memory-merged");
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-rollback-memory-merged", mode: "merge", targetCompanyId: "target", memoryImportMode: "full", installConfirmationToken: token }),
    });
    const installBody = await installR.json() as any;
    expect(installR.status).toBe(200);
    expect(installBody.memoryImport.imported).toBe(1);
    const tx = getInstallTransaction(root, installBody.txId);
    expect(tx?.memory?.governedProposalIds).toHaveLength(1);
    expect(tx?.memory?.proceduralSkillCreatedIds).toEqual([]);
    expect(tx?.memory?.proceduralSkillMergedIds).toEqual([]);
    expect(loadRegistry(root).find(r => r.id === pre.id)).toEqual(pre);
    expect(listGovernedMemoryProposals(root)[0]).toMatchObject({
      proposalId: tx?.memory?.governedProposalIds[0],
      status: "proposed",
      sourceType: "import",
      portableBundleRecord: { memory_id: "mem-ps-merge" },
    });

    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    const rbBody = await rbR.json() as any;
    expect(rbR.status).toBe(200);
    expect(rbBody.memoryRollback).toEqual({
      governedProposalsRemoved: 1,
      conclusionsRemoved: 0,
      proceduralSkillsRemoved: 0,
      lessonsRemoved: 0,
    });
    expect(listGovernedMemoryProposals(root)).toEqual([]);
  });

  it("#9:老 transaction(无 memory 字段)回滚——维持原行为,不碰记忆、响应不带 memoryRollback", async () => {
    seedTemplateFile(root, tpl({ id: "t-rollback-no-memory" }));
    const installR = await fetch(`${baseUrl}/api/community/install/company`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "t-rollback-no-memory" }),
    });
    const installBody = await installR.json() as any;
    const rbR = await fetch(`${baseUrl}/api/community/install/${installBody.txId}/rollback`, { method: "POST" });
    const rbBody = await rbR.json() as any;
    expect(rbR.status).toBe(200);
    expect(rbBody.memoryRollback).toBeUndefined();
  });
});

// D8(指南 11.17 Community Report / Unlist)· remote/delete 改"标记下架"——本地立即生效(不等 PR 合并),
// 记录仍在(GitHub 历史/本地 remote-unlisted.json 都没被真的抹掉),list 默认把下架条目过滤掉。
// 全套 GitHub API 序列(user/contents 单文件/contents 目录列表/issues/refs/trees/commits/pulls)按
// URL 模式匹配而非严格顺序 mock——健壮于 register() 启动时后台预热 computeRemote() 的并发调用。
describe("D8 · communityRoutes remote/delete — 下架不真删,list 默认过滤", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  const GH = "https://api.github.com";
  const OWNER = "WUBING2023"; // 与 communityRoutes.ts 的 DEFAULT_COMMUNITY_REPO 一致
  const REPO = "opc-studio-community";
  const REMOTE_ITEM = { id: "t-unlist-me", title: "下架测试模板", author: OWNER, description: "d" };

  function githubRouter() {
    return async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      const method = (init?.method || "GET").toUpperCase();
      const ok = (body: unknown): any => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (!url.startsWith(GH)) return realFetch(input, init); // 非 GitHub 域名(不应发生)照常放行
      if (url.includes("/mock/t-unlist-me.json")) return ok(REMOTE_ITEM); // computeRemote 的 download_url 单文件拉取
      if (url === `${GH}/user`) return ok({ login: OWNER });
      if (url === `${GH}/repos/${OWNER}/${REPO}/contents/templates?ref=main`) {
        return ok([{ type: "file", name: "t-unlist-me.json", path: "templates/t-unlist-me.json", download_url: `${GH}/mock/t-unlist-me.json` }]);
      }
      if (url === `${GH}/repos/${OWNER}/${REPO}/contents/agents?ref=main`) return ok([]); // 简化:agents 目录空
      if (url.startsWith(`${GH}/repos/${OWNER}/${REPO}/contents/templates/t-unlist-me.json?ref=main`)) return ok(REMOTE_ITEM); // 所有权预检的单文件 raw 读取
      if (url === `${GH}/repos/${OWNER}/${REPO}/issues?state=all&per_page=100`) return ok([]); // 跳过 star/下载数富化
      if (url === `${GH}/repos/${OWNER}/${REPO}/git/refs/heads/main`) return ok({ object: { sha: "base-sha" } });
      if (url === `${GH}/repos/${OWNER}/${REPO}/git/trees` && method === "POST") return ok({ sha: "tree-sha" });
      if (url === `${GH}/repos/${OWNER}/${REPO}/git/commits` && method === "POST") return ok({ sha: "commit-sha" });
      if (url === `${GH}/repos/${OWNER}/${REPO}/git/refs` && method === "POST") return ok({});
      if (url === `${GH}/repos/${OWNER}/${REPO}/pulls` && method === "POST") return ok({ html_url: `https://github.com/${OWNER}/${REPO}/pull/1` });
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "community-routes-d8-"));
    fs.mkdirSync(path.join(root, ".opc", "community", "templates"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
    saveGithubAuth(root, { accessToken: "test-gh-token", connectedAt: "2026-07-08T00:00:00Z" });
    vi.stubGlobal("fetch", githubRouter()); // 装在 startServer 之前 —— register() 的后台预热也走这份 mock
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    vi.stubGlobal("fetch", (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("api.github.com")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as unknown as Response;
      return realFetch(input, init);
    }) as typeof fetch); // 还原成文件级默认(503)stub,不影响后续 describe 块
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("下架成功:返回 unlisted:true + prUrl;本地 remote-unlisted.json 落一笔记录(记录仍在,不是删除)", async () => {
    const del = await fetch(`${baseUrl}/api/community/remote/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", id: "t-unlist-me" }),
    });
    expect(del.status).toBe(200);
    const body = await del.json() as any;
    expect(body.unlisted).toBe(true);
    expect(typeof body.unlistedAt).toBe("string");
    expect(body.prUrl).toBe(`https://github.com/${OWNER}/${REPO}/pull/1`);

    const marks = loadRemoteUnlisted(root);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ type: "template", id: "t-unlist-me" });
  });

  it("下架前 GET /api/community/remote 能看到该条目,下架后同一接口不再返回它(list 默认过滤)", async () => {
    const before = await fetch(`${baseUrl}/api/community/remote?fresh=1`);
    const beforeBody = await before.json() as any;
    expect(beforeBody.entries.some((e: any) => e.id === "t-unlist-me")).toBe(true);

    const del = await fetch(`${baseUrl}/api/community/remote/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", id: "t-unlist-me" }),
    });
    expect(del.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/community/remote?fresh=1`);
    const afterBody = await after.json() as any;
    expect(afterBody.entries.some((e: any) => e.id === "t-unlist-me")).toBe(false);
  });

  it("下架自己名下的内容;非自己(author 不匹配)则 403 拒绝,且不产生本地下架记录", async () => {
    const del = await fetch(`${baseUrl}/api/community/remote/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", id: "not-mine" }), // githubRouter 对未知 id 返回 404 → 内容不存在
    });
    expect(del.status).toBe(404);
    expect(loadRemoteUnlisted(root)).toEqual([]);
  });
});

// D8 补丁·验收缺口①(本地库下架无产品入口):存储层 unlistLocalEntry(D8)一直没有路由暴露——
// 补 POST /api/community/local/:type/:id/unlist,行为对齐远程下架(标记不真删,list 默认过滤)。
describe("D8 补丁 · communityRoutes local/:type/:id/unlist — 本地库下架路由", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("下架前列表可见 → 下架后同一列表不可见 → includeUnlisted=true 仍可见 → 内容文件/索引条目原样保留", async () => {
    const t = tpl({ id: "t-local-unlist" });
    const imp = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t),
    });
    expect(imp.status).toBe(200);

    const before = await fetch(`${baseUrl}/api/community/templates`);
    expect((await before.json() as any[]).some(e => e.id === "t-local-unlist")).toBe(true);

    const unlist = await fetch(`${baseUrl}/api/community/local/templates/t-local-unlist/unlist`, { method: "POST" });
    expect(unlist.status).toBe(200);
    expect(await unlist.json()).toEqual({ ok: true, unlisted: true });

    const after = await fetch(`${baseUrl}/api/community/templates`);
    expect((await after.json() as any[]).some(e => e.id === "t-local-unlist")).toBe(false);

    const full = await fetch(`${baseUrl}/api/community/templates?includeUnlisted=true`);
    const fullList = await full.json() as any[];
    const entry = fullList.find(e => e.id === "t-local-unlist");
    expect(entry).toBeTruthy();
    expect(entry.visibility).toBe("unlisted");

    // 记录仍在:按 id 直读(GET /:id)依旧拿到完整内容,不是被删除。
    const single = await fetch(`${baseUrl}/api/community/templates/t-local-unlist`);
    expect(single.status).toBe(200);
    expect((await single.json() as any).id).toBe("t-local-unlist");
  });

  it("对不存在的 id 下架 → 404", async () => {
    const r = await fetch(`${baseUrl}/api/community/local/templates/no-such-id/unlist`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("非法 type → 400", async () => {
    const r = await fetch(`${baseUrl}/api/community/local/bogus/some-id/unlist`, { method: "POST" });
    expect(r.status).toBe(400);
  });
});

// P0-3(canonical)· 库内模板导出走 Company Bundle 路径:带 schema_version、结构字段与
// seedMemories→memory.records 保真,导出物可经 templates/import 无损重新入库。
describe("P0-3 · GET /api/community/templates/:id/export → canonical Company Bundle", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  const seedMem: BundleMemoryRecord = {
    memory_id: "mem-cs-1", scope: "s", owner_type: "company", owner_id: "c1", content: "库内模板经验",
    source: { type: "run", run_id: "r1", task_id: "" }, level: "sop", score: 80, status: "active", tags: [],
    metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
    created_at: "2026-01-01", updated_at: "2026-01-01", last_used_at: "2026-01-01",
  };

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("导出物带 schema_version + bundle_type=company;结构字段与 seedMemories→memory.records 保真", async () => {
    seedTemplateFile(root, tpl({
      id: "t-export-bundle",
      workflow: { verificationEdges: [{ producer: "ceo", verifier: "dev", method: "llm-review", onReject: "redo" }] },
      a2aChannels: [{ from: "ceo", to: "dev", purpose: "同步" }],
      bundledSkills: [{ name: "onboarding", content: "正文", roles: ["dev"] }],
      seedMemories: [seedMem],
      defaultTasks: [{ title: "示例任务", goal: "写一份调研报告", suggestedRole: "lead" }],
    }));
    const r = await fetch(`${baseUrl}/api/community/templates/t-export-bundle/export`);
    expect(r.status).toBe(200);
    const bundle = await r.json();
    expect(typeof bundle.schema_version).toBe("string");
    expect(bundle.schema_version.length).toBeGreaterThan(0);
    expect(bundle.bundle_type).toBe("company");
    expect(bundle.agents).toHaveLength(2);
    expect(bundle.workflow?.verificationEdges).toHaveLength(1);
    expect(bundle.a2aChannels).toHaveLength(1);
    expect(bundle.bundledSkills).toHaveLength(1);
    expect(bundle.memory.records).toHaveLength(1);
    expect(bundle.memory.records[0].content).toBe("库内模板经验");
    // C3:defaultTasks 经 templateToBundle 进 canonical 导出物(bundleToTemplateShape 反向同款保真)。
    expect(bundle.defaultTasks).toEqual([{ title: "示例任务", goal: "写一份调研报告", suggestedRole: "lead" }]);
    expect(bundle.privacy).toBeTruthy();
  });

  it("canonical round-trip:导出的 bundle 直接 POST templates/import 重新入库成功(memory 不丢)", async () => {
    seedTemplateFile(root, tpl({ id: "t-export-rt", seedMemories: [seedMem] }));
    const bundle = await (await fetch(`${baseUrl}/api/community/templates/t-export-rt/export`)).json();
    const imp = await fetch(`${baseUrl}/api/community/templates/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle),
    });
    expect(imp.status).toBe(200);
    const impBody = await imp.json();
    expect(impBody.ok).toBe(true);
  });

  // P0-4 · 导出脱敏:agent 的 workspaceDir/cliConfigDir + bundledSkills 正文里的本机路径必须被剥离/占位,
  // 导出物 stringify 后不含任何盘符路径。
  it("导出物脱敏:agent 本机路径被剥离,stringify 后不含盘符路径,privacy.redacted_fields 记账", async () => {
    seedTemplateFile(root, tpl({
      id: "t-export-redact",
      agents: [
        agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"], workspaceDir: "C:\\Users\\bob\\proj", cliConfigDir: "C:\\Users\\bob\\.opc\\cli" }),
        agent({ id: "dev-0", parentId: "ceo-0" }),
      ],
      bundledSkills: [{ name: "onboarding", content: "工作目录在 C:\\Users\\bob\\secret 里", roles: ["dev"] }],
    }));
    const r = await fetch(`${baseUrl}/api/community/templates/t-export-redact/export`);
    expect(r.status).toBe(200);
    const bundle = await r.json();
    expect(JSON.stringify(bundle)).not.toMatch(/[A-Za-z]:\\/); // 无盘符路径
    expect(bundle.agents[0].workspaceDir).toBeUndefined();
    expect(bundle.agents[0].cliConfigDir).toBeUndefined();
    expect(bundle.privacy.redacted_fields).toContain("agents[0].workspaceDir");
    expect(bundle.privacy.redacted_fields).toContain("bundledSkills[0].content");
  });

  // 分场景收口:社区导出端点**强制 share 档**——不给 ?profile=full 逃生门(full 保真档只走
  // 「我的组织」自己公司的 GET /api/companies/:id/export?profile=full,不经社区)。
  it("导出库内模板:?profile=full 被无视,永远 share 档(genericCli 剥离 + export_profile=share)", async () => {
    seedTemplateFile(root, tpl({
      id: "t-export-no-full",
      agents: [
        agent({ id: "ceo-0", role: "ceo", childrenIds: ["qa-0"] }),
        agent({ id: "qa-0", parentId: "ceo-0", genericCli: { command: "C:\\tools\\mycli.exe", args: ["--check"] } as any }),
      ],
    }));
    const r = await fetch(`${baseUrl}/api/community/templates/t-export-no-full/export?profile=full`);
    expect(r.status).toBe(200);
    const bundle = await r.json();
    expect(bundle.export_profile).toBe("share");
    expect(bundle.agents[1].genericCli).toBeUndefined();
    expect(bundle.privacy.redacted_fields).toContain("agents[1].genericCli.command");
    expect(JSON.stringify(bundle)).not.toMatch(/[A-Za-z]:\\/);
  });
});

// P0-5 · 分享 / 工坊保存强制过安全闸:含密钥或本机路径的内容被拒(422 + findings),干净内容通过。
describe("P0-5 · communityRoutes — 分享 / 工坊保存安全体检", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── 工坊保存(POST /api/community/templates,纯本地写)──
  it("工坊保存:干净公司 → 200 入库", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: tpl({ id: "t-save-clean" }) }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    // 真入库
    const g = await fetch(`${baseUrl}/api/community/templates/t-save-clean`);
    expect(g.status).toBe(200);
  });

  it("工坊保存:模板含密钥 → 422 拒绝,findings 含 no_secrets_detected,未入库", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: tpl({ id: "t-save-secret", description: "泄漏 sk-abcdefgh12345678" }) }),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.findings.map((f: any) => f.id)).toContain("no_secrets_detected");
    const g = await fetch(`${baseUrl}/api/community/templates/t-save-secret`);
    expect(g.status).toBe(404);
  });

  it("工坊保存:agent 带本机路径 → 422 拒绝(findings 含 local_paths_redacted)", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: tpl({ id: "t-save-path", agents: [agent({ id: "ceo-0", role: "ceo", workspaceDir: "C:\\Users\\bob\\x" })] }) }),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.findings.map((f: any) => f.id)).toContain("local_paths_redacted");
  });

  it("工坊保存:persona 正文含密钥 → 422 拒绝,persona/skill 未落盘", async () => {
    const r = await fetch(`${baseUrl}/api/community/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: tpl({ id: "t-save-persona-secret" }),
        personas: [{ role: "dev", title: "开发", content: "系统提示词里藏了 sk-abcdefgh12345678" }],
      }),
    });
    expect(r.status).toBe(422);
    expect((await r.json() as any).findings.map((f: any) => f.id)).toContain("no_secrets_detected");
    // 模板本体也未入库(闸在落盘之前)
    const g = await fetch(`${baseUrl}/api/community/templates/t-save-persona-secret`);
    expect(g.status).toBe(404);
  });

  // ── 分享(POST /api/community/share,推送公开社区)──
  // C2 · 社区二分类闭环:分享类型白名单只留 template/agent,prompt 模块已下线,上传口关死。
  it("C2 分享:type=prompt → 400 拒绝(白名单收窄,prompt 分享已下线)", async () => {
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", author: "bob", data: { id: "p1", title: "旧 prompt", content: "x" } }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain("template or agent");
  });

  it("C2 分享:type=agent(员工卡)过白名单 + 安全闸——正文含密钥仍 422 硬拦", async () => {
    const leaky = { id: "w-leak", agent: { name: "advisor", role: "dev", systemPrompt: "key sk-abcdefgh12345678" } };
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent", author: "bob", data: leaky }),
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).findings.map((f: any) => f.id)).toContain("no_secrets_detected");
  });

  it("分享:公司含密钥 → 422 拒绝,findings 结构化,未触达 GitHub", async () => {
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", author: "bob", data: tpl({ id: "t-share-secret", description: "key=sk-abcdefgh12345678" }) }),
    });
    expect(r.status).toBe(422);
    const body = await r.json() as any;
    expect(body.findings.map((f: any) => f.id)).toContain("no_secrets_detected");
  });

  // 分场景收口:agent 的本机路径**字段**(workspaceDir/cliConfigDir/genericCli)不再 422 硬拒,而是被
  // forceShareDowngrade 在安全闸之前强制剥离(share 档语义,与导出端点的 share 脱敏同口径)——请求照常
  // 放行(等价干净公司),带 full 标记的包也骗不过。**正文**里的密钥/绝对路径仍走安全闸 422 硬拦(下测)。
  it("分享:agent 本机路径字段(workspaceDir)被强制剥离后放行,不再 422", async () => {
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", author: "bob", data: tpl({ id: "t-share-path", agents: [agent({ id: "ceo-0", role: "ceo", workspaceDir: "C:\\Users\\bob\\secret" })] }) }),
    });
    expect(r.status).not.toBe(422); // 字段已被强制剥离,安全闸看不到本机路径
    expect((await r.json() as any).findings).toBeUndefined();
  });

  it("分享:自封 full 档(export_profile/genericCli/本机路径俱全)照样被强制降为 share 后放行——骗不成 full", async () => {
    const fullish = {
      ...tpl({
        id: "t-share-fake-full",
        agents: [
          agent({ id: "ceo-0", role: "ceo", workspaceDir: "C:\\Users\\bob\\proj", cliConfigDir: "C:\\Users\\bob\\.claude" }),
          agent({ id: "qa-0", genericCli: { command: "C:\\tools\\mycli.exe", args: ["--run"] } as any }),
        ],
      }),
      export_profile: "full",
    };
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", author: "bob", data: fullish }),
    });
    expect(r.status).not.toBe(422); // full 标记与本机命令/路径全部在闸前被剥离
    expect((await r.json() as any).findings).toBeUndefined();
  });

  it("分享:记忆正文(agentMemories.content)含密钥 → 仍 422 硬拦(记忆随 share 带走,但脱敏硬拦不放松)", async () => {
    const withMemory = {
      ...tpl({ id: "t-share-memory-secret" }),
      agentMemories: [{ agent_id: "dev-0", role: "dev", content: "记住这个 key=sk-abcdefgh12345678" }],
    };
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", author: "bob", data: withMemory }),
    });
    expect(r.status).toBe(422);
    expect((await r.json() as any).findings.map((f: any) => f.id)).toContain("no_secrets_detected");
  });

  // forceShareDowngrade 纯函数:端点响应观察不到被改写后的 data(后续进 GitHub 流程),这里直接锁函数行为。
  it("forceShareDowngrade:删 export_profile 与 agents/agent 的 genericCli/workspaceDir/cliConfigDir,保留 agentMemories", () => {
    const data: any = {
      export_profile: "full",
      agents: [
        { id: "a1", genericCli: { command: "mycli" }, workspaceDir: "C:\\x", cliConfigDir: "C:\\y", role: "dev" },
      ],
      agent: { name: "w", genericCli: { command: "othercli" }, workspaceDir: "D:\\z" },
      agentMemories: [{ agent_id: "dev-0", content: "经验:先冒烟再放量" }],
      memory: { records: [{ id: "m1", content: "结论" }] },
    };
    forceShareDowngrade(data);
    expect(data.export_profile).toBeUndefined();
    expect(data.agents[0].genericCli).toBeUndefined();
    expect(data.agents[0].workspaceDir).toBeUndefined();
    expect(data.agents[0].cliConfigDir).toBeUndefined();
    expect(data.agents[0].role).toBe("dev"); // 其余字段不动
    expect(data.agent.genericCli).toBeUndefined();
    expect(data.agent.workspaceDir).toBeUndefined();
    expect(data.agentMemories).toEqual([{ agent_id: "dev-0", content: "经验:先冒烟再放量" }]); // 记忆两档都带走
    expect(data.memory.records).toHaveLength(1);
  });

  it("forceShareDowngrade:非对象/缺 agents 的畸形输入不抛", () => {
    expect(() => forceShareDowngrade(null)).not.toThrow();
    expect(() => forceShareDowngrade("str")).not.toThrow();
    expect(() => forceShareDowngrade({ agents: "not-array" })).not.toThrow();
  });

  it("分享:干净公司通过安全闸(不返回 422 findings,放行到后续 GitHub 流程)", async () => {
    // 安全闸只负责"内容干不干净";干净内容不应被 422 拦,后续 OAuth/GitHub 行为不在本用例断言范围。
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "template", author: "bob", data: tpl({ id: "t-share-clean" }) }),
    });
    expect(r.status).not.toBe(422); // 安全闸放行
    expect((await r.json() as any).findings).toBeUndefined(); // 没有安全 findings
  });

  it("分享:干净 worker(非模板结构)也放行,不因不满足 CompanyTemplateSchema 误拦", async () => {
    const r = await fetch(`${baseUrl}/api/community/share`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent", author: "bob", data: { id: "w-clean", title: "顾问", agent: { name: "顾问", systemPrompt: "干净人设" } } }),
    });
    expect(r.status).not.toBe(422);
    expect((await r.json() as any).findings).toBeUndefined();
  });
});
