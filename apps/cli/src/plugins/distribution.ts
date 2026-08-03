import * as fs from "node:fs";
import * as path from "node:path";
import { ECOSYSTEM_CONTRACT_SCHEMA_VERSION } from "@opc/shared";
import { MCP_TOOL_DEFINITIONS } from "../mcp/tools.js";
import { renderSkillMarkdown, SHARED_SKILLS } from "../skills/catalog.js";
import {
  EMBEDDED_UI_DESCRIPTOR,
  EMBEDDED_UI_DESCRIPTOR_PATH,
  validateEmbeddedUiDescriptor,
} from "./embeddedUiDescriptor.js";

export type PluginPlatform = "codex" | "claude";

const readTools = MCP_TOOL_DEFINITIONS
  .filter((tool) => tool.annotations.readOnlyHint)
  .map((tool) => tool.name);
const writeTools = MCP_TOOL_DEFINITIONS
  .filter((tool) => !tool.annotations.readOnlyHint)
  .map((tool) => tool.name);

export const PLUGIN_SOURCE = {
  schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
  name: "opc-studio",
  version: "0.1.0",
  description: "Use OPC Studio companies for durable multi-agent runs, evidence review, and proposal-only company design.",
  license: "MIT",
  author: { name: "OPC Studio" },
  skills: SHARED_SKILLS.map((skill) => skill.name),
  mcp: {
    server: "opc-studio",
    command: "opc-mcp-not-configured",
    args: [] as string[],
    tools: MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
  },
  permissions: {
    direct: [] as string[],
    delegated: {
      boundary: "opc-mcp server-enforced high-level tools",
      readTools,
      writeTools,
      writeRequirements: ["authenticated OPC session", "confirm=true", "idempotencyKey", "durable audit record"],
    },
  },
  dataPolicy: {
    includes: ["plugin metadata", "standard Skill instructions", "opc-mcp process configuration"],
    excludes: ["memory", "credentials", "keys", "run-data", "artifact-content", "company-data", "local-paths"],
  },
  compatibility: {
    ecosystemContract: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    opcCli: ">=0.1.0",
    codex: "plugin marketplace with stdio MCP support",
    claudeCode: ">=2.1.154",
  },
} as const;

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

function mcpConfig(): string {
  return json({
    mcpServers: {
      "opc-studio": { command: PLUGIN_SOURCE.mcp.command, args: PLUGIN_SOURCE.mcp.args, env: {} },
    },
  });
}

function policyManifest(platform: PluginPlatform): string {
  return json({
    schemaVersion: PLUGIN_SOURCE.schemaVersion,
    ecosystemContractVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    name: PLUGIN_SOURCE.name,
    version: PLUGIN_SOURCE.version,
    platform,
    commandEntrypoint: { command: PLUGIN_SOURCE.mcp.command, args: PLUGIN_SOURCE.mcp.args },
    lifecycle: {
      workingDirectory: "marketplace-root",
      install: "scripts/install.ps1",
      uninstall: "scripts/uninstall.ps1",
      doctor: "scripts/doctor.ps1",
      smoke: "scripts/smoke.ps1",
    },
    permissions: {
      direct: PLUGIN_SOURCE.permissions.direct,
      delegated: {
        command: PLUGIN_SOURCE.mcp.command,
        readTools,
        writeTools,
      },
      writeRequirements: PLUGIN_SOURCE.permissions.delegated.writeRequirements,
    },
    dataPolicy: PLUGIN_SOURCE.dataPolicy,
    compatibility: PLUGIN_SOURCE.compatibility,
    embeddedUi: {
      descriptor: "ui/embedded-ui.json",
      optional: true,
      headlessRequired: true,
    },
  });
}

function codexManifest(): string {
  return json({
    name: PLUGIN_SOURCE.name,
    version: PLUGIN_SOURCE.version,
    description: PLUGIN_SOURCE.description,
    author: PLUGIN_SOURCE.author,
    license: PLUGIN_SOURCE.license,
    keywords: ["opc", "multi-agent", "mcp", "evidence", "workflow"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "OPC Studio",
      shortDescription: "Run and verify durable OPC company work",
      longDescription: "Connect Codex to OPC Studio through high-level MCP tools for company discovery, durable runs, artifact review, and committed evidence.",
      developerName: "OPC Studio",
      category: "Productivity",
      capabilities: ["Interactive", "Read", "Write"],
      defaultPrompt: [
        "Run this task with my OPC Studio company",
        "Review this OPC run and verify its evidence",
        "Propose a right-sized OPC company design",
      ],
      brandColor: "#1677FF",
    },
  });
}

function claudeManifest(): string {
  return json({
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: PLUGIN_SOURCE.name,
    displayName: "OPC Studio",
    version: PLUGIN_SOURCE.version,
    description: PLUGIN_SOURCE.description,
    author: PLUGIN_SOURCE.author,
    license: PLUGIN_SOURCE.license,
    keywords: ["opc", "multi-agent", "mcp", "evidence", "workflow"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    defaultEnabled: false,
  });
}

function codexMarketplace(): string {
  return json({
    name: "opc-studio-codex",
    interface: { displayName: "OPC Studio Local" },
    plugins: [{
      name: PLUGIN_SOURCE.name,
      source: { source: "local", path: "./plugins/opc-studio" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    }],
  });
}

function claudeMarketplace(): string {
  return json({
    name: "opc-studio-claude",
    description: "Local OPC Studio adapter marketplace for Claude Code.",
    owner: PLUGIN_SOURCE.author,
    plugins: [{
      name: PLUGIN_SOURCE.name,
      source: "./plugins/opc-studio",
      description: PLUGIN_SOURCE.description,
      version: PLUGIN_SOURCE.version,
      category: "productivity",
    }],
  });
}

function integrationReadme(platform: PluginPlatform): string {
  const host = platform === "codex" ? "Codex" : "Claude Code";
  const marketplace = platform === "codex" ? "opc-studio-codex" : "opc-studio-claude";
  const install = platform === "codex"
    ? "powershell -ExecutionPolicy Bypass -File .\\scripts\\install.ps1"
    : "powershell -ExecutionPolicy Bypass -File .\\scripts\\install.ps1 -Scope user";
  const uninstall = platform === "codex"
    ? "powershell -ExecutionPolicy Bypass -File .\\scripts\\uninstall.ps1"
    : "powershell -ExecutionPolicy Bypass -File .\\scripts\\uninstall.ps1 -Scope user";
  return `# OPC Studio for ${host}\n\n` +
    `Local marketplace: \`${marketplace}\`. This package exposes the same three standard Skills and the same ${MCP_TOOL_DEFINITIONS.length} \`opc-mcp\` tools as the other host adapter.\n\n` +
    "## Prerequisites\n\n- OPC Studio is installed, or installation receives an explicit absolute MCP runtime path.\n- The installer verifies the runtime through an MCP identity handshake before registering it; bare PATH commands are rejected.\n- Configure an OPC session token only through OPC Studio or the existing CLI environment; this package never stores it.\n\n" +
    `## Install\n\n\`\`\`powershell\n${install}\n\`\`\`\n\n` +
    "The install script is the only operation that changes host plugin configuration. It supports PowerShell `-WhatIf`.\n\n" +
    "## Doctor and smoke\n\n```powershell\npowershell -ExecutionPolicy Bypass -File .\\scripts\\doctor.ps1\npowershell -ExecutionPolicy Bypass -File .\\scripts\\smoke.ps1\n```\n\n" +
    `## Uninstall\n\n\`\`\`powershell\n${uninstall}\n\`\`\`\n\n` +
    "Uninstall removes only the host adapter. OPC Studio companies, runs, memories, artifacts, credentials, and keys remain owned by OPC Studio.\n\n" +
    "## Permission and data boundary\n\nThe plugin itself has no direct filesystem, network, shell, memory, or credential permission. It starts only the absolute OPC Studio MCP runtime pinned after an identity handshake. Read and write behavior is enforced by the MCP server; start/cancel operations require confirmation, authentication, idempotency, and audit. The package contains metadata, MCP configuration, and standard Skill instructions only.\n";
}

function installScript(platform: PluginPlatform): string {
  if (platform === "codex") return String.raw`[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$McpCommand,
  [string[]]$McpArgs = @()
)
$ErrorActionPreference = "Stop"
$IntegrationRoot = Split-Path -Parent $PSScriptRoot
$MarketplaceName = "opc-studio-codex"
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "setup_unavailable: host_cli_unavailable (Codex CLI is not available on PATH)." }
if (-not $McpCommand) {
  $RuntimeRoots = @(
    (Join-Path $env:LOCALAPPDATA "Programs\OPC Studio\resources\server-bundle"),
    (Join-Path $env:ProgramFiles "OPC Studio\resources\server-bundle")
  )
  foreach ($RuntimeRoot in $RuntimeRoots) {
    $NodeCandidate = Join-Path $RuntimeRoot "node-runtime\node.exe"
    $EntrypointCandidate = Join-Path $RuntimeRoot "cli-dist\mcp\index.js"
    if ((Test-Path -LiteralPath $NodeCandidate -PathType Leaf) -and (Test-Path -LiteralPath $EntrypointCandidate -PathType Leaf)) {
      $McpCommand = $NodeCandidate
      $McpArgs = @($EntrypointCandidate)
      break
    }
  }
}
if (-not $McpCommand -or -not [IO.Path]::IsPathRooted($McpCommand) -or -not (Test-Path -LiteralPath $McpCommand -PathType Leaf)) {
  throw "setup_unavailable: opc_mcp_command_unpinned (install OPC Studio or pass an absolute -McpCommand)."
}
$DoctorHost = (Get-Process -Id $PID).Path
& $DoctorHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "doctor.ps1") -McpCommand $McpCommand -McpArgs $McpArgs -SkipHostRegistration
if ($LASTEXITCODE -ne 0) { throw "setup_unavailable: opc_mcp_identity_mismatch" }
if ($PSCmdlet.ShouldProcess("Codex", "Install OPC Studio plugin")) {
  $McpManifestPath = Join-Path $IntegrationRoot "plugins\opc-studio\.mcp.json"
  $PolicyManifestPath = Join-Path $IntegrationRoot "plugins\opc-studio\opc-plugin.manifest.json"
  $PinnedCommand = (Resolve-Path -LiteralPath $McpCommand).Path
  $McpManifest = Get-Content -Raw $McpManifestPath | ConvertFrom-Json
  $McpManifest.mcpServers.'opc-studio'.command = $PinnedCommand
  $McpManifest.mcpServers.'opc-studio'.args = @($McpArgs)
  $PolicyManifest = Get-Content -Raw $PolicyManifestPath | ConvertFrom-Json
  $PolicyManifest.commandEntrypoint.command = $PinnedCommand
  $PolicyManifest.commandEntrypoint.args = @($McpArgs)
  $PolicyManifest.permissions.delegated.command = $PinnedCommand
  [IO.File]::WriteAllText($McpManifestPath, (($McpManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($PolicyManifestPath, (($PolicyManifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  $known = (& codex plugin marketplace list 2>&1 | Out-String)
  if ($known -notmatch [regex]::Escape($MarketplaceName)) {
    & codex plugin marketplace add $IntegrationRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not add the OPC Studio Codex marketplace." }
  }
  & codex plugin add "opc-studio@$MarketplaceName" --json
  if ($LASTEXITCODE -ne 0) { throw "Could not install the OPC Studio Codex plugin." }
}
`;
  return String.raw`[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [ValidateSet("user", "project", "local")][string]$Scope = "user",
  [string]$McpCommand,
  [string[]]$McpArgs = @()
)
$ErrorActionPreference = "Stop"
$IntegrationRoot = Split-Path -Parent $PSScriptRoot
$MarketplaceName = "opc-studio-claude"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "setup_unavailable: host_cli_unavailable (Claude Code CLI is not available on PATH)." }
if (-not $McpCommand) {
  $RuntimeRoots = @(
    (Join-Path $env:LOCALAPPDATA "Programs\OPC Studio\resources\server-bundle"),
    (Join-Path $env:ProgramFiles "OPC Studio\resources\server-bundle")
  )
  foreach ($RuntimeRoot in $RuntimeRoots) {
    $NodeCandidate = Join-Path $RuntimeRoot "node-runtime\node.exe"
    $EntrypointCandidate = Join-Path $RuntimeRoot "cli-dist\mcp\index.js"
    if ((Test-Path -LiteralPath $NodeCandidate -PathType Leaf) -and (Test-Path -LiteralPath $EntrypointCandidate -PathType Leaf)) {
      $McpCommand = $NodeCandidate
      $McpArgs = @($EntrypointCandidate)
      break
    }
  }
}
if (-not $McpCommand -or -not [IO.Path]::IsPathRooted($McpCommand) -or -not (Test-Path -LiteralPath $McpCommand -PathType Leaf)) {
  throw "setup_unavailable: opc_mcp_command_unpinned (install OPC Studio or pass an absolute -McpCommand)."
}
$DoctorHost = (Get-Process -Id $PID).Path
& $DoctorHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "doctor.ps1") -McpCommand $McpCommand -McpArgs $McpArgs -SkipHostRegistration
if ($LASTEXITCODE -ne 0) { throw "setup_unavailable: opc_mcp_identity_mismatch" }
if ($PSCmdlet.ShouldProcess("Claude Code", "Install OPC Studio plugin at $Scope scope")) {
  $McpManifestPath = Join-Path $IntegrationRoot "plugins\opc-studio\.mcp.json"
  $PolicyManifestPath = Join-Path $IntegrationRoot "plugins\opc-studio\opc-plugin.manifest.json"
  $PinnedCommand = (Resolve-Path -LiteralPath $McpCommand).Path
  $McpManifest = Get-Content -Raw $McpManifestPath | ConvertFrom-Json
  $McpManifest.mcpServers.'opc-studio'.command = $PinnedCommand
  $McpManifest.mcpServers.'opc-studio'.args = @($McpArgs)
  $PolicyManifest = Get-Content -Raw $PolicyManifestPath | ConvertFrom-Json
  $PolicyManifest.commandEntrypoint.command = $PinnedCommand
  $PolicyManifest.commandEntrypoint.args = @($McpArgs)
  $PolicyManifest.permissions.delegated.command = $PinnedCommand
  [IO.File]::WriteAllText($McpManifestPath, (($McpManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($PolicyManifestPath, (($PolicyManifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  $known = (& claude plugin marketplace list --json 2>$null | Out-String)
  if ($known -notmatch [regex]::Escape($MarketplaceName)) {
    & claude plugin marketplace add $IntegrationRoot --scope $Scope
    if ($LASTEXITCODE -ne 0) { throw "Could not add the OPC Studio Claude marketplace." }
  }
  & claude plugin install "opc-studio@$MarketplaceName" --scope $Scope
  if ($LASTEXITCODE -ne 0) { throw "Could not install the OPC Studio Claude plugin." }
  & claude plugin enable "opc-studio@$MarketplaceName" --scope $Scope
  if ($LASTEXITCODE -ne 0) { throw "Plugin was installed, but could not be enabled." }
}
`;
}

function uninstallScript(platform: PluginPlatform): string {
  const preface = String.raw`# This removes only the host adapter and preserves OPC Studio companies, runs, memories, and artifacts.
`;
  if (platform === "codex") return preface + String.raw`[CmdletBinding(SupportsShouldProcess=$true)]
param([switch]$RemoveMarketplace)
$ErrorActionPreference = "Stop"
$MarketplaceName = "opc-studio-codex"
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "Codex CLI is not available on PATH." }
if ($PSCmdlet.ShouldProcess("Codex", "Uninstall OPC Studio plugin")) {
  $installed = (& codex plugin list --json 2>$null | Out-String)
  if ($installed -match [regex]::Escape("opc-studio")) {
    & codex plugin remove "opc-studio@$MarketplaceName" --json
    if ($LASTEXITCODE -ne 0) { throw "Could not uninstall the OPC Studio Codex plugin." }
  }
  if ($RemoveMarketplace) {
    $known = (& codex plugin marketplace list --json 2>$null | Out-String)
    if ($known -match [regex]::Escape($MarketplaceName)) {
      & codex plugin marketplace remove $MarketplaceName --json
      if ($LASTEXITCODE -ne 0) { throw "Plugin was removed, but the marketplace could not be removed." }
    }
  }
}
`;
  return preface + String.raw`[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [ValidateSet("user", "project", "local")][string]$Scope = "user",
  [switch]$RemoveMarketplace
)
$ErrorActionPreference = "Stop"
$MarketplaceName = "opc-studio-claude"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI is not available on PATH." }
if ($PSCmdlet.ShouldProcess("Claude Code", "Uninstall OPC Studio plugin at $Scope scope")) {
  $installed = (& claude plugin list --json 2>$null | Out-String)
  if ($installed -match [regex]::Escape("opc-studio")) {
    & claude plugin uninstall "opc-studio@$MarketplaceName" --scope $Scope --keep-data
    if ($LASTEXITCODE -ne 0) { throw "Could not uninstall the OPC Studio Claude plugin." }
  }
  if ($RemoveMarketplace) {
    $known = (& claude plugin marketplace list --json 2>$null | Out-String)
    if ($known -match [regex]::Escape($MarketplaceName)) {
      & claude plugin marketplace remove $MarketplaceName --scope $Scope
      if ($LASTEXITCODE -ne 0) { throw "Plugin was removed, but the marketplace could not be removed." }
    }
  }
}
`;
}

function doctorScript(platform: PluginPlatform): string {
  const hostCommand = platform === "codex" ? "codex" : "claude";
  const manifestPath = platform === "codex" ? ".codex-plugin\\plugin.json" : ".claude-plugin\\plugin.json";
  const registrationCommand = platform === "codex" ? "plugin marketplace list" : "plugin marketplace list --json";
  const marketplaceName = `opc-studio-${platform}`;
  return String.raw`[CmdletBinding()]
param(
  [string]$McpCommand,
  [string[]]$McpArgs = @(),
  [switch]$SkipHostRegistration
)
$ErrorActionPreference = "Stop"
$IntegrationRoot = Split-Path -Parent $PSScriptRoot
$PluginRoot = Join-Path $IntegrationRoot "plugins\opc-studio"
$checks = [ordered]@{}
$checks.hostCommand = [bool](Get-Command ` + hostCommand + String.raw` -ErrorAction SilentlyContinue)

$checks.hostManifest = Test-Path (Join-Path $PluginRoot "` + manifestPath + String.raw`")
$checks.mcpManifest = Test-Path (Join-Path $PluginRoot ".mcp.json")
$checks.policyManifest = Test-Path (Join-Path $PluginRoot "opc-plugin.manifest.json")
$checks.uiDescriptor = Test-Path (Join-Path $PluginRoot "ui\embedded-ui.json")
$checks.manifestIdentity = $false
$checks.mcpEntrypoint = $false
$checks.uiDescriptorSafe = $false
$checks.mcpCommand = $false
$checks.mcpIdentity = $false
try {
  $hostManifest = Get-Content -Raw (Join-Path $PluginRoot "` + manifestPath + String.raw`") | ConvertFrom-Json
  $mcpManifest = Get-Content -Raw (Join-Path $PluginRoot ".mcp.json") | ConvertFrom-Json
  $policyManifest = Get-Content -Raw (Join-Path $PluginRoot "opc-plugin.manifest.json") | ConvertFrom-Json
  $uiDescriptor = Get-Content -Raw (Join-Path $PluginRoot "ui\embedded-ui.json") | ConvertFrom-Json
  $server = $mcpManifest.mcpServers.'opc-studio'
  $checks.manifestIdentity = $hostManifest.name -eq "opc-studio" -and $hostManifest.version -eq "0.1.0"
  $entrypointArgsMatch = (@($policyManifest.commandEntrypoint.args).Count -eq @($server.args).Count) -and ([string]::Join([char]31, [string[]]@($policyManifest.commandEntrypoint.args)) -ceq [string]::Join([char]31, [string[]]@($server.args)))
  $checks.mcpEntrypoint = ([bool]$server.command) -and ($server.command -eq "opc-mcp-not-configured" -or [IO.Path]::IsPathRooted([string]$server.command)) -and (@($server.env.psobject.Properties).Count -eq 0) -and ([string]$policyManifest.commandEntrypoint.command -eq [string]$server.command) -and $entrypointArgsMatch -and ([string]$policyManifest.permissions.delegated.command -eq [string]$server.command)
  $checks.uiDescriptorSafe = $uiDescriptor.schemaVersion -eq 1 -and $uiDescriptor.optional -eq $true -and $uiDescriptor.headless.requiresEmbeddedUi -eq $false -and -not (@($uiDescriptor.cards.refresh.createsRun) -contains $true)
  if (-not $McpCommand -and [IO.Path]::IsPathRooted([string]$server.command)) {
    $McpCommand = [string]$server.command
    $McpArgs = @($server.args)
  }
} catch {
  $checks.manifestIdentity = $false
  $checks.mcpEntrypoint = $false
  $checks.uiDescriptorSafe = $false
}
$checks.mcpCommand = [bool]($McpCommand -and [IO.Path]::IsPathRooted($McpCommand) -and (Test-Path -LiteralPath $McpCommand -PathType Leaf))
if ($checks.mcpCommand) {
  $identityRequest = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"opc-plugin-doctor","version":"1"}}}'
  $mcpArgsJson = ConvertTo-Json @($McpArgs) -Compress
  $identityJob = Start-Job -ScriptBlock {
    param($Command, $ArgumentsJson, $Request)
    $ErrorActionPreference = "Stop"
    $Arguments = @($ArgumentsJson | ConvertFrom-Json)
    @($Request | & $Command @Arguments)
  } -ArgumentList $McpCommand, $mcpArgsJson, $identityRequest
  try {
    $finished = Wait-Job $identityJob -Timeout 15
    if ($finished) {
      $identityLines = @(Receive-Job $identityJob -ErrorAction Stop)
      $identity = $identityLines | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.id -eq 1 } | Select-Object -First 1
      $checks.mcpIdentity = $identity.result.serverInfo.name -eq "opc-studio"
    }
  } catch { $checks.mcpIdentity = $false }
  finally {
    if ($identityJob.State -notin @("Completed", "Failed", "Stopped")) { Stop-Job $identityJob -ErrorAction SilentlyContinue }
    Remove-Job $identityJob -Force -ErrorAction SilentlyContinue
  }
}
$checks.skills = @("opc-team-run", "opc-run-review", "opc-company-design") | ForEach-Object {
  Test-Path (Join-Path $PluginRoot "skills\$_\SKILL.md")
}
if (-not $SkipHostRegistration -and $checks.hostCommand) {
  $registration = (& ` + hostCommand + " " + registrationCommand + String.raw` 2>&1 | Out-String)
  $checks.hostRegistration = $registration -match [regex]::Escape("` + marketplaceName + String.raw`")
} else {
  $checks.hostRegistration = $null
}
$registrationOk = $SkipHostRegistration -or $checks.hostRegistration -eq $true
$ok = $checks.hostCommand -and $checks.mcpCommand -and $checks.mcpIdentity -and $checks.hostManifest -and $checks.mcpManifest -and $checks.policyManifest -and $checks.uiDescriptor -and $checks.manifestIdentity -and $checks.mcpEntrypoint -and $checks.uiDescriptorSafe -and -not ($checks.skills -contains $false) -and $registrationOk
$setupState = "ready"
$setupReason = $null
if (-not $checks.hostCommand) { $setupState = "setup_unavailable"; $setupReason = "host_cli_unavailable" }
elseif (-not $checks.mcpCommand) { $setupState = "setup_unavailable"; $setupReason = "opc_mcp_command_unpinned" }
elseif (-not $checks.mcpIdentity) { $setupState = "setup_unavailable"; $setupReason = "opc_mcp_identity_mismatch" }
elseif (-not $checks.hostManifest -or -not $checks.mcpManifest -or -not $checks.policyManifest -or -not $checks.uiDescriptor -or -not $checks.manifestIdentity -or -not $checks.mcpEntrypoint -or -not $checks.uiDescriptorSafe -or $checks.skills -contains $false) { $setupState = "distribution_invalid"; $setupReason = "plugin_contract_invalid" }
elseif (-not $registrationOk) { $setupState = "registration_required"; $setupReason = "host_registration_missing" }
[pscustomobject]@{ ok = [bool]$ok; platform = "` + platform + String.raw`"; setupState = $setupState; setupReason = $setupReason; checks = $checks } | ConvertTo-Json -Depth 6
if (-not $ok) { exit 1 }
`;
}

function smokeScript(platform: PluginPlatform): string {
  return String.raw`[CmdletBinding()]
param(
  [string]$McpCommand,
  [string[]]$McpArgs = @()
)
$ErrorActionPreference = "Stop"
$IntegrationRoot = Split-Path -Parent $PSScriptRoot
$PolicyPath = Join-Path $IntegrationRoot "plugins\opc-studio\opc-plugin.manifest.json"
$McpManifest = Get-Content -Raw (Join-Path $IntegrationRoot "plugins\opc-studio\.mcp.json") | ConvertFrom-Json
if (-not $McpCommand) {
  $McpCommand = [string]$McpManifest.mcpServers.'opc-studio'.command
  $McpArgs = @($McpManifest.mcpServers.'opc-studio'.args)
}
$DoctorHost = (Get-Process -Id $PID).Path
& $DoctorHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "doctor.ps1") -McpCommand $McpCommand -McpArgs $McpArgs -SkipHostRegistration
if ($LASTEXITCODE -ne 0) { throw "Doctor failed before MCP smoke." }
$requests = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"opc-plugin-smoke","version":"1"}}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
)
$lines = @($requests | & $McpCommand @McpArgs)
if ($LASTEXITCODE -ne 0) { throw "opc-mcp exited with code $LASTEXITCODE." }
$responses = @($lines | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$initialize = $responses | Where-Object { $_.id -eq 1 } | Select-Object -First 1
$toolList = $responses | Where-Object { $_.id -eq 2 } | Select-Object -First 1
if (-not $initialize.result.serverInfo.name -or $initialize.result.serverInfo.name -ne "opc-studio") { throw "MCP initialize response is invalid." }
$expected = @((Get-Content -Raw $PolicyPath | ConvertFrom-Json).permissions.delegated.readTools) + @((Get-Content -Raw $PolicyPath | ConvertFrom-Json).permissions.delegated.writeTools)
$actual = @($toolList.result.tools | ForEach-Object { $_.name })
$missing = @($expected | Where-Object { $_ -notin $actual })
$unexpected = @($actual | Where-Object { $_ -notin $expected })
if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) { throw "MCP tool contract mismatch. Missing=$($missing -join ',') Unexpected=$($unexpected -join ',')" }
[pscustomobject]@{ ok = $true; platform = "` + platform + String.raw`"; server = $initialize.result.serverInfo; tools = $actual } | ConvertTo-Json -Depth 6
`;
}

const mitLicense = `MIT License\n\nCopyright (c) 2026 OPC Studio\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;

export function buildPluginFiles(platform: PluginPlatform): Map<string, string> {
  const files = new Map<string, string>();
  const pluginRoot = "plugins/opc-studio/";
  files.set(platform === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json",
    platform === "codex" ? codexMarketplace() : claudeMarketplace());
  files.set(pluginRoot + (platform === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json"),
    platform === "codex" ? codexManifest() : claudeManifest());
  files.set(pluginRoot + ".mcp.json", mcpConfig());
  files.set(pluginRoot + "opc-plugin.manifest.json", policyManifest(platform));
  files.set(EMBEDDED_UI_DESCRIPTOR_PATH, json(EMBEDDED_UI_DESCRIPTOR));
  files.set(pluginRoot + "LICENSE", mitLicense);
  for (const skill of SHARED_SKILLS) files.set(pluginRoot + `skills/${skill.name}/SKILL.md`, renderSkillMarkdown(skill));
  files.set("README.md", integrationReadme(platform));
  files.set("scripts/install.ps1", installScript(platform));
  files.set("scripts/uninstall.ps1", uninstallScript(platform));
  files.set("scripts/doctor.ps1", doctorScript(platform));
  files.set("scripts/smoke.ps1", smokeScript(platform));
  return files;
}

function parseJsonFile(files: Map<string, string>, relativePath: string, errors: string[]): Record<string, unknown> {
  const raw = files.get(relativePath);
  if (!raw) {
    errors.push(`missing file: ${relativePath}`);
    return {};
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    errors.push(`invalid JSON: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function validatePluginFiles(platform: PluginPlatform, files: Map<string, string>): string[] {
  const errors: string[] = [];
  const pluginRoot = "plugins/opc-studio/";
  const hostManifestPath = pluginRoot + (platform === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json");
  const marketplacePath = platform === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
  const hostManifest = parseJsonFile(files, hostManifestPath, errors);
  const marketplace = parseJsonFile(files, marketplacePath, errors);
  const mcp = parseJsonFile(files, pluginRoot + ".mcp.json", errors);
  const policy = parseJsonFile(files, pluginRoot + "opc-plugin.manifest.json", errors);
  const embeddedUi = parseJsonFile(files, EMBEDDED_UI_DESCRIPTOR_PATH, errors);
  if (hostManifest.name !== PLUGIN_SOURCE.name || hostManifest.version !== PLUGIN_SOURCE.version) errors.push("host manifest identity mismatch");
  if (hostManifest.skills !== "./skills/" || hostManifest.mcpServers !== "./.mcp.json") errors.push("host manifest entrypoint mismatch");
  if (platform === "claude" && hostManifest.$schema !== "https://json.schemastore.org/claude-code-plugin-manifest.json") errors.push("Claude manifest schema mismatch");

  if (marketplace.name !== `opc-studio-${platform}`) errors.push("marketplace name mismatch");
  const marketplacePlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const marketplacePlugin = marketplacePlugins.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).name === PLUGIN_SOURCE.name) as Record<string, unknown> | undefined;
  if (!marketplacePlugin) errors.push("marketplace plugin entry missing");
  const marketplaceSource = marketplacePlugin?.source;
  const sourcePath = platform === "codex"
    ? (marketplaceSource && typeof marketplaceSource === "object" ? (marketplaceSource as Record<string, unknown>).path : undefined)
    : marketplaceSource;
  if (sourcePath !== "./plugins/opc-studio") errors.push("marketplace source path mismatch");
  const servers = mcp.mcpServers as Record<string, unknown> | undefined;
  if (!servers || JSON.stringify(servers["opc-studio"]) !== JSON.stringify({ command: "opc-mcp-not-configured", args: [], env: {} })) errors.push("MCP command must use the non-executable placeholder until install pins a verified absolute runtime");
  if (policy.ecosystemContractVersion !== ECOSYSTEM_CONTRACT_SCHEMA_VERSION) errors.push("ecosystem contract version mismatch");
  if (policy.name !== PLUGIN_SOURCE.name || policy.version !== PLUGIN_SOURCE.version || policy.platform !== platform) errors.push("policy manifest identity mismatch");
  if (JSON.stringify(policy.commandEntrypoint) !== JSON.stringify({ command: PLUGIN_SOURCE.mcp.command, args: PLUGIN_SOURCE.mcp.args })) errors.push("policy command entrypoint mismatch");
  const permissions = policy.permissions as Record<string, unknown> | undefined;
  const delegated = permissions?.delegated as Record<string, unknown> | undefined;
  if (JSON.stringify(delegated?.readTools) !== JSON.stringify(readTools) || JSON.stringify(delegated?.writeTools) !== JSON.stringify(writeTools)) errors.push("policy MCP tool inventory mismatch");
  errors.push(...validateEmbeddedUiDescriptor(embeddedUi));
  const embeddedCards = Array.isArray(embeddedUi.cards) ? embeddedUi.cards : [];
  const describedMcpTools = embeddedCards.flatMap((card) => {
    const source = card && typeof card === "object" ? (card as Record<string, unknown>).source : undefined;
    const tools = source && typeof source === "object" ? (source as Record<string, unknown>).mcpTools : undefined;
    return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
  });
  for (const tool of describedMcpTools) {
    if (!PLUGIN_SOURCE.mcp.tools.includes(tool as typeof PLUGIN_SOURCE.mcp.tools[number])) errors.push("embedded UI references unknown MCP tool: " + tool);
  }
  for (const skill of SHARED_SKILLS) {
    const relative = pluginRoot + `skills/${skill.name}/SKILL.md`;
    if (files.get(relative) !== renderSkillMarkdown(skill)) errors.push(`Skill drift: ${skill.name}`);
  }
  const forbiddenPath = /(^|\/)(memory|memories|keys?|credentials?|runs?|artifacts?|\.env)(\/|$)/i;
  const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]/i;
  for (const [relativePath, content] of files) {
    if (path.posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) errors.push(`unsafe package path: ${relativePath}`);
    if (forbiddenPath.test(relativePath)) errors.push(`user data path is forbidden: ${relativePath}`);
    if (secret.test(content)) errors.push(`secret-like content is forbidden: ${relativePath}`);
  }
  for (const lifecycle of ["install", "uninstall", "doctor", "smoke"]) {
    if (!files.has(`scripts/${lifecycle}.ps1`)) errors.push(`missing lifecycle script: ${lifecycle}`);
  }
  const install = files.get("scripts/install.ps1") ?? "";
  const doctor = files.get("scripts/doctor.ps1") ?? "";
  const uninstall = files.get("scripts/uninstall.ps1") ?? "";
  if (!install.includes("setup_unavailable: host_cli_unavailable") || !install.includes("setup_unavailable: opc_mcp_command_unpinned")) errors.push("install script must fail closed with a setup_unavailable reason");
  if (!doctor.includes('$setupState = "setup_unavailable"') || !doctor.includes('"opc_mcp_command_unpinned"') || !doctor.includes('"opc_mcp_identity_mismatch"')) errors.push("Doctor must expose setup_unavailable state");
  if (/\b(Remove-Item|Clear-Content|Set-Content|rm|rmdir|del)\b/i.test(uninstall)) errors.push("uninstall script must not perform direct filesystem deletion");
  if (/\$env:(?:OPC|HOME|USERPROFILE)|\.opc(?:studio)?[\\/]/i.test(uninstall)) errors.push("uninstall script must not reference OPC or user data roots");
  if (platform === "claude" && !uninstall.includes("--keep-data")) errors.push("Claude uninstall must preserve plugin data");
  return errors;
}

export function validatePluginPair(codex: Map<string, string>, claude: Map<string, string>): string[] {
  const errors = [
    ...validatePluginFiles("codex", codex).map((error) => `codex: ${error}`),
    ...validatePluginFiles("claude", claude).map((error) => `claude: ${error}`),
  ];
  const sharedPaths = [
    "plugins/opc-studio/.mcp.json",
    EMBEDDED_UI_DESCRIPTOR_PATH,
    ...SHARED_SKILLS.map((skill) => `plugins/opc-studio/skills/${skill.name}/SKILL.md`),
  ];
  for (const relativePath of sharedPaths) {
    if (codex.get(relativePath) !== claude.get(relativePath)) errors.push(`cross-host drift: ${relativePath}`);
  }

  const codexPolicyErrors: string[] = [];
  const claudePolicyErrors: string[] = [];
  const codexPolicy = parseJsonFile(codex, "plugins/opc-studio/opc-plugin.manifest.json", codexPolicyErrors);
  const claudePolicy = parseJsonFile(claude, "plugins/opc-studio/opc-plugin.manifest.json", claudePolicyErrors);
  for (const key of ["schemaVersion", "ecosystemContractVersion", "name", "version", "commandEntrypoint", "permissions", "dataPolicy", "compatibility", "embeddedUi"] as const) {
    if (JSON.stringify(codexPolicy[key]) !== JSON.stringify(claudePolicy[key])) errors.push(`cross-host policy drift: ${key}`);
  }
  return [...new Set(errors)];
}

export function readPluginDistribution(root: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(root)) return result;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result.set(path.relative(root, absolute).replace(/\\/g, "/"), fs.readFileSync(absolute, "utf-8"));
    }
  };
  visit(root);
  return result;
}

export function validatePluginDistributionRoot(outputRoot: string): string[] {
  const codex = readPluginDistribution(path.join(outputRoot, "codex"));
  const claude = readPluginDistribution(path.join(outputRoot, "claude"));
  const errors: string[] = [];
  if (codex.size === 0) errors.push("codex: distribution missing");
  if (claude.size === 0) errors.push("claude: distribution missing");
  if (errors.length > 0) return errors;
  return validatePluginPair(codex, claude);
}

export function writePluginDistributions(outputRoot: string): void {
  const resolvedRoot = path.resolve(outputRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root || resolvedRoot === path.resolve(process.cwd())) throw new Error("Unsafe plugin distribution root");
  const distributions = {
    codex: buildPluginFiles("codex"),
    claude: buildPluginFiles("claude"),
  };
  const errors = validatePluginPair(distributions.codex, distributions.claude);
  if (errors.length > 0) throw new Error(`Invalid plugin distributions: ${errors.join("; ")}`);
  for (const platform of ["codex", "claude"] as const) {
    writePluginFiles(resolvedRoot, platform, distributions[platform]);
  }
}

function writePluginFiles(outputRoot: string, platform: PluginPlatform, files: Map<string, string>): void {
  const platformRoot = path.resolve(outputRoot, platform);
  for (const [relativePath, content] of files) {
    const destination = path.resolve(platformRoot, ...relativePath.split("/"));
    if (!destination.startsWith(`${platformRoot}${path.sep}`)) throw new Error(`Unsafe generated path: ${relativePath}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, "utf-8");
  }
}

/** Export one host adapter without generating or touching the other host tree. */
export function writePluginDistribution(outputRoot: string, platform: PluginPlatform): void {
  const resolvedRoot = path.resolve(outputRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root || resolvedRoot === path.resolve(process.cwd())) {
    throw new Error("Unsafe plugin distribution root");
  }
  const files = buildPluginFiles(platform);
  const errors = validatePluginFiles(platform, files);
  if (errors.length > 0) throw new Error(`Invalid ${platform} plugin distribution: ${errors.join("; ")}`);
  writePluginFiles(resolvedRoot, platform, files);
}
