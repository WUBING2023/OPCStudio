import { describe, it, expect, vi, afterEach } from "vitest";

// Import the module under test AFTER potentially mocking node:child_process.
// We use vi.mock at the top level so Vitest hoists it before the import.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { killProcessTree } from "./processUtils.js";

afterEach(() => vi.resetAllMocks());

describe("killProcessTree", () => {
  it("calls the fallback kill() on every platform", () => {
    const kill = vi.fn();
    killProcessTree(undefined, kill);
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does NOT call spawnSync when pid is undefined", () => {
    const kill = vi.fn();
    killProcessTree(undefined, kill);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("swallows a throw from kill() without propagating", () => {
    const kill = vi.fn(() => { throw new Error("process gone"); });
    expect(() => killProcessTree(undefined, kill)).not.toThrow();
  });

  it("on win32: calls taskkill /T /F then kill()", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0 });
    const kill = vi.fn();

    killProcessTree(12345, kill);

    expect(spawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "12345", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(kill).toHaveBeenCalledOnce();

    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });

  it("on win32: swallows spawnSync throw, still calls kill()", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (spawnSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("taskkill ENOENT"); });
    const kill = vi.fn();

    expect(() => killProcessTree(99, kill)).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();

    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });

  it("on non-win32: skips taskkill, only calls kill()", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const kill = vi.fn();

    killProcessTree(42, kill);

    expect(spawnSync).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();

    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  });
});
