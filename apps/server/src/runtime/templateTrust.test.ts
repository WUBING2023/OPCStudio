import { describe, it, expect } from "vitest";
import type { CompanyTemplate } from "@opc/shared";
import { CompanyTemplateSchema } from "@opc/shared";
import { computeTemplateHash, signTemplate, verifyAndAssignTrust, forkTemplate, dangerFlags, deriveRequiredPermissions } from "./templateTrust.js";

function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t1", title: "队", description: "d", author: "alice", createdAt: "2026-06-30T00:00:00Z",
    tags: ["x"], downloads: 0, stars: 0, readme: "r",
    agents: [{ id: "ceo-0", role: "ceo", name: "CEO", childrenIds: [], model: "m", provider: "deepseek", framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as any],
    ...over,
  };
}

describe("Stage 8 · hash/sign/verify", () => {
  it("computeTemplateHash 确定性 + 字段顺序无关 + 排除 hash/sig/trust 自身", () => {
    const a = tpl();
    const b = tpl(); // 同内容
    expect(computeTemplateHash(a)).toBe(computeTemplateHash(b));
    // 带 hash/sig/trust 不影响(被排除)
    expect(computeTemplateHash({ ...a, hash: "x", signature: "y", trustLevel: "official" })).toBe(computeTemplateHash(a));
    // 改内容 → hash 变
    expect(computeTemplateHash(tpl({ title: "改了" }))).not.toBe(computeTemplateHash(a));
  });

  it("signTemplate 填 hash/signature/trustLevel/version", () => {
    const s = signTemplate(tpl());
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.signature).toBe(s.hash);
    expect(s.trustLevel).toBe("community"); // hash OK = community(非身份背书)
    expect(s.version).toBe("1.0.0");
    // 安全:不能据 author 自封 official(无真签名);任何 author 都只到 community。
    expect(signTemplate(tpl({ author: "OPC Studio" })).trustLevel).toBe("community");
  });

  it("verifyAndAssignTrust:合法→community/official;篡改→untrusted;无 hash→untrusted", () => {
    const signed = signTemplate(tpl());
    expect(verifyAndAssignTrust(signed)).toMatchObject({ hashVerified: true, template: { trustLevel: "community" } });
    // 篡改 agent provider 但不改 hash → 校验失败
    const tampered = { ...signed, agents: [{ ...signed.agents[0], provider: "evil" }] };
    expect(verifyAndAssignTrust(tampered as any).hashVerified).toBe(false);
    expect(verifyAndAssignTrust(tampered as any).template.trustLevel).toBe("untrusted");
    // 无 hash
    expect(verifyAndAssignTrust(tpl()).template.trustLevel).toBe("untrusted");
  });
});

describe("D8 · Trust Level 5 级判定(指南 11.17)", () => {
  it("official:函数任何路径都不会自动赋 official(留给 Stage 9 真签名)", () => {
    // 即便调用方在输入对象上自己声明 trustLevel:"official",verifyAndAssignTrust 也会按 hash 状态
    // 重新判定并覆盖它——不存在任何输入组合能让返回值是 official。
    const claimed = { ...signTemplate(tpl()), trustLevel: "official" as const };
    expect(verifyAndAssignTrust(claimed).template.trustLevel).not.toBe("official");
    expect(verifyAndAssignTrust(tpl({ trustLevel: "official" })).template.trustLevel).not.toBe("official");
  });

  it("#23:hash-only 校验路径封顶 community——verifiedAuthor:true 是内容自声明(参与 hash,人人可自算),不能自封 verified_community", () => {
    const signed = signTemplate(tpl({ verifiedAuthor: true }));
    const r = verifyAndAssignTrust(signed);
    expect(r.hashVerified).toBe(true);
    expect(r.template.trustLevel).toBe("community");
  });

  it("#23:攻击者路径——JSON 里写 verifiedAuthor:true 后用公开算法自算 hash/signature,导入也只拿到 community", () => {
    const forged = tpl({ verifiedAuthor: true });
    const hash = computeTemplateHash(forged);
    const r = verifyAndAssignTrust({ ...forged, hash, signature: hash });
    expect(r.hashVerified).toBe(true); // 完整性校验本身确实会通过(hash 是公开算法)
    expect(r.template.trustLevel).toBe("community"); // 但信任级不被内容自带的 verifiedAuthor 抬高
  });

  it("verified_author 缺失 → 降级到 community(判不出,不假定已验证)", () => {
    const signed = signTemplate(tpl()); // 未设 verifiedAuthor
    const r = verifyAndAssignTrust(signed);
    expect(r.template.trustLevel).toBe("community");
    expect(signed.verifiedAuthor).toBeUndefined();
  });

  it("verifiedAuthor===false 也判 community,不是 verified_community(必须显式 true 才算)", () => {
    const signed = signTemplate(tpl({ verifiedAuthor: false }));
    expect(verifyAndAssignTrust(signed).template.trustLevel).toBe("community");
  });

  it("community:hash 存在且校验通过", () => {
    const signed = signTemplate(tpl());
    expect(verifyAndAssignTrust(signed).template.trustLevel).toBe("community");
  });

  it("local_import:无 hash + 调用方标明 localImport:true → local_import,而不是笼统的 untrusted", () => {
    const r = verifyAndAssignTrust(tpl(), { localImport: true });
    expect(r.hashVerified).toBe(false);
    expect(r.template.trustLevel).toBe("local_import");
  });

  it("untrusted:无 hash 且未标 localImport(缺省行为不变)→ untrusted", () => {
    expect(verifyAndAssignTrust(tpl()).template.trustLevel).toBe("untrusted");
    expect(verifyAndAssignTrust(tpl(), {}).template.trustLevel).toBe("untrusted");
    expect(verifyAndAssignTrust(tpl(), { localImport: false }).template.trustLevel).toBe("untrusted");
  });

  it("untrusted:hash 校验失败(篡改)→ untrusted,即便调用方标了 localImport:true(篡改优先于来源判定)", () => {
    const signed = signTemplate(tpl());
    const tampered = { ...signed, title: "改了但没改 hash" };
    const r = verifyAndAssignTrust(tampered as any, { localImport: true });
    expect(r.hashVerified).toBe(false);
    expect(r.template.trustLevel).toBe("untrusted");
  });

  it("旧枚举值(仅 official/community/untrusted 三级)向后兼容:CompanyTemplateSchema 仍能正常校验通过", () => {
    for (const legacy of ["official", "community", "untrusted"] as const) {
      const parsed = CompanyTemplateSchema.safeParse(tpl({ trustLevel: legacy }));
      expect(parsed.success).toBe(true);
    }
    // 新增两级同样合法
    for (const level of ["verified_community", "local_import"] as const) {
      expect(CompanyTemplateSchema.safeParse(tpl({ trustLevel: level })).success).toBe(true);
    }
    // 非法取值仍应被拒绝(枚举没有被放宽成任意字符串)
    expect(CompanyTemplateSchema.safeParse(tpl({ trustLevel: "super-trusted" as any })).success).toBe(false);
  });

  it("fork:verifiedAuthor 不随 fork 带到新副本(换了作者,徽章不能白嫖)", () => {
    const src = signTemplate(tpl({ verifiedAuthor: true }));
    const forked = forkTemplate(src, { author: "bob" });
    expect(forked.verifiedAuthor).toBeUndefined();
    // fork 后重新签名 = community(hash-only 路径的上限,见 #23)
    expect(verifyAndAssignTrust(forked).template.trustLevel).toBe("community");
  });
});

describe("Stage 8 · fork", () => {
  it("新 id/forkedFrom/重置 version&downloads&stars/打 forked tag/重签名;agentPatches 生效", () => {
    const src = signTemplate(tpl({ id: "src-1", downloads: 99, stars: 50 }));
    const f = forkTemplate(src, { author: "bob", title: "我的", agentPatches: { "ceo-0": { model: "新模型" } } });
    expect(f.id).not.toBe("src-1");
    expect(f.id).toMatch(/-fork-/);
    expect(f.forkedFrom).toBe("src-1");
    expect(f.version).toBe("1.0.0");
    expect(f.downloads).toBe(0);
    expect(f.stars).toBe(0);
    expect(f.author).toBe("bob");
    expect(f.tags).toContain("forked");
    expect(f.agents.find(a => a.id === "ceo-0")?.model).toBe("新模型");
    // 重签名:hash 反映 fork 后内容
    expect(verifyAndAssignTrust(f).hashVerified).toBe(true);
  });
});

describe("Stage 8 · 危险权限旗标", () => {
  it("claude-code/codex → shell;dev → file-write;mcp 依赖", () => {
    const t = tpl({
      agents: [{ id: "d", role: "dev", name: "D", childrenIds: [], model: "m", provider: "anthropic", framework: "claude-code", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as any],
      toolRequirements: { requiredEngines: [], requiredProviders: [], requiredMcpServers: ["github"], requiredSkills: [], optionalTools: [] },
    });
    const flags = dangerFlags(t);
    expect(flags).toContain("shell-access");
    expect(flags).toContain("file-write");
    expect(flags).toContain("mcp-dependency");
    expect(deriveRequiredPermissions(t).mcpServers).toContain("github");
  });
});
