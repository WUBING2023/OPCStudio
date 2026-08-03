import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactSecrets, maskConfigSecrets, filteredSpawnEnv } from "./redact.js";

describe("Stage 9 · redactSecrets", () => {
  it("脱敏 sk-/ark-/Bearer/api_key 模式", () => {
    expect(redactSecrets("Invalid API key: sk-46d6d77debaa4153ba9055e9")).not.toContain("sk-46d6");
    expect(redactSecrets("Invalid API key: sk-46d6d77debaa4153ba9055e9")).toContain("[REDACTED]");
    expect(redactSecrets('"apiKey":"ark-7ab12cd34ef"')).toContain("[REDACTED]");
    expect(redactSecrets("Authorization: Bearer abcd1234efgh5678")).toContain("[REDACTED]");
    expect(redactSecrets('x-api-key: deadbeef12345678')).toContain("[REDACTED]");
  });
  it("普通文本不动", () => {
    expect(redactSecrets("快速排序的平均复杂度是 O(n log n)")).toBe("快速排序的平均复杂度是 O(n log n)");
  });
});

describe("Stage 9 · maskConfigSecrets", () => {
  it("apiKeys/github secret/providers.apiKey 掩码,已配=*** 未配=空", () => {
    const masked = maskConfigSecrets({
      apiKeys: { deepseek: "sk-realkey123456", minimax: "" },
      github: { oauth: { clientSecret: "abc123secret", accessToken: "tok123" } },
      providers: [{ id: "x", apiKey: "sk-custom999999" }],
      other: "保留",
    } as any);
    expect(masked.apiKeys.deepseek).toBe("***");
    expect(masked.apiKeys.minimax).toBe(""); // 未配 → 空(前端知道没配)
    expect((masked as any).github.oauth.clientSecret).toBe("***");
    expect((masked as any).providers[0].apiKey).toBe("***");
    expect((masked as any).other).toBe("保留"); // 非密钥字段不动
  });
  it("不改原对象(纯函数)", () => {
    const orig = { apiKeys: { deepseek: "sk-x123456789" } } as any;
    maskConfigSecrets(orig);
    expect(orig.apiKeys.deepseek).toBe("sk-x123456789");
  });
});

// ── A1-V3 · filteredSpawnEnv + roleProfile.envAllowlist ──────────────────────

describe("A1-V3 · filteredSpawnEnv envAllowlist(允许/拦截/缺省)", () => {
  const TEST_VARS = ["OPC_TEST_RANDOM_VAR", "OPC_TEST_KEPT_VAR", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "EVIL_ACCESS_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of TEST_VARS) saved[k] = process.env[k];
    process.env.OPC_TEST_RANDOM_VAR = "leak-me";
    process.env.OPC_TEST_KEPT_VAR = "keep-me";
    process.env.DEEPSEEK_API_KEY = "sk-own-provider";
    process.env.OPENAI_API_KEY = "sk-other-provider";
    process.env.EVIL_ACCESS_TOKEN = "tok-evil";
  });
  afterEach(() => {
    for (const k of TEST_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("缺省(不传/空数组)= 全放行:行为与旧版一致,任意非密钥 env 保留", () => {
    const out1 = filteredSpawnEnv("deepseek");
    expect(out1.OPC_TEST_RANDOM_VAR).toBe("leak-me");
    const out2 = filteredSpawnEnv("deepseek", []);
    expect(out2.OPC_TEST_RANDOM_VAR).toBe("leak-me");
  });

  it("allowlist 生效:白名单命中保留,不在名单的普通 env 被剔除", () => {
    const out = filteredSpawnEnv("deepseek", ["PATH", "HOME", "OPC_TEST_KEPT_VAR"]);
    expect(out.OPC_TEST_KEPT_VAR).toBe("keep-me");
    expect(out.OPC_TEST_RANDOM_VAR).toBeUndefined();
  });

  it("自己 provider 的 key 始终保留;其他 provider 的密钥仍被剔除", () => {
    const out = filteredSpawnEnv("deepseek", ["PATH"]);
    expect(out.DEEPSEEK_API_KEY).toBe("sk-own-provider");
    expect(out.OPENAI_API_KEY).toBeUndefined();
  });

  it("白名单不能复活密钥类变量(SECRET_ENV_RE deny 优先)", () => {
    const out = filteredSpawnEnv("deepseek", ["EVIL_ACCESS_TOKEN", "PATH"]);
    expect(out.EVIL_ACCESS_TOKEN).toBeUndefined();
  });

  it("进程运行基线(PATH/TEMP 等)即便不在 allowlist 也保留——不搞坏子进程运行时", () => {
    const out = filteredSpawnEnv("deepseek", ["OPC_TEST_KEPT_VAR"]); // allowlist 故意不含 PATH
    const keys = Object.keys(out).map((k) => k.toUpperCase());
    // 本机(Windows/POSIX)一定存在 PATH;TEMP/TMP 至少其一
    expect(keys).toContain("PATH");
  });

  it("大小写不敏感匹配(Windows env 名不区分大小写:allowlist 写 PATH,实际键可能是 Path)", () => {
    const prev = process.env.OpcMixedCaseVar;
    process.env.OpcMixedCaseVar = "mixed";
    try {
      const out = filteredSpawnEnv("deepseek", ["OPCMIXEDCASEVAR"]);
      expect(out.OpcMixedCaseVar).toBe("mixed");
    } finally {
      if (prev === undefined) delete process.env.OpcMixedCaseVar; else process.env.OpcMixedCaseVar = prev;
    }
  });
});
