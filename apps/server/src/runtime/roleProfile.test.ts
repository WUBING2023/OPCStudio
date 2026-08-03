import { describe, it, expect } from "vitest";
import {
  research_profile_v1,
  fact_check_profile_v1,
  lead_profile_v1,
  code_profile_v1,
  PROFILES,
  getProfileForRole,
  globToRegExp,
  checkFileAllowed,
  checkShellAllowed,
  SHELL_ALLOWLIST_COMMANDS,
  type RoleProfile,
  type ShellMode,
  type NetworkMode,
} from "./roleProfile.js";

// ── 类型形状检查 ──────────────────────────────────────────────────────────────

describe("RoleProfile 结构完整性", () => {
  const allProfiles: RoleProfile[] = [
    research_profile_v1,
    fact_check_profile_v1,
    lead_profile_v1,
    code_profile_v1,
  ];

  it("所有 profile 包含必要字段且类型正确", () => {
    for (const p of allProfiles) {
      expect(typeof p.id, `${p.id}.id 应为 string`).toBe("string");
      expect(p.id.length, `${p.id}.id 不得为空`).toBeGreaterThan(0);

      expect(Array.isArray(p.allowedExtensions), `${p.id}.allowedExtensions 应为数组`).toBe(true);
      expect(Array.isArray(p.blockedGlobs), `${p.id}.blockedGlobs 应为数组`).toBe(true);

      expect(typeof p.maxWorkspaceBytes).toBe("number");
      expect(typeof p.maxFiles).toBe("number");
      expect(typeof p.maxDepth).toBe("number");
      expect(typeof p.maxFilenameBytes).toBe("number");

      expect(p.maxWorkspaceBytes, `${p.id}.maxWorkspaceBytes 须 > 0`).toBeGreaterThan(0);
      expect(p.maxFiles, `${p.id}.maxFiles 须 > 0`).toBeGreaterThan(0);
      expect(p.maxDepth, `${p.id}.maxDepth 须 > 0`).toBeGreaterThan(0);
      expect(p.maxFilenameBytes, `${p.id}.maxFilenameBytes 须 > 0`).toBeGreaterThan(0);

      const validShellModes: ShellMode[] = ["none", "allowlist", "full"];
      expect(validShellModes, `${p.id}.shellMode 非法值`).toContain(p.shellMode);

      const validNetworkModes: NetworkMode[] = ["off", "limited", "on"];
      expect(validNetworkModes, `${p.id}.networkMode 非法值`).toContain(p.networkMode);

      expect(Array.isArray(p.envAllowlist), `${p.id}.envAllowlist 应为数组`).toBe(true);

      expect(typeof p.preStopFlush.softTimeoutMs).toBe("number");
      expect(typeof p.preStopFlush.hardTimeoutMs).toBe("number");
      expect(typeof p.preStopFlush.flushArtifacts).toBe("boolean");
    }
  });

  it("hardTimeoutMs 严格大于 softTimeoutMs（保证 flush 窗口存在）", () => {
    for (const p of allProfiles) {
      expect(
        p.preStopFlush.hardTimeoutMs,
        `${p.id}: hard(${p.preStopFlush.hardTimeoutMs}) 必须 > soft(${p.preStopFlush.softTimeoutMs})`,
      ).toBeGreaterThan(p.preStopFlush.softTimeoutMs);
    }
  });

  it("allowedExtensions 每项均以 '.' 开头", () => {
    for (const p of allProfiles) {
      for (const ext of p.allowedExtensions) {
        expect(ext, `${p.id}: 后缀 "${ext}" 应以 '.' 开头`).toMatch(/^\./);
      }
    }
  });
});

// ── PROFILES 索引表 ───────────────────────────────────────────────────────────

describe("PROFILES 索引表", () => {
  it("包含全部 4 个预设 profile", () => {
    expect(Object.keys(PROFILES).sort()).toEqual([
      "code_profile_v1",
      "fact_check_profile_v1",
      "lead_profile_v1",
      "research_profile_v1",
    ]);
  });

  it("id 字段与索引 key 一致", () => {
    for (const [key, profile] of Object.entries(PROFILES)) {
      expect(profile.id).toBe(key);
    }
  });
});

// ── research_profile_v1 ───────────────────────────────────────────────────────

describe("research_profile_v1", () => {
  it("id 正确", () => {
    expect(research_profile_v1.id).toBe("research_profile_v1");
  });

  it("只允许 .md 和 .json 写入", () => {
    expect(research_profile_v1.allowedExtensions).toContain(".md");
    expect(research_profile_v1.allowedExtensions).toContain(".json");
    // 不应包含代码文件
    expect(research_profile_v1.allowedExtensions).not.toContain(".ts");
    expect(research_profile_v1.allowedExtensions).not.toContain(".py");
  });

  it("磁盘上限 = 32 MB", () => {
    expect(research_profile_v1.maxWorkspaceBytes).toBe(32 * 1024 * 1024);
  });

  it("最大文件数 = 500", () => {
    expect(research_profile_v1.maxFiles).toBe(500);
  });

  it("目录深度上限 = 6（防 ENAMETOOLONG）", () => {
    expect(research_profile_v1.maxDepth).toBe(6);
  });

  it("shellMode = allowlist（非 none/full）", () => {
    expect(research_profile_v1.shellMode).toBe("allowlist");
  });

  it("networkMode = limited（可联网检索，不完全开放）", () => {
    expect(research_profile_v1.networkMode).toBe("limited");
  });

  it("blockedGlobs 包含 .env / secrets / .py / .sh", () => {
    const globs = research_profile_v1.blockedGlobs;
    expect(globs.some(g => g.includes(".env"))).toBe(true);
    expect(globs.some(g => g.includes("secrets"))).toBe(true);
    expect(globs.some(g => g.includes(".py"))).toBe(true);
    expect(globs.some(g => g.includes(".sh"))).toBe(true);
  });

  it("preStopFlush.flushArtifacts = true", () => {
    expect(research_profile_v1.preStopFlush.flushArtifacts).toBe(true);
  });
});

// ── fact_check_profile_v1 ─────────────────────────────────────────────────────

describe("fact_check_profile_v1", () => {
  it("shellMode = none（最严格：禁建环境）", () => {
    expect(fact_check_profile_v1.shellMode).toBe("none");
  });

  it("磁盘上限 = 16 MB（比研究 profile 更小）", () => {
    expect(fact_check_profile_v1.maxWorkspaceBytes).toBe(16 * 1024 * 1024);
  });

  it("磁盘上限严格小于 research_profile_v1", () => {
    expect(fact_check_profile_v1.maxWorkspaceBytes)
      .toBeLessThan(research_profile_v1.maxWorkspaceBytes);
  });

  it("networkMode = limited（需要联网核查）", () => {
    expect(fact_check_profile_v1.networkMode).toBe("limited");
  });

  it("只允许 .md 和 .json（同 research）", () => {
    expect(fact_check_profile_v1.allowedExtensions).toContain(".md");
    expect(fact_check_profile_v1.allowedExtensions).toContain(".json");
    expect(fact_check_profile_v1.allowedExtensions).not.toContain(".py");
  });
});

// ── lead_profile_v1 ───────────────────────────────────────────────────────────

describe("lead_profile_v1", () => {
  it("磁盘上限 = 64 MB（拆解/汇总需要更大空间）", () => {
    expect(lead_profile_v1.maxWorkspaceBytes).toBe(64 * 1024 * 1024);
  });

  it("shellMode = allowlist（编排层需要有限 shell 能力）", () => {
    expect(lead_profile_v1.shellMode).toBe("allowlist");
  });

  it("networkMode = on（Lead 需完整网络）", () => {
    expect(lead_profile_v1.networkMode).toBe("on");
  });

  it("allowedExtensions 包含 .yaml / .yml（计划文件）", () => {
    expect(lead_profile_v1.allowedExtensions).toContain(".yaml");
    expect(lead_profile_v1.allowedExtensions).toContain(".yml");
  });

  it("磁盘上限大于 research_profile_v1", () => {
    expect(lead_profile_v1.maxWorkspaceBytes)
      .toBeGreaterThan(research_profile_v1.maxWorkspaceBytes);
  });

  it("maxDepth 大于 research（Lead 可读全 run workspace 深层结构）", () => {
    expect(lead_profile_v1.maxDepth).toBeGreaterThan(research_profile_v1.maxDepth);
  });
});

// ── code_profile_v1 ───────────────────────────────────────────────────────────

describe("code_profile_v1", () => {
  it("磁盘上限 = 256 MB（代码任务最大）", () => {
    expect(code_profile_v1.maxWorkspaceBytes).toBe(256 * 1024 * 1024);
  });

  it("shellMode = full（允许跑测试）", () => {
    expect(code_profile_v1.shellMode).toBe("full");
  });

  it("networkMode = on", () => {
    expect(code_profile_v1.networkMode).toBe("on");
  });

  it("allowedExtensions 含主流代码后缀", () => {
    const exts = code_profile_v1.allowedExtensions;
    for (const e of [".ts", ".js", ".py", ".json", ".md"]) {
      expect(exts, `缺少后缀 ${e}`).toContain(e);
    }
  });

  it("blockedGlobs 仍保护 .env / secrets / keys", () => {
    const globs = code_profile_v1.blockedGlobs;
    expect(globs.some(g => g.includes(".env"))).toBe(true);
    expect(globs.some(g => g.includes("secrets"))).toBe(true);
    expect(globs.some(g => g.includes("keys"))).toBe(true);
  });

  it("磁盘上限大于所有其他 profile", () => {
    for (const p of [research_profile_v1, fact_check_profile_v1, lead_profile_v1]) {
      expect(code_profile_v1.maxWorkspaceBytes).toBeGreaterThan(p.maxWorkspaceBytes);
    }
  });
});

// ── getProfileForRole ─────────────────────────────────────────────────────────

describe("getProfileForRole — 角色→profile 映射", () => {
  it("researcher → research_profile_v1", () => {
    expect(getProfileForRole("researcher").id).toBe("research_profile_v1");
  });

  it("research → research_profile_v1", () => {
    expect(getProfileForRole("research").id).toBe("research_profile_v1");
  });

  it("worker → research_profile_v1（保守兜底）", () => {
    expect(getProfileForRole("worker").id).toBe("research_profile_v1");
  });

  it("fact_checker → fact_check_profile_v1", () => {
    expect(getProfileForRole("fact_checker").id).toBe("fact_check_profile_v1");
  });

  it("fact_check → fact_check_profile_v1", () => {
    expect(getProfileForRole("fact_check").id).toBe("fact_check_profile_v1");
  });

  it("fact-check（连字符）→ fact_check_profile_v1", () => {
    expect(getProfileForRole("fact-check").id).toBe("fact_check_profile_v1");
  });

  it("lead → lead_profile_v1", () => {
    expect(getProfileForRole("lead").id).toBe("lead_profile_v1");
  });

  it("ceo → lead_profile_v1（编排层同级）", () => {
    expect(getProfileForRole("ceo").id).toBe("lead_profile_v1");
  });

  it("integrator → lead_profile_v1", () => {
    expect(getProfileForRole("integrator").id).toBe("lead_profile_v1");
  });

  it("dev → code_profile_v1", () => {
    expect(getProfileForRole("dev").id).toBe("code_profile_v1");
  });

  it("coder → code_profile_v1", () => {
    expect(getProfileForRole("coder").id).toBe("code_profile_v1");
  });

  it("code → code_profile_v1", () => {
    expect(getProfileForRole("code").id).toBe("code_profile_v1");
  });

  it("未知角色兜底为 research_profile_v1（最保守）", () => {
    expect(getProfileForRole("some-future-role").id).toBe("research_profile_v1");
    expect(getProfileForRole("").id).toBe("research_profile_v1");
    expect(getProfileForRole("UNKNOWN").id).toBe("research_profile_v1");
  });

  it("返回值是 PROFILES 表中的同一个对象引用（不是 copy）", () => {
    expect(getProfileForRole("researcher")).toBe(research_profile_v1);
    expect(getProfileForRole("lead")).toBe(lead_profile_v1);
    expect(getProfileForRole("dev")).toBe(code_profile_v1);
  });

  it("返回 profile 的 preStopFlush hardTimeoutMs > softTimeoutMs", () => {
    const roles = ["researcher", "fact_checker", "lead", "dev", "some-unknown"];
    for (const role of roles) {
      const p = getProfileForRole(role);
      expect(
        p.preStopFlush.hardTimeoutMs,
        `role "${role}" → ${p.id}: hard 必须 > soft`,
      ).toBeGreaterThan(p.preStopFlush.softTimeoutMs);
    }
  });
});

// ── 配额层级一致性（跨 profile 比较）────────────────────────────────────────

describe("配额层级一致性", () => {
  it("磁盘配额满足 fact_check ≤ research < lead < code", () => {
    expect(fact_check_profile_v1.maxWorkspaceBytes)
      .toBeLessThanOrEqual(research_profile_v1.maxWorkspaceBytes);
    expect(research_profile_v1.maxWorkspaceBytes)
      .toBeLessThan(lead_profile_v1.maxWorkspaceBytes);
    expect(lead_profile_v1.maxWorkspaceBytes)
      .toBeLessThan(code_profile_v1.maxWorkspaceBytes);
  });

  it("shell 权限层级：fact_check(none) ≤ research/lead(allowlist) ≤ code(full)", () => {
    const shellOrder: ShellMode[] = ["none", "allowlist", "full"];
    const idx = (m: ShellMode) => shellOrder.indexOf(m);
    expect(idx(fact_check_profile_v1.shellMode)).toBeLessThanOrEqual(idx(research_profile_v1.shellMode));
    expect(idx(research_profile_v1.shellMode)).toBeLessThanOrEqual(idx(lead_profile_v1.shellMode));
    expect(idx(lead_profile_v1.shellMode)).toBeLessThanOrEqual(idx(code_profile_v1.shellMode));
  });

  it("所有研究/核查类 profile 均包含 .md 和 .json 后缀", () => {
    for (const p of [research_profile_v1, fact_check_profile_v1]) {
      expect(p.allowedExtensions).toContain(".md");
      expect(p.allowedExtensions).toContain(".json");
    }
  });

  it("所有 profile 的 envAllowlist 均含 PATH（子进程找可执行文件需要）", () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.envAllowlist, `${p.id} 缺少 PATH`).toContain("PATH");
    }
  });
});

// ── A1-V3 · globToRegExp / checkFileAllowed 运行时文件护栏 ────────────────────

describe("globToRegExp — profile 用到的全部模式形状", () => {
  it("**/.env 匹配根级与任意深度的 .env", () => {
    const re = globToRegExp("**/.env");
    expect(re.test(".env")).toBe(true);
    expect(re.test("a/b/.env")).toBe(true);
    expect(re.test("a/b/env")).toBe(false);
    expect(re.test("a/b/x.env.md")).toBe(false);
  });
  it("**/secrets/** 匹配任意位置 secrets 目录下的任意文件", () => {
    const re = globToRegExp("**/secrets/**");
    expect(re.test("secrets/key.json")).toBe(true);
    expect(re.test("a/secrets/deep/key.json")).toBe(true);
    expect(re.test("secretsfile.md")).toBe(false);
  });
  it("**/*.py 匹配任意深度的 .py,不误伤 .pyc / 大小写不敏感", () => {
    const re = globToRegExp("**/*.py");
    expect(re.test("setup.py")).toBe(true);
    expect(re.test("a/b/c/tool.py")).toBe(true);
    expect(re.test("a/tool.pyc")).toBe(false);
    expect(re.test("a/TOOL.PY")).toBe(true); // Windows 主场,大小写同罪
  });
});

describe("checkFileAllowed — A1-V3 允许/拦截/缺省三态", () => {
  // ① 允许
  it("研究 profile:output/report.md 与 data.json 放行", () => {
    expect(checkFileAllowed(research_profile_v1, "output/report.md").allowed).toBe(true);
    expect(checkFileAllowed(research_profile_v1, "data.json").allowed).toBe(true);
  });
  it("代码 profile:src/app.ts 放行", () => {
    expect(checkFileAllowed(code_profile_v1, "src/app.ts").allowed).toBe(true);
  });
  it("Windows 反斜杠路径与大写后缀同样放行(output\\REPORT.MD)", () => {
    expect(checkFileAllowed(research_profile_v1, "output\\REPORT.MD").allowed).toBe(true);
  });

  // ② 拦截
  it("研究 profile:.py 命中 blockedGlobs → blocked_glob", () => {
    const v = checkFileAllowed(research_profile_v1, "tools/setup.py");
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe("blocked_glob");
    expect(v.detail).toContain("*.py");
  });
  it("研究 profile:嵌套 .env / secrets/ 命中 blockedGlobs", () => {
    expect(checkFileAllowed(research_profile_v1, "cfg/.env").allowed).toBe(false);
    expect(checkFileAllowed(research_profile_v1, "secrets\\key.json").allowed).toBe(false);
  });
  it("研究 profile:.txt 不在 allowedExtensions → extension_not_allowed", () => {
    const v = checkFileAllowed(research_profile_v1, "report.txt");
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe("extension_not_allowed");
    expect(v.detail).toContain(".txt");
  });
  it("代码 profile:secrets/creds.json 仍被禁写(blockedGlobs 优先于后缀白名单)", () => {
    const v = checkFileAllowed(code_profile_v1, "secrets/creds.json");
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe("blocked_glob");
  });
  it("无后缀文件在启用后缀白名单时被拦(Dockerfile)", () => {
    expect(checkFileAllowed(research_profile_v1, "Dockerfile").allowed).toBe(false);
  });
  it("allowedExtensions 为空数组 = 显式禁止任何写入(字段注释语义)", () => {
    const v = checkFileAllowed({ allowedExtensions: [], blockedGlobs: [] }, "a.md");
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe("extension_not_allowed");
  });

  // ③ 缺省 = 全放行(向后兼容铁则:没定义这两个字段的 profile 行为与从前完全一致)
  it("字段缺省(undefined)→ 任何文件全放行", () => {
    const legacy = { allowedExtensions: undefined, blockedGlobs: undefined } as unknown as Pick<RoleProfile, "allowedExtensions" | "blockedGlobs">;
    expect(checkFileAllowed(legacy, "anything.xyz").allowed).toBe(true);
    expect(checkFileAllowed(legacy, ".env").allowed).toBe(true);
    expect(checkFileAllowed(legacy, "no_extension_file").allowed).toBe(true);
  });
  it("blockedGlobs 缺省但 allowedExtensions 存在 → 只做后缀白名单", () => {
    const p = { allowedExtensions: [".md"], blockedGlobs: undefined } as unknown as Pick<RoleProfile, "allowedExtensions" | "blockedGlobs">;
    expect(checkFileAllowed(p, "a/.env.md").allowed).toBe(true);
    expect(checkFileAllowed(p, "a.json").allowed).toBe(false);
  });
});

// ── A1-V3: checkShellAllowed(shellMode 运行时判定)──────────────────────────

describe("checkShellAllowed", () => {
  it("full 档位放行任何命令", () => {
    expect(checkShellAllowed({ shellMode: "full" }, "rm -rf /tmp/x").allowed).toBe(true);
    expect(checkShellAllowed({ shellMode: "full" }, "npm run build && npm test").allowed).toBe(true);
  });

  it("none 档位拦截一切命令(含白名单内的)", () => {
    const v = checkShellAllowed({ shellMode: "none" }, "echo hi");
    expect(v.allowed).toBe(false);
    expect(v.detail).toContain("none");
  });

  it("allowlist 档位放行白名单首词命令", () => {
    expect(checkShellAllowed({ shellMode: "allowlist" }, "node script.js").allowed).toBe(true);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "git status").allowed).toBe(true);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "echo hello world").allowed).toBe(true);
  });

  it("allowlist 档位拦截白名单外的首词", () => {
    const v = checkShellAllowed({ shellMode: "allowlist" }, "del important.txt");
    expect(v.allowed).toBe(false);
    expect(v.detail).toContain("del");
  });

  it("复合命令逐段判定:任一段首词违规即拦(防搭车)", () => {
    expect(checkShellAllowed({ shellMode: "allowlist" }, "echo hi && del x").allowed).toBe(false);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "echo hi; curl http://evil").allowed).toBe(false);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "cat a.txt | grep foo").allowed).toBe(true);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "echo a\ngit log").allowed).toBe(true);
  });

  it("首词判定大小写不敏感;空命令拦截", () => {
    expect(checkShellAllowed({ shellMode: "allowlist" }, "NODE -v").allowed).toBe(true);
    expect(checkShellAllowed({ shellMode: "allowlist" }, "   ").allowed).toBe(false);
  });

  it("白名单数据面保守:不含 rm/del/curl 等危险或出网首词", () => {
    for (const dangerous of ["rm", "del", "curl", "wget", "powershell", "cmd", "bash", "sh"]) {
      expect(SHELL_ALLOWLIST_COMMANDS, `白名单不应包含 ${dangerous}`).not.toContain(dangerous);
    }
  });
});
