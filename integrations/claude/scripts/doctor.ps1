[CmdletBinding()]
param(
  [string]$McpCommand,
  [string[]]$McpArgs = @(),
  [switch]$SkipHostRegistration
)
$ErrorActionPreference = "Stop"
$IntegrationRoot = Split-Path -Parent $PSScriptRoot
$PluginRoot = Join-Path $IntegrationRoot "plugins\opc-studio"
$checks = [ordered]@{}
$checks.hostCommand = [bool](Get-Command claude -ErrorAction SilentlyContinue)

$checks.hostManifest = Test-Path (Join-Path $PluginRoot ".claude-plugin\plugin.json")
$checks.mcpManifest = Test-Path (Join-Path $PluginRoot ".mcp.json")
$checks.policyManifest = Test-Path (Join-Path $PluginRoot "opc-plugin.manifest.json")
$checks.uiDescriptor = Test-Path (Join-Path $PluginRoot "ui\embedded-ui.json")
$checks.manifestIdentity = $false
$checks.mcpEntrypoint = $false
$checks.uiDescriptorSafe = $false
$checks.mcpCommand = $false
$checks.mcpIdentity = $false
try {
  $hostManifest = Get-Content -Raw (Join-Path $PluginRoot ".claude-plugin\plugin.json") | ConvertFrom-Json
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
  $registration = (& claude plugin marketplace list --json 2>&1 | Out-String)
  $checks.hostRegistration = $registration -match [regex]::Escape("opc-studio-claude")
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
[pscustomobject]@{ ok = [bool]$ok; platform = "claude"; setupState = $setupState; setupReason = $setupReason; checks = $checks } | ConvertTo-Json -Depth 6
if (-not $ok) { exit 1 }
