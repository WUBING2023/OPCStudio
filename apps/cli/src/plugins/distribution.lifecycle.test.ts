import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writePluginDistributions, type PluginPlatform } from "./distribution.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

function cleanPathEnvironment(pathValue: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const entries = Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path");
  return { ...Object.fromEntries(entries), Path: pathValue, ...extra };
}

function writeHostStub(binRoot: string, command: string, logPath: string): void {
  fs.mkdirSync(binRoot, { recursive: true });
  const marketplaceName = `opc-studio-${command}`;
  fs.writeFileSync(path.join(binRoot, `${command}.cmd`), [
    "@echo off",
    `echo %*>>\"${logPath}\"`,
    `if \"%1 %2\"==\"plugin list\" echo [{\"name\":\"opc-studio\",\"marketplace\":\"${marketplaceName}\"}]`,
    `if \"%1 %2 %3\"==\"plugin marketplace list\" echo [{\"name\":\"${marketplaceName}\"}]`,
    "exit /b 0",
    "",
  ].join("\r\n"), "utf-8");
}

function writeMcpCollisionStub(binRoot: string, logPath: string): void {
  fs.writeFileSync(path.join(binRoot, "opc-mcp.cmd"), [
    "@echo off",
    `echo invoked>>"${logPath}"`,
    "exit /b 0",
    "",
  ].join("\r\n"), "utf-8");
}
function runPowerShell(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawnSync(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    encoding: "utf-8",
    env,
  });
}

describe("plugin distribution lifecycle release gate", () => {
  windowsIt.each(["codex", "claude"] as const)("%s reports setup_unavailable and does not invoke the host when opc-mcp is absent", (platform) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-setup-"));
    try {
      writePluginDistributions(root);
      const binRoot = path.join(root, "fake-bin");
      const logPath = path.join(root, "host.log");
      writeHostStub(binRoot, platform, logPath);
      const env = cleanPathEnvironment(binRoot, { OPC_FAKE_HOST_LOG: logPath });
      const scripts = path.join(root, platform, "scripts");

      const doctor = runPowerShell(path.join(scripts, "doctor.ps1"), ["-McpCommand", "opc-mcp-definitely-missing", "-SkipHostRegistration"], env);
      expect(doctor.status).toBe(1);
      expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
        ok: false,
        platform,
        setupState: "setup_unavailable",
        setupReason: "opc_mcp_command_unpinned",
        checks: {
          uiDescriptor: true,
          uiDescriptorSafe: true,
        },
      });

      const install = runPowerShell(path.join(scripts, "install.ps1"), ["-WhatIf"], env);
      expect(install.status).not.toBe(0);
      expect(`${install.stdout}\n${install.stderr}`).toContain("setup_unavailable: opc_mcp_command_unpinned");
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  windowsIt.each(["codex", "claude"] as const)("%s never executes a same-name opc-mcp found on PATH", (platform) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-path-collision-"));
    try {
      writePluginDistributions(root);
      const binRoot = path.join(root, "fake-bin");
      const hostLog = path.join(root, "host.log");
      const collisionLog = path.join(root, "collision.log");
      writeHostStub(binRoot, platform, hostLog);
      writeMcpCollisionStub(binRoot, collisionLog);
      const doctor = runPowerShell(
        path.join(root, platform, "scripts", "doctor.ps1"),
        ["-SkipHostRegistration"],
        cleanPathEnvironment(binRoot),
      );
      expect(doctor.status).toBe(1);
      expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
        setupState: "setup_unavailable",
        setupReason: "opc_mcp_command_unpinned",
        checks: { mcpCommand: false, mcpIdentity: false },
      });
      expect(fs.existsSync(collisionLog)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  windowsIt.each(["codex", "claude"] as const)("%s rejects an explicitly pinned process with the wrong MCP identity", (platform) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-identity-"));
    try {
      writePluginDistributions(root);
      const binRoot = path.join(root, "fake-bin");
      writeHostStub(binRoot, platform, path.join(root, "host.log"));
      const wrongServer = path.join(root, "wrong-server.mjs");
      fs.writeFileSync(wrongServer, [
        "process.stdin.resume();",
        "process.stdin.on('end', () => console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{serverInfo:{name:'not-opc-studio',version:'1'}}})));",
      ].join("\n"), "utf-8");
      const doctor = runPowerShell(
        path.join(root, platform, "scripts", "doctor.ps1"),
        ["-McpCommand", process.execPath, "-McpArgs", wrongServer, "-SkipHostRegistration"],
        cleanPathEnvironment(binRoot),
      );
      expect(doctor.status).toBe(1);
      expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
        setupState: "setup_unavailable",
        setupReason: "opc_mcp_identity_mismatch",
        checks: { mcpCommand: true, mcpIdentity: false },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  windowsIt.each(["codex", "claude"] as const)("%s uninstall leaves OPC-owned data byte-identical", (platform: PluginPlatform) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-uninstall-"));
    try {
      writePluginDistributions(root);
      const binRoot = path.join(root, "fake-bin");
      const logPath = path.join(root, "host.log");
      writeHostStub(binRoot, platform, logPath);

      const opcHome = path.join(root, "opc-home");
      const opcData = path.join(root, "opc-data");
      const userProfile = path.join(root, "user-profile");
      const canaries = [
        [path.join(opcHome, "companies", "company.json"), "company-owned"],
        [path.join(opcData, "runs", "task.json"), "run-owned"],
        [path.join(userProfile, ".opcstudio", "memory.md"), "memory-owned"],
      ] as const;
      for (const [file, content] of canaries) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf-8");
      }
      const env = cleanPathEnvironment(binRoot, {
        OPC_FAKE_HOST_LOG: logPath,
        OPC_HOME: opcHome,
        OPC_DATA_DIR: opcData,
        USERPROFILE: userProfile,
      });
      const uninstall = runPowerShell(path.join(root, platform, "scripts", "uninstall.ps1"), ["-RemoveMarketplace"], env);
      expect(uninstall.status, uninstall.stderr).toBe(0);
      for (const [file, content] of canaries) expect(fs.readFileSync(file, "utf-8")).toBe(content);
      const hostCalls = fs.readFileSync(logPath, "utf-8");
      expect(hostCalls).toContain("plugin");
      if (platform === "claude") expect(hostCalls).toContain("--keep-data");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
