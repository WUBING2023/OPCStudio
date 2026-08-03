import { describe, it, expect, beforeEach } from "vitest";
import { setProjectRoot, resolveSafe, isPathSafe, readFile, writeFile } from "./pathGuard.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

beforeEach(() => {
  setProjectRoot(process.cwd());
});

describe("setProjectRoot", () => {
  it("resolves relative path to absolute", () => {
    setProjectRoot(".");
    // Should resolve to current working directory
    expect(() => resolveSafe("package.json")).not.toThrow();
  });
});

describe("isPathSafe", () => {
  it("returns true for a path inside project root", () => {
    setProjectRoot("/tmp/test-project");
    expect(isPathSafe("src/file.ts")).toBe(true);
  });

  it("returns true for nested paths inside project root", () => {
    setProjectRoot("/tmp/test-project");
    expect(isPathSafe("src/deep/nested/file.ts")).toBe(true);
  });

  it("handles paths with .. that resolve inside root", () => {
    setProjectRoot("/tmp/test-project");
    // "src/../src/file.ts" should normalize to "src/file.ts" which is inside
    expect(isPathSafe("src/../src/config.ts")).toBe(true);
  });

  // 回归:旧实现 includes("..") 分支恒 false → 逃逸路径被误判为 safe(恒 true)。
  it("returns FALSE for paths escaping root via ..", () => {
    setProjectRoot("/tmp/test-project");
    expect(isPathSafe("../../../etc/passwd")).toBe(false);
    expect(isPathSafe("src/../../escape.txt")).toBe(false);
  });

  it("returns FALSE for a sibling dir sharing the root prefix (project-evil)", () => {
    setProjectRoot("/tmp/test-project");
    expect(isPathSafe("../test-project-evil/x.ts")).toBe(false);
  });
});

describe("resolveSafe", () => {
  it("resolves a relative path inside project root", () => {
    const root = process.cwd();
    setProjectRoot(root);
    const resolved = resolveSafe("src");
    expect(resolved).toBe(path.resolve(root, "src"));
  });

  it("throws for a path that escapes project root via ..", () => {
    setProjectRoot("/tmp/test-project");
    expect(() => resolveSafe("../../../etc/passwd")).toThrow("Access denied");
  });

  it("throws for absolute path outside project root", () => {
    setProjectRoot("/tmp/test-project");
    expect(() => resolveSafe("/etc/passwd")).toThrow("Access denied");
  });

  it("resolves the project root itself", () => {
    setProjectRoot("/tmp/test-project");
    expect(resolveSafe(".")).toBe(path.resolve("/tmp/test-project"));
  });

  // 回归:前缀碰撞 —— /tmp/test-project-evil 不应被 /tmp/test-project 放行。
  it("throws for a sibling dir sharing the root prefix", () => {
    setProjectRoot("/tmp/test-project");
    expect(() => resolveSafe("../test-project-evil/secret")).toThrow("Access denied");
  });
});

describe("canonical path boundary", () => {
  it("rejects a file hard-linked to content outside the workspace", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opc-path-hardlink-"));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside.txt");
    fs.mkdirSync(root);
    fs.writeFileSync(outside, "outside");
    fs.linkSync(outside, path.join(root, "linked.txt"));
    try {
      expect(() => readFile("linked.txt", root)).toThrow(/hard links/);
      expect(() => writeFile("linked.txt", "changed", root)).toThrow(/hard links/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("rejects Windows UNC, device names, and alternate data streams", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-path-win32-"));
    try {
      expect(() => writeFile("\\\\server\\share\\file.txt", "no", root)).toThrow(/UNC|device/);
      expect(() => writeFile("CON.txt", "no", root)).toThrow(/device name/);
      expect(() => writeFile("safe.txt:secret", "no", root)).toThrow(/alternate data stream/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects read and write through a workspace link that targets an outside directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opc-path-boundary-"));
    const root = path.join(parent, "workspace");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(root); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE_SECRET");
    const link = path.join(root, "link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(() => readFile("link/secret.txt", root)).toThrow(/outside project root/);
      expect(() => writeFile("link/written.txt", "no", root)).toThrow(/symlink|junction/);
      expect(fs.existsSync(path.join(outside, "written.txt"))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows an internal read link but never mutations through a link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-path-internal-"));
    const target = path.join(root, "target");
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, "ok.txt"), "ok");
    fs.symlinkSync(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    try {
      expect(readFile("link/ok.txt", root)).toBe("ok");
      expect(() => writeFile("link/no.txt", "no", root)).toThrow(/symlink|junction/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
