[CmdletBinding(SupportsShouldProcess=$true)]
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
