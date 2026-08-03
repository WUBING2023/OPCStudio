import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ECOSYSTEM_CONTRACT_SCHEMA_VERSION } from "@opc/shared";
import { describe, expect, it } from "vitest";
import { MCP_TOOL_DEFINITIONS } from "../mcp/tools.js";
import { renderSkillMarkdown, SHARED_SKILLS } from "../skills/catalog.js";
import {
  PLUGIN_SOURCE,
  buildPluginFiles,
  readPluginDistribution,
  validatePluginDistributionRoot,
  validatePluginFiles,
  validatePluginPair,
  type PluginPlatform,
} from "./distribution.js";
import { EMBEDDED_UI_DESCRIPTOR_PATH } from "./embeddedUiDescriptor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const platforms: PluginPlatform[] = ["codex", "claude"];

function readFixture(platform: PluginPlatform): Map<string, string> {
  return readPluginDistribution(path.join(repoRoot, "integrations", platform));
}

describe("OPC dual plugin distribution", () => {
  it("uses one neutral descriptor and the shared ecosystem contract", () => {
    expect(PLUGIN_SOURCE.schemaVersion).toBe(ECOSYSTEM_CONTRACT_SCHEMA_VERSION);
    expect(PLUGIN_SOURCE.mcp.command).toBe("opc-mcp-not-configured");
    expect(PLUGIN_SOURCE.mcp.tools).toEqual(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(PLUGIN_SOURCE.skills).toEqual(SHARED_SKILLS.map((skill) => skill.name));
    expect(PLUGIN_SOURCE.permissions.direct).toEqual([]);
    expect(PLUGIN_SOURCE.dataPolicy.excludes).toEqual(expect.arrayContaining([
      "memory", "credentials", "keys", "run-data", "artifact-content",
    ]));
  });

  it.each(platforms)("generates a valid %s package with a non-executable MCP placeholder", (platform) => {
    const files = buildPluginFiles(platform);
    expect(validatePluginFiles(platform, files)).toEqual([]);
    const mcp = JSON.parse(files.get("plugins/opc-studio/.mcp.json") ?? "null");
    expect(mcp).toEqual({
      mcpServers: { "opc-studio": { command: "opc-mcp-not-configured", args: [], env: {} } },
    });
    const policy = JSON.parse(files.get("plugins/opc-studio/opc-plugin.manifest.json") ?? "null");
    expect(policy.ecosystemContractVersion).toBe(ECOSYSTEM_CONTRACT_SCHEMA_VERSION);
    expect(policy.permissions.direct).toEqual([]);
    expect(policy.permissions.delegated).toEqual({
      command: "opc-mcp-not-configured",
      readTools: MCP_TOOL_DEFINITIONS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name),
      writeTools: MCP_TOOL_DEFINITIONS.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name),
    });
    const embeddedUi = JSON.parse(files.get(EMBEDDED_UI_DESCRIPTOR_PATH) ?? "null");
    expect(embeddedUi.optional).toBe(true);
    expect(embeddedUi.headless.requiresEmbeddedUi).toBe(false);
    expect(embeddedUi.cards).toHaveLength(5);
  });

  it("keeps Codex and Claude skills byte-identical to the standard Skills source", () => {
    const codex = buildPluginFiles("codex");
    const claude = buildPluginFiles("claude");
    for (const skill of SHARED_SKILLS) {
      const relative = `plugins/opc-studio/skills/${skill.name}/SKILL.md`;
      const expected = renderSkillMarkdown(skill);
      expect(codex.get(relative)).toBe(expected);
      expect(claude.get(relative)).toBe(expected);
    }
    expect(codex.get(EMBEDDED_UI_DESCRIPTOR_PATH)).toBe(claude.get(EMBEDDED_UI_DESCRIPTOR_PATH));
  });

  it("validates both host manifests against one Skills and MCP release contract", () => {
    const codex = buildPluginFiles("codex");
    const claude = buildPluginFiles("claude");
    expect(validatePluginPair(codex, claude)).toEqual([]);

    const drifted = new Map(claude);
    drifted.set("plugins/opc-studio/.mcp.json", JSON.stringify({ mcpServers: {} }));
    expect(validatePluginPair(codex, drifted)).toEqual(expect.arrayContaining([
      "claude: MCP command must use the non-executable placeholder until install pins a verified absolute runtime",
      "cross-host drift: plugins/opc-studio/.mcp.json",
    ]));
  });

  it.each(platforms)("checked-in %s fixture exactly matches the generator", (platform) => {
    expect(readFixture(platform)).toEqual(buildPluginFiles(platform));
  });

  it("passes the release validator against the checked-in dual distribution", () => {
    expect(validatePluginDistributionRoot(path.join(repoRoot, "integrations"))).toEqual([]);
  });

  it.each(platforms)("%s package contains no user data or secret-bearing configuration", (platform) => {
    const files = buildPluginFiles(platform);
    for (const [relativePath, content] of files) {
      expect(relativePath).not.toMatch(/(^|\/)(memory|memories|keys?|credentials?|runs?|artifacts?|\.env)(\/|$)/i);
      expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]/i);
    }
  });

  it.each(platforms)("%s ships install, uninstall, Doctor and smoke entrypoints", (platform) => {
    const files = buildPluginFiles(platform);
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      "scripts/install.ps1", "scripts/uninstall.ps1", "scripts/doctor.ps1", "scripts/smoke.ps1",
    ]));
    expect(files.get("scripts/uninstall.ps1")).toContain("preserves OPC Studio companies, runs, memories, and artifacts");
    expect(files.get("scripts/install.ps1")).toContain("plugin marketplace add");
    if (platform === "codex") {
      expect(files.get("scripts/install.ps1")).toContain("plugin add");
    } else {
      expect(files.get("scripts/install.ps1")).toContain("plugin install");
      expect(files.get("scripts/install.ps1")).toContain("plugin enable");
    }
    expect(files.get("scripts/doctor.ps1")).toContain("mcpEntrypoint");
    expect(files.get("scripts/doctor.ps1")).toContain("mcpIdentity");
    expect(files.get("scripts/doctor.ps1")).toContain("setup_unavailable");
    expect(files.get("scripts/install.ps1")).toContain("setup_unavailable: opc_mcp_command_unpinned");
    expect(files.get("scripts/install.ps1")).toContain("$PolicyManifest.commandEntrypoint.command = $PinnedCommand");
    expect(files.get("scripts/install.ps1")).toContain("$PolicyManifest.permissions.delegated.command = $PinnedCommand");
    expect(files.get("scripts/doctor.ps1")).toContain(`opc-studio-${platform}`);
    expect(files.get("scripts/smoke.ps1")).toContain("initialize");
    expect(files.get("scripts/smoke.ps1")).toContain("tools/list");
  });

  it.each(platforms)("%s uninstall has no direct filesystem or OPC data operation", (platform) => {
    const uninstall = buildPluginFiles(platform).get("scripts/uninstall.ps1") ?? "";
    expect(uninstall).not.toMatch(/\b(Remove-Item|Clear-Content|Set-Content|rm|rmdir|del)\b/i);
    expect(uninstall).not.toMatch(/\$env:(?:OPC|HOME|USERPROFILE)|\.opc(?:studio)?[\\/]/i);
    expect(uninstall).toContain("plugin list --json");
    expect(uninstall).toContain('"opc-studio@$MarketplaceName"');
    expect(uninstall).toContain("plugin marketplace list --json");
    if (platform === "claude") expect(uninstall).toContain("--keep-data");
  });
});
