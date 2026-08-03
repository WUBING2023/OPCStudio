import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { knownInstallCandidates, resolveDirectCommandFromCandidates } from "./executableResolver.js";

// 已知安装位置兜底(PATH 定位失败时仍能找到引擎 CLI)—— 修复"从 git-bash 等非 Windows-PATH 环境启动
// 服务端 → where.exe 拿到 unix 格式 PATH 解析不了 → claude/codex 明明装了也登录了却检测不到",以及
// "桌面端/CLI 装了但没加进 PATH"。断言各引擎的候选位置齐全、只认已知引擎、且候选与命令一致。

describe("knownInstallCandidates · 只兜底已知引擎", () => {
  it("非 claude/codex/gemini → 空(不给未知命令编造路径)", () => {
    expect(knownInstallCandidates("bash")).toEqual([]);
    expect(knownInstallCandidates("rm")).toEqual([]);
    expect(knownInstallCandidates("node")).toEqual([]);
  });

  it("claude/codex/gemini/kimi/grok → 非空,且每个候选的 basename 都对应该命令", () => {
    for (const cmd of ["claude", "codex", "gemini", "kimi", "grok"]) {
      const cands = knownInstallCandidates(cmd);
      expect(cands.length).toBeGreaterThan(0);
      for (const c of cands) {
        expect(path.basename(c).toLowerCase()).toContain(cmd);
      }
    }
  });

  it("带扩展名/大小写也能归一(codex.exe / CLAUDE)", () => {
    expect(knownInstallCandidates("codex.exe").length).toBeGreaterThan(0);
    expect(knownInstallCandidates("CLAUDE").length).toBeGreaterThan(0);
  });

  it("跨平台标准 bin(~/.local/bin/<cmd>)恒在候选里", () => {
    const home = os.homedir();
    expect(knownInstallCandidates("codex")).toContain(path.join(home, ".local", "bin", "codex"));
    expect(knownInstallCandidates("claude")).toContain(path.join(home, ".local", "bin", "claude"));
  });

  it("win32:codex 兜底含桌面端内置 CLI 路径;claude 兜底含 npm claude-code bin", () => {
    if (process.platform !== "win32") return; // 平台特定断言只在 Windows 上跑
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    expect(knownInstallCandidates("codex")).toContain(
      path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    );
    expect(knownInstallCandidates("claude")).toContain(
      path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    );
  });
});

describe("resolveDirectCommandFromCandidates · 无 PATH 也能按绝对路径解析(兜底机制核心)", () => {
  it("给出一个真实存在的原生可执行绝对路径 → 直接返回它(prefixArgs 空)", () => {
    // 用一个本机确定存在的原生 exe 冒充"已知安装位置命中",证明"PATH 一个都没有、只靠绝对路径候选"能解析。
    const realExe = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe")
      : "/bin/sh";
    const resolved = resolveDirectCommandFromCandidates("claude", [realExe]);
    expect(resolved).not.toBeNull();
    expect(resolved!.file).toBe(path.resolve(realExe));
    expect(resolved!.prefixArgs).toEqual([]);
  });

  it("候选全不存在 → null(不假报)", () => {
    expect(resolveDirectCommandFromCandidates("claude", [path.join(os.tmpdir(), "definitely-not-here-xyz.exe")])).toBeNull();
  });
});
