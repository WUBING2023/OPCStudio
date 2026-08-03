# This removes only the host adapter and preserves OPC Studio companies, runs, memories, and artifacts.
[CmdletBinding(SupportsShouldProcess=$true)]
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
