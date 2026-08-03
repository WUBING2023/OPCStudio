import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./projectStore.js";

let root = "";
function tempRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-project-config-"));
  return root;
}
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe("project config defaults and migration", () => {
  it("新项目默认开启 shell、文件变更和网络权限", () => {
    const cfg = loadConfig(tempRoot());
    expect(cfg.permissions).toEqual({ allowShell: true, allowFileWrite: true, allowWebAccess: true });
  });

  it("旧项目显式关闭的权限不会被默认值覆盖", () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, ".opc"));
    fs.writeFileSync(path.join(dir, ".opc", "config.json"), JSON.stringify({
      permissions: { allowShell: false, allowFileWrite: false, allowWebAccess: false },
    }));
    expect(loadConfig(dir).permissions).toEqual({ allowShell: false, allowFileWrite: false, allowWebAccess: false });
  });

  it("历史 creative/judge 分档读取时收敛为唯一 default", () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, ".opc"));
    fs.writeFileSync(path.join(dir, ".opc", "config.json"), JSON.stringify({
      defaultModel: "old-model",
      systemModel: {
        creative: { framework: "api", provider: "minimax", model: "MiniMax-M3" },
        judge: { framework: "codex", provider: "openai", model: "gpt-5.5" },
      },
    }));
    const cfg = loadConfig(dir);
    expect(cfg.systemModel).toEqual({ default: { framework: "api", provider: "minimax", model: "MiniMax-M3" } });
    expect(cfg.defaultModel).toBe("MiniMax-M3");
  });
});