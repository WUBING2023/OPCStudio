import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";
import { templateToBundle, bundleToTemplateShape } from "@opc/shared";
import { runTemplateDoctor, orgHasCycle, scanContentSafety, runShareSafetyGate, redactShareContent } from "./templateDoctor.js";
import { signTemplate } from "./templateTrust.js";

// provider 故意用非预置名(prov-x):collectApiKeys 只对预置 provider 探 env/keys 文件,
// prov-x 的"已配置"完全由测试自己写的 tmp config.json 决定,不受本机环境变量干扰。
function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "ceo-0", name: "CEO", role: "ceo", childrenIds: [], model: "m", provider: "prov-x",
    framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}

function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-doctor", title: "体检模板", description: "d", author: "alice",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [agent()],
    ...over,
  };
}

function checkOf(report: ReturnType<typeof runTemplateDoctor>, id: string) {
  return report.checks.find(c => c.id === id);
}

describe("D1 · runTemplateDoctor — 五类输入的 checks 输出", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-doctor-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("合法模板(已签名 + provider 已配 + 无危险权限 + 无环)→ 全 pass,install_allowed", () => {
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { "prov-x": "test-key" } }));
    const report = runTemplateDoctor(signTemplate(tpl()), { projectRoot: root });
    expect(report.status).toBe("pass");
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.install_allowed).toBe(true);
    expect(report.checks.map(c => c.id)).toEqual([
      "schema_valid", "hash_valid", "danger_permissions", "missing_required_capabilities", "no_cycle_in_org",
      "no_secrets_detected", "local_paths_redacted", "template_size_warning",
    ]);
    expect(report.checks.every(c => c.status === "pass")).toBe(true);
  });

  it("坏 schema → 只回 schema_valid 一条 error,拒绝安装(不对垃圾数据硬跑其余检查)", () => {
    const report = runTemplateDoctor({ id: "x", title: "残缺" }, { projectRoot: root });
    expect(report.status).toBe("error");
    expect(report.install_allowed).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: "schema_valid", status: "error", severity: "error" });
    expect(report.checks[0].message).toContain("manifest 校验失败");
  });

  it("带危险权限(allowShell)→ danger_permissions warning 且点名 shell-access,不阻断", () => {
    const t = tpl({ recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } } });
    const report = runTemplateDoctor(signTemplate(t), { projectRoot: root });
    const danger = checkOf(report, "danger_permissions")!;
    expect(danger.status).toBe("warning");
    expect(danger.message).toContain("shell-access");
    expect(danger.message).toContain("file-write");
    expect(report.install_allowed).toBe(true); // 危险权限交 UI 确认 + Safe Install 剥离,不在 doctor 拒装
    expect(report.status).toBe("warning");
  });

  it("缺能力(provider 未配 key)→ missing_required_capabilities warning,不阻断", () => {
    const report = runTemplateDoctor(signTemplate(tpl()), { projectRoot: root }); // root 无 config
    const cap = checkOf(report, "missing_required_capabilities")!;
    expect(cap.status).toBe("warning");
    expect(cap.message).toContain("prov-x");
    expect(report.install_allowed).toBe(true);
  });

  it("组织成环(parentId 互指)→ no_cycle_in_org error,拒绝安装", () => {
    const t = tpl({
      agents: [
        agent({ id: "a", role: "ceo", parentId: "b", childrenIds: [] }),
        agent({ id: "b", role: "lead", parentId: "a", childrenIds: [] }),
      ],
    });
    const report = runTemplateDoctor(signTemplate(t), { projectRoot: root });
    expect(checkOf(report, "no_cycle_in_org")).toMatchObject({ status: "error", severity: "error" });
    expect(report.status).toBe("error");
    expect(report.install_allowed).toBe(false);
  });

  it("hash 篡改 → hash_valid error 拒装;未签名 → hash_valid warning 不阻断", () => {
    const tampered = { ...signTemplate(tpl()), title: "签名后改标题" };
    const r1 = runTemplateDoctor(tampered, { projectRoot: root });
    expect(checkOf(r1, "hash_valid")).toMatchObject({ status: "error" });
    expect(r1.install_allowed).toBe(false);

    const r2 = runTemplateDoctor(tpl(), { projectRoot: root }); // 无 hash
    expect(checkOf(r2, "hash_valid")).toMatchObject({ status: "warning" });
    expect(r2.install_allowed).toBe(true);
  });

  it("不传 projectRoot → 能力检查如实标注跳过(pass/info),其余检查照常", () => {
    const report = runTemplateDoctor(signTemplate(tpl()));
    const cap = checkOf(report, "missing_required_capabilities")!;
    expect(cap.status).toBe("pass");
    expect(cap.message).toContain("跳过");
    expect(report.checks).toHaveLength(8);
  });
});

describe("D2 · runTemplateDoctor — 三项内容级检查(密钥/本机路径/体积)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-doctor-d2-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("no_secrets_detected:含疑似 API Key(sk-...) → error,拒绝导入", () => {
    const t = tpl({ description: "调试用:sk-abcdefghij1234567890 请勿分享" });
    const report = runTemplateDoctor(t, { projectRoot: root });
    expect(checkOf(report, "no_secrets_detected")).toMatchObject({ status: "error", severity: "error" });
    expect(report.status).toBe("error");
    expect(report.install_allowed).toBe(false);
  });

  it("no_secrets_detected:含 Bearer token → error", () => {
    const t = tpl({ readme: "Authorization: Bearer abcd1234efgh5678zzzz" });
    const report = runTemplateDoctor(t, { projectRoot: root });
    expect(checkOf(report, "no_secrets_detected")).toMatchObject({ status: "error" });
    expect(report.install_allowed).toBe(false);
  });

  it("no_secrets_detected:privacy.required_secrets 这类只声明*名字*的字段(如 ANTHROPIC_API_KEY)不算命中(无实际密钥值)", () => {
    const t = tpl() as any;
    t.requiredPermissions = { mcpServers: [] };
    (t as any).required_secrets = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]; // 只是名字数组,非真实密钥值
    const report = runTemplateDoctor(t, { projectRoot: root });
    expect(checkOf(report, "no_secrets_detected")).toMatchObject({ status: "pass" });
  });

  it("local_paths_redacted:agent.workspaceDir 带 Windows 本机绝对路径 → warning,不阻断安装", () => {
    const t = tpl({ agents: [agent({ workspaceDir: "C:\\Users\\Wubin\\secret-project" })] });
    const report = runTemplateDoctor(signTemplate(t), { projectRoot: root });
    const check = checkOf(report, "local_paths_redacted")!;
    expect(check.status).toBe("warning");
    expect(check.message).toContain("Users");
    expect(report.install_allowed).toBe(true);
  });

  it("local_paths_redacted:无本机路径 → pass", () => {
    const report = runTemplateDoctor(signTemplate(tpl()), { projectRoot: root });
    expect(checkOf(report, "local_paths_redacted")).toMatchObject({ status: "pass" });
  });

  it("template_size_warning:序列化 >2MB → warning,不阻断安装", () => {
    const t = tpl({ readme: "x".repeat(3 * 1024 * 1024) });
    const report = runTemplateDoctor(t, { projectRoot: root });
    const check = checkOf(report, "template_size_warning")!;
    expect(check.status).toBe("warning");
    expect(report.install_allowed).toBe(true);
  });

  it("template_size_warning:序列化 >10MB → error,拒绝导入", () => {
    const t = tpl({ readme: "x".repeat(11 * 1024 * 1024) });
    const report = runTemplateDoctor(t, { projectRoot: root });
    const check = checkOf(report, "template_size_warning")!;
    expect(check.status).toBe("error");
    expect(report.status).toBe("error");
    expect(report.install_allowed).toBe(false);
  });

  it("体积在 2MB 以内 → pass", () => {
    const report = runTemplateDoctor(signTemplate(tpl()), { projectRoot: root });
    expect(checkOf(report, "template_size_warning")).toMatchObject({ status: "pass" });
  });
});

describe("P0-5 · 密钥形态扩展(ghp_/AKIA)+ 内容级扫描 scanContentSafety", () => {
  it("no_secrets_detected 命中 GitHub PAT(ghp_)", () => {
    const t = tpl({ description: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
    expect(checkOf(runTemplateDoctor(t), "no_secrets_detected")).toMatchObject({ status: "error" });
  });
  it("no_secrets_detected 命中 AWS access key(AKIA)", () => {
    const t = tpl({ readme: "AKIAIOSFODNN7EXAMPLE" });
    expect(checkOf(runTemplateDoctor(t), "no_secrets_detected")).toMatchObject({ status: "error" });
  });

  it("scanContentSafety:命中密钥 → 返回 no_secrets_detected(error)", () => {
    const f = scanContentSafety({ persona: "我的 key 是 sk-abcdefgh12345678" });
    expect(f.map((x) => x.id)).toContain("no_secrets_detected");
    expect(f.every((x) => x.severity === "error")).toBe(true);
  });
  it("scanContentSafety:命中本机绝对路径 → local_paths_redacted(error)", () => {
    const f = scanContentSafety({ note: "在 C:\\Users\\bob\\proj 里" });
    expect(f.map((x) => x.id)).toContain("local_paths_redacted");
  });
  it("scanContentSafety:干净内容 → 无 findings", () => {
    expect(scanContentSafety({ note: "普通描述,没有密钥也没有路径" })).toEqual([]);
  });
});

describe("P0-5 · runShareSafetyGate — 分享/工坊保存安全闸", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "share-gate-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { "prov-x": "test-key" } }));
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("干净公司(无密钥/无本机路径)→ ok,findings 空", () => {
    const r = runShareSafetyGate(tpl(), { projectRoot: root });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("含密钥的公司 → 拒绝(ok=false),findings 含 no_secrets_detected", () => {
    const r = runShareSafetyGate(tpl({ description: "泄漏 sk-abcdefgh12345678" }), { projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("no_secrets_detected");
  });

  it("含本机绝对路径(agent.workspaceDir)的公司 → 拒绝(分享比导入更严,path 从 warning 升为硬拦)", () => {
    const r = runShareSafetyGate(tpl({ agents: [agent({ workspaceDir: "C:\\Users\\bob\\secret" })] }), { projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("local_paths_redacted");
  });

  it("危险权限(allowShell)但内容干净 → 仍 ok(安装侧 Safe Install 兜底,不在分享闸拦)", () => {
    const r = runShareSafetyGate(tpl({ recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } } }), { projectRoot: root });
    expect(r.ok).toBe(true);
  });

  it("组织成环的模板 → 拒绝(结构级 error 叠加)", () => {
    const cyclic = tpl({ agents: [agent({ id: "a", role: "ceo", parentId: "b" }), agent({ id: "b", parentId: "a" })] });
    const r = runShareSafetyGate(cyclic, { projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("no_cycle_in_org");
  });

  it("非模板内容(worker/prompt,不满足 CompanyTemplateSchema)也做内容级扫描,不因结构不符误拦干净内容", () => {
    const cleanWorker = { id: "w1", agent: { name: "advisor", systemPrompt: "普通人设,无密钥无路径" } };
    expect(runShareSafetyGate(cleanWorker, { projectRoot: root }).ok).toBe(true);
    const leakyWorker = { id: "w2", agent: { name: "advisor", systemPrompt: "key sk-abcdefgh12345678" } };
    expect(runShareSafetyGate(leakyWorker, { projectRoot: root }).ok).toBe(false);
  });

  it("extraContent(工坊 persona 数组)里的密钥也被扫到 → 拒绝", () => {
    const r = runShareSafetyGate(tpl(), { projectRoot: root, extraContent: [{ role: "dev", content: "藏在 persona 里的 sk-abcdefgh12345678" }] });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.id)).toContain("no_secrets_detected");
  });
});

describe("D1 · orgHasCycle — 服务端汇报链成环检测", () => {
  const n = (id: string, parentId?: string) => ({ id, parentId });

  it("无环链 / 空数组 → false", () => {
    expect(orgHasCycle([n("ceo"), n("lead", "ceo"), n("w1", "lead")])).toBe(false);
    expect(orgHasCycle([])).toBe(false);
  });

  it("自指 / 两节点互指 / 长链回环 → true", () => {
    expect(orgHasCycle([n("a", "a")])).toBe(true);
    expect(orgHasCycle([n("a", "b"), n("b", "a")])).toBe(true);
    expect(orgHasCycle([n("a", "c"), n("b", "a"), n("c", "b")])).toBe(true);
  });

  it("parentId 悬空(引用不存在的节点)不算环", () => {
    expect(orgHasCycle([n("a", "ghost"), n("b", "a")])).toBe(false);
  });
});

// ── C2 · org_projection_consistent(bundle org 投影与 agents 派生交叉核对,warning 级)──
describe("C2 · runTemplateDoctor — org_projection_consistent", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-doctor-org-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const richTpl = () => tpl({
    agents: [
      agent({ id: "ceo-0", role: "ceo", childrenIds: ["dev-0"] }),
      agent({ id: "dev-0", role: "dev", parentId: "ceo-0" }),
    ],
    a2aChannels: [{ from: "ceo", to: "dev", purpose: "同步" }],
    workflow: { verificationEdges: [{ producer: "ceo-0", verifier: "dev-0", method: "llm-review", onReject: "redo" }] },
  });

  it("templateToBundle 真填的投影(自家导出物)→ pass;不传 bundle / bundle 无 teams·edges → 不出该检查项", () => {
    const bundle = templateToBundle(richTpl());
    const candidate = bundleToTemplateShape(bundle);
    const withBundle = runTemplateDoctor(candidate, { projectRoot: root, bundle });
    expect(checkOf(withBundle, "org_projection_consistent")).toMatchObject({ status: "pass" });

    const withoutBundle = runTemplateDoctor(candidate, { projectRoot: root });
    expect(checkOf(withoutBundle, "org_projection_consistent")).toBeUndefined();

    const v0Bundle = { ...bundle, org: { agents: bundle.agents } }; // V0 形状:org 只有 agents,无声明即无谎可查
    expect(checkOf(runTemplateDoctor(candidate, { projectRoot: root, bundle: v0Bundle }), "org_projection_consistent")).toBeUndefined();
  });

  it("手改 bundle 的 org 说谎(边被删/队被造)→ warning 点破,但不拦装(install_allowed 不受影响)", () => {
    const bundle = templateToBundle(richTpl());
    const candidate = bundleToTemplateShape(bundle);
    const lying = {
      ...bundle,
      org: {
        agents: bundle.agents,
        teams: [{ team_id: "team-fake", lead_agent_id: "dev-0", member_agent_ids: ["ceo-0"] }], // 无中生有的队
        edges: [], // 删光真实的边
      },
    };
    const report = runTemplateDoctor(candidate, { projectRoot: root, bundle: lying });
    const check = checkOf(report, "org_projection_consistent");
    expect(check).toMatchObject({ status: "warning", severity: "warning" });
    expect(check!.message).toContain("不一致");
    expect(report.install_allowed).toBe(true); // warning 不拦装
  });

  it("语义等价不算说谎:team_id/name 不同但 lead+成员一致、edges 乱序、purpose 被脱敏改写 → pass", () => {
    const leadTpl = tpl({
      agents: [
        agent({ id: "ceo-0", role: "ceo", childrenIds: ["lead-1"] }),
        agent({ id: "lead-1", role: "lead", parentId: "ceo-0", childrenIds: ["dev-2"] }),
        agent({ id: "dev-2", role: "dev", parentId: "lead-1" }),
      ],
      a2aChannels: [{ from: "lead", to: "dev", purpose: "对齐" }],
    });
    const bundle = templateToBundle(leadTpl);
    const renamed = {
      ...bundle,
      org: {
        agents: bundle.agents,
        teams: [{ team_id: "another-naming-convention", name: "别名", lead_agent_id: "lead-1", member_agent_ids: ["dev-2"] }],
        edges: [...bundle.org!.edges!].reverse().map((e) => (e.type === "a2a" ? { ...e, purpose: "[REDACTED_PATH]" } : e)),
      },
    };
    const report = runTemplateDoctor(bundleToTemplateShape(bundle), { projectRoot: root, bundle: renamed });
    expect(checkOf(report, "org_projection_consistent")).toMatchObject({ status: "pass" });
  });
});

// ── C2 · redactShareContent(员工卡等轻量外发面的深度脱敏)────────────────────────────
describe("C2 · redactShareContent — 密钥/本机路径占位化", () => {
  it("嵌套字段里的密钥与 Windows/Unix 绝对路径被占位化,redactedFields 记路径", () => {
    const card = {
      id: "local-agent-a1",
      agent: {
        systemPrompt: "用 key sk-abcdefgh12345678 调 API,产物放 C:\\Users\\wubin\\out",
        tools: [{ name: "读 /home/wubin/notes.md", enabled: true }],
      },
    };
    const { value, redactedFields } = redactShareContent(card);
    const s = JSON.stringify(value);
    expect(s).not.toContain("sk-abcdefgh12345678");
    expect(s).not.toContain("wubin");
    expect(value.agent.systemPrompt).toContain("[REDACTED_SECRET]");
    expect(value.agent.systemPrompt).toContain("[REDACTED_PATH]");
    expect(value.agent.tools[0].name).toContain("[REDACTED_PATH]");
    expect(redactedFields).toContain("agent.systemPrompt");
    expect(redactedFields).toContain("agent.tools[0].name");
    // 脱敏后的产物过安全闸零发现(与 /api/community/share 的闸门形态同源)。
    expect(scanContentSafety(value)).toEqual([]);
  });

  it("同字段多个命中全部占位(全局替换,不是只替换第一个)", () => {
    const { value } = redactShareContent({ p: "a sk-abcdefgh12345678 b sk-zyxwvuts87654321 c" });
    expect(value.p).not.toContain("sk-");
    expect(value.p.match(/\[REDACTED_SECRET\]/g)).toHaveLength(2);
  });

  it("干净内容原样返回(同一引用,幂等;重复调用零改写)", () => {
    const clean = { id: "w", agent: { systemPrompt: "普通人设,无密钥无路径", tools: [] } };
    const once = redactShareContent(clean);
    expect(once.value).toBe(clean); // 未命中 → 原引用
    expect(once.redactedFields).toEqual([]);
    const dirty = { p: "sk-abcdefgh12345678 与 /home/x/y" };
    const first = redactShareContent(dirty).value;
    const second = redactShareContent(first);
    expect(second.value).toBe(first); // 已占位化的内容再扫是空操作
    expect(second.redactedFields).toEqual([]);
  });

  it("非字符串叶子(数字/布尔/null)原样保留,不抛", () => {
    const { value } = redactShareContent({ n: 42, b: true, x: null, arr: [1, "sk-abcdefgh12345678"] });
    expect(value.n).toBe(42);
    expect(value.b).toBe(true);
    expect(value.x).toBeNull();
    expect(value.arr[1]).toBe("[REDACTED_SECRET]");
  });
});
