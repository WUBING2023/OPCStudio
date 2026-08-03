import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "@opc/shared";
import {
  descriptorHash,
  serverProvenance,
  defaultPermission,
  loadPins,
  savePins,
  loadPolicy,
  evaluateServer,
  evaluateGovernance,
  governMcpServers,
  governMcpServersAsync,
  signDescriptor,
  verifyDescriptorSignature,
  signatureStatusFor,
  loadSigningKey,
  loadSignatures,
  saveSignatures,
  buildSignatureManifest,
  loadRegistry,
  matchRegistry,
  probeServerHealth,
  probeHealth,
  getMcpCapabilityVersions,
  type McpGovernancePolicy,
} from "./mcpGovernance.js";

function srv(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "filesystem-mcp",
    name: "Filesystem",
    description: "受限目录内的文件读写",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: {},
    enabled: true,
    assignedAgents: [],
    createdAt: "2026-06-21T00:00:00Z",
    ...over,
  };
}

function policy(over: Partial<McpGovernancePolicy> = {}): McpGovernancePolicy {
  return { allowlist: [], managedOnly: false, onViolation: "mark-and-allow", pins: {}, ...over };
}

describe("descriptorHash 稳定签名", () => {
  it("字段顺序无关、纯函数稳定", () => {
    const a = descriptorHash(srv());
    const b = descriptorHash(srv());
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("运行期元数据（id 之外的 createdAt/enabled/assignedAgents）不影响指纹", () => {
    const base = descriptorHash(srv());
    const same = descriptorHash(srv({ createdAt: "2099-01-01T00:00:00Z", enabled: false, assignedAgents: ["x"] }));
    expect(same).toBe(base);
  });

  it("命令/参数/描述变化会改变指纹（捕获供应链替换与 tool-poisoning）", () => {
    const base = descriptorHash(srv());
    expect(descriptorHash(srv({ args: ["-y", "evil-pkg"] }))).not.toBe(base);
    expect(descriptorHash(srv({ command: "uvx" }))).not.toBe(base);
    expect(descriptorHash(srv({ description: "悄悄改了描述" }))).not.toBe(base);
  });
});

describe("serverProvenance 来源记录", () => {
  it("npx → npm 并解析包名", () => {
    const p = serverProvenance(srv());
    expect(p.source).toBe("npm");
    expect(p.packageName).toBe("@modelcontextprotocol/server-filesystem");
    expect(p.origin).toContain("npx");
  });
  it("uvx → pypi", () => {
    const p = serverProvenance(srv({ command: "uvx", args: ["mcp-server-fetch"] }));
    expect(p.source).toBe("pypi");
    expect(p.packageName).toBe("mcp-server-fetch");
  });
  it("http/url → remote", () => {
    const p = serverProvenance(srv({ transport: "http", command: undefined, args: undefined, url: "https://x.example/mcp" }));
    expect(p.source).toBe("remote");
    expect(p.origin).toBe("https://x.example/mcp");
  });
});

describe("defaultPermission 最小权限默认", () => {
  it("不可信 server 一律 needs-confirmation", () => {
    expect(defaultPermission(srv(), "untrusted")).toBe("needs-confirmation");
  });
  it("可信但含写入关键词 → restricted", () => {
    expect(defaultPermission(srv(), "trusted")).toBe("restricted"); // filesystem
  });
  it("可信只读型 → read-only", () => {
    const s = srv({ id: "ddg", name: "Search", description: "网页搜索", args: ["duckduckgo-mcp-server"] });
    expect(defaultPermission(s, "trusted")).toBe("read-only");
  });
});

describe("evaluateServer 白名单 / 钉住裁决", () => {
  it("未在白名单 → untrusted，但默认 mark-and-allow 放行", () => {
    const f = evaluateServer(srv(), policy());
    expect(f.trust).toBe("untrusted");
    expect(f.allowlisted).toBe(false);
    expect(f.decision).toBe("mark-and-allow");
    expect(f.reasons.some((r) => r.includes("allowlist"))).toBe(true);
  });

  it("白名单命中 + 无钉住 → baseline + allow", () => {
    const f = evaluateServer(srv(), policy({ allowlist: ["filesystem-mcp"] }));
    expect(f.trust).toBe("trusted");
    expect(f.pinStatus).toBe("baseline");
    expect(f.decision).toBe("allow");
  });

  it("白名单 + 钉住一致 → pinned-ok + allow", () => {
    const s = srv();
    const f = evaluateServer(
      s,
      policy({ allowlist: [s.id], pins: { [s.id]: { hash: descriptorHash(s), pinnedAt: "t" } } }),
    );
    expect(f.pinStatus).toBe("pinned-ok");
    expect(f.decision).toBe("allow");
  });

  it("钉住哈希不一致 → drift，默认标记放行", () => {
    const s = srv();
    const f = evaluateServer(
      s,
      policy({ allowlist: [s.id], pins: { [s.id]: { hash: "sha256:old", pinnedAt: "t" } } }),
    );
    expect(f.pinStatus).toBe("drift");
    expect(f.decision).toBe("mark-and-allow");
    expect(f.reasons.some((r) => r.includes("drift"))).toBe(true);
  });

  it("onViolation=deny → drift 被拒绝", () => {
    const s = srv();
    const f = evaluateServer(
      s,
      policy({ allowlist: [s.id], onViolation: "deny", pins: { [s.id]: { hash: "sha256:old", pinnedAt: "t" } } }),
    );
    expect(f.decision).toBe("deny");
  });

  it("managedOnly + 未授权 → deny", () => {
    const f = evaluateServer(srv(), policy({ managedOnly: true }));
    expect(f.decision).toBe("deny");
    expect(f.reasons.some((r) => r.includes("managed-only"))).toBe(true);
  });
});

describe("绝不抛异常（保守降级）", () => {
  it("畸形 server 对象也返回 finding 而非抛错", () => {
    const broken = { id: "x" } as unknown as McpServerConfig;
    expect(() => evaluateServer(broken, policy())).not.toThrow();
    const rep = evaluateGovernance([broken, null as any], policy());
    expect(rep.findings.length).toBe(2);
  });
});

describe("evaluateGovernance 批量 + 基线收集", () => {
  it("收集所有缺失钉住为 newBaselines，并正确汇总 deniedIds", () => {
    const a = srv({ id: "a" });
    const b = srv({ id: "b" });
    const rep = evaluateGovernance([a, b], policy({ allowlist: ["a"], managedOnly: true }));
    expect(Object.keys(rep.newBaselines)).toContain("a"); // a 授权 → baseline
    expect(rep.deniedIds).toContain("b"); // b 未授权 + managedOnly
    expect(rep.flagged).toBe(true);
  });
});

describe("磁盘加载 / 回写（绝不抛）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgov-"));
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("缺失文件时 loadPins/loadPolicy 返回安全默认值", () => {
    expect(loadPins(dir)).toEqual({});
    const pol = loadPolicy(dir);
    expect(pol.allowlist).toEqual([]);
    expect(pol.managedOnly).toBe(false);
    expect(pol.onViolation).toBe("mark-and-allow");
  });

  it("损坏的 allowlist JSON 不会抛，降级为空", () => {
    fs.writeFileSync(path.join(dir, ".opc", "mcp_allowlist.json"), "{ not json");
    expect(() => loadPolicy(dir)).not.toThrow();
    expect(loadPolicy(dir).allowlist).toEqual([]);
  });

  it("allowlist 支持 {servers, managedOnly} 形态", () => {
    fs.writeFileSync(
      path.join(dir, ".opc", "mcp_allowlist.json"),
      JSON.stringify({ servers: ["filesystem-mcp"], managedOnly: true }),
    );
    const pol = loadPolicy(dir);
    expect(pol.allowlist).toContain("filesystem-mcp");
    expect(pol.managedOnly).toBe(true);
  });

  it("savePins 后 loadPins 可读回", () => {
    const s = srv();
    expect(savePins(dir, { [s.id]: { hash: descriptorHash(s), pinnedAt: "t" } })).toBe(true);
    expect(loadPins(dir)[s.id].hash).toBe(descriptorHash(s));
  });

  it("governMcpServers recordBaseline 会把缺失钉住写盘，二次运行变为 pinned-ok", () => {
    fs.writeFileSync(
      path.join(dir, ".opc", "mcp_allowlist.json"),
      JSON.stringify(["filesystem-mcp"]),
    );
    const s = srv();
    const r1 = governMcpServers(dir, [s], undefined, { recordBaseline: true });
    expect(r1.findings[0].pinStatus).toBe("baseline");
    expect(fs.existsSync(path.join(dir, ".opc", "mcp_pins.json"))).toBe(true);

    const r2 = governMcpServers(dir, [s], undefined, { recordBaseline: true });
    expect(r2.findings[0].pinStatus).toBe("pinned-ok");
    expect(r2.findings[0].decision).toBe("allow");
  });

  it("基线钉住后若描述符被替换 → 二次运行 drift", () => {
    fs.writeFileSync(path.join(dir, ".opc", "mcp_allowlist.json"), JSON.stringify(["filesystem-mcp"]));
    const s = srv();
    governMcpServers(dir, [s], undefined, { recordBaseline: true });
    const tampered = srv({ args: ["-y", "evil-pkg"] });
    const r = governMcpServers(dir, [tampered], undefined, { recordBaseline: false });
    expect(r.findings[0].pinStatus).toBe("drift");
  });
});

// ── ② descriptor 签名真校验（HMAC-SHA256） ──────────────────────────────────

describe("descriptor 签名（HMAC-SHA256）", () => {
  const KEY = "test-secret-key";

  it("签名稳定、字段顺序无关、与篡改可区分", () => {
    const s = srv();
    const sig = signDescriptor(s, KEY);
    expect(sig.startsWith("hmac-sha256:")).toBe(true);
    expect(signDescriptor(srv({ createdAt: "2099-01-01T00:00:00Z" }), KEY)).toBe(sig);
    expect(signDescriptor(srv({ args: ["-y", "evil-pkg"] }), KEY)).not.toBe(sig);
  });

  it("verifyDescriptorSignature 正确接受/拒绝", () => {
    const s = srv();
    const sig = signDescriptor(s, KEY);
    expect(verifyDescriptorSignature(s, sig, KEY)).toBe(true);
    expect(verifyDescriptorSignature(s, sig, "wrong-key")).toBe(false);
    expect(verifyDescriptorSignature(srv({ args: ["evil"] }), sig, KEY)).toBe(false);
    expect(verifyDescriptorSignature(s, undefined, KEY)).toBe(false);
    expect(verifyDescriptorSignature(s, sig, undefined)).toBe(false);
  });

  it("无密钥 → no-key（降级为仅 hash，不视为违规）", () => {
    const s = srv();
    expect(signatureStatusFor(s, policy({ allowlist: [s.id] }))).toBe("no-key");
    const f = evaluateServer(s, policy({ allowlist: [s.id] }));
    expect(f.signatureStatus).toBe("no-key");
    expect(f.decision).toBe("allow");
  });

  it("有密钥但无签名记录 → unsigned，不阻断", () => {
    const s = srv();
    const st = signatureStatusFor(s, policy({ allowlist: [s.id], signingKey: KEY }));
    expect(st).toBe("unsigned");
    const f = evaluateServer(s, policy({ allowlist: [s.id], signingKey: KEY }));
    expect(f.decision).toBe("allow");
  });

  it("签名匹配 → signed-ok + allow", () => {
    const s = srv();
    const pol = policy({ allowlist: [s.id], signingKey: KEY, signatures: { [s.id]: signDescriptor(s, KEY) } });
    const f = evaluateServer(s, pol);
    expect(f.signatureStatus).toBe("signed-ok");
    expect(f.decision).toBe("allow");
  });

  it("签名不符 → sig-mismatch，默认标记 / onViolation=deny 拒绝", () => {
    const s = srv();
    const badSig = signDescriptor(srv({ args: ["evil"] }), KEY);
    const base = policy({ allowlist: [s.id], signingKey: KEY, signatures: { [s.id]: badSig } });
    const f = evaluateServer(s, base);
    expect(f.signatureStatus).toBe("sig-mismatch");
    expect(f.decision).toBe("mark-and-allow");
    expect(f.reasons.some((r) => r.includes("signature"))).toBe(true);

    const f2 = evaluateServer(s, { ...base, onViolation: "deny" });
    expect(f2.decision).toBe("deny");
  });
});

describe("签名清单磁盘读写 + env 密钥", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgov-sig-"));
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
  });
  afterEach(() => {
    delete process.env.OPC_MCP_SIGNING_KEY;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("loadSigningKey: 优先 env，其次 .opc/mcp_signing.key，缺失 undefined", () => {
    expect(loadSigningKey(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, ".opc", "mcp_signing.key"), "file-key\n");
    expect(loadSigningKey(dir)).toBe("file-key");
    process.env.OPC_MCP_SIGNING_KEY = "env-key";
    expect(loadSigningKey(dir)).toBe("env-key");
  });

  it("buildSignatureManifest + save/load 往返", () => {
    const s = srv();
    const man = buildSignatureManifest([s], "k");
    expect(man[s.id]).toBe(signDescriptor(s, "k"));
    expect(saveSignatures(dir, man)).toBe(true);
    expect(loadSignatures(dir)[s.id]).toBe(man[s.id]);
  });

  it("loadSignatures 支持 { signatures: {...} } 形态，损坏不抛", () => {
    fs.writeFileSync(path.join(dir, ".opc", "mcp_signatures.json"), JSON.stringify({ signatures: { a: "x" } }));
    expect(loadSignatures(dir)).toEqual({ a: "x" });
    fs.writeFileSync(path.join(dir, ".opc", "mcp_signatures.json"), "{ broken");
    expect(() => loadSignatures(dir)).not.toThrow();
    expect(loadSignatures(dir)).toEqual({});
  });

  it("loadPolicy 自动注入签名密钥后，端到端检出签名漂移", () => {
    const s = srv();
    fs.writeFileSync(path.join(dir, ".opc", "mcp_allowlist.json"), JSON.stringify([s.id]));
    fs.writeFileSync(path.join(dir, ".opc", "mcp_signing.key"), "k");
    // 给一份对"旧版本"签发的签名 → 当前描述符校验失败
    saveSignatures(dir, { [s.id]: signDescriptor(srv({ args: ["old"] }), "k") });
    const r = governMcpServers(dir, [s], undefined, { recordBaseline: false });
    expect(r.findings[0].signatureStatus).toBe("sig-mismatch");
  });
});

// ── ③ 健康探测/扫描 ────────────────────────────────────────────────────────

describe("健康探测", () => {
  it("命令存在 → healthy（node 一定在 PATH）", async () => {
    const s = srv({ command: "node", args: [] });
    expect(await probeServerHealth(s)).toBe("healthy");
  });

  it("命令缺失 → unhealthy", async () => {
    const s = srv({ command: "definitely-not-a-real-command-xyz", args: [] });
    expect(await probeServerHealth(s)).toBe("unhealthy");
  });

  it("无命令 → unknown", async () => {
    const s = srv({ command: undefined, args: [] });
    expect(await probeServerHealth(s)).toBe("unknown");
  });

  it("不可达 url → unhealthy（带超时）", async () => {
    const s = srv({ transport: "http", command: undefined, args: undefined, url: "http://127.0.0.1:1/mcp" });
    expect(await probeServerHealth(s, { timeoutMs: 800 })).toBe("unhealthy");
  });

  it("probeHealth 批量返回 id→状态，单个失败不影响其他", async () => {
    const m = await probeHealth([srv({ id: "ok", command: "node" }), srv({ id: "bad", command: "nope-xyz" })]);
    expect(m.ok).toBe("healthy");
    expect(m.bad).toBe("unhealthy");
  });

  it("unhealthy 仅标记（mark-and-allow），不单独 deny", () => {
    const s = srv();
    const f = evaluateServer(s, policy({ allowlist: [s.id] }), "unhealthy");
    expect(f.health).toBe("unhealthy");
    expect(f.decision).toBe("mark-and-allow");
    expect(f.reasons.some((r) => r.includes("health"))).toBe(true);
  });

  it("健康但 unknown（未探测）不影响裁决", () => {
    const s = srv();
    expect(evaluateServer(s, policy({ allowlist: [s.id] })).decision).toBe("allow");
  });
});

// ── ④ managed registry ─────────────────────────────────────────────────────

describe("managed registry", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgov-reg-"));
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("不在注册表 → absent（非违规）", () => {
    const s = srv();
    expect(matchRegistry(s, {}, descriptorHash(s)).match).toBe("absent");
  });

  it("expectedHash 一致 → match；不一致 → mismatch", () => {
    const s = srv();
    const h = descriptorHash(s);
    expect(matchRegistry(s, { [s.id]: { id: s.id, expectedHash: h } }, h).match).toBe("match");
    expect(matchRegistry(s, { [s.id]: { id: s.id, expectedHash: "sha256:other" } }, h).match).toBe("mismatch");
  });

  it("packageName 不符 → mismatch", () => {
    const s = srv();
    const h = descriptorHash(s);
    const prov = serverProvenance(s);
    const r = matchRegistry(s, { [s.id]: { id: s.id, packageName: "totally-different" } }, h, prov);
    expect(r.match).toBe("mismatch");
  });

  it("loadRegistry 支持数组/{servers}/Record 三形态，损坏不抛", () => {
    const fp = path.join(dir, ".opc", "mcp_registry.json");
    fs.writeFileSync(fp, JSON.stringify([{ id: "a", expectedHash: "h" }]));
    expect(loadRegistry(dir).a.expectedHash).toBe("h");
    fs.writeFileSync(fp, JSON.stringify({ servers: [{ id: "b" }] }));
    expect(loadRegistry(dir).b.id).toBe("b");
    fs.writeFileSync(fp, JSON.stringify({ c: { name: "C" } }));
    expect(loadRegistry(dir).c.name).toBe("C");
    fs.writeFileSync(fp, "{ broken");
    expect(() => loadRegistry(dir)).not.toThrow();
    expect(loadRegistry(dir)).toEqual({});
  });

  it("registry mismatch 端到端 → 违规（默认标记，onViolation=deny 拒绝）", () => {
    const s = srv();
    const pol = policy({ allowlist: [s.id], registry: { [s.id]: { id: s.id, expectedHash: "sha256:wrong" } } });
    const f = evaluateServer(s, pol);
    expect(f.registry.match).toBe("mismatch");
    expect(f.decision).toBe("mark-and-allow");
    expect(evaluateServer(s, { ...pol, onViolation: "deny" }).decision).toBe("deny");
  });
});

// ── ① enforcing 开关 + 异步入口 ─────────────────────────────────────────────

describe("enforcing 开关", () => {
  it("enforce 默认 true：deny 进入 enforcedDeniedIds", () => {
    const a = srv({ id: "a" });
    const b = srv({ id: "b" });
    const rep = evaluateGovernance([a, b], policy({ allowlist: ["a"], managedOnly: true }));
    expect(rep.enforce).toBe(true);
    expect(rep.enforcedDeniedIds).toContain("b");
    expect(rep.deniedIds).toContain("b");
  });

  it("enforce=false：report-only，deniedIds 保留但 enforcedDeniedIds 为空", () => {
    const b = srv({ id: "b" });
    const rep = evaluateGovernance([b], policy({ allowlist: [], managedOnly: true, enforce: false }));
    expect(rep.deniedIds).toContain("b"); // 审计仍记录
    expect(rep.enforcedDeniedIds).toEqual([]); // 但不真正跳过
    expect(rep.enforce).toBe(false);
  });

  it("env OPC_MCP_ENFORCE=0 关闭 enforcing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgov-enf-"));
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
    try {
      process.env.OPC_MCP_ENFORCE = "0";
      expect(loadPolicy(dir).enforce).toBe(false);
      process.env.OPC_MCP_ENFORCE = "1";
      expect(loadPolicy(dir).enforce).toBe(true);
    } finally {
      delete process.env.OPC_MCP_ENFORCE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("governMcpServersAsync（探测 + 评估）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpgov-async-"));
    fs.mkdirSync(path.join(dir, ".opc"), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("probe=true 时把命令缺失标记为 unhealthy，但不阻断", async () => {
    fs.writeFileSync(path.join(dir, ".opc", "mcp_allowlist.json"), JSON.stringify(["x"]));
    const s = srv({ id: "x", command: "nope-not-real-xyz", args: [] });
    const r = await governMcpServersAsync(dir, [s], undefined, { probe: true, probeTimeoutMs: 500 });
    expect(r.findings[0].health).toBe("unhealthy");
    expect(r.findings[0].decision).not.toBe("deny");
    expect(r.enforcedDeniedIds).toEqual([]);
  });

  it("probe=false 时 health 为 unknown，零回归", async () => {
    const s = srv();
    const r = await governMcpServersAsync(dir, [s], undefined, { probe: false });
    expect(r.findings[0].health).toBe("unknown");
  });
});

// ── B5 · getMcpCapabilityVersions（能力版本摘要,供 Run Ledger 写入）──────────────

describe("B5 · getMcpCapabilityVersions 形状与降级", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpver-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  const writeServers = (servers: McpServerConfig[]) =>
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), JSON.stringify(servers), "utf-8");

  it("形状:enabled server id → 版本+hash 短串;无显式版本只留 hash;disabled 不入摘要", () => {
    writeServers([
      srv({ id: "with-version", args: ["-y", "@scope/pkg@1.2.3"] }),
      srv({ id: "no-version" }),
      srv({ id: "disabled-one", enabled: false }),
    ]);
    const versions = getMcpCapabilityVersions(root);
    expect(Object.keys(versions).sort()).toEqual(["no-version", "with-version"]);
    expect(versions["with-version"]).toMatch(/^1\.2\.3\+sha256:[0-9a-f]{12}$/);
    expect(versions["no-version"]).toMatch(/^sha256:[0-9a-f]{12}$/);
    // hash 短串 = descriptorHash 前 12 位 hex(id 不入指纹,与 srv() 基线一致)
    const full = descriptorHash(srv({ id: "no-version" }));
    expect(versions["no-version"]).toBe("sha256:" + full.slice("sha256:".length, "sha256:".length + 12));
  });

  it("描述符变化 → hash 短串变化(捕获供应链替换)", () => {
    writeServers([srv({ id: "s1", args: ["-y", "good-pkg"] })]);
    const before = getMcpCapabilityVersions(root)["s1"];
    writeServers([srv({ id: "s1", args: ["-y", "evil-pkg"] })]);
    const after = getMcpCapabilityVersions(root)["s1"];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("无配置文件 → {};配置损坏 → {}(绝不抛)", () => {
    expect(getMcpCapabilityVersions(root)).toEqual({});
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), "{ 坏 json", "utf-8");
    expect(getMcpCapabilityVersions(root)).toEqual({});
  });
});
