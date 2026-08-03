import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTool } from "./tools.js";

// v7：工具永不抛错——失败返回 Error 字符串（给模型反馈），不冒泡崩 run。
describe("runTool 健壮性", () => {
  it("读不存在的文件 → 返回 Error 字符串，不抛", async () => {
    const r = await runTool("readFile", { path: "__no_such_file_xyz__.txt" }, process.cwd());
    expect(typeof r).toBe("string");
    expect(r).toMatch(/Error|not found|ENOENT|失败/i);
  });
  it("未知工具名 → 返回 Error 字符串，不抛", async () => {
    const r = await runTool("totally_bogus_tool", {});
    expect(r).toMatch(/未知工具|Unknown/);
  });
});

describe("文件变更权限与 deleteFile", () => {
  function roots(allowFileWrite: boolean): { workdir: string; configRoot: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "opc-tool-perm-"));
    const workdir = path.join(base, "work");
    const configRoot = path.join(base, "project");
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(path.join(configRoot, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(configRoot, ".opc", "config.json"), JSON.stringify({
      permissions: { allowShell: true, allowFileWrite, allowWebAccess: true },
    }));
    return { workdir, configRoot };
  }

  it("允许文件变更时可创建并删除普通文件", async () => {
    const { workdir, configRoot } = roots(true);
    expect(await runTool("writeFile", { path: "src/a.txt", content: "ok" }, workdir, configRoot)).toContain("Written");
    expect(fs.existsSync(path.join(workdir, "src", "a.txt"))).toBe(true);
    expect(await runTool("deleteFile", { path: "src/a.txt" }, workdir, configRoot)).toContain("Deleted");
    expect(fs.existsSync(path.join(workdir, "src", "a.txt"))).toBe(false);
    fs.rmSync(path.dirname(workdir), { recursive: true, force: true });
  });

  it("关闭文件变更时 writeFile/deleteFile 都 fail-closed", async () => {
    const { workdir, configRoot } = roots(false);
    fs.writeFileSync(path.join(workdir, "keep.txt"), "keep");
    expect(await runTool("writeFile", { path: "new.txt", content: "no" }, workdir, configRoot)).toMatch(/not allowed|allowFileWrite/i);
    expect(await runTool("deleteFile", { path: "keep.txt" }, workdir, configRoot)).toMatch(/not allowed|allowFileWrite/i);
    expect(fs.existsSync(path.join(workdir, "new.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(workdir, "keep.txt"), "utf-8")).toBe("keep");
    fs.rmSync(path.dirname(workdir), { recursive: true, force: true });
  });

  it("deleteFile 拒绝目录、凭据和越界路径", async () => {
    const { workdir, configRoot } = roots(true);
    fs.mkdirSync(path.join(workdir, "dir"));
    fs.writeFileSync(path.join(workdir, ".env"), "SECRET=x");
    expect(await runTool("deleteFile", { path: "dir" }, workdir, configRoot)).toMatch(/Directory deletion|目录/i);
    expect(await runTool("deleteFile", { path: ".env" }, workdir, configRoot)).toMatch(/Credential|凭据/i);
    expect(await runTool("deleteFile", { path: "../outside.txt" }, workdir, configRoot)).toMatch(/outside project root|Access denied/i);
    expect(fs.existsSync(path.join(workdir, ".env"))).toBe(true);
    fs.rmSync(path.dirname(workdir), { recursive: true, force: true });
  });
});