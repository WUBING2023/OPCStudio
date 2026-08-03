import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { managedInstallArgs, resolveInstallerLaunch, setupInstallPlan } from "./setupRoutes.js";

describe("packaged CLI installer runtime", () => {
  it("uses bundled node + npm-cli without a shell", () => {
    const launch = resolveInstallerLaunch({
      OPC_NODE_EXECUTABLE: process.execPath,
      OPC_NPM_CLI: process.execPath,
    });
    expect(launch).toEqual({ file: process.execPath, prefixArgs: [process.execPath] });
  });

  it("fails closed when only half of the packaged runtime is present", () => {
    expect(() => resolveInstallerLaunch({ OPC_NODE_EXECUTABLE: process.execPath })).toThrow(/incomplete/);
  });

  it("only accepts an absolute managed install prefix", () => {
    expect(managedInstallArgs({ OPC_MANAGED_CLI_PREFIX: path.resolve("tmp", "opc-cli") }))
      .toEqual(["--prefix", path.resolve("tmp", "opc-cli")]);
    expect(() => managedInstallArgs({ OPC_MANAGED_CLI_PREFIX: "relative" })).toThrow(/absolute/);
  });

  it("installs Kimi from the confirmed official npm package", () => {
    expect(setupInstallPlan("kimi-cli")).toEqual({
      supported: true,
      engine: "kimi-cli",
      args: ["install", "-g", "@moonshot-ai/kimi-code"],
    });
  });

  it("does not invent an unattended Grok installer", () => {
    const plan = setupInstallPlan("grok-build");
    expect(plan).toMatchObject({ supported: false, engine: "grok-build" });
    expect(plan && "reason" in plan ? plan.reason : "").toMatch(/手动安装/);
  });

  it("rejects unknown setup engines", () => {
    expect(setupInstallPlan("not-a-cli")).toBeNull();
  });
});