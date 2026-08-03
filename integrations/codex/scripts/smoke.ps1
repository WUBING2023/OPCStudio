[CmdletBinding()]
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
[pscustomobject]@{ ok = $true; platform = "codex"; server = $initialize.result.serverInfo; tools = $actual } | ConvertTo-Json -Depth 6
